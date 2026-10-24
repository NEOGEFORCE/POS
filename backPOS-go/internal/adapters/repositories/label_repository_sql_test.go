package repositories

import (
	"context"
	"database/sql/driver"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
)

// =============================================================================
// Pruebas de las sentencias SQL que REALMENTE emite el repositorio de
// etiquetas. Se usa GORM en modo DryRun con el dialecto Postgres: el código
// se ejecuta de verdad (mismos builders, mismas cláusulas) pero nada viaja a
// una base. Un logger captura cada sentencia con sus parámetros bind.
//
// Además, TestLabelRepo_AlternateCodes_PostgresReal corre contra un
// Postgres real si se define POS_TEST_DATABASE_URL (usa tablas TEMP dentro
// de una tx que se revierte; no toca datos).
// =============================================================================

type capturedStmt struct {
	SQL  string
	Vars []interface{}
}

type sqlCapture struct {
	logger.Interface
	mu    sync.Mutex
	stmts []capturedStmt
}

// ParamsFilter lo invoca GORM con el SQL con placeholders y sus vars
// antes de interpolarlos para el log.
func (c *sqlCapture) ParamsFilter(_ context.Context, sql string, params ...interface{}) (string, []interface{}) {
	c.mu.Lock()
	c.stmts = append(c.stmts, capturedStmt{SQL: sql, Vars: append([]interface{}(nil), params...)})
	c.mu.Unlock()
	return sql, params
}

func (c *sqlCapture) Trace(ctx context.Context, begin time.Time, fc func() (string, int64), err error) {
	fc() // fuerza ParamsFilter
}

func (c *sqlCapture) LogMode(logger.LogLevel) logger.Interface { return c }

func newDryRunDB(t *testing.T) (*gorm.DB, *sqlCapture) {
	t.Helper()
	capture := &sqlCapture{Interface: logger.Discard}
	db, err := gorm.Open(postgres.New(postgres.Config{
		// Nunca se conecta: DryRun + sin ping automático.
		DSN: "host=127.0.0.1 port=1 user=dryrun dbname=dryrun sslmode=disable",
	}), &gorm.Config{
		DryRun:               true,
		DisableAutomaticPing: true,
		Logger:               capture,
	})
	if err != nil {
		t.Fatalf("abriendo gorm DryRun: %v", err)
	}
	return db, capture
}

func TestLabelRepo_AlternateCodesColumnCoincideConElModelo(t *testing.T) {
	sch, err := schema.Parse(&models.Product{}, &sync.Map{}, schema.NamingStrategy{})
	if err != nil {
		t.Fatalf("parse schema Product: %v", err)
	}
	field := sch.LookUpField("AlternateCodes")
	if field == nil {
		t.Fatal("models.Product ya no tiene AlternateCodes; revisar la colisión de códigos")
	}
	if !strings.Contains(alternateCodesContainsSQL, field.DBName) {
		t.Fatalf("la consulta de colisión debe usar la columna real %q; usa: %s", field.DBName, alternateCodesContainsSQL)
	}
}

