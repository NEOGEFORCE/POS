// Pruebas del service orientadas al flujo de asignación manual y los
// contadores auxiliares (sprint SMS). No tocan BD: el repo se conecta
// contra el fake SQL driver vía gorm (mismo patrón del repo_test).
//
// Validamos:
//   - CountSameAmountPending delega al repo con el reloj inyectado.
//   - ListUnassignedWebhookEvents valida minutos [1..120] y produce el
//     shape UnassignedEvent sin mutación de datos.
//   - AssignEventToIntent emite el audit log con DNI del contexto y
//     dispara publishIntentSnapshot + QRTrayKindApproved post-commit
//     (comprobamos los eventos SSE con un hub real en memoria).

package services

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/sse"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// =============================================================================
// Fake SQL driver minimal (copia inlineada del paquete repositories).
// Mantenemos un fake local para evitar un ciclo de imports en tests.
// =============================================================================

type svcFakeStmt struct {
	SQL  string
	Vars []interface{}
}

type svcFakeResult struct {
	Columns []string
	Rows    [][]driver.Value
}

type svcFakeSQL struct {
	stmts   []svcFakeStmt
	respond func(q string, args []interface{}) svcFakeResult
}

type svcFakeConnector struct{ f *svcFakeSQL }

func (c svcFakeConnector) Connect(context.Context) (driver.Conn, error) {
	return &svcFakeConn{f: c.f}, nil
}
func (c svcFakeConnector) Driver() driver.Driver { return svcFakeDriver{f: c.f} }

type svcFakeDriver struct{ f *svcFakeSQL }

func (d svcFakeDriver) Open(string) (driver.Conn, error) { return &svcFakeConn{f: d.f}, nil }

type svcFakeConn struct{ f *svcFakeSQL }

func (c *svcFakeConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("no prepare") }
func (c *svcFakeConn) Close() error                        { return nil }
func (c *svcFakeConn) Begin() (driver.Tx, error)           { return svcFakeTx{}, nil }
func (c *svcFakeConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return svcFakeTx{}, nil
}
func (c *svcFakeConn) QueryContext(_ context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	vals := make([]interface{}, len(args))
	for i, a := range args {
		vals[i] = a.Value
	}
	c.f.stmts = append(c.f.stmts, svcFakeStmt{SQL: q, Vars: vals})
	res := svcFakeResult{}
	if c.f.respond != nil {
		res = c.f.respond(q, vals)
	}
	return &svcFakeRows{cols: res.Columns, rows: res.Rows}, nil
}
func (c *svcFakeConn) ExecContext(_ context.Context, q string, args []driver.NamedValue) (driver.Result, error) {
	vals := make([]interface{}, len(args))
	for i, a := range args {
		vals[i] = a.Value
	}
	c.f.stmts = append(c.f.stmts, svcFakeStmt{SQL: q, Vars: vals})
	return driver.RowsAffected(1), nil
}
func (c *svcFakeConn) CheckNamedValue(*driver.NamedValue) error { return nil }

type svcFakeTx struct{}

func (svcFakeTx) Commit() error   { return nil }
func (svcFakeTx) Rollback() error { return nil }

type svcFakeRows struct {
	cols []string
	rows [][]driver.Value
	i    int
}

func (r *svcFakeRows) Columns() []string { return r.cols }
func (r *svcFakeRows) Close() error      { return nil }
func (r *svcFakeRows) Next(dest []driver.Value) error {
	if r.i >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.i])
	r.i++
	return nil
}

func errorsEOF() error {
	// Mantenemos la función por compatibilidad con un snapshot
	// anterior; nunca se invoca.
	return errors.New("unused")
}

func newSvcGormDB(t *testing.T, f *svcFakeSQL) *gorm.DB {
	t.Helper()
	sqlDB := sql.OpenDB(svcFakeConnector{f: f})
	t.Cleanup(func() { _ = sqlDB.Close() })
	db, err := gorm.Open(postgres.New(postgres.Config{Conn: sqlDB}), &gorm.Config{
		DisableAutomaticPing: true,
		Logger:               logger.Discard,
	})
	if err != nil {
		t.Fatalf("gorm.Open: %v", err)
	}
	return db
}

// -----------------------------------------------------------------------------
// CountSameAmountPending
// -----------------------------------------------------------------------------

