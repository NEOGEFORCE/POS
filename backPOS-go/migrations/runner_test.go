package migrations

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestCatalogIsCompleteOrderedAndChecksummed(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	if len(catalog) != 28 {
		t.Fatalf("len(Catalog()) = %d, want 28", len(catalog))
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

func TestMigration024InternalBarcodeReservationsIsTransactionalDDL(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	var migration *Migration
	for i := range catalog {
		if catalog[i].Version == 24 {
			migration = &catalog[i]
			break
		}
	}
	if migration == nil {
		t.Fatal("migration 024 no está en el catálogo")
	}
	if !migration.Transactional {
		t.Fatal("migration 024 debe ser transaccional: no usa CREATE INDEX CONCURRENTLY")
	}

	// La tabla principal se declara una sola vez y de forma idempotente.
	if !strings.Contains(migration.Source, "CREATE TABLE IF NOT EXISTS internal_barcode_reservations") {
		t.Error("migration 024 debe crear internal_barcode_reservations con IF NOT EXISTS")
	}
	// PK sobre el código: es la última línea de defensa que impide emitir
	// dos veces el mismo valor. Si alguien cambia la clave primaria a un
	// id serial, se pierde esa garantía y el test falla a propósito.
	if !strings.Contains(migration.Source, "reserved_code              VARCHAR(64)   PRIMARY KEY") {
		t.Error("migration 024 debe tener reserved_code VARCHAR(64) PRIMARY KEY (unicidad absoluta del namespace)")
	}

	// CHECKs obligatorios: namespace, status enumerado, coherencia de
	// CONSUMED y expiración futura. Si alguien afloja estos invariantes
	// el modelo de reserva ↔ consumo se contamina.
	for _, constraint := range []string{
		"ck_ibr_status_known",
		"CHECK (status IN ('RESERVED', 'CONSUMED', 'EXPIRED'))",
		"ck_ibr_source_known",
		"CHECK (source IN ('product_form', 'reception', 'other'))",
		"ck_ibr_namespace_shape",
		"CHECK (reserved_code ~ '^POSINT-[0-9A-F]{8,24}$')",
		"ck_ibr_consumed_coherent",
		"ck_ibr_expiry_after_reserved",
		"CHECK (expires_at IS NULL OR expires_at > reserved_at)",
	} {
		if !strings.Contains(migration.Source, constraint) {
			t.Errorf("migration 024 debe declarar %q", constraint)
		}
	}

	// Índices esperados: hot path de reserva, auditoría por actor,
	// resolución por producto consumido. Son parciales a propósito para
	// no inflar el B-tree con filas CONSUMED/EXPIRED (que son la mayoría
	// con el tiempo).
	for _, idx := range []string{
		"CREATE INDEX IF NOT EXISTS ix_ibr_live_by_expiry",
		"WHERE status = 'RESERVED'",
		"CREATE INDEX IF NOT EXISTS ix_ibr_by_actor",
		"CREATE INDEX IF NOT EXISTS ix_ibr_by_consumed_product",
		"WHERE consumed_product_barcode IS NOT NULL",
	} {
		if !strings.Contains(migration.Source, idx) {
			t.Errorf("migration 024 debe declarar %q", idx)
		}
	}

	// Guardianes cruzados sobre otras tablas: package_barcode_aliases y
	// products NO pueden adoptar el namespace POSINT-. label_codes SÍ
	// puede llevar code=POSINT-<hex>, pero debe cumplir una coherencia
	// intra-fila (code = product_barcode) que no es una prohibición.
	// Las tres se agregan vía DO $$ ... END $$ porque Postgres no soporta
	// ADD CONSTRAINT IF NOT EXISTS y el runner debe poder reintentar la
	// migración tras un fallo parcial.
	for _, cross := range []string{
		"ck_pba_no_internal_namespace",
		`ALTER TABLE package_barcode_aliases`,
		"CHECK (package_code !~* '^POSINT-')",
		"ck_products_alternate_codes_no_internal_namespace",
		`ALTER TABLE products`,
		"position('POSINT-' in upper(alternate_codes)) = 0",
	} {
		if !strings.Contains(migration.Source, cross) {
			t.Errorf("migration 024 debe declarar el guardián cruzado %q", cross)
		}
	}
	// label_codes NO debe prohibirse en general: el flujo audit-first de
	// LabelPrintSheet para productos internos persiste
	// code=product_barcode=POSINT-<hex> para que al escanear la etiqueta
	// impresa ResolveLabelCode resuelva al producto. La prohibición
	// global que una versión anterior intentó introducir rompía ese flujo
	// y no debe reintroducirse.
	for _, forbidden := range []string{
		"ck_label_codes_no_internal_namespace",
		"CHECK (code !~* '^POSINT-')",
	} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 024 NO debe prohibir en general POSINT- en label_codes.code (encontró %q): rompería el audit-first de LabelPrintSheet para productos internos", forbidden)
		}
	}
	// En su lugar: CHECK de COHERENCIA intra-fila sobre label_codes. Para
	// filas con code POSINT-, product_barcode debe ser igual a code (la
	// etiqueta impresa ES el barcode del producto). Sin subquery: la
	// existencia global del producto la garantiza el repositorio Go.
	for _, coherence := range []string{
		"ck_label_codes_posint_matches_product_barcode",
		`ALTER TABLE label_codes`,
		"code !~ '^POSINT-'",
		"product_barcode IS NOT NULL AND product_barcode = code",
	} {
		if !strings.Contains(migration.Source, coherence) {
			t.Errorf("migration 024 debe declarar la coherencia intra-fila %q sobre label_codes", coherence)
		}
	}
	// Idempotencia de los tres CHECK que se añaden vía ALTER (los dos
	// cruzados sobre otras tablas + la coherencia sobre label_codes):
	// deben vivir dentro de DO $$ con comprobación en pg_constraint. Si
	// alguien reemplaza por ALTER directo, el runner no puede reintentar
	// tras un fallo parcial.
	if count := strings.Count(migration.Source, "FROM pg_constraint"); count != 3 {
		t.Errorf("migration 024 debe envolver los tres ADD CONSTRAINT (pba, products.alternate_codes, label_codes coherencia) en bloques DO $$ con pg_constraint, encontró %d", count)
	}
	if count := strings.Count(migration.Source, "\nDO $$\n"); count != 3 {
		t.Errorf("migration 024 debe tener exactamente 3 bloques DO $$ ejecutables (pba, products.alternate_codes, label_codes coherencia), encontró %d", count)
	}

	// Al ser transaccional NO puede usar CREATE INDEX CONCURRENTLY.
	// Postgres prohíbe CONCURRENTLY dentro de una transacción.
	if concurrentIndexPattern.MatchString(migration.Source) {
		t.Error("migration 024 es transaccional: contiene una sentencia CREATE INDEX CONCURRENTLY ejecutable")
	}

	// Puramente DDL: la 024 NO backfillea nada. Si alguien agrega
	// INSERT/UPDATE/DELETE para "sembrar" reservas iniciales, estaría
	// generando códigos sin pasar por el handler (que valida colisión
	// contra las cuatro fuentes). Explícitamente prohibido.
	for _, forbidden := range []string{
		"UPDATE internal_barcode_reservations",
		"UPDATE products",
		"UPDATE label_codes",
		"UPDATE package_barcode_aliases",
		"DELETE FROM ",
		"INSERT INTO ",
	} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 024 debe ser puramente DDL, encontró %q", forbidden)
		}
	}

	// COMMENT ON TABLE / COLUMN para que pg_dump --schema-only conserve
	// la justificación con la BD. Documenta el contrato operativo.
	for _, comment := range []string{
		"COMMENT ON TABLE internal_barcode_reservations",
		"COMMENT ON COLUMN internal_barcode_reservations.reserved_code",
		"COMMENT ON COLUMN internal_barcode_reservations.status",
		"COMMENT ON COLUMN internal_barcode_reservations.source",
		"COMMENT ON COLUMN internal_barcode_reservations.reserved_by_dni",
		"COMMENT ON COLUMN internal_barcode_reservations.expires_at",
		"COMMENT ON COLUMN internal_barcode_reservations.consumed_at",
		"COMMENT ON COLUMN internal_barcode_reservations.consumed_product_barcode",
		"COMMENT ON COLUMN internal_barcode_reservations.consumed_by_dni",
		"COMMENT ON CONSTRAINT ck_pba_no_internal_namespace ON package_barcode_aliases",
		"COMMENT ON CONSTRAINT ck_products_alternate_codes_no_internal_namespace ON products",
		"COMMENT ON CONSTRAINT ck_label_codes_posint_matches_product_barcode ON label_codes",
	} {
		if !strings.Contains(migration.Source, comment) {
			t.Errorf("migration 024 debe declarar %q", comment)
		}
	}

	// Documentación obligatoria: el archivo tiene que explicar POR QUÉ el
	// namespace es POSINT- (ASCII, CODE128, no comercial), por qué hex en
	// mayúsculas (empata con strings.ToUpper del handler), por qué sin FK
	// dura al producto (soft delete + marcadores [HISTORICO]), por qué el
	// status jamás se borra (unicidad eterna), por qué label_codes PUEDE
	// llevar code=POSINT- (flujo audit-first de LabelPrintSheet con
	// code = product_barcode) y por qué los dos guardianes cruzados
	// restantes existen. Blindaje semántico: si alguien reemplaza el
	// contenido sin esa justificación, el test obliga a revisarlo.
	for _, mustExplain := range []string{
		"POSINT-",
		"CODE128",
		"no comercial",
		"ToUpper",
		"soft delete",
		"[HISTORICO]",
		"buildProductLookup",
		"ProductFormModal",
		"RESERVED",
		"CONSUMED",
		"EXPIRED",
		"crypto/rand",
		"label_codes",
		"package_barcode_aliases",
		"alternate_codes",
		"LabelPrintSheet",
		"audit-first",
		"ResolveLabelCode",
		"EnsureCodeForProduct",
		"LC-<hex>",
	} {
		if !strings.Contains(migration.Source, mustExplain) {
			t.Errorf("migration 024 debe documentar %q", mustExplain)
		}
	}
}