func TestLabelRepo_CodeExistsAnywhereTx_SQLEmitido(t *testing.T) {
	db, capture := newDryRunDB(t)
	const candidate = "LC-abc123def456"

	exists, err := codeExistsAnywhereTx(context.Background(), db, candidate)
	if err != nil {
		t.Fatalf("codeExistsAnywhereTx: %v", err)
	}
	if exists {
		t.Fatal("en DryRun no hay filas; no debería reportar colisión")
	}
	// Fix 2026-10-13: ahora se consultan CUATRO fuentes (products.barcode,
	// alternate_codes, label_codes.code y package_barcode_aliases.package_code)
	// para cerrar el hueco "label code vs package alias". Si alguien
	// vuelve a 3, el guardián cruzado de la 024 deja un flanco abierto.
	if len(capture.stmts) != 4 {
		t.Fatalf("se esperaban exactamente 4 consultas (barcode, alternate_codes, label_codes, package_barcode_aliases), hubo %d: %+v", len(capture.stmts), capture.stmts)
	}
	for i, st := range capture.stmts {
		if strings.Contains(st.SQL, "alternateCodes") {
			t.Errorf("consulta %d usa la columna inexistente \"alternateCodes\": %s", i, st.SQL)
		}
		if strings.Contains(st.SQL, candidate) {
			t.Errorf("consulta %d concatena el candidato en el SQL (debe ir como parámetro): %s", i, st.SQL)
		}
		if len(st.Vars) != 1 || st.Vars[0] != candidate {
			t.Errorf("consulta %d debe llevar el candidato como único parámetro bind; vars=%v", i, st.Vars)
		}
	}
	if !strings.Contains(capture.stmts[1].SQL, "alternate_codes") {
		t.Errorf("la segunda consulta debe ir contra alternate_codes: %s", capture.stmts[1].SQL)
	}
	if !strings.Contains(capture.stmts[2].SQL, "label_codes") {
		t.Errorf("la tercera consulta debe ir contra label_codes: %s", capture.stmts[2].SQL)
	}
	if !strings.Contains(capture.stmts[3].SQL, "package_barcode_aliases") {
		t.Errorf("la cuarta consulta debe ir contra package_barcode_aliases: %s", capture.stmts[3].SQL)
	}
	if !strings.Contains(capture.stmts[3].SQL, "package_code") {
		t.Errorf("la cuarta consulta debe filtrar por package_code: %s", capture.stmts[3].SQL)
	}
}

func TestLabelRepo_LockProductBarcodeTx_AdvisoryLockParametrizado(t *testing.T) {
	db, capture := newDryRunDB(t)
	if err := lockProductBarcodeTx(db, "7701234567890"); err != nil {
		t.Fatalf("lockProductBarcodeTx: %v", err)
	}
	if len(capture.stmts) != 1 {
		t.Fatalf("se esperaba 1 sentencia, hubo %d", len(capture.stmts))
	}
	st := capture.stmts[0]
	if !strings.Contains(st.SQL, "pg_advisory_xact_lock(hashtext(") {
		t.Errorf("el lock debe ser pg_advisory_xact_lock (se libera con la tx): %s", st.SQL)
	}
	if len(st.Vars) != 1 || st.Vars[0] != "label_codes:product_barcode:7701234567890" {
		t.Errorf("la clave del lock debe ir como parámetro y con namespace; vars=%v", st.Vars)
	}
}

func TestLabelRepo_LabelBarcodeLockKey_DistingueBarcodes(t *testing.T) {
	a := labelBarcodeLockKey("123")
	b := labelBarcodeLockKey("1234")
	if a == b {
		t.Fatal("barcodes distintos deben producir claves distintas")
	}
	if !strings.HasPrefix(a, "label_codes:") {
		t.Fatalf("la clave debe tener namespace propio para no chocar con otros advisory locks: %q", a)
	}
}

func TestLabelRepo_ResolveLabelCode_SinMigracion016DevuelveUnknown(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(q, "to_regclass") {
			return one("exists", false) // 016 no aplicada
		}
		return fakeResult{Err: errors.New(`relation "label_codes" does not exist`)}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	res, err := repo.ResolveLabelCode(context.Background(), "  LC-0a1b2c3d4e5f  ")
	if err != nil {
		t.Fatalf("con la 016 ausente no debe fallar: %v", err)
	}
	if res == nil || res.Match != "unknown" || res.Code != "LC-0a1b2c3d4e5f" {
		t.Fatalf("debe responder unknown con el código normalizado; got %+v", res)
	}
	stmts := f.statements()
	if len(stmts) != 1 {
		t.Fatalf("con la tabla ausente sólo debe emitirse el chequeo de existencia; hubo %d: %+v", len(stmts), stmts)
	}
	if strings.Contains(stmts[0].SQL, "FROM label_codes") {
		t.Errorf("el chequeo no debe nombrar label_codes: %s", stmts[0].SQL)
	}
}

