package migrations

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCatalogIsCompleteOrderedAndChecksummed(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	if len(catalog) != 23 {
		t.Fatalf("len(Catalog()) = %d, want 23", len(catalog))
	}
	for i, migration := range catalog {
		wantVersion := int64(i + 1)
		if migration.Version != wantVersion {
			t.Fatalf("catalog[%d].Version = %d, want %d", i, migration.Version, wantVersion)
		}
		if len(migration.Checksum) != 64 {
			t.Errorf("migration %03d checksum length = %d, want 64", migration.Version, len(migration.Checksum))
		}
		if migration.Version == 2 && migration.Apply == nil {
			t.Error("model schema migration must use explicit Go callback")
		}
		wantTransactional := migration.Version != 8 && migration.Version != 9 && migration.Version != 11 && migration.Version != 13 && migration.Version != 14 && migration.Version != 15 && migration.Version != 18
		if migration.Transactional != wantTransactional {
			t.Errorf("migration %03d transactional = %t, want %t", migration.Version, migration.Transactional, wantTransactional)
		}
	}
}

func TestMigrationChecksumDetectsContentChanges(t *testing.T) {
	original := migrationChecksum(1, "example", "SELECT 1;", true)
	changed := migrationChecksum(1, "example", "SELECT 2;", true)
	windowsLineEndings := migrationChecksum(1, "example", "SELECT 1;\r\n", true)
	unixLineEndings := migrationChecksum(1, "example", "SELECT 1;\n", true)
	if original == changed {
		t.Fatal("checksum did not change with migration content")
	}
	if windowsLineEndings != unixLineEndings {
		t.Fatal("checksum must normalize CRLF to LF")
	}
}

func TestSplitSQLStatementsPreservesPostgresBlocks(t *testing.T) {
	source := `
-- preflight
DO $$
BEGIN
    PERFORM 1;
    RAISE NOTICE 'semicolon; inside';
END $$;
CREATE INDEX CONCURRENTLY idx_example ON example(id);
/* final comment */
SELECT "semi;colon" FROM example;
`
	statements := splitSQLStatements(source)
	if len(statements) != 3 {
		t.Fatalf("len(splitSQLStatements()) = %d, want 3: %#v", len(statements), statements)
	}
	if !strings.Contains(statements[0], "PERFORM 1;") || !strings.Contains(statements[0], "END $$") {
		t.Fatalf("DO block was split incorrectly: %q", statements[0])
	}
	if !strings.Contains(statements[1], "CREATE INDEX CONCURRENTLY") {
		t.Fatalf("second statement = %q", statements[1])
	}
}

func TestValidateAppliedRejectsDriftAndUnknownVersions(t *testing.T) {
	catalog := []Migration{{Version: 1, Name: "one", Checksum: "abc"}}
	valid := []AppliedMigration{{Version: 1, Name: "one", Checksum: "abc", AppliedAt: time.Now()}}
	if err := validateApplied(catalog, valid); err != nil {
		t.Fatalf("validateApplied(valid) error = %v", err)
	}
	if err := validateApplied(catalog, []AppliedMigration{{Version: 1, Name: "one", Checksum: "changed"}}); err == nil {
		t.Fatal("validateApplied accepted checksum drift")
	}
	if err := validateApplied(catalog, []AppliedMigration{{Version: 2, Name: "future", Checksum: "abc"}}); err == nil {
		t.Fatal("validateApplied accepted unknown migration")
	}
}

func TestConcurrentIndexPattern(t *testing.T) {
	matches := concurrentIndexPattern.FindStringSubmatch(`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_tx ON sales("clientTxId")`)
	if len(matches) != 2 || matches[1] != "idx_sales_tx" {
		t.Fatalf("concurrent index match = %#v", matches)
	}
	if concurrentIndexPattern.MatchString(`CREATE INDEX idx_normal ON sales(id)`) {
		t.Fatal("normal index must not match concurrent retry pattern")
	}
}

func TestNormalStartupContainsNoSchemaOrSeedMutations(t *testing.T) {
	checks := []struct {
		path      string
		forbidden []string
	}{
		{
			path: filepath.Join("..", "internal", "adapters", "repositories", "db.go"),
			forbidden: []string{
				"AutoMigrate(", "CREATE DATABASE", "CREATE EXTENSION", "ALTER TABLE", "DROP TABLE", "SeedAdmin(", "SeedProducts(",
			},
		},
		{
			path: filepath.Join("..", "cmd", "api", "main.go"),
			forbidden: []string{
				"InitMaterializedViews(", "REFRESH MATERIALIZED VIEW", "AutoMigrate(",
			},
		},
		{
			path: filepath.Join("..", "cmd", "seed", "main.go"),
			forbidden: []string{
				"DROP SCHEMA", "CASCADE; CREATE SCHEMA", "AutoMigrate(",
			},
		},
	}
	for _, check := range checks {
		body, err := os.ReadFile(check.path)
		if err != nil {
			t.Fatalf("ReadFile(%s) error = %v", check.path, err)
		}
		for _, forbidden := range check.forbidden {
			if strings.Contains(string(body), forbidden) {
				t.Errorf("%s still contains forbidden startup mutation %q", check.path, forbidden)
			}
		}
	}
}

func TestOperationalIndexesMigrationUsesPhysicalColumnsConcurrently(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	migration := catalog[10]
	if migration.Version != 11 || migration.Transactional {
		t.Fatalf("migration 011 = version %d transactional=%t", migration.Version, migration.Transactional)
	}
	for _, expected := range []string{
		"stock_movements(reference_id, reason)",
		"stock_movements(barcode, reason, date DESC)",
		"expenses(category, supplier_id, date DESC)",
		"audit_logs(module, employee_dni, created_at DESC)",
	} {
		if !strings.Contains(migration.Source, expected) {
			t.Errorf("migration 011 missing %q", expected)
		}
	}
	if count := strings.Count(migration.Source, "CREATE INDEX CONCURRENTLY IF NOT EXISTS"); count != 4 {
		t.Errorf("migration 011 concurrent index count = %d, want 4", count)
	}
}