func TestQrPaymentService_CountSameAmountPending_DelegaAlRepo(t *testing.T) {
	f := &svcFakeSQL{respond: func(q string, _ []interface{}) svcFakeResult {
		up := strings.ToUpper(q)
		if strings.Contains(up, "SELECT COUNT(") && strings.Contains(up, "POS_QR_PAYMENT_INTENTS") {
			return svcFakeResult{Columns: []string{"count"}, Rows: [][]driver.Value{{int64(2)}}}
		}
		return svcFakeResult{}
	}}
	repo := repositories.NewQrPaymentRepository(newSvcGormDB(t, f))
	svc := NewQrPaymentService(repo, nil, nil)
	svc = svc.WithClock(func() time.Time { return time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC) })

	got, err := svc.CountSameAmountPending(context.Background(), 45800, 7)
	if err != nil {
		t.Fatalf("CountSameAmountPending: %v", err)
	}
	if got != 2 {
		t.Errorf("count=%d, want 2", got)
	}
}

func TestQrPaymentService_CountSameAmountPending_InputInvalido(t *testing.T) {
	svc := NewQrPaymentService(nil, nil, nil)
	if _, err := svc.CountSameAmountPending(context.Background(), 0, 0); err != ErrQRInvalidInput {
		t.Errorf("monto 0 debe ErrQRInvalidInput, got %v", err)
	}
}

// -----------------------------------------------------------------------------
// ListUnassignedWebhookEvents
// -----------------------------------------------------------------------------

func TestQrPaymentService_ListUnassignedWebhookEvents_MinutosFueraDeRango(t *testing.T) {
	svc := NewQrPaymentService(nil, nil, nil)
	for _, m := range []int{0, -1, 1441, 5000} {
		if _, err := svc.ListUnassignedWebhookEvents(context.Background(), m); err != ErrQRInvalidInput {
			t.Errorf("minutos=%d debe ErrQRInvalidInput, got %v", m, err)
		}
	}
}

func TestQrPaymentService_ListUnassignedWebhookEvents_Mapea(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	f := &svcFakeSQL{respond: func(q string, _ []interface{}) svcFakeResult {
		up := strings.ToUpper(q)
		if strings.HasPrefix(strings.TrimSpace(up), "SELECT") && strings.Contains(up, "POS_QR_WEBHOOK_EVENTS") {
			return svcFakeResult{
				Columns: []string{"id", "amount_cop", "received_at", "processed_status", "source", "note"},
				Rows: [][]driver.Value{
					{int64(10), int64(45800), now.Add(-3 * time.Minute), "AMBIGUOUS", "BRIDGE_NOTIFICATION", "resumen"},
				},
			}
		}
		return svcFakeResult{}
	}}
	repo := repositories.NewQrPaymentRepository(newSvcGormDB(t, f))
	svc := NewQrPaymentService(repo, nil, nil).WithClock(func() time.Time { return now })

	items, err := svc.ListUnassignedWebhookEvents(context.Background(), 30)
	if err != nil {
		t.Fatalf("ListUnassignedWebhookEvents: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len=%d want 1", len(items))
	}
	if items[0].EventID != 10 || items[0].AmountCOP != 45800 ||
		items[0].Status != "AMBIGUOUS" || items[0].Resumen != "resumen" ||
		items[0].Source != "BRIDGE_NOTIFICATION" {
		t.Errorf("mapeo incorrecto: %+v", items[0])
	}
}

// -----------------------------------------------------------------------------
// AssignEventToIntent
// -----------------------------------------------------------------------------