func TestLabelRepo_ResolveLabelCode_ResuelveExactoYParametrizado(t *testing.T) {
	payload := `{"code":"LC-0a1b2c3d4e5f","product_barcode":"770100","product_name":"ARROZ","sale_price":2500,"purchase_price":2000,"quantity":10,"is_weighted":false,"is_pack":false}`
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(q, "to_regclass") {
			return one("exists", true)
		}
		return one("payload", payload)
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	res, err := repo.ResolveLabelCode(context.Background(), " LC-0a1b2c3d4e5f\t")
	if err != nil {
		t.Fatalf("ResolveLabelCode: %v", err)
	}
	if res.Match != "label_code" || res.ProductBarcode != "770100" || res.Product == nil || res.Product.ProductName != "ARROZ" {
		t.Fatalf("resolución inesperada: %+v", res)
	}
	stmts := f.statements()
	if len(stmts) != 2 {
		t.Fatalf("se esperaban 2 sentencias (existencia + lookup), hubo %d", len(stmts))
	}
	q := stmts[1]
	if !containsAll(q.SQL, "lc.code = $1", "voided_at IS NULL", "product_barcode IS NOT NULL") {
		t.Errorf("el lookup debe ser exacto, excluir anulados y libres: %s", q.SQL)
	}
	if strings.Contains(q.SQL, "package_barcode_aliases") || strings.Contains(q.SQL, "LIKE") {
		t.Errorf("la caja no debe usar alias de paquete ni LIKE: %s", q.SQL)
	}
	if len(q.Vars) != 1 || q.Vars[0] != "LC-0a1b2c3d4e5f" {
		t.Errorf("el código normalizado (TrimSpace, sin ToUpper) debe ser el único parámetro; vars=%v", q.Vars)
	}
}

func TestLabelRepo_EnsureCodeForProduct_ReusaCodigoVivoBajoLock(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(q, "FROM \"label_codes\"") && strings.Contains(q, "product_barcode") {
			return fakeResult{
				Columns: []string{"code", "product_barcode"},
				Rows:    [][]driver.Value{{"LC-existing00001", "770100"}},
			}
		}
		return fakeResult{Columns: []string{"count"}, Rows: [][]driver.Value{{int64(0)}}}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	code, created, err := repo.EnsureCodeForProduct(context.Background(), " 770100 ", nil, "", "ADMIN-1")
	if err != nil {
		t.Fatalf("EnsureCodeForProduct: %v", err)
	}
	if created || code.Code != "LC-existing00001" {
		t.Fatalf("debe reusar el código vivo sin crear; created=%v code=%+v", created, code)
	}
	stmts := f.statements()
	if len(stmts) < 2 || !strings.Contains(stmts[0].SQL, "pg_advisory_xact_lock") {
		t.Fatalf("la primera sentencia de la tx debe ser el advisory lock; got %+v", stmts)
	}
	if stmts[0].Vars[0] != "label_codes:product_barcode:770100" {
		t.Errorf("la clave del lock debe usar el barcode normalizado; vars=%v", stmts[0].Vars)
	}
	for _, st := range stmts {
		if strings.HasPrefix(strings.TrimSpace(strings.ToUpper(st.SQL)), "INSERT") {
			t.Errorf("no debe insertar cuando ya existe un código vivo: %s", st.SQL)
		}
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("debe correr en una sola transacción confirmada; eventos=%v", f.txEvents)
	}
}