func TestReceptionSnapshotMigrationUsesPhysicalColumnsConcurrently(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	migration := catalog[14]
	if migration.Version != 15 || migration.Transactional {
		t.Fatalf("migration 015 = version %d transactional=%t", migration.Version, migration.Transactional)
	}
	// Índices con su tabla y columnas físicas reales; si algún índice se
	// renombra o cambia de tabla, este test se rompe a propósito.
	for _, expected := range []string{
		`idx_clients_credit_debtors`,
		`ON clients ("currentCredit" DESC)`,
		`idx_sales_debt_pending_date`,
		`ON sales ("saleDate" DESC)`,
		`idx_expenses_pending_debts_date`,
		`ON expenses (date DESC)`,
		`idx_missing_items_pendiente_created`,
		`ON missing_items (created_at DESC)`,
		`idx_shrinkages_date`,
		`ON shrinkages (date DESC)`,
		`idx_price_logs_created_at`,
		`ON price_logs (created_at DESC)`,
	} {
		if !strings.Contains(migration.Source, expected) {
			t.Errorf("migration 015 missing %q", expected)
		}
	}
	if count := strings.Count(migration.Source, "CREATE INDEX CONCURRENTLY IF NOT EXISTS"); count != 6 {
		t.Errorf("migration 015 concurrent index count = %d, want 6", count)
	}
	// Columnas de porcentajes de recepción sobre stock_movements: tienen que
	// aparecer con ADD COLUMN IF NOT EXISTS y su COMMENT explicativo.
	for _, column := range []string{"discount_pct", "iva_pct", "icui_pct", "ibua_pct"} {
		addColumn := "ADD COLUMN IF NOT EXISTS " + column + " NUMERIC(6,3)"
		if !strings.Contains(migration.Source, addColumn) {
			t.Errorf("migration 015 missing %q", addColumn)
		}
		commentOn := "COMMENT ON COLUMN stock_movements." + column
		if !strings.Contains(migration.Source, commentOn) {
			t.Errorf("migration 015 missing %q", commentOn)
		}
	}
	if count := strings.Count(migration.Source, "NUMERIC(6,3) NULL;"); count != 4 {
		t.Errorf("migration 015 NUMERIC(6,3) NULL column count = %d, want 4", count)
	}
	if count := strings.Count(migration.Source, "ALTER TABLE stock_movements"); count != 4 {
		t.Errorf("migration 015 ALTER TABLE stock_movements count = %d, want 4", count)
	}
	// Blindaje contra mutación de datos: la migración es puramente DDL.
	for _, forbidden := range []string{"UPDATE stock_movements", "DELETE FROM ", "INSERT INTO "} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 015 must not mutate data, found %q", forbidden)
		}
	}
}

func TestLabelGeneratorAndCashDrawerMigrationIsTransactionalDDL(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	migration := catalog[15]
	if migration.Version != 16 || !migration.Transactional {
		t.Fatalf("migration 016 = version %d transactional=%t, want version=16 transactional=true", migration.Version, migration.Transactional)
	}
	// Las cinco tablas nuevas deben declararse de forma idempotente.
	for _, table := range []string{
		"label_size_templates",
		"label_printer_profiles",
		"label_codes",
		"label_print_jobs",
		"cash_drawer_opens",
	} {
		expected := "CREATE TABLE IF NOT EXISTS " + table
		if !strings.Contains(migration.Source, expected) {
			t.Errorf("migration 016 missing %q", expected)
		}
	}
	// La regla "no abrir sin venta salvo admin" tiene que vivir en la BD,
	// no sólo en el handler Go: si alguien renombra o elimina este CHECK
	// esta prueba falla a propósito.
	for _, constraint := range []string{
		"ck_cash_drawer_opens_sale_or_admin",
		"ck_cash_drawer_opens_override_requires_authorizer",
	} {
		if !strings.Contains(migration.Source, constraint) {
			t.Errorf("migration 016 debe declarar el CONSTRAINT %q", constraint)
		}
	}
	// La migración es puramente DDL: nunca debe mutar datos de negocio.
	for _, forbidden := range []string{"UPDATE ", "DELETE FROM ", "INSERT INTO "} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 016 debe ser puramente DDL, encontró %q", forbidden)
		}
	}
	// Al ser transaccional NO puede usar CREATE INDEX CONCURRENTLY: Postgres
	// prohíbe CONCURRENTLY dentro de una transacción y además rompería el
	// contrato declarado en catalog.go (016 no está en la lista de excepciones).
	// Reusamos concurrentIndexPattern (regex multilínea de runner.go) para
	// matchear sólo sentencias ejecutables, no la palabra en comentarios --.
	if concurrentIndexPattern.MatchString(migration.Source) {
		t.Error("migration 016 es transaccional: contiene una sentencia CREATE INDEX CONCURRENTLY")
	}
	// El `code` persistente y la regla de impresión también quedan amarrados:
	// el PK de label_codes debe ser el `code` (lo que se imprime), no un id
	// autoincremental, y debe haber un índice parcial por producto.
	for _, expected := range []string{
		"code              VARCHAR(64)   PRIMARY KEY",
		"ix_label_codes_product",
		"print_count",
	} {
		if !strings.Contains(migration.Source, expected) {
			t.Errorf("migration 016 missing %q", expected)
		}
	}
}

