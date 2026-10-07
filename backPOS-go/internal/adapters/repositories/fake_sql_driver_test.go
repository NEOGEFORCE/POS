package repositories

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// =============================================================================
// fakeSQL: driver database/sql en memoria para ejecutar el código del
// repositorio a través de GORM de verdad (con Begin/Commit, Exec, Query y
// Scan reales), sin Postgres. Registra cada sentencia con sus parámetros y
// responde según una función que decide el test.
//
// No reemplaza una prueba contra Postgres (no valida sintaxis SQL), pero sí
// prueba el ORDEN de las sentencias, que todo vaya parametrizado, el uso de
// la transacción y las ramas del código según lo que devuelva la base.
// =============================================================================

type fakeResult struct {
	Columns []string
	Rows    [][]driver.Value
	Err     error
}

type fakeSQL struct {
	mu        sync.Mutex
	stmts     []capturedStmt
	txEvents  []string
	respond   func(query string, args []interface{}) fakeResult
	execError func(query string, args []interface{}) error
}

func (f *fakeSQL) record(query string, args []driver.NamedValue) []interface{} {
	vals := make([]interface{}, len(args))
	for i, a := range args {
		vals[i] = a.Value
	}
	f.mu.Lock()
	f.stmts = append(f.stmts, capturedStmt{SQL: query, Vars: vals})
	f.mu.Unlock()
	return vals
}

func (f *fakeSQL) statements() []capturedStmt {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]capturedStmt(nil), f.stmts...)
}

// Connector / Driver -----------------------------------------------------------

type fakeConnector struct{ f *fakeSQL }

func (c fakeConnector) Connect(context.Context) (driver.Conn, error) { return &fakeConn{f: c.f}, nil }
func (c fakeConnector) Driver() driver.Driver                        { return fakeDriver{f: c.f} }

type fakeDriver struct{ f *fakeSQL }

func (d fakeDriver) Open(string) (driver.Conn, error) { return &fakeConn{f: d.f}, nil }

// Conn ---------------------------------------------------------------------------

type fakeConn struct{ f *fakeSQL }

func (c *fakeConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("fakeSQL: Prepare no soportado; se usa QueryContext/ExecContext")
}
func (c *fakeConn) Close() error { return nil }
func (c *fakeConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}
func (c *fakeConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	c.f.mu.Lock()
	c.f.txEvents = append(c.f.txEvents, "BEGIN")
	c.f.mu.Unlock()
	return fakeTx{f: c.f}, nil
}

func (c *fakeConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	vals := c.f.record(query, args)
	res := fakeResult{}
	if c.f.respond != nil {
		res = c.f.respond(query, vals)
	}
	if res.Err != nil {
		return nil, res.Err
	}
	return &fakeRows{cols: res.Columns, rows: res.Rows}, nil
}

func (c *fakeConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	vals := c.f.record(query, args)
	if c.f.execError != nil {
		if err := c.f.execError(query, vals); err != nil {
			return nil, err
		}
	}
	return driver.RowsAffected(1), nil
}

func (c *fakeConn) CheckNamedValue(*driver.NamedValue) error { return nil }

type fakeTx struct{ f *fakeSQL }

func (t fakeTx) Commit() error {
	t.f.mu.Lock()
	t.f.txEvents = append(t.f.txEvents, "COMMIT")
	t.f.mu.Unlock()
	return nil
}
func (t fakeTx) Rollback() error {
	t.f.mu.Lock()
	t.f.txEvents = append(t.f.txEvents, "ROLLBACK")
	t.f.mu.Unlock()
	return nil
}

// Rows ---------------------------------------------------------------------------

type fakeRows struct {
	cols []string
	rows [][]driver.Value
	i    int
}

func (r *fakeRows) Columns() []string { return r.cols }
func (r *fakeRows) Close() error      { return nil }
func (r *fakeRows) Next(dest []driver.Value) error {
	if r.i >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.i])
	r.i++
	return nil
}

// Helpers ------------------------------------------------------------------------

func newFakeGormDB(t *testing.T, f *fakeSQL) *gorm.DB {
	t.Helper()
	sqlDB := sql.OpenDB(fakeConnector{f: f})
	t.Cleanup(func() { _ = sqlDB.Close() })
	db, err := gorm.Open(postgres.New(postgres.Config{Conn: sqlDB}), &gorm.Config{
		DisableAutomaticPing: true,
		Logger:               logger.Discard,
	})
	if err != nil {
		t.Fatalf("abriendo gorm sobre fakeSQL: %v", err)
	}
	return db
}

func one(col string, v driver.Value) fakeResult {
	return fakeResult{Columns: []string{col}, Rows: [][]driver.Value{{v}}}
}

func containsAll(s string, parts ...string) bool {
	for _, p := range parts {
		if !strings.Contains(s, p) {
			return false
		}
	}
	return true
}