func TestLabelRepo_EnsureCodeForProduct_CreaCodigoNuevoTrasVerificarColisiones(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(q, "count(") || strings.Contains(q, "COUNT(") {
			return one("count", int64(0))
		}
		return fakeResult{Columns: []string{"code"}} // lookup sin filas / RETURNING vacío
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	code, created, err := repo.EnsureCodeForProduct(context.Background(), "770100", nil, "nota", "ADMIN-1")
	if err != nil {
		t.Fatalf("EnsureCodeForProduct: %v", err)
	}
	if !created || !strings.HasPrefix(code.Code, "LC-") || code.ProductBarcode == nil || *code.ProductBarcode != "770100" {
		t.Fatalf("debe crear un código nuevo para el producto; created=%v code=%+v", created, code)
	}

	stmts := f.statements()
	var order []string
	for _, st := range stmts {
		switch {
		case strings.Contains(st.SQL, "pg_advisory_xact_lock"):
			order = append(order, "lock")
		case strings.Contains(st.SQL, "alternate_codes"):
			order = append(order, "alt")
		case strings.Contains(strings.ToUpper(st.SQL), "INSERT INTO \"LABEL_CODES\""):
			order = append(order, "insert")
		}
		if strings.Contains(st.SQL, "alternateCodes") {
			t.Errorf("columna inexistente \"alternateCodes\" en: %s", st.SQL)
		}
	}
	got := strings.Join(order, ",")
	if got != "lock,alt,insert" {
		t.Fatalf("orden esperado lock → colisión alternate_codes → insert; got %q (%+v)", got, stmts)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("debe correr en una sola transacción confirmada; eventos=%v", f.txEvents)
	}
}

func TestLabelRepo_EnsureCodeForProduct_ErrorDeColisionRevierte(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		if strings.Contains(q, "alternate_codes") {
			return fakeResult{Err: errors.New("boom")}
		}
		if strings.Contains(q, "count(") || strings.Contains(q, "COUNT(") {
			return one("count", int64(0))
		}
		return fakeResult{Columns: []string{"code"}}
	}}
	repo := NewLabelRepository(newFakeGormDB(t, f))

	if _, _, err := repo.EnsureCodeForProduct(context.Background(), "770100", nil, "", "ADMIN-1"); err == nil {
		t.Fatal("un error en la verificación de colisiones debe propagarse")
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("la tx debe revertirse; eventos=%v", f.txEvents)
	}
	for _, st := range f.statements() {
		if strings.Contains(strings.ToUpper(st.SQL), "INSERT") {
			t.Errorf("no debe insertar si la verificación falló: %s", st.SQL)
		}
	}
}

// TestLabelRepo_AlternateCodes_PostgresReal ejecuta la consulta de
// colisión contra Postgres real. Opt-in: requiere POS_TEST_DATABASE_URL.
// Crea tablas TEMP (que sombrean a las reales dentro de la sesión) en una
// tx que siempre se revierte.
func TestLabelRepo_AlternateCodes_PostgresReal(t *testing.T) {
	dsn := os.Getenv("POS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("POS_TEST_DATABASE_URL no definido; prueba contra Postgres real omitida")
	}
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatalf("conectando: %v", err)
	}
	tx := db.Begin()
	defer tx.Rollback()

	for _, stmt := range []string{
		`CREATE TEMP TABLE products (barcode text, alternate_codes text) ON COMMIT DROP`,
		`CREATE TEMP TABLE label_codes (code text) ON COMMIT DROP`,
		`INSERT INTO products VALUES ('770100', 'ABC1, lc-dup000000001 ,XYZ'), ('770200', NULL)`,
		`INSERT INTO label_codes VALUES ('LC-taken0000001')`,
	} {
		if err := tx.Exec(stmt).Error; err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}

	cases := map[string]bool{
		"770100":          true,  // barcode principal
		"LC-DUP000000001": true,  // alterno con espacios y otra caja
		"LC-dup00000000":  false, // subcadena: no es colisión
		"LC-taken0000001": true,  // ya existe en label_codes
		"LC-free00000001": false,
	}
	for candidate, want := range cases {
		got, err := codeExistsAnywhereTx(context.Background(), tx, candidate)
		if err != nil {
			t.Fatalf("%s: %v", candidate, err)
		}
		if got != want {
			t.Errorf("%s: colisión=%v, se esperaba %v", candidate, got, want)
		}
	}
}