func TestPackageBarcodeAliasesMigrationIsTransactionalDDL(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	migration := catalog[16]
	if migration.Version != 17 || !migration.Transactional {
		t.Fatalf("migration 017 = version %d transactional=%t, want version=17 transactional=true", migration.Version, migration.Transactional)
	}
	// La única tabla nueva debe declararse de forma idempotente.
	if !strings.Contains(migration.Source, "CREATE TABLE IF NOT EXISTS package_barcode_aliases") {
		t.Error("migration 017 missing CREATE TABLE IF NOT EXISTS package_barcode_aliases")
	}
	// Unicidad global del package_code: sin esto, dos productos distintos
	// podrían reclamar el mismo código y la validación cruzada quedaría
	// expuesta a una condición de carrera.
	if !strings.Contains(migration.Source, "uq_package_barcode_aliases_code") {
		t.Error("migration 017 debe declarar UNIQUE sobre package_code (uq_package_barcode_aliases_code).")
	}
	if !strings.Contains(migration.Source, "UNIQUE (package_code)") {
		t.Error("migration 017 debe declarar UNIQUE (package_code).")
	}
	// FK dura al producto para que el alias no quede huérfano cuando se
	// borra físicamente el producto.
	if !strings.Contains(migration.Source, "REFERENCES products(barcode) ON DELETE CASCADE") {
		t.Error("migration 017 debe tener FK a products(barcode) ON DELETE CASCADE.")
	}
	// units_per_pack >= 1: no tiene sentido un paquete que no trae nada.
	if !strings.Contains(migration.Source, "units_per_pack") || !strings.Contains(migration.Source, "CHECK (units_per_pack >= 1)") {
		t.Error("migration 017 debe exigir units_per_pack >= 1.")
	}
	// Al ser transaccional NO puede usar CREATE INDEX CONCURRENTLY.
	if concurrentIndexPattern.MatchString(migration.Source) {
		t.Error("migration 017 es transaccional: contiene una sentencia CREATE INDEX CONCURRENTLY")
	}
	// Es puramente DDL: nunca debe mutar datos de negocio.
	for _, forbidden := range []string{"UPDATE ", "DELETE FROM ", "INSERT INTO "} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 017 debe ser puramente DDL, encontró %q", forbidden)
		}
	}
	// Blindaje semántico: el documento del archivo DEBE explicar por qué
	// NO se tocan products.alternateCodes. Esto es un contrato: si alguien
	// renombra el archivo o reemplaza su contenido sin la justificación,
	// debe fallar la prueba para que lo revise un humano.
	if !strings.Contains(migration.Source, "alternateCodes") {
		t.Error("migration 017 debe documentar en comentarios por qué NO se usa products.alternateCodes.")
	}
}

func TestClosureIdempotencyMigrationIsConcurrentPartialUnique(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	migration := catalog[17]
	if migration.Version != 18 || migration.Transactional {
		t.Fatalf("migration 018 = version %d transactional=%t, want version=18 transactional=false", migration.Version, migration.Transactional)
	}
	// La columna que recibe el UUID del frontend debe declararse con IF NOT
	// EXISTS: la migración puede reintentar tras un fallo del CREATE INDEX
	// posterior sin reventar en el ADD COLUMN.
	if !strings.Contains(migration.Source, "ALTER TABLE cashier_closures") {
		t.Error("migration 018 debe ALTERAR cashier_closures")
	}
	if !strings.Contains(migration.Source, "ADD COLUMN IF NOT EXISTS client_tx_id VARCHAR(64) NULL") {
		t.Error("migration 018 debe declarar `ADD COLUMN IF NOT EXISTS client_tx_id VARCHAR(64) NULL`")
	}
	// Mismo patrón que la 009 para sales("clientTxId"): índice único parcial
	// con `IS NOT NULL AND <> ''`, en autocommit vía CONCURRENTLY. Si alguien
	// quita CONCURRENTLY o quita el parcial, este test grita.
	if !strings.Contains(migration.Source, "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_cashier_closures_client_tx_id") {
		t.Error("migration 018 debe crear ux_cashier_closures_client_tx_id con CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS")
	}
	if !strings.Contains(migration.Source, "ON cashier_closures (client_tx_id)") {
		t.Error("migration 018 debe anclar el índice en cashier_closures(client_tx_id)")
	}
	if !strings.Contains(migration.Source, "WHERE client_tx_id IS NOT NULL AND client_tx_id <> ''") {
		t.Error("migration 018 debe filtrar `client_tx_id IS NOT NULL AND client_tx_id <> ''` (mismo contrato que idx_sales_client_tx_id_unique)")
	}
	// El runner matchea solo sentencias ejecutables (no comentarios --), así
	// que esto confirma que la 018 contiene UNA sentencia CONCURRENTLY y por
	// eso NO puede ser transaccional.
	if !concurrentIndexPattern.MatchString(migration.Source) {
		t.Error("migration 018 debe contener una sentencia CREATE INDEX CONCURRENTLY ejecutable (no sólo comentarios)")
	}
	// Blindaje semántico: la 018 no debe mutar datos de negocio. Las filas
	// históricas quedan con client_tx_id NULL a propósito; no se backfillea.
	for _, forbidden := range []string{"UPDATE cashier_closures", "DELETE FROM ", "INSERT INTO "} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 018 debe ser puramente DDL, encontró %q", forbidden)
		}
	}
	// Documentación obligatoria: el archivo tiene que explicar por qué el
	// índice es PARCIAL (no hay backfill) y referenciar el patrón ya probado
	// en producción (la 009). Si alguien reemplaza el contenido sin esa
	// justificación, el test obliga a revisarlo.
	for _, mustExplain := range []string{"parcial", "009", "localStorage"} {
		if !strings.Contains(migration.Source, mustExplain) {
			t.Errorf("migration 018 debe documentar %q en comentarios", mustExplain)
		}
	}
	// COMMENT ON COLUMN y COMMENT ON INDEX dejan la razón persistida en la
	// propia BD, útil para auditorías posteriores con pg_dump --schema-only.
	if !strings.Contains(migration.Source, "COMMENT ON COLUMN cashier_closures.client_tx_id") {
		t.Error("migration 018 debe declarar COMMENT ON COLUMN cashier_closures.client_tx_id")
	}
	if !strings.Contains(migration.Source, "COMMENT ON INDEX ux_cashier_closures_client_tx_id") {
		t.Error("migration 018 debe declarar COMMENT ON INDEX ux_cashier_closures_client_tx_id")
	}
}