func TestMigration025CashDrawerOtpChallengesIsTransactionalDDL(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	var migration *Migration
	for i := range catalog {
		if catalog[i].Version == 25 {
			migration = &catalog[i]
			break
		}
	}
	if migration == nil {
		t.Fatal("migration 025 no está en el catálogo")
	}
	if !migration.Transactional {
		t.Fatal("migration 025 debe ser transaccional: no usa CREATE INDEX CONCURRENTLY")
	}

	// La tabla principal se declara una sola vez y de forma idempotente.
	if !strings.Contains(migration.Source, "CREATE TABLE IF NOT EXISTS cash_drawer_otp_challenges") {
		t.Error("migration 025 debe crear cash_drawer_otp_challenges con IF NOT EXISTS")
	}

	// Columnas obligatorias y tipos exactos. Si alguien cambia BYTEA por
	// TEXT para code_hash, o VARCHAR por TEXT para challenge_id, el
	// contrato con el handler bcrypt se rompe en silencio.
	for _, column := range []string{
		"id                        BIGSERIAL     PRIMARY KEY",
		"challenge_id              VARCHAR(64)   NOT NULL",
		"requested_by_dni          VARCHAR(32)   NOT NULL",
		"code_hash                 BYTEA         NOT NULL",
		"created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW()",
		"expires_at                TIMESTAMPTZ   NOT NULL",
		"attempts_used             INTEGER       NOT NULL DEFAULT 0",
		"attempts_max              INTEGER       NOT NULL DEFAULT 3",
		"status                    VARCHAR(16)   NOT NULL DEFAULT 'PENDING'",
		"consumed_at               TIMESTAMPTZ",
		"consumed_drawer_open_id   BIGINT",
	} {
		if !strings.Contains(migration.Source, column) {
			t.Errorf("migration 025 debe declarar la columna %q", column)
		}
	}

	// Blindaje tipo-de-dato: el hash bcrypt vive como BYTEA, no como
	// JSON ni VARCHAR. Si alguien lo cambia a texto, bcrypt sigue
	// funcionando pero la columna pierde la semántica binaria explícita
	// y abre la puerta a persistir el OTP en claro por error.
	if strings.Contains(migration.Source, "code_hash                 TEXT") ||
		strings.Contains(migration.Source, "code_hash                 VARCHAR") ||
		strings.Contains(migration.Source, "code_hash                 JSONB") ||
		strings.Contains(migration.Source, "code_hash                 JSON") {
		t.Error("migration 025 debe mantener code_hash BYTEA (bcrypt es binario, JSON nunca aplica en SQL)")
	}

	// CHECKs obligatorios: status enumerado, cotas de intentos, ventana
	// positiva, tamaño del hash bcrypt y biyección CONSUMED ↔
	// (consumed_at, consumed_drawer_open_id).
	for _, constraint := range []string{
		"ck_cdoc_status_known",
		"CHECK (status IN ('PENDING', 'CONSUMED', 'FAILED', 'EXPIRED', 'CANCELLED'))",
		"ck_cdoc_attempts_bounds",
		"attempts_max  >= 1",
		"attempts_used >= 0",
		"attempts_used <= attempts_max",
		"ck_cdoc_expires_after_created",
		"CHECK (expires_at > created_at)",
		"ck_cdoc_code_hash_bcrypt_size",
		"CHECK (octet_length(code_hash) BETWEEN 59 AND 72)",
		"ck_cdoc_consumed_coherent",
	} {
		if !strings.Contains(migration.Source, constraint) {
			t.Errorf("migration 025 debe declarar %q", constraint)
		}
	}

	// Índices: challenge_id UNIQUE global, PENDING vivo por actor
	// (unique parcial), expiración parcial, auditoría por actor.
	for _, idx := range []string{
		"CREATE UNIQUE INDEX IF NOT EXISTS ux_cdoc_challenge_id",
		"ON cash_drawer_otp_challenges (challenge_id)",
		"CREATE UNIQUE INDEX IF NOT EXISTS ux_cdoc_live_by_actor",
		"ON cash_drawer_otp_challenges (requested_by_dni)",
		"WHERE status = 'PENDING'",
		"CREATE INDEX IF NOT EXISTS ix_cdoc_expiry_pending",
		"ON cash_drawer_otp_challenges (expires_at)",
		"CREATE INDEX IF NOT EXISTS ix_cdoc_actor_created",
		"ON cash_drawer_otp_challenges (requested_by_dni, created_at DESC)",
	} {
		if !strings.Contains(migration.Source, idx) {
			t.Errorf("migration 025 debe declarar %q", idx)
		}
	}

	// FK dura challenge → cash_drawer_opens (soft RESTRICT) y FK dura
	// cash_drawer_opens → challenge (soft RESTRICT), ambas vía DO $$
	// para idempotencia.
	for _, fk := range []string{
		"fk_cdoc_consumed_drawer_open",
		"REFERENCES cash_drawer_opens(id)",
		"fk_cash_drawer_opens_otp_challenge",
		"REFERENCES cash_drawer_otp_challenges(id)",
	} {
		if !strings.Contains(migration.Source, fk) {
			t.Errorf("migration 025 debe declarar %q", fk)
		}
	}
	// Las dos FKs usan ON DELETE RESTRICT: cash_drawer_opens es
	// append-only y los challenges tampoco se borran en operación
	// normal. ON DELETE CASCADE o SET NULL abriría la puerta a perder
	// trazabilidad.
	if count := strings.Count(migration.Source, "ON DELETE RESTRICT"); count < 2 {
		t.Errorf("migration 025 debe usar ON DELETE RESTRICT en las dos FKs, encontró %d", count)
	}

	// Alteración de cash_drawer_opens: nueva columna + FK + UNIQUE parcial.
	for _, alter := range []string{
		"ALTER TABLE cash_drawer_opens",
		"ADD COLUMN IF NOT EXISTS otp_challenge_id BIGINT NULL",
		"CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_drawer_opens_otp_challenge",
		"ON cash_drawer_opens (otp_challenge_id)",
		"WHERE otp_challenge_id IS NOT NULL",
	} {
		if !strings.Contains(migration.Source, alter) {
			t.Errorf("migration 025 debe declarar %q", alter)
		}
	}

	// Reemplazo del CHECK anónimo de reason: debe nacer un
	// ck_cash_drawer_opens_reason_known que admita 'otp_manual' y
	// mantenga los cuatro valores originales (sale/return/admin_override/other).
	for _, reasonCheck := range []string{
		"ck_cash_drawer_opens_reason_known",
		"CHECK (reason IN ('sale', 'return', 'admin_override', 'other', 'otp_manual'))",
	} {
		if !strings.Contains(migration.Source, reasonCheck) {
			t.Errorf("migration 025 debe declarar %q", reasonCheck)
		}
	}
	// El reemplazo del CHECK anónimo heredado de la 016 se hace vía
	// lookup por contenido en pg_constraint (no por nombre), porque el
	// nombre autogenerado por Postgres (<table>_<col>_check) no es un
	// contrato estable. Si alguien introduce un DROP por nombre
	// hardcoded, el test lo detecta.
	for _, lookupBit := range []string{
		"legacy_check_name TEXT",
		"FROM pg_constraint c",
		"JOIN pg_class t",
		"pg_get_constraintdef(c.oid)",
		"NOT ILIKE '%otp_manual%'",
	} {
		if !strings.Contains(migration.Source, lookupBit) {
			t.Errorf("migration 025 debe localizar el CHECK anónimo de reason por contenido: falta %q", lookupBit)
		}
	}

	// Reemplazo del guardián sale_or_admin: desaparece el nombre viejo y
	// nace el nuevo sale_admin_return_otp con las cuatro justificaciones.
	for _, saleGuard := range []string{
		"DROP CONSTRAINT ck_cash_drawer_opens_sale_or_admin",
		"ck_cash_drawer_opens_sale_admin_return_otp",
		"sale_id IS NOT NULL",
		"return_id IS NOT NULL",
		"override_admin",
		"otp_challenge_id IS NOT NULL",
	} {
		if !strings.Contains(migration.Source, saleGuard) {
			t.Errorf("migration 025 debe declarar %q", saleGuard)
		}
	}

	// Biyección exacta reason='otp_manual' ↔ otp_challenge_id IS NOT NULL.
	for _, coherent := range []string{
		"ck_cash_drawer_opens_otp_reason_coherent",
		"(reason = 'otp_manual' AND otp_challenge_id IS NOT NULL)",
		"(reason <> 'otp_manual' AND otp_challenge_id IS NULL)",
	} {
		if !strings.Contains(migration.Source, coherent) {
			t.Errorf("migration 025 debe declarar la coherencia %q", coherent)
		}
	}

	// Idempotencia de todos los ADD CONSTRAINT que se añaden vía ALTER:
	// deben vivir dentro de DO $$ con comprobación en pg_constraint. La
	// 025 añade 5 bloques DO $$ (FK cdoc→opens, FK opens→cdoc, reason
	// CHECK con lookup+add, sale_or_admin DROP+ADD, otp_reason_coherent ADD).
	if count := strings.Count(migration.Source, "\nDO $$\n"); count != 5 {
		t.Errorf("migration 025 debe tener exactamente 5 bloques DO $$ ejecutables (dos FKs, reason, sale/admin/return/otp, coherencia), encontró %d", count)
	}
	if count := strings.Count(migration.Source, "FROM pg_constraint"); count < 5 {
		t.Errorf("migration 025 debe consultar pg_constraint en todos los bloques idempotentes, encontró %d", count)
	}

	// Al ser transaccional NO puede usar CREATE INDEX CONCURRENTLY.
	// Postgres prohíbe CONCURRENTLY dentro de una transacción.
	if concurrentIndexPattern.MatchString(migration.Source) {
		t.Error("migration 025 es transaccional: contiene una sentencia CREATE INDEX CONCURRENTLY ejecutable")
	}

	// Puramente DDL: la 025 NO backfillea ni semilla challenges. Si
	// alguien agrega INSERT/UPDATE/DELETE para "sembrar" datos iniciales,
	// está generando OTPs sin pasar por el handler (que calcula bcrypt
	// y manda por Telegram). Explícitamente prohibido.
	for _, forbidden := range []string{
		"UPDATE cash_drawer_otp_challenges",
		"UPDATE cash_drawer_opens",
		"DELETE FROM ",
		"INSERT INTO ",
	} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 025 debe ser puramente DDL, encontró %q", forbidden)
		}
	}

	// COMMENT ON TABLE / COLUMN / CONSTRAINT para que pg_dump --schema-only
	// conserve la justificación con la BD.
	for _, comment := range []string{
		"COMMENT ON TABLE cash_drawer_otp_challenges",
		"COMMENT ON COLUMN cash_drawer_otp_challenges.challenge_id",
		"COMMENT ON COLUMN cash_drawer_otp_challenges.requested_by_dni",
		"COMMENT ON COLUMN cash_drawer_otp_challenges.code_hash",
		"COMMENT ON COLUMN cash_drawer_otp_challenges.expires_at",
		"COMMENT ON COLUMN cash_drawer_otp_challenges.attempts_used",
		"COMMENT ON COLUMN cash_drawer_otp_challenges.attempts_max",
		"COMMENT ON COLUMN cash_drawer_otp_challenges.status",
		"COMMENT ON COLUMN cash_drawer_otp_challenges.consumed_drawer_open_id",
		"COMMENT ON COLUMN cash_drawer_opens.otp_challenge_id",
		"COMMENT ON CONSTRAINT fk_cdoc_consumed_drawer_open ON cash_drawer_otp_challenges",
		"COMMENT ON CONSTRAINT fk_cash_drawer_opens_otp_challenge ON cash_drawer_opens",
		"COMMENT ON CONSTRAINT ck_cash_drawer_opens_reason_known ON cash_drawer_opens",
		"COMMENT ON CONSTRAINT ck_cash_drawer_opens_sale_admin_return_otp ON cash_drawer_opens",
		"COMMENT ON CONSTRAINT ck_cash_drawer_opens_otp_reason_coherent ON cash_drawer_opens",
	} {
		if !strings.Contains(migration.Source, comment) {
			t.Errorf("migration 025 debe declarar %q", comment)
		}
	}

	// Documentación obligatoria: el archivo tiene que explicar POR QUÉ el
	// OTP se persiste como BYTEA (bcrypt, no JSON ni texto en claro),
	// por qué hay un UNIQUE parcial por actor PENDING (DoS a Telegram),
	// por qué cash_drawer_opens.reason se amplía a cuatro valores
	// (sale/admin/return/otp), por qué la biyección es exacta (no sólo
	// "si hay challenge, legal"), por qué las FKs son ON DELETE RESTRICT
	// y por qué la 025 no reemplaza al override admin sino que corre en
	// paralelo. Blindaje semántico: si alguien reemplaza el contenido
	// sin esa justificación, el test obliga a revisarlo.
	for _, mustExplain := range []string{
		"bcrypt",
		"BYTEA",
		"JSON",
		"Telegram",
		"DoS",
		"append-only",
		"RESTRICT",
		"otp_manual",
		"sale/admin/return/otp",
		"override admin",
		"biyección",
		"crypto/rand",
		"estrictamente más permisivo",
		"append-only",
		"PENDING",
		"CONSUMED",
		"FAILED",
		"EXPIRED",
		"CANCELLED",
	} {
		if !strings.Contains(migration.Source, mustExplain) {
			t.Errorf("migration 025 debe documentar %q", mustExplain)
		}
	}

	// La 025 limita su alcance a cash_drawer_otp_challenges y
	// cash_drawer_opens. Si alguien añade ALTER TABLE sobre otras
	// tablas, debe ser una migración 026+ con su propia justificación.
	for _, forbiddenAlter := range []string{
		"ALTER TABLE products",
		"ALTER TABLE sales",
		"ALTER TABLE returns",
		"ALTER TABLE audit_logs",
		"ALTER TABLE label_codes",
		"ALTER TABLE package_barcode_aliases",
		"ALTER TABLE internal_barcode_reservations",
	} {
		if strings.Contains(migration.Source, forbiddenAlter) {
			t.Errorf("migration 025 debe limitarse a cash_drawer_otp_challenges y cash_drawer_opens, encontró %q", forbiddenAlter)
		}
	}
}