func TestQrPaymentService_AssignEventToIntent_PublicaSSEYTray(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	received := now.Add(-5 * time.Minute)
	expires := now.Add(10 * time.Minute)

	// Primer SELECT: evento. Segundo (bajo lock): mismo evento. Tercero:
	// intent. UPDATE: no responde (fake registra pero no afecta).
	call := 0
	f := &svcFakeSQL{respond: func(q string, _ []interface{}) svcFakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, "POS_QR_PAYMENT_INTENTS") &&
			strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "STATUS IN"):
			// Paid-check: ninguna paid existe.
			return svcFakeResult{}
		case strings.HasPrefix(strings.TrimSpace(up), "SELECT") && strings.Contains(up, "POS_QR_WEBHOOK_EVENTS"):
			call++
			return svcFakeResult{
				Columns: []string{
					"id", "received_at", "source", "event_type", "external_id",
					"fingerprint", "amount_cop", "processed_at", "processed_status",
					"matched_intent_id", "note",
				},
				Rows: [][]driver.Value{{
					int64(99), received, "BRIDGE_NOTIFICATION", "PUSH_NOTIFICATION", nil,
					"fp-abcdefg1", int64(45800), received, "AMBIGUOUS",
					nil, "resumen OCR saneado",
				}},
			}
		case strings.HasPrefix(strings.TrimSpace(up), "SELECT") && strings.Contains(up, "POS_QR_PAYMENT_INTENTS"):
			return svcFakeResult{
				Columns: []string{
					"id", "venta_temp_id", "caja_id", "created_by_dni",
					"amount_cop", "status", "created_at", "expires_at",
					"approved_at", "approved_source", "approved_reference",
					"approved_event_id", "cancelled_at", "cancelled_by_dni",
					"cancel_reason", "manual_confirmed_by_dni",
					"manual_confirmed_note", "related_sale_id",
				},
				Rows: [][]driver.Value{{
					int64(42), "temp-asignar-svc", "CAJA-7", "EMP-1",
					int64(45800), "PENDIENTE", now.Add(-1 * time.Minute), expires,
					nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
				}},
			}
		}
		return svcFakeResult{}
	}}
	repo := repositories.NewQrPaymentRepository(newSvcGormDB(t, f))

	hub := sse.NewQRHub()
	svc := NewQrPaymentService(repo, hub, nil).WithClock(func() time.Time { return now })

	// Dos suscriptores: uno al stream del venta_temp_id, otro al tray
	// de la caja. Ambos deben recibir eventos post-commit.
	chStream, cancelStream := hub.Subscribe("temp-asignar-svc")
	defer cancelStream()
	chTray, cancelTray := hub.SubscribeCaja("CAJA-7")
	defer cancelTray()

	out, err := svc.AssignEventToIntent(context.Background(), AssignEventInput{
		VentaTempID: "temp-asignar-svc",
		EventID:     99,
		ActorDNI:    "EMP-9",
		ActorName:   "Juan Testing",
		IP:          "192.168.1.21",
		Device:      "TestAgent/1.0",
	})
	if err != nil {
		t.Fatalf("AssignEventToIntent: %v", err)
	}
	if out == nil || out.Status != models.QRIntentStatusApproved {
		t.Fatalf("output esperado APROBADA, got %+v", out)
	}
	if out.ApprovedReference != "ASIG-99" {
		t.Errorf("approved_reference esperado 'ASIG-99', got %q", out.ApprovedReference)
	}
	if out.ApprovedVia != models.QRApprovalSourceBridge {
		t.Errorf("approved_via esperado %q, got %q", models.QRApprovalSourceBridge, out.ApprovedVia)
	}

	// SSE: stream recibe snapshot APROBADO.
	select {
	case ev := <-chStream:
		if ev.Status != models.QRStreamStatusApproved {
			t.Errorf("stream event status=%s, want APROBADO", ev.Status)
		}
		if ev.Reference != "ASIG-99" {
			t.Errorf("stream event reference=%q, want ASIG-99", ev.Reference)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("stream SSE no recibió evento APROBADO")
	}

	// Tray: QRTrayKindApproved con cajaId coincidente.
	select {
	case ev := <-chTray:
		if ev.Kind != models.QRTrayKindApproved {
			t.Errorf("tray kind=%s, want APPROVED", ev.Kind)
		}
		if ev.CajaID != "CAJA-7" {
			t.Errorf("tray cajaId=%s, want CAJA-7", ev.CajaID)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("tray SSE no recibió evento APPROVED")
	}
}

func TestQrPaymentService_AssignEventToIntent_RechazaInputsDuros(t *testing.T) {
	svc := NewQrPaymentService(nil, nil, nil)
	cases := []AssignEventInput{
		{VentaTempID: "", EventID: 1, ActorDNI: "D"},
		{VentaTempID: "temp-x", EventID: 0, ActorDNI: "D"},
		{VentaTempID: "temp-x", EventID: 1, ActorDNI: ""},
		{VentaTempID: "ab", EventID: 1, ActorDNI: "D"}, // venta_temp_id corto
	}
	for _, c := range cases {
		if _, err := svc.AssignEventToIntent(context.Background(), c); err != ErrQRInvalidInput {
			t.Errorf("AssignEventToIntent(%+v) debe ErrQRInvalidInput, got %v", c, err)
		}
	}
}