func TestLoansModuleMigrationIsTransactionalDDL(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	migration := catalog[18]
	if migration.Version != 19 || !migration.Transactional {
		t.Fatalf("migration 019 = version %d transactional=%t, want version=19 transactional=true", migration.Version, migration.Transactional)
	}
	// Las tres tablas nuevas deben declararse de forma idempotente.
	for _, table := range []string{
		"loans",
		"loan_installments",
		"loan_expenses",
	} {
		expected := "CREATE TABLE IF NOT EXISTS " + table
		if !strings.Contains(migration.Source, expected) {
			t.Errorf("migration 019 missing %q", expected)
		}
	}
	// Dinero en NUMERIC(14,2): si alguien reintroduce float o decimal(10,2)
	// este test falla. El techo 14,2 cubre préstamos del orden de billones
	// de COP sin desbordar los pagos acumulados.
	for _, column := range []string{
		"principal_amount     NUMERIC(14,2)",
		"total_payable        NUMERIC(14,2)",
		"remaining_balance    NUMERIC(14,2)",
		"principal_due           NUMERIC(14,2)",
		"interest_due            NUMERIC(14,2)",
		"paid_amount             NUMERIC(14,2)",
		"amount_used    NUMERIC(14,2)",
	} {
		if !strings.Contains(migration.Source, column) {
			t.Errorf("migration 019 debe declarar %q", column)
		}
	}
	for _, forbidden := range []string{" FLOAT", " float", "DOUBLE PRECISION", "double precision", "REAL,", "real,"} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 019 debe usar NUMERIC para dinero, encontró %q", forbidden)
		}
	}
	// Estados con CHECK (no enums, no triggers): la BD rechaza valores
	// desconocidos aunque un handler nuevo se olvide de validarlos.
	// FRENCH queda fuera del CHECK a propósito: NO forma parte del
	// contrato del módulo (ver loan_schedule.go). El servicio Go lo
	// rechaza con ErrInvalidInterestMode; la BD es al menos tan
	// estricta. Si una futura migración lo habilita, debe ampliar este
	// CHECK y actualizar este test.
	for _, check := range []string{
		"CHECK (interest_mode IN ('NONE', 'SIMPLE'))",
		"CHECK (payment_frequency IN ('WEEKLY', 'BIWEEKLY', 'MONTHLY'))",
		"CHECK (status IN ('ACTIVE', 'PAID', 'DEFAULTED', 'CANCELLED'))",
		"CHECK (status IN ('PENDING', 'PARTIAL', 'PAID', 'LATE'))",
	} {
		if !strings.Contains(migration.Source, check) {
			t.Errorf("migration 019 debe declarar %q", check)
		}
	}
	// Blindaje explícito contra re-introducir FRENCH como valor admitido:
	// FRENCH no forma parte del contrato (ver loan_schedule.go, enum
	// InterestMode). El día que una migración 020+ lo habilite, debe
	// borrar este guardián a propósito.
	if strings.Contains(migration.Source, "'FRENCH'") {
		t.Error("migration 019 no debe admitir 'FRENCH' en los CHECK: no forma parte del contrato")
	}
	// Invariantes de dominio: principal positivo, cuota con total positivo,
	// paid_amount dentro de la cuota (con tolerancia de redondeo), fecha
	// de primera cuota >= start_date, interés requiere tasa, saldo del
	// préstamo nunca negativo ni mayor al total comprometido.
	for _, constraint := range []string{
		"CHECK (principal_amount > 0)",
		"CHECK (interest_rate_pct >= 0)",
		"CHECK (term_count >= 1 AND term_count <= 600)",
		"ck_loans_first_payment_after_start",
		"ck_loans_interest_requires_rate",
		"ck_loans_remaining_within_total",
		"CHECK (total_payable >= 0)",
		"CHECK (remaining_balance >= 0)",
		"CHECK (remaining_balance <= total_payable)",
		"ck_loan_installment_total_positive",
		"ck_loan_installment_paid_within_total",
		"ck_loan_installment_paid_at_requires_paid",
		"uq_loan_installment_number UNIQUE (loan_id, number)",
		"CHECK (amount_used > 0)",
	} {
		if !strings.Contains(migration.Source, constraint) {
			t.Errorf("migration 019 debe declarar la invariante %q", constraint)
		}
	}
	// Timestamps obligatorios: created_at NOT NULL en las tres tablas y
	// updated_at en loans/loan_installments (loan_expenses es append-only).
	for _, column := range []string{
		"created_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW()",
		"updated_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW()",
		"created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()",
		"updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()",
		"created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()",
	} {
		if !strings.Contains(migration.Source, column) {
			t.Errorf("migration 019 debe declarar timestamp %q", column)
		}
	}
	// Cascada desde loans hacia installments y loan_expenses: borrar un
	// préstamo arrastra su cronograma y su libro de usos.
	if count := strings.Count(migration.Source, "REFERENCES loans(id) ON DELETE CASCADE"); count != 2 {
		t.Errorf("migration 019 debe cascada desde loans en 2 tablas (installments, expenses), encontró %d", count)
	}
	// Convivencia con la 016 (patrón de FK soft para auditoría): expense_id
	// y settlement_expense_id son INTEGER sin REFERENCES para preservar el
	// audit si el expense se purga.
	for _, forbidden := range []string{
		"settlement_expense_id INTEGER REFERENCES expenses",
		"settlement_expense_id   INTEGER       REFERENCES expenses",
		"expense_id     INTEGER       REFERENCES expenses",
		"expense_id     INTEGER REFERENCES expenses",
	} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 019 no debe amarrar FK dura a expenses (soft delete), encontró %q", forbidden)
		}
	}
	// Al ser transaccional NO puede usar CREATE INDEX CONCURRENTLY.
	if concurrentIndexPattern.MatchString(migration.Source) {
		t.Error("migration 019 es transaccional: contiene una sentencia CREATE INDEX CONCURRENTLY")
	}
	// Es puramente DDL: nunca debe mutar datos de negocio. Ni backfill de
	// expenses.PRESTAMO legacy ni semillas de ningún tipo. Nota: SELECT
	// ... FOR UPDATE es un lock de lectura y aparece a propósito en los
	// comentarios del archivo describiendo cómo valida el servicio Go la
	// invariante de principal; por eso el guardián es específico por
	// tabla (UPDATE <tabla>) en vez de un UPDATE suelto.
	for _, forbidden := range []string{
		"UPDATE loans",
		"UPDATE loan_installments",
		"UPDATE loan_expenses",
		"UPDATE expenses",
		"DELETE FROM ",
		"INSERT INTO ",
	} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 019 debe ser puramente DDL, encontró %q", forbidden)
		}
	}
	// Documentación obligatoria: el archivo tiene que explicar por qué NO
	// se mezcla con expenses.PRESTAMO legacy, por qué no entra en
	// schemaModels(), por qué los FK a expenses son soft, por qué SIMPLE
	// significa interés TOTAL FLAT (no anual) y por qué total_payable y
	// remaining_balance viven como columnas con CHECK. Blindaje semántico:
	// si alguien reemplaza el contenido sin esa justificación, la prueba
	// obliga a revisarlo humanamente.
	for _, mustExplain := range []string{
		"PRESTAMO",
		"schemaModels()",
		"soft delete",
		"NUMERIC(14,2)",
		"America/Bogota",
		"flat",
		"total_payable",
		"remaining_balance",
	} {
		if !strings.Contains(migration.Source, mustExplain) {
			t.Errorf("migration 019 debe documentar %q en comentarios", mustExplain)
		}
	}
	// COMMENT ON TABLE para que pg_dump --schema-only lleve la razón
	// persistida con la BD.
	for _, comment := range []string{
		"COMMENT ON TABLE loans",
		"COMMENT ON TABLE loan_installments",
		"COMMENT ON TABLE loan_expenses",
	} {
		if !strings.Contains(migration.Source, comment) {
			t.Errorf("migration 019 debe declarar %q", comment)
		}
	}
}