func TestMigration026PosQrPaymentIntentsIsTransactionalDDL(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	var migration *Migration
	for i := range catalog {
		if catalog[i].Version == 26 {
			migration = &catalog[i]
			break
		}
	}
	if migration == nil {
		t.Fatal("migration 026 no está en el catálogo")
	}
	if !migration.Transactional {
		t.Fatal("migration 026 debe ser transaccional: no usa CREATE INDEX CONCURRENTLY")
	}

	// Las dos tablas nuevas deben declararse de forma idempotente.
	for _, table := range []string{
		"pos_qr_payment_intents",
		"pos_qr_webhook_events",
	} {
		expected := "CREATE TABLE IF NOT EXISTS " + table
		if !strings.Contains(migration.Source, expected) {
			t.Errorf("migration 026 debe crear %s con IF NOT EXISTS", table)
		}
	}

	// Columnas obligatorias y tipos exactos de pos_qr_payment_intents.
	// Si alguien cambia BIGINT por NUMERIC en amount_cop (perdiendo el
	// contrato int64 pedido por el dueño) o VARCHAR por TEXT en los
	// enums, el matcher y los CHECK se vuelven ambiguos: estas pruebas
	// lo detectan antes de que la BD lo acepte en silencio.
	for _, column := range []string{
		"id                        BIGSERIAL     PRIMARY KEY",
		"venta_temp_id             VARCHAR(80)   NOT NULL",
		"caja_id                   VARCHAR(64)   NOT NULL",
		"created_by_dni            VARCHAR(32)   NOT NULL",
		"amount_cop                BIGINT        NOT NULL",
		"status                    VARCHAR(24)   NOT NULL DEFAULT 'PENDIENTE'",
		"created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW()",
		"expires_at                TIMESTAMPTZ   NOT NULL",
		"approved_at               TIMESTAMPTZ",
		"approved_source           VARCHAR(24)",
		"approved_reference        VARCHAR(128)",
		"approved_event_id         BIGINT",
		"cancelled_at              TIMESTAMPTZ",
		"cancelled_by_dni          VARCHAR(32)",
		"cancel_reason             VARCHAR(64)",
		"manual_confirmed_by_dni   VARCHAR(32)",
		"manual_confirmed_note     TEXT",
		"related_sale_id           BIGINT",
	} {
		if !strings.Contains(migration.Source, column) {
			t.Errorf("migration 026 (pos_qr_payment_intents) debe declarar la columna %q", column)
		}
	}

	// Blindaje tipo-de-dinero: amount_cop vive en BIGINT por contrato
	// explícito (int64 del dueño). Si alguien lo cambia a NUMERIC con o
	// sin escala, cambia la semántica a número con decimales y rompe la
	// equidad exacta del match.
	for _, forbidden := range []string{
		"amount_cop                NUMERIC",
		"amount_cop                DECIMAL",
		"amount_cop                FLOAT",
		"amount_cop                DOUBLE PRECISION",
		"amount_cop                REAL",
	} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 026 debe mantener amount_cop BIGINT (int64 por contrato), encontró %q", forbidden)
		}
	}

	// Columnas obligatorias y tipos exactos de pos_qr_webhook_events.
	for _, column := range []string{
		"id                 BIGSERIAL     PRIMARY KEY",
		"received_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()",
		"source             VARCHAR(24)   NOT NULL",
		"event_type         VARCHAR(32)",
		"external_id        VARCHAR(128)",
		"fingerprint        VARCHAR(128)  NOT NULL",
		"amount_cop         BIGINT        NOT NULL",
		"processed_at       TIMESTAMPTZ",
		"processed_status   VARCHAR(24)   NOT NULL DEFAULT 'PENDING'",
		"matched_intent_id  BIGINT",
		"note               VARCHAR(255)",
	} {
		if !strings.Contains(migration.Source, column) {
			t.Errorf("migration 026 (pos_qr_webhook_events) debe declarar la columna %q", column)
		}
	}

	// CHECKs obligatorios sobre pos_qr_payment_intents: estados,
	// fuentes, montos, coherencia aprobada ↔ cancelada ↔ manual. Si
	// alguien afloja estos invariantes, la máquina de estados queda
	// expuesta a race conditions del service.
	for _, constraint := range []string{
		"ck_pqpi_amount_positive",
		"CHECK (amount_cop > 0)",
		"ck_pqpi_status_known",
		"CHECK (status IN ('PENDIENTE', 'APROBADA', 'CONFIRMADA_MANUAL', 'EXPIRADA', 'CANCELADA'))",
		"ck_pqpi_approved_source_known",
		"approved_source IN ('BOLD_OFFICIAL', 'BRIDGE_NOTIFICATION', 'MANUAL')",
		"ck_pqpi_expires_after_created",
		"CHECK (expires_at > created_at)",
		"ck_pqpi_approval_coherent",
		"status = 'APROBADA'",
		"status = 'CONFIRMADA_MANUAL'",
		"status IN ('PENDIENTE', 'EXPIRADA', 'CANCELADA')",
		"ck_pqpi_cancelled_coherent",
	} {
		if !strings.Contains(migration.Source, constraint) {
			t.Errorf("migration 026 debe declarar el CHECK/CONSTRAINT %q sobre pos_qr_payment_intents", constraint)
		}
	}

	// CHECKs obligatorios sobre pos_qr_webhook_events: fuente,
	// estado procesado, monto positivo, fingerprint no vacío,
	// biyección matched_intent_id ↔ APPROVED, y FK dura hacia la
	// intención.
	for _, constraint := range []string{
		"ck_pqwe_source_known",
		"CHECK (source IN ('BOLD_OFFICIAL', 'BRIDGE_NOTIFICATION'))",
		"ck_pqwe_processed_status_known",
		"CHECK (processed_status IN ('PENDING', 'APPROVED', 'UNMATCHED', 'AMBIGUOUS', 'DUPLICATE', 'INVALID'))",
		"ck_pqwe_amount_positive",
		"ck_pqwe_fingerprint_nonempty",
		"CHECK (char_length(fingerprint) >= 8",
		"ck_pqwe_external_id_shape",
		"ck_pqwe_matched_only_if_approved",
		"processed_status = 'APPROVED'",
		"matched_intent_id IS NOT NULL",
		"fk_pqwe_matched_intent",
		"REFERENCES pos_qr_payment_intents(id)",
	} {
		if !strings.Contains(migration.Source, constraint) {
			t.Errorf("migration 026 debe declarar el CHECK/CONSTRAINT %q sobre pos_qr_webhook_events", constraint)
		}
	}

	// Las dos FK (eventos→intenciones y la retro intenciones→eventos)
	// usan ON DELETE RESTRICT. Un CASCADE o SET NULL abriría la puerta
	// a perder la trazabilidad entre pagos y aprobaciones.
	if count := strings.Count(migration.Source, "ON DELETE RESTRICT"); count < 2 {
		t.Errorf("migration 026 debe usar ON DELETE RESTRICT en las dos FKs cruzadas, encontró %d", count)
	}

	// Índices esperados sobre pos_qr_payment_intents.
	for _, idx := range []string{
		"CREATE UNIQUE INDEX IF NOT EXISTS ux_pqpi_live_by_venta_temp",
		"ON pos_qr_payment_intents (venta_temp_id)",
		"WHERE status = 'PENDIENTE'",
		"CREATE INDEX IF NOT EXISTS ix_pqpi_match_by_amount_live",
		"ON pos_qr_payment_intents (amount_cop, expires_at)",
		"CREATE INDEX IF NOT EXISTS ix_pqpi_expiry_pending",
		"CREATE INDEX IF NOT EXISTS ix_pqpi_actor_created",
		"ON pos_qr_payment_intents (created_by_dni, created_at DESC)",
		"CREATE INDEX IF NOT EXISTS ix_pqpi_caja_created",
		"ON pos_qr_payment_intents (caja_id, created_at DESC)",
		"CREATE INDEX IF NOT EXISTS ix_pqpi_created_desc",
		"CREATE INDEX IF NOT EXISTS ix_pqpi_approved_event",
	} {
		if !strings.Contains(migration.Source, idx) {
			t.Errorf("migration 026 debe declarar %q", idx)
		}
	}

	// Índices esperados sobre pos_qr_webhook_events, incluyendo los
	// dos UNIQUE del dedupe doble (external_id canónico Bold y
	// fingerprint de replay MacroDroid).
	for _, idx := range []string{
		"CREATE UNIQUE INDEX IF NOT EXISTS ux_pqwe_source_external_id",
		"ON pos_qr_webhook_events (source, external_id)",
		"WHERE external_id IS NOT NULL",
		"CREATE UNIQUE INDEX IF NOT EXISTS ux_pqwe_source_fingerprint",
		"ON pos_qr_webhook_events (source, fingerprint)",
		"CREATE INDEX IF NOT EXISTS ix_pqwe_received_desc",
		"CREATE INDEX IF NOT EXISTS ix_pqwe_needs_review",
		"processed_status IN ('PENDING', 'UNMATCHED', 'AMBIGUOUS')",
		"CREATE INDEX IF NOT EXISTS ix_pqwe_matched_intent",
		"CREATE INDEX IF NOT EXISTS ix_pqwe_amount_received",
	} {
		if !strings.Contains(migration.Source, idx) {
			t.Errorf("migration 026 debe declarar %q", idx)
		}
	}

	// La FK retro intents→events se añade vía DO $$ porque Postgres no
	// admite ADD CONSTRAINT IF NOT EXISTS y el runner debe poder
	// reintentar la migración tras un fallo parcial. Debe haber
	// exactamente UN bloque DO $$ ejecutable (la FK retro).
	if count := strings.Count(migration.Source, "\nDO $$\n"); count != 1 {
		t.Errorf("migration 026 debe tener exactamente 1 bloque DO $$ ejecutable (la FK retro intents→events), encontró %d", count)
	}
	if !strings.Contains(migration.Source, "fk_pqpi_approved_event") {
		t.Error("migration 026 debe nombrar la FK retro como fk_pqpi_approved_event")
	}
	if !strings.Contains(migration.Source, "REFERENCES pos_qr_webhook_events(id)") {
		t.Error("migration 026 debe referenciar pos_qr_webhook_events(id) desde la intención")
	}
	if !strings.Contains(migration.Source, "FROM pg_constraint") {
		t.Error("migration 026 debe consultar pg_constraint dentro del DO $$ para idempotencia")
	}

	// Al ser transaccional NO puede usar CREATE INDEX CONCURRENTLY.
	// Postgres prohíbe CONCURRENTLY dentro de una transacción. El
	// regex del runner matchea sólo sentencias ejecutables, no la
	// palabra en comentarios "--".
	if concurrentIndexPattern.MatchString(migration.Source) {
		t.Error("migration 026 es transaccional: contiene una sentencia CREATE INDEX CONCURRENTLY ejecutable")
	}

	// Puramente DDL: la 026 NO backfillea ni semilla intenciones o
	// eventos. Si alguien agrega INSERT/UPDATE/DELETE para "sembrar"
	// datos iniciales, está emitiendo intenciones o eventos sin pasar
	// por el handler (que valida monto, caja, DNI, firma HMAC o
	// token). Explícitamente prohibido.
	for _, forbidden := range []string{
		"UPDATE pos_qr_payment_intents",
		"UPDATE pos_qr_webhook_events",
		"DELETE FROM ",
		"INSERT INTO ",
	} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 026 debe ser puramente DDL, encontró %q", forbidden)
		}
	}

	// COMMENT ON TABLE / COLUMN / CONSTRAINT para que pg_dump
	// --schema-only conserve la justificación con la BD.
	for _, comment := range []string{
		"COMMENT ON TABLE pos_qr_payment_intents",
		"COMMENT ON TABLE pos_qr_webhook_events",
		"COMMENT ON COLUMN pos_qr_payment_intents.venta_temp_id",
		"COMMENT ON COLUMN pos_qr_payment_intents.caja_id",
		"COMMENT ON COLUMN pos_qr_payment_intents.amount_cop",
		"COMMENT ON COLUMN pos_qr_payment_intents.status",
		"COMMENT ON COLUMN pos_qr_payment_intents.expires_at",
		"COMMENT ON COLUMN pos_qr_payment_intents.approved_source",
		"COMMENT ON COLUMN pos_qr_payment_intents.approved_reference",
		"COMMENT ON COLUMN pos_qr_payment_intents.approved_event_id",
		"COMMENT ON COLUMN pos_qr_payment_intents.manual_confirmed_by_dni",
		"COMMENT ON COLUMN pos_qr_payment_intents.related_sale_id",
		"COMMENT ON COLUMN pos_qr_webhook_events.source",
		"COMMENT ON COLUMN pos_qr_webhook_events.event_type",
		"COMMENT ON COLUMN pos_qr_webhook_events.external_id",
		"COMMENT ON COLUMN pos_qr_webhook_events.fingerprint",
		"COMMENT ON COLUMN pos_qr_webhook_events.amount_cop",
		"COMMENT ON COLUMN pos_qr_webhook_events.processed_status",
		"COMMENT ON COLUMN pos_qr_webhook_events.matched_intent_id",
		"COMMENT ON CONSTRAINT fk_pqwe_matched_intent ON pos_qr_webhook_events",
		"COMMENT ON CONSTRAINT fk_pqpi_approved_event ON pos_qr_payment_intents",
	} {
		if !strings.Contains(migration.Source, comment) {
			t.Errorf("migration 026 debe declarar %q", comment)
		}
	}

	// Documentación obligatoria: el archivo tiene que explicar POR QUÉ
	// la aprobación por webhook SÓLO procede con match exacto 1-a-1
	// (regla "falso negativo antes que doble aprobación"), por qué el
	// token BOLD_BRIDGE_TOKEN y la firma HMAC-SHA256 NO se persisten,
	// por qué amount_cop es BIGINT y no NUMERIC, por qué hay dedupe
	// doble (external_id canónico Bold + fingerprint de replay
	// MacroDroid), por qué la autoría manual se guarda con DNI, y la
	// identidad fiscal del local (Sebastian Sarmiento / 0093097755
	// Bre-B). Blindaje semántico: si alguien reemplaza el contenido
	// sin esa justificación, el test obliga a revisarlo.
	for _, mustExplain := range []string{
		"Bre-B",
		"Nequi",
		"DaviPlata",
		"Bancolombia",
		"Supermercado Surtifamiliar",
		"Sebastian Sarmiento",
		"0093097755",
		"BOLD_OFFICIAL",
		"BRIDGE_NOTIFICATION",
		"BOLD_BRIDGE_TOKEN",
		"BOLD_SECRET_KEY",
		"x-bold-signature",
		"HMAC-SHA256",
		"SALE_APPROVED",
		"bold_code",
		"MacroDroid",
		"fingerprint",
		"replay",
		"idempotente",
		"doble aprobación",
		"falso negativo",
		"5 min",
		"UNMATCHED",
		"AMBIGUOUS",
		"CONFIRMADA_MANUAL",
		"SELECT ... FOR UPDATE",
		"sync.RWMutex",
		"BIGINT",
		"int64",
		"soft delete",
		"RESTRICT",
		"append-only",
		"audit_logs",
	} {
		if !strings.Contains(migration.Source, mustExplain) {
			t.Errorf("migration 026 debe documentar %q en comentarios", mustExplain)
		}
	}

	// Guardas contra fuga de secretos: la 026 NO debe persistir el
	// token del bridge ni la firma HMAC-SHA256. Si alguien introduce
	// una columna llamada así, el test grita.
	for _, forbiddenColumn := range []string{
		"bold_bridge_token ",
		"bold_bridge_token\t",
		"signature_header ",
		"x_bold_signature ",
		"raw_payload ",
		"raw_payload_json ",
		"payload_raw ",
	} {
		if strings.Contains(migration.Source, forbiddenColumn) {
			t.Errorf("migration 026 no debe persistir secretos ni payload crudo, encontró columna %q", forbiddenColumn)
		}
	}

	// La 026 limita su alcance a las dos tablas nuevas. Si alguien
	// agrega ALTER TABLE sobre tablas existentes (sales, employees,
	// audit_logs, cash_drawer_opens, label_codes, etc.), debe ser una
	// migración 027+ con su propia justificación. La única ALTER
	// legítima aquí es sobre pos_qr_payment_intents dentro del bloque
	// DO $$ para añadir la FK retro.
	for _, forbiddenAlter := range []string{
		"ALTER TABLE sales",
		"ALTER TABLE employees",
		"ALTER TABLE audit_logs",
		"ALTER TABLE cash_drawer_opens",
		"ALTER TABLE cash_drawer_otp_challenges",
		"ALTER TABLE label_codes",
		"ALTER TABLE products",
		"ALTER TABLE package_barcode_aliases",
		"ALTER TABLE internal_barcode_reservations",
		"ALTER TABLE pos_qr_webhook_events",
	} {
		if strings.Contains(migration.Source, forbiddenAlter) {
			t.Errorf("migration 026 debe limitarse a pos_qr_payment_intents y pos_qr_webhook_events, encontró %q", forbiddenAlter)
		}
	}
}