func TestMigration020ExcludesLoanFundedExpensesFromMonthlyView(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	var migration *Migration
	for i := range catalog {
		if catalog[i].Version == 20 {
			migration = &catalog[i]
			break
		}
	}
	if migration == nil {
		t.Fatal("migration 020 no está en el catálogo")
	}
	if !migration.Transactional {
		t.Fatal("migration 020 debe ser transaccional")
	}
	for _, required := range []string{
		"CREATE MATERIALIZED VIEW mv_dashboard_stats_monthly",
		`UPPER(COALESCE("paymentSource", '')) NOT IN ('PRESTAMO', 'PREST.')`,
		"CREATE UNIQUE INDEX idx_mv_dashboard_month_year",
	} {
		if !strings.Contains(migration.Source, required) {
			t.Errorf("migration 020 debe contener %q", required)
		}
	}
	if strings.Contains(strings.ToUpper(migration.Source), "UPDATE EXPENSES") ||
		strings.Contains(strings.ToUpper(migration.Source), "DELETE FROM EXPENSES") {
		t.Fatal("migration 020 no debe mutar egresos históricos")
	}
}

func TestMigration021LoansFrenchModeIsTransactionalDDL(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	var migration *Migration
	for i := range catalog {
		if catalog[i].Version == 21 {
			migration = &catalog[i]
			break
		}
	}
	if migration == nil {
		t.Fatal("migration 021 no está en el catálogo")
	}
	if !migration.Transactional {
		t.Fatal("migration 021 debe ser transaccional: no usa CREATE INDEX CONCURRENTLY")
	}
	// Nuevas columnas en loans con el tipo exacto. Si alguien cambia el
	// tipo (ej. float, decimal(10,2)) esta prueba lo detecta antes de que
	// la BD lo acepte en silencio.
	for _, column := range []string{
		"annual_effective_rate_pct NUMERIC(9,6)",
		"monthly_insurance_amount  NUMERIC(14,2)",
		"fga_total_amount          NUMERIC(14,2)",
		"monthly_fga_amount        NUMERIC(14,2)",
		"base_installment_amount   NUMERIC(14,2)",
	} {
		expected := "ADD COLUMN IF NOT EXISTS " + column
		if !strings.Contains(migration.Source, expected) {
			t.Errorf("migration 021 debe declarar %q", expected)
		}
	}
	// Nuevas columnas en loan_installments.
	for _, column := range []string{
		"insurance_due NUMERIC(14,2)",
		"fga_due       NUMERIC(14,2)",
	} {
		expected := "ADD COLUMN IF NOT EXISTS " + column
		if !strings.Contains(migration.Source, expected) {
			t.Errorf("migration 021 debe declarar %q", expected)
		}
	}
	// Blindaje tipo-de-dinero: ningún FLOAT ni DOUBLE PRECISION.
	for _, forbidden := range []string{" FLOAT", " float", "DOUBLE PRECISION", "double precision", " REAL,", " real,"} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 021 debe usar NUMERIC para dinero, encontró %q", forbidden)
		}
	}
	// FRENCH ahora admitido en el CHECK de interest_mode. La 019 lo
	// bloquea explícitamente; la 021 lo habilita.
	if !strings.Contains(migration.Source, "CHECK (interest_mode IN ('NONE', 'SIMPLE', 'FRENCH'))") {
		t.Error("migration 021 debe recrear el CHECK de interest_mode incluyendo 'FRENCH'")
	}
	// Cada modo amarrado a la columna de tasa que efectivamente usa.
	for _, required := range []string{
		"ck_loans_interest_requires_rate",
		"interest_mode = 'NONE'",
		"interest_mode = 'SIMPLE' AND interest_rate_pct > 0",
		"interest_mode = 'FRENCH' AND annual_effective_rate_pct > 0",
	} {
		if !strings.Contains(migration.Source, required) {
			t.Errorf("migration 021 debe reconstruir ck_loans_interest_requires_rate con %q", required)
		}
	}
	// Techos y pisos de cordura declarados a nivel BD.
	for _, constraint := range []string{
		"ck_loans_annual_effective_rate_range",
		"CHECK (annual_effective_rate_pct >= 0 AND annual_effective_rate_pct <= 1000)",
		"ck_loans_monthly_insurance_non_negative",
		"CHECK (monthly_insurance_amount >= 0)",
		"ck_loans_fga_total_non_negative",
		"CHECK (fga_total_amount >= 0)",
		"ck_loans_monthly_fga_non_negative",
		"CHECK (monthly_fga_amount >= 0)",
		"ck_loans_base_installment_non_negative",
		"CHECK (base_installment_amount >= 0)",
		"ck_loan_installment_insurance_non_negative",
		"CHECK (insurance_due >= 0)",
		"ck_loan_installment_fga_non_negative",
		"CHECK (fga_due >= 0)",
	} {
		if !strings.Contains(migration.Source, constraint) {
			t.Errorf("migration 021 debe declarar la invariante %q", constraint)
		}
	}
	// El CHECK ampliado de paid_amount debe incluir seguro + FGA. Si
	// alguien lo recorta a la versión 019, un pago FRENCH completo
	// rompería la restricción.
	if !strings.Contains(migration.Source, "paid_amount <= principal_due + interest_due + insurance_due + fga_due + 0.01") {
		t.Error("migration 021 debe ampliar ck_loan_installment_paid_within_total con insurance_due + fga_due")
	}
	// Defaults seguros: NOT NULL DEFAULT 0 para que las filas existentes
	// NONE/SIMPLE queden en 0 sin que el handler las toque.
	if count := strings.Count(migration.Source, "NOT NULL DEFAULT 0"); count < 7 {
		t.Errorf("migration 021 debe declarar NOT NULL DEFAULT 0 en las 7 columnas nuevas, encontró %d", count)
	}
	// Idempotencia: ADD COLUMN IF NOT EXISTS para las 7 columnas nuevas.
	if count := strings.Count(migration.Source, "ADD COLUMN IF NOT EXISTS "); count < 7 {
		t.Errorf("migration 021 debe ser idempotente con ADD COLUMN IF NOT EXISTS en las 7 columnas (encontró %d)", count)
	}
	// NO puede usar CREATE INDEX CONCURRENTLY: es transaccional. El
	// regex del runner matchea sólo sentencias ejecutables, no la
	// palabra en comentarios "--".
	if concurrentIndexPattern.MatchString(migration.Source) {
		t.Error("migration 021 es transaccional: contiene una sentencia CREATE INDEX CONCURRENTLY ejecutable")
	}
	// Puramente DDL: la 021 NO recalcula los préstamos NONE/SIMPLE
	// existentes, no backfillea EA desde interest_rate_pct, no toca
	// cuotas. Cualquier UPDATE/DELETE/INSERT en estas tablas es un bug.
	for _, forbidden := range []string{
		"UPDATE loans",
		"UPDATE loan_installments",
		"UPDATE loan_expenses",
		"UPDATE expenses",
		"DELETE FROM ",
		"INSERT INTO ",
	} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 021 debe ser puramente DDL, encontró %q", forbidden)
		}
	}
	// COMMENT ON COLUMN para las 5 columnas nuevas en loans + las 2 en
	// loan_installments. pg_dump --schema-only conserva la justificación
	// con la BD.
	for _, comment := range []string{
		"COMMENT ON COLUMN loans.annual_effective_rate_pct",
		"COMMENT ON COLUMN loans.monthly_insurance_amount",
		"COMMENT ON COLUMN loans.fga_total_amount",
		"COMMENT ON COLUMN loans.monthly_fga_amount",
		"COMMENT ON COLUMN loans.base_installment_amount",
		"COMMENT ON COLUMN loan_installments.insurance_due",
		"COMMENT ON COLUMN loan_installments.fga_due",
	} {
		if !strings.Contains(migration.Source, comment) {
			t.Errorf("migration 021 debe declarar %q", comment)
		}
	}
	// Documentación obligatoria: el archivo debe explicar por qué FRENCH
	// se añade como modo nuevo (no se reinterpreta SIMPLE), por qué el
	// FGA ingresado es TOTAL y se difiere, por qué el seguro es MENSUAL
	// fijo, qué conversión EA→MV usa el servicio, y por qué los
	// préstamos NONE/SIMPLE no se tocan.
	for _, mustExplain := range []string{
		"FRENCH",
		"Sistema Francés",
		"NONE/SIMPLE",
		"FGA",
		"diferido",
		"MENSUAL",
		"TOTAL",
		"(1 + annual_effective_rate_pct/100)^(1/12) - 1",
		"NUMERIC(14,2)",
		"no reinterpreta",
	} {
		if !strings.Contains(migration.Source, mustExplain) {
			t.Errorf("migration 021 debe documentar %q", mustExplain)
		}
	}
	// La 021 NO debe reescribir el guardián de la 019: la 019 sigue
	// bloqueando 'FRENCH' en el CHECK heredado, y la 021 instala el
	// CHECK nuevo que lo admite. Si alguien ampliara la 019, su
	// checksum cambiaría y validateApplied abortaría el arranque.
}

func TestMigration022ReversibleLoanExpensePayments(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	migration := catalog[21]
	if migration.Version != 22 || !migration.Transactional {
		t.Fatalf("migration 022 = version %d transactional=%t", migration.Version, migration.Transactional)
	}
	for _, required := range []string{
		"source_expense_id", "source_status_before", "source_paid_before",
		"source_remaining_before", "reversed_at", "reversed_by_dni",
		"idx_loan_expenses_active_by_loan", "WHERE reversed_at IS NULL",
	} {
		if !strings.Contains(migration.Source, required) {
			t.Errorf("migration 022 missing %q", required)
		}
	}
	for _, forbidden := range []string{"UPDATE loan_expenses", "UPDATE expenses", "DELETE FROM ", "INSERT INTO "} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 022 no debe adivinar/backfillear datos históricos: %q", forbidden)
		}
	}
	if concurrentIndexPattern.MatchString(migration.Source) {
		t.Error("migration 022 es transaccional y no puede usar CONCURRENTLY")
	}
}


func TestMigration023LoansBankMetadataIsTransactionalDDL(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	var migration *Migration
	for i := range catalog {
		if catalog[i].Version == 23 {
			migration = &catalog[i]
			break
		}
	}
	if migration == nil {
		t.Fatal("migration 023 no está en el catálogo")
	}
	if !migration.Transactional {
		t.Fatal("migration 023 debe ser transaccional: no usa CREATE INDEX CONCURRENTLY")
	}

	// Columnas nuevas con tipo exacto. Si alguien cambia el tipo (ej.
	// float, decimal(10,2), VARCHAR demasiado corto), este test lo
	// detecta antes de que la BD lo acepte en silencio.
	for _, column := range []string{
		"credit_number                    VARCHAR(64)",
		"loan_type                        VARCHAR(16)",
		"holder_name                      VARCHAR(160)",
		"holder_dni                       VARCHAR(32)",
		"currency                         VARCHAR(8)",
		"rate_type                        VARCHAR(16)",
		"auto_debit                       BOOLEAN",
		"maturity_date                    DATE",
		"late_annual_effective_rate_pct   NUMERIC(9,6)",
		"net_disbursement_amount          NUMERIC(14,2)",
		"fga_iva_amount                   NUMERIC(14,2)",
		"fga_gmf_amount                   NUMERIC(14,2)",
		"bank_balance_amount              NUMERIC(14,2)",
		"bank_balance_as_of               TIMESTAMPTZ",
		"bank_paid_amount                 NUMERIC(14,2)",
		"official_next_installment_amount NUMERIC(14,2)",
		"official_next_installment_date   DATE",
	} {
		expected := "ADD COLUMN IF NOT EXISTS " + column
		if !strings.Contains(migration.Source, expected) {
			t.Errorf("migration 023 debe declarar %q", expected)
		}
	}

	// Idempotencia: 17 columnas nuevas, cada una con ADD COLUMN IF NOT EXISTS.
	if count := strings.Count(migration.Source, "ADD COLUMN IF NOT EXISTS "); count < 17 {
		t.Errorf("migration 023 debe tener 17 ADD COLUMN IF NOT EXISTS, encontró %d", count)
	}

	// Blindaje tipo-de-dinero: ningún FLOAT ni DOUBLE PRECISION ni REAL
	// en las columnas monetarias nuevas.
	for _, forbidden := range []string{" FLOAT", " float", "DOUBLE PRECISION", "double precision", " REAL,", " real,"} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 023 debe usar NUMERIC para dinero, encontró %q", forbidden)
		}
	}

	// Enums cerrados a nivel BD. Si alguien introduce un tipo nuevo sin
	// migración o cambia el repertorio (ej. VEHÍCULO con tilde, EUR), el
	// test cae.
	for _, check := range []string{
		"ck_loans_loan_type",
		"CHECK (loan_type IN ('CONSUMO', 'HIPOTECARIO', 'LIBRANZA', 'COMERCIAL', 'VEHICULO', 'OTRO'))",
		"ck_loans_rate_type",
		"CHECK (rate_type IN ('FIJO', 'VARIABLE'))",
		"ck_loans_currency_known",
		"CHECK (currency IN ('COP', 'USD'))",
	} {
		if !strings.Contains(migration.Source, check) {
			t.Errorf("migration 023 debe declarar %q", check)
		}
	}

	// Invariantes de dominio: tasa de mora en rango, vencimiento >= inicio,
	// desglose del FGA no negativo, desembolso neto no negativo, snapshot
	// bancario coherente, cuota oficial coherente, no negativos.
	for _, constraint := range []string{
		"ck_loans_late_rate_range",
		"CHECK (late_annual_effective_rate_pct >= 0 AND late_annual_effective_rate_pct <= 1000)",
		"ck_loans_maturity_after_start",
		"CHECK (maturity_date IS NULL OR maturity_date >= start_date)",
		"ck_loans_fga_breakdown_non_negative",
		"CHECK (fga_iva_amount >= 0 AND fga_gmf_amount >= 0)",
		"ck_loans_net_disbursement_non_negative",
		"CHECK (net_disbursement_amount IS NULL OR net_disbursement_amount >= 0)",
		"ck_loans_bank_snapshot_coherent",
		"ck_loans_bank_paid_requires_snapshot",
		"ck_loans_bank_balance_non_negative",
		"ck_loans_bank_paid_non_negative",
		"ck_loans_official_next_coherent",
		"ck_loans_official_installment_non_negative",
	} {
		if !strings.Contains(migration.Source, constraint) {
			t.Errorf("migration 023 debe declarar la invariante %q", constraint)
		}
	}

	// Snapshot bancario atado: ambos campos NULL o ambos NOT NULL. Si
	// alguien suaviza la condición, un snapshot a medias entraría a la
	// BD y la UI mostraría "saldo sin fecha" (ruido).
	if !strings.Contains(
		migration.Source,
		"(bank_balance_amount IS NULL AND bank_balance_as_of IS NULL)",
	) {
		t.Error("migration 023 debe exigir que bank_balance_amount y bank_balance_as_of sean ambos NULL o ambos NOT NULL")
	}
	if !strings.Contains(
		migration.Source,
		"(bank_balance_amount IS NOT NULL AND bank_balance_as_of IS NOT NULL)",
	) {
		t.Error("migration 023 debe exigir que bank_balance_amount y bank_balance_as_of sean ambos NULL o ambos NOT NULL")
	}
	// Cuota oficial atada: monto y fecha van juntos.
	if !strings.Contains(
		migration.Source,
		"(official_next_installment_amount IS NULL AND official_next_installment_date IS NULL)",
	) {
		t.Error("migration 023 debe exigir que la cuota oficial y su fecha sean ambas NULL o ambas NOT NULL")
	}
	if !strings.Contains(
		migration.Source,
		"(official_next_installment_amount IS NOT NULL AND official_next_installment_date IS NOT NULL)",
	) {
		t.Error("migration 023 debe exigir que la cuota oficial y su fecha sean ambas NULL o ambas NOT NULL")
	}

	// Defaults seguros: 'OTRO'/'COP'/'FIJO'/FALSE para los enums y el
	// boolean; NOT NULL DEFAULT 0 para las monetarias no nullable
	// (late_annual_effective_rate_pct, fga_iva_amount, fga_gmf_amount).
	// Las monetarias "snapshot" y "cuota oficial" quedan NULL por
	// diseño (no backfill).
	for _, def := range []string{
		"NOT NULL DEFAULT 'OTRO'",
		"NOT NULL DEFAULT 'COP'",
		"NOT NULL DEFAULT 'FIJO'",
		"NOT NULL DEFAULT FALSE",
		"NOT NULL DEFAULT 0",
	} {
		if !strings.Contains(migration.Source, def) {
			t.Errorf("migration 023 debe declarar default seguro %q", def)
		}
	}

	// Índice parcial sobre credit_number: justificado (alta cardinalidad,
	// búsqueda realista desde administración). No UNIQUE a propósito.
	if !strings.Contains(migration.Source, "CREATE INDEX IF NOT EXISTS ix_loans_credit_number") {
		t.Error("migration 023 debe crear ix_loans_credit_number con CREATE INDEX IF NOT EXISTS")
	}
	if !strings.Contains(migration.Source, "WHERE credit_number IS NOT NULL") {
		t.Error("migration 023 debe hacer el índice de credit_number parcial (WHERE credit_number IS NOT NULL)")
	}
	// NO debe ser UNIQUE a nivel BD: la unicidad vive en el handler.
	if strings.Contains(migration.Source, "UNIQUE INDEX IF NOT EXISTS ix_loans_credit_number") ||
		strings.Contains(migration.Source, "UNIQUE INDEX ix_loans_credit_number") {
		t.Error("migration 023 no debe hacer credit_number UNIQUE a nivel BD (la validación vive en el handler)")
	}

	// Al ser transaccional NO puede usar CREATE INDEX CONCURRENTLY.
	if concurrentIndexPattern.MatchString(migration.Source) {
		t.Error("migration 023 es transaccional: contiene una sentencia CREATE INDEX CONCURRENTLY ejecutable")
	}

	// Puramente DDL: NO backfill, NO reinterpretación. Los préstamos
	// heredados quedan con defaults seguros y campos opcionales en NULL.
	for _, forbidden := range []string{
		"UPDATE loans",
		"UPDATE loan_installments",
		"UPDATE loan_expenses",
		"UPDATE expenses",
		"DELETE FROM ",
		"INSERT INTO ",
	} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 023 debe ser puramente DDL, encontró %q", forbidden)
		}
	}

	// COMMENT ON COLUMN para las 17 columnas nuevas. pg_dump --schema-only
	// conserva la justificación con la BD.
	for _, comment := range []string{
		"COMMENT ON COLUMN loans.credit_number",
		"COMMENT ON COLUMN loans.loan_type",
		"COMMENT ON COLUMN loans.holder_name",
		"COMMENT ON COLUMN loans.holder_dni",
		"COMMENT ON COLUMN loans.currency",
		"COMMENT ON COLUMN loans.rate_type",
		"COMMENT ON COLUMN loans.auto_debit",
		"COMMENT ON COLUMN loans.maturity_date",
		"COMMENT ON COLUMN loans.late_annual_effective_rate_pct",
		"COMMENT ON COLUMN loans.net_disbursement_amount",
		"COMMENT ON COLUMN loans.fga_iva_amount",
		"COMMENT ON COLUMN loans.fga_gmf_amount",
		"COMMENT ON COLUMN loans.bank_balance_amount",
		"COMMENT ON COLUMN loans.bank_balance_as_of",
		"COMMENT ON COLUMN loans.bank_paid_amount",
		"COMMENT ON COLUMN loans.official_next_installment_amount",
		"COMMENT ON COLUMN loans.official_next_installment_date",
	} {
		if !strings.Contains(migration.Source, comment) {
			t.Errorf("migration 023 debe declarar %q", comment)
		}
	}

	// Documentación obligatoria: el archivo debe explicar la separación
	// semántica entre metadata editable y snapshot del banco, por qué no
	// se concilia automáticamente, por qué loan_type es ASCII sin tilde,
	// y por qué no se backfillea.
	for _, mustExplain := range []string{
		"snapshot",
		"remaining_balance",
		"VEHICULO",
		"ASCII",
		"backfill",
		"NUMERIC(14,2)",
		"FIJO",
		"VARIABLE",
		"mora",
	} {
		if !strings.Contains(migration.Source, mustExplain) {
			t.Errorf("migration 023 debe documentar %q", mustExplain)
		}
	}

	// La 023 NO debe tocar loan_installments ni loan_expenses: su
	// alcance es exclusivamente metadata editable y snapshot sobre
	// loans. Si alguien agrega ALTER TABLE sobre otras tablas de
	// préstamos, debe ser una migración 024+ con su propia justificación.
	for _, forbiddenAlter := range []string{
		"ALTER TABLE loan_installments",
		"ALTER TABLE loan_expenses",
	} {
		if strings.Contains(migration.Source, forbiddenAlter) {
			t.Errorf("migration 023 debe limitarse a ALTER TABLE loans, encontró %q", forbiddenAlter)
		}
	}
}