func TestMigration027PosQrAsyncCheckoutIsTransactionalDDL(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	var migration *Migration
	for i := range catalog {
		if catalog[i].Version == 27 {
			migration = &catalog[i]
			break
		}
	}
	if migration == nil {
		t.Fatal("migration 027 no está en el catálogo")
	}
	if !migration.Transactional {
		t.Fatal("migration 027 debe ser transaccional: no usa CREATE INDEX CONCURRENTLY")
	}

	// La 027 extiende pos_qr_payment_intents y nada más. Si alguien
	// agrega CREATE TABLE sobre otra tabla, debe ser una migración
	// 028+ con su propia justificación.
	if strings.Contains(migration.Source, "CREATE TABLE") {
		t.Error("migration 027 no debe crear tablas nuevas (es una extensión aditiva de pos_qr_payment_intents)")
	}

	// Columnas nuevas obligatorias con tipo exacto y DEFAULT seguro.
	// Si alguien cambia JSONB por TEXT, BIGINT por INTEGER para
	// cashier_notified_at (que es TIMESTAMPTZ), o quita el NOT NULL
	// DEFAULT en finalization_status/attempts, el contrato se rompe.
	for _, column := range []string{
		"ADD COLUMN IF NOT EXISTS cart_snapshot                JSONB",
		"ADD COLUMN IF NOT EXISTS client_snapshot              JSONB",
		"ADD COLUMN IF NOT EXISTS totals_snapshot              JSONB",
		"ADD COLUMN IF NOT EXISTS sale_client_tx_id            VARCHAR(64)",
		"ADD COLUMN IF NOT EXISTS queued_at                    TIMESTAMPTZ",
		"ADD COLUMN IF NOT EXISTS finalization_status          VARCHAR(24)  NOT NULL DEFAULT 'NOT_STARTED'",
		"ADD COLUMN IF NOT EXISTS finalization_started_at      TIMESTAMPTZ",
		"ADD COLUMN IF NOT EXISTS finalization_completed_at    TIMESTAMPTZ",
		"ADD COLUMN IF NOT EXISTS finalization_attempts        INTEGER      NOT NULL DEFAULT 0",
		"ADD COLUMN IF NOT EXISTS finalization_last_error      VARCHAR(255)",
		"ADD COLUMN IF NOT EXISTS finalization_next_retry_at   TIMESTAMPTZ",
		"ADD COLUMN IF NOT EXISTS cashier_notified_at          TIMESTAMPTZ",
	} {
		if !strings.Contains(migration.Source, column) {
			t.Errorf("migration 027 debe declarar %q", column)
		}
	}

	// Blindaje tipo-de-dato: los snapshots deben ser JSONB (no TEXT ni
	// JSON) para que PostgreSQL pueda indexar y validar más adelante
	// sin reescribir la tabla. Si alguien lo cambia a TEXT (string
	// crudo) perdemos validación y el servicio tendría que parsear
	// cada vez.
	for _, forbidden := range []string{
		"cart_snapshot                TEXT",
		"client_snapshot              TEXT",
		"totals_snapshot              TEXT",
		"cart_snapshot                JSON,",
		"client_snapshot              JSON,",
		"totals_snapshot              JSON,",
	} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 027 debe mantener los snapshots como JSONB, encontró %q", forbidden)
		}
	}

	// CHECKs obligatorios: enum, bounds de attempts, shape de error,
	// shape de clientTxId, coherencia de la máquina de materialización,
	// requerimiento de aprobación antes de SUCCEEDED.
	for _, constraint := range []string{
		"ck_pqpi_finalization_status_known",
		"CHECK (finalization_status IN ('NOT_STARTED', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED'))",
		"ck_pqpi_finalization_attempts_bounds",
		"CHECK (finalization_attempts >= 0 AND finalization_attempts <= 100)",
		"ck_pqpi_finalization_last_error_shape",
		"ck_pqpi_sale_client_tx_id_shape",
		"ck_pqpi_finalization_coherent",
		"ck_pqpi_finalization_requires_approval",
		"finalization_status <> 'SUCCEEDED'",
		"status IN ('APROBADA', 'CONFIRMADA_MANUAL')",
	} {
		if !strings.Contains(migration.Source, constraint) {
			t.Errorf("migration 027 debe declarar el CHECK/CONSTRAINT %q", constraint)
		}
	}

	// Las cuatro ramas de la biyección deben estar en el CHECK
	// coherente. Si alguien quita una rama (p. ej. permite SUCCEEDED
	// sin related_sale_id), la máquina queda contaminada.
	for _, branch := range []string{
		"finalization_status = 'NOT_STARTED'",
		"finalization_status = 'IN_PROGRESS'",
		"finalization_status = 'SUCCEEDED'",
		"finalization_status = 'FAILED'",
		"related_sale_id IS NOT NULL",
		"related_sale_id IS NULL",
		"sale_client_tx_id IS NOT NULL",
		"finalization_last_error IS NOT NULL",
		"finalization_last_error IS NULL",
	} {
		if !strings.Contains(migration.Source, branch) {
			t.Errorf("migration 027 debe incluir la rama %q en ck_pqpi_finalization_coherent", branch)
		}
	}

	// Índices obligatorios: dos UNIQUE partial (idempotencia cruzada)
	// y tres parciales para hot paths operativos.
	for _, idx := range []string{
		"CREATE UNIQUE INDEX IF NOT EXISTS ux_pqpi_sale_client_tx_id",
		"ON pos_qr_payment_intents (sale_client_tx_id)",
		"WHERE sale_client_tx_id IS NOT NULL",
		"CREATE UNIQUE INDEX IF NOT EXISTS ux_pqpi_related_sale_id",
		"ON pos_qr_payment_intents (related_sale_id)",
		"WHERE related_sale_id IS NOT NULL",
		"CREATE INDEX IF NOT EXISTS ix_pqpi_queued_bandeja",
		"ON pos_qr_payment_intents (caja_id, queued_at DESC)",
		"WHERE queued_at IS NOT NULL AND status = 'PENDIENTE'",
		"CREATE INDEX IF NOT EXISTS ix_pqpi_finalization_retry",
		"WHERE finalization_status = 'FAILED' AND finalization_next_retry_at IS NOT NULL",
		"CREATE INDEX IF NOT EXISTS ix_pqpi_finalization_in_progress",
		"WHERE finalization_status = 'IN_PROGRESS'",
	} {
		if !strings.Contains(migration.Source, idx) {
			t.Errorf("migration 027 debe declarar %q", idx)
		}
	}

	// Los seis CHECK se añaden vía DO $$ ... END $$ con lookup en
	// pg_constraint para idempotencia. Si alguien colapsa dos en el
	// mismo bloque, un fallo parcial deja el estado roto.
	if count := strings.Count(migration.Source, "\nDO $$\n"); count != 6 {
		t.Errorf("migration 027 debe tener exactamente 6 bloques DO $$ ejecutables (uno por CHECK), encontró %d", count)
	}
	if count := strings.Count(migration.Source, "FROM pg_constraint"); count != 6 {
		t.Errorf("migration 027 debe consultar pg_constraint en los 6 bloques idempotentes, encontró %d", count)
	}

	// Al ser transaccional NO puede usar CREATE INDEX CONCURRENTLY.
	// Postgres prohíbe CONCURRENTLY dentro de una transacción. El
	// regex del runner matchea sólo sentencias ejecutables, no la
	// palabra en comentarios "--".
	if concurrentIndexPattern.MatchString(migration.Source) {
		t.Error("migration 027 es transaccional: contiene una sentencia CREATE INDEX CONCURRENTLY ejecutable")
	}

	// Puramente DDL: la 027 NO backfillea datos legacy. Las intenciones
	// pre-027 quedan en finalization_status='NOT_STARTED' con snapshots
	// NULL; el servicio las trata como "cerradas por fuera" y no las
	// reintenta.
	for _, forbidden := range []string{
		"UPDATE pos_qr_payment_intents",
		"UPDATE pos_qr_webhook_events",
		"UPDATE sales",
		"DELETE FROM ",
		"INSERT INTO ",
	} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 027 debe ser puramente DDL, encontró %q", forbidden)
		}
	}

	// COMMENT ON COLUMN / CONSTRAINT / INDEX para que pg_dump
	// --schema-only conserve la justificación con la BD.
	for _, comment := range []string{
		"COMMENT ON COLUMN pos_qr_payment_intents.cart_snapshot",
		"COMMENT ON COLUMN pos_qr_payment_intents.client_snapshot",
		"COMMENT ON COLUMN pos_qr_payment_intents.totals_snapshot",
		"COMMENT ON COLUMN pos_qr_payment_intents.sale_client_tx_id",
		"COMMENT ON COLUMN pos_qr_payment_intents.queued_at",
		"COMMENT ON COLUMN pos_qr_payment_intents.finalization_status",
		"COMMENT ON COLUMN pos_qr_payment_intents.finalization_started_at",
		"COMMENT ON COLUMN pos_qr_payment_intents.finalization_completed_at",
		"COMMENT ON COLUMN pos_qr_payment_intents.finalization_attempts",
		"COMMENT ON COLUMN pos_qr_payment_intents.finalization_last_error",
		"COMMENT ON COLUMN pos_qr_payment_intents.finalization_next_retry_at",
		"COMMENT ON COLUMN pos_qr_payment_intents.cashier_notified_at",
		"COMMENT ON CONSTRAINT ck_pqpi_finalization_status_known ON pos_qr_payment_intents",
		"COMMENT ON CONSTRAINT ck_pqpi_finalization_coherent ON pos_qr_payment_intents",
		"COMMENT ON CONSTRAINT ck_pqpi_finalization_requires_approval ON pos_qr_payment_intents",
		"COMMENT ON CONSTRAINT ck_pqpi_sale_client_tx_id_shape ON pos_qr_payment_intents",
		"COMMENT ON CONSTRAINT ck_pqpi_finalization_attempts_bounds ON pos_qr_payment_intents",
		"COMMENT ON CONSTRAINT ck_pqpi_finalization_last_error_shape ON pos_qr_payment_intents",
		"COMMENT ON INDEX ux_pqpi_sale_client_tx_id",
		"COMMENT ON INDEX ux_pqpi_related_sale_id",
		"COMMENT ON INDEX ix_pqpi_queued_bandeja",
		"COMMENT ON INDEX ix_pqpi_finalization_retry",
		"COMMENT ON INDEX ix_pqpi_finalization_in_progress",
	} {
		if !strings.Contains(migration.Source, comment) {
			t.Errorf("migration 027 debe declarar %q", comment)
		}
	}

	// Documentación obligatoria: el archivo tiene que explicar POR QUÉ
	// se separa la máquina de materialización de la máquina de pago,
	// por qué sale_client_tx_id se reserva al emitir (no al cerrar),
	// por qué queued_at NO es un status del pago, por qué los
	// snapshots son inmutables, por qué no se backfillea, por qué los
	// secretos (BOLD_BRIDGE_TOKEN, BOLD_SECRET_KEY, firma HMAC) siguen
	// fuera del esquema, y la convivencia con confirmar-manual (que
	// queda deprecada en handler pero sus columnas permanecen).
	// Blindaje semántico: si alguien reemplaza el contenido sin esa
	// justificación, el test obliga a revisarlo.
	for _, mustExplain := range []string{
		"Bre-B",
		"MacroDroid",
		"co.bold",
		"BOLD_BRIDGE_TOKEN",
		"BOLD_SECRET_KEY",
		"HMAC",
		"inmutable",
		"snapshot",
		"clientTxId",
		"idempotencia",
		"reintentar",
		"backoff",
		"migración 009",
		"migración 026",
		"NOT_STARTED",
		"IN_PROGRESS",
		"SUCCEEDED",
		"FAILED",
		"bandeja",
		"queued_at",
		"ModalPagoBoldQR",
		"confirmar-manual",
		"AMBIGUOUS",
		"falso negativo",
		"SELECT ... FOR UPDATE",
		"CreateSale",
		"soft delete",
		"append-only",
		"audit",
		"segundo plano",
	} {
		if !strings.Contains(migration.Source, mustExplain) {
			t.Errorf("migration 027 debe documentar %q en comentarios", mustExplain)
		}
	}

	// Guardas contra fuga de secretos: la 027 NO debe persistir el
	// token del bridge ni la firma HMAC-SHA256 ni el payload crudo. Si
	// alguien introduce una columna llamada así, el test grita. Mismo
	// guardián que la 026, replicado aquí para que al extender la
	// tabla no se filtre un secreto por error.
	for _, forbiddenColumn := range []string{
		"bold_bridge_token ",
		"bold_bridge_token\t",
		"signature_header ",
		"x_bold_signature ",
		"raw_payload ",
		"raw_payload_json ",
		"payload_raw ",
	} {
		if strings.Contains(migration.Source, forbiddenColumn) {
			t.Errorf("migration 027 no debe persistir secretos ni payload crudo, encontró columna %q", forbiddenColumn)
		}
	}

	// La 027 limita su alcance a pos_qr_payment_intents. Si alguien
	// agrega ALTER TABLE sobre otras tablas (sales, employees,
	// audit_logs, pos_qr_webhook_events, etc.), debe ser una migración
	// 028+ con su propia justificación. En particular NO toca
	// pos_qr_webhook_events (la ingestión del webhook sigue igual).
	for _, forbiddenAlter := range []string{
		"ALTER TABLE sales",
		"ALTER TABLE employees",
		"ALTER TABLE audit_logs",
		"ALTER TABLE pos_qr_webhook_events",
		"ALTER TABLE cash_drawer_opens",
		"ALTER TABLE cash_drawer_otp_challenges",
		"ALTER TABLE label_codes",
		"ALTER TABLE products",
		"ALTER TABLE package_barcode_aliases",
		"ALTER TABLE internal_barcode_reservations",
	} {
		if strings.Contains(migration.Source, forbiddenAlter) {
			t.Errorf("migration 027 debe limitarse a pos_qr_payment_intents, encontró %q", forbiddenAlter)
		}
	}
}

func TestMigration028ExpensesBoldQrAmountIsTransactionalWithScopedBackfill(t *testing.T) {
	catalog, err := Catalog()
	if err != nil {
		t.Fatalf("Catalog() error = %v", err)
	}
	var migration *Migration
	for i := range catalog {
		if catalog[i].Version == 28 {
			migration = &catalog[i]
			break
		}
	}
	if migration == nil {
		t.Fatal("migration 028 no está en el catálogo")
	}
	if !migration.Transactional {
		t.Fatal("migration 028 debe ser transaccional: ADD COLUMN + UPDATE acotado, sin CREATE INDEX CONCURRENTLY")
	}

	// La 028 extiende expenses y nada más. Si alguien agrega CREATE
	// TABLE o toca otra entidad, debe ser una migración 029+ con su
	// propia justificación.
	if strings.Contains(migration.Source, "CREATE TABLE") {
		t.Error("migration 028 no debe crear tablas nuevas (sólo extiende expenses con un bolsillo)")
	}

	// Columna nueva con tipo exacto. Si alguien cambia DECIMAL(10,2) por
	// otro tipo (NUMERIC(14,2), DOUBLE PRECISION, FLOAT), rompe la
	// familia de bolsillos: cash_amount, nequi_amount, daviplata_amount,
	// fondo_amount y coins_amount son todos DECIMAL(10,2) DEFAULT 0.
	if !strings.Contains(migration.Source, "ADD COLUMN IF NOT EXISTS bold_qr_amount DECIMAL(10,2) NOT NULL DEFAULT 0") {
		t.Error("migration 028 debe declarar `ADD COLUMN IF NOT EXISTS bold_qr_amount DECIMAL(10,2) NOT NULL DEFAULT 0` (misma forma que los otros cinco bolsillos)")
	}

	// Blindaje tipo-de-dinero: ningún FLOAT ni DOUBLE PRECISION ni REAL
	// en la columna nueva. Mismo guardián que las 019/021/023.
	for _, forbidden := range []string{
		"bold_qr_amount FLOAT",
		"bold_qr_amount DOUBLE PRECISION",
		"bold_qr_amount REAL",
		"bold_qr_amount NUMERIC(14,2)",
	} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 028 debe usar DECIMAL(10,2) como el resto de bolsillos de expenses, encontró %q", forbidden)
		}
	}

	// La 028 limita su alcance a la tabla expenses. Si alguien agrega
	// ALTER TABLE sobre otras tablas, debe ser una migración 029+ con
	// su propia justificación.
	for _, forbiddenAlter := range []string{
		"ALTER TABLE sales",
		"ALTER TABLE cashier_closures",
		"ALTER TABLE audit_logs",
		"ALTER TABLE pos_qr_payment_intents",
		"ALTER TABLE pos_qr_webhook_events",
		"ALTER TABLE loans",
		"ALTER TABLE loan_installments",
		"ALTER TABLE loan_expenses",
		"ALTER TABLE products",
	} {
		if strings.Contains(migration.Source, forbiddenAlter) {
			t.Errorf("migration 028 debe limitarse a expenses, encontró %q", forbiddenAlter)
		}
	}

	// Al ser transaccional NO puede usar CREATE INDEX CONCURRENTLY.
	// Postgres prohíbe CONCURRENTLY dentro de una transacción. El regex
	// del runner matchea sólo sentencias ejecutables, no la palabra en
	// comentarios "--".
	if concurrentIndexPattern.MatchString(migration.Source) {
		t.Error("migration 028 es transaccional: contiene una sentencia CREATE INDEX CONCURRENTLY ejecutable")
	}

	// COMMENT ON COLUMN obligatorio: pg_dump --schema-only debe llevar
	// la justificación con la BD. Blindaje operativo contra
	// documentación perdida.
	if !strings.Contains(migration.Source, "COMMENT ON COLUMN expenses.bold_qr_amount") {
		t.Error("migration 028 debe declarar COMMENT ON COLUMN expenses.bold_qr_amount")
	}

	// Backfill acotado: UPPER(status)='PAID', deleted_at IS NULL,
	// paymentSource canónico 'BOLD_QR' y los cinco bolsillos físicos en
	// cero. Si alguien afloja estas guardas (p.ej. incluye SETTLED),
	// está moviendo dinero del padre al bolsillo cuando en realidad
	// vive en los hijos abonos; o peor, cuenta dos veces el mismo
	// dinero.
	for _, backfillBit := range []string{
		"UPDATE expenses",
		"SET bold_qr_amount = amount",
		"UPPER(status) = 'PAID'",
		"deleted_at IS NULL",
		`UPPER(COALESCE("paymentSource", '')) = 'BOLD_QR'`,
		"COALESCE(cash_amount, 0)      = 0",
		"COALESCE(nequi_amount, 0)     = 0",
		"COALESCE(daviplata_amount, 0) = 0",
		"COALESCE(fondo_amount, 0)     = 0",
		"COALESCE(coins_amount, 0)     = 0",
		"bold_qr_amount                = 0",
		"amount                        > 0",
	} {
		if !strings.Contains(migration.Source, backfillBit) {
			t.Errorf("migration 028 debe tener el backfill acotado con %q", backfillBit)
		}
	}

	// El backfill NO debe incluir SETTLED: ver la nota larga en el
	// archivo SQL y en expense_service.go#SettleExpense. SETTLED es el
	// padre de una cadena de abonos (hijos PAID) y marcarlo con
	// bold_qr_amount = amount duplicaría el dinero. Barremos los
	// comentarios -- antes de buscar para no gritar cuando la
	// documentación menciona SETTLED explicando por qué NO se incluye.
	lineCommentRe := regexp.MustCompile(`(?m)--[^\n]*`)
	blockCommentRe := regexp.MustCompile(`(?s)/\*.*?\*/`)
	executable := blockCommentRe.ReplaceAllString(migration.Source, "")
	executable = lineCommentRe.ReplaceAllString(executable, "")
	for _, forbiddenScope := range []string{
		"'SETTLED'",
		"IN ('PAID', 'SETTLED')",
		"IN ('SETTLED', 'PAID')",
		"IN ('PAID','SETTLED')",
	} {
		if strings.Contains(executable, forbiddenScope) {
			t.Errorf("migration 028 no debe backfillear status SETTLED en una sentencia ejecutable (dinero vive en los abonos hijos PAID, no en el padre): encontró %q", forbiddenScope)
		}
	}
	// Tampoco debe mutar otras tablas o campos. Explícitamente
	// prohibido UPDATE sobre tablas distintas a expenses, DELETE o
	// INSERT. Dentro de expenses, el único SET admitido es
	// bold_qr_amount; si alguien introduce `SET status = ...` o
	// `SET paymentSource = ...` cambia la semántica del migración.
	for _, forbidden := range []string{
		"UPDATE sales",
		"UPDATE cashier_closures",
		"UPDATE audit_logs",
		"UPDATE pos_qr_payment_intents",
		"UPDATE pos_qr_webhook_events",
		"UPDATE products",
		"UPDATE loans",
		"UPDATE loan_installments",
		"UPDATE loan_expenses",
		"DELETE FROM ",
		"INSERT INTO ",
		"SET status =",
		`SET "paymentSource"`,
		"SET amount =",
		"SET tax_amount =",
		"SET paid_amount =",
		"SET remaining_amount =",
	} {
		if strings.Contains(migration.Source, forbidden) {
			t.Errorf("migration 028 sólo debe hacer SET bold_qr_amount = amount sobre expenses: encontró %q", forbidden)
		}
	}

	// Documentación obligatoria. El archivo debe explicar POR QUÉ
	// se agrega la columna ahora, POR QUÉ el backfill no incluye
	// SETTLED, POR QUÉ no se agrega CHECK >= 0 (consistencia con los
	// otros bolsillos), POR QUÉ la vista mv_dashboard_stats_monthly no
	// necesita refresh (suma amount, no bolsillos) y la relación con
	// payment_source_boldqr.go y expense_bold_qr_normalize.go.
	for _, mustExplain := range []string{
		"BOLD_QR",
		"Bre-B",
		"bolsillo",
		"SETTLED",
		"abono",
		"SettleExpense",
		"payment_source_boldqr",
		"expense_bold_qr_normalize",
		"DECIMAL(10,2)",
		"mv_dashboard_stats_monthly",
		"metadata-only",
		"idempotente",
		"PostgreSQL 11+",
	} {
		if !strings.Contains(migration.Source, mustExplain) {
			t.Errorf("migration 028 debe documentar %q en comentarios", mustExplain)
		}
	}
}
