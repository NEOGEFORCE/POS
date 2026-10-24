// Pruebas de servicio para el guardia AlreadyPaid (migración 027 +
// fix del bug productivo del 23/10/2026). La secuencia reproducida:
//
//   T0: intent 53 APROBADA (SUCCEEDED, related_sale_id=33191) para V.
//   T1: /iniciar con snapshot nuevo para V (nuevo sale_client_tx_id).
//       → Devuelve 200 con alreadyPaid=true, saleId=33191, SIN fila nueva.
//   T2: /encolar sobre la misma V.
//       → Devuelve *IntentAlreadyPaidError con el saleId; el handler lo
//         traduce a 409 QR_INTENT_ALREADY_PAID.
//
// Verificamos vía fakeSQL que NO se emite INSERT y NO se persiste un
// nuevo sale_client_tx_id, snapshot ni queued_at.

package services

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/sse"
)

// -----------------------------------------------------------------------------
// Fake SQL harness local (sin ciclos de imports)
// -----------------------------------------------------------------------------

// paidResponder arma la rama de paid-check del fakeSQL. Devuelve el
// intent 53 APROBADA cuando el SELECT lleva STATUS IN; para cualquier
// otra query cae a vacío.
func paidResponder(saleID int64, status string) func(string, []interface{}) svcFakeResult {
	return func(q string, _ []interface{}) svcFakeResult {
		up := strings.ToUpper(q)
		if strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "POS_QR_PAYMENT_INTENTS") &&
			strings.Contains(up, "STATUS IN") {
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
					int64(53), "V", "CAJA-1", "EMP-1",
					int64(10000), status, time.Now().UTC(), time.Now().UTC().Add(15 * time.Minute),
					time.Now().UTC(), models.QRApprovalSourceBoldOfficial, "bld-xyz",
					int64(1), nil, nil, nil, nil, nil, saleID,
				}},
			}
		}
		return svcFakeResult{}
	}
}

// -----------------------------------------------------------------------------
// Initiate: aprobada previa → alreadyPaid=true, sin INSERT
// -----------------------------------------------------------------------------

func TestQrPaymentService_Initiate_SobreVentaYaPagada_DevuelveAlreadyPaid(t *testing.T) {
	saleID := int64(33191)
	f := &svcFakeSQL{respond: paidResponder(saleID, models.QRIntentStatusApproved)}
	repo := repositories.NewQrPaymentRepository(newSvcGormDB(t, f))
	hub := sse.NewQRHub()
	svc := NewQrPaymentService(repo, hub, nil).
		WithClock(func() time.Time { return time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC) })

	out, err := svc.Initiate(context.Background(), "V-paid-123", "CAJA-1", "EMP-9", 10000)
	if err != nil {
		t.Fatalf("Initiate: %v", err)
	}
	if !out.AlreadyPaid {
		t.Error("se esperaba AlreadyPaid=true")
	}
	if out.Status != models.QRIntentStatusApproved {
		t.Errorf("status = %s, want APROBADA", out.Status)
	}
	if out.SaleID != uint64(saleID) {
		t.Errorf("saleId = %d, want 33191", out.SaleID)
	}
	if out.AmountCOP != 10000 {
		t.Errorf("amountCop = %d, want 10000", out.AmountCOP)
	}
	if !out.Reused {
		t.Error("AlreadyPaid implica Reused=true")
	}
	// NO INSERT emitido.
	for _, st := range f.stmts {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, "INSERT INTO \"POS_QR_PAYMENT_INTENTS\"") {
			t.Errorf("AlreadyPaid NO debe emitir INSERT: %s", st.SQL)
		}
	}
}

// -----------------------------------------------------------------------------
// InitiateWithSnapshot: /iniciar con snapshot nuevo sobre V ya pagada
// -----------------------------------------------------------------------------

// TestQrPaymentService_InitiateWithSnapshot_SobreVentaYaPagada_NoCreaFilaNiPersisteClientTxID
// es la segunda pata de la reproducción: /iniciar con snapshot y
// nuevo sale_client_tx_id sobre V ya pagada. Debe devolver AlreadyPaid
// y NO persistir el nuevo clientTxId ni ningún snapshot (la fila paid
// queda intacta).
func TestQrPaymentService_InitiateWithSnapshot_SobreVentaYaPagada_NoCreaFilaNiPersisteClientTxID(t *testing.T) {
	saleID := int64(33191)
	f := &svcFakeSQL{respond: paidResponder(saleID, models.QRIntentStatusApproved)}
	repo := repositories.NewQrPaymentRepository(newSvcGormDB(t, f))
	svc := NewQrPaymentService(repo, sse.NewQRHub(), nil).
		WithClock(func() time.Time { return time.Date(2026, 10, 23, 12, 2, 0, 0, time.UTC) })

	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":10000,"subtotal":10000}]`)
	out, err := svc.InitiateWithSnapshot(context.Background(), InitiateWithSnapshotInput{
		VentaTempID:  "V-paid-123",
		CajaID:       "CAJA-1",
		ActorDNI:     "EMP-9",
		AmountCOP:    10000,
		ClientTxID:   strings.Repeat("x", 24), // nuevo tx id
		CartSnapshot: cart,
	})
	if err != nil {
		t.Fatalf("InitiateWithSnapshot: %v", err)
	}
	if !out.AlreadyPaid {
		t.Error("se esperaba AlreadyPaid=true")
	}
	if out.SaleID != uint64(saleID) {
		t.Errorf("saleId = %d, want 33191", out.SaleID)
	}
	// La fila paid no debe tocarse: ni INSERT ni UPDATE con sale_client_tx_id,
	// cart_snapshot o queued_at.
	for _, st := range f.stmts {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, "INSERT INTO \"POS_QR_PAYMENT_INTENTS\"") {
			t.Errorf("InitiateWithSnapshot sobre venta pagada NO debe INSERT: %s", st.SQL)
		}
		if strings.HasPrefix(strings.TrimSpace(up), "UPDATE") {
			for _, forbidden := range []string{"SALE_CLIENT_TX_ID", "CART_SNAPSHOT", "QUEUED_AT"} {
				if strings.Contains(up, forbidden) {
					t.Errorf("NO debe persistir %s nuevo sobre venta pagada: %s", forbidden, st.SQL)
				}
			}
		}
	}
}

// -----------------------------------------------------------------------------
// Enqueue: /encolar sobre V ya pagada → *IntentAlreadyPaidError
// -----------------------------------------------------------------------------

// TestQrPaymentService_Enqueue_SobreVentaYaPagada_Devuelve409 cubre el
// contrato: /encolar sobre una venta ya pagada responde con
// *IntentAlreadyPaidError (que el handler traduce a 409
// QR_INTENT_ALREADY_PAID con saleId). Verifica que:
//   - errors.Is matchea ErrQRIntentAlreadyPaid.
//   - errors.As extrae *IntentAlreadyPaidError con el SaleID real.
//   - NO se emite INSERT ni se persiste queued_at.
func TestQrPaymentService_Enqueue_SobreVentaYaPagada_Devuelve409(t *testing.T) {
	saleID := int64(33191)
	f := &svcFakeSQL{respond: paidResponder(saleID, models.QRIntentStatusApproved)}
	repo := repositories.NewQrPaymentRepository(newSvcGormDB(t, f))
	svc := NewQrPaymentService(repo, sse.NewQRHub(), nil).
		WithClock(func() time.Time { return time.Date(2026, 10, 23, 12, 3, 0, 0, time.UTC) })

	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":10000,"subtotal":10000}]`)
	out, err := svc.Enqueue(context.Background(), EnqueueInput{
		VentaTempID:  "V-paid-123",
		CajaID:       "CAJA-1",
		ActorDNI:     "EMP-9",
		CashierName:  "Juan Testing",
		AmountCOP:    10000,
		ClientTxID:   strings.Repeat("y", 24),
		CartSnapshot: cart,
	})
	if err == nil {
		t.Fatal("se esperaba error de Enqueue sobre venta pagada")
	}
	if out != nil {
		t.Errorf("Enqueue debe devolver nil output cuando AlreadyPaid, got %+v", out)
	}
	if !errors.Is(err, ErrQRIntentAlreadyPaid) {
		t.Errorf("errors.Is debe reconocer ErrQRIntentAlreadyPaid, got %v", err)
	}
	var paidErr *IntentAlreadyPaidError
	if !errors.As(err, &paidErr) {
		t.Fatalf("errors.As debe extraer *IntentAlreadyPaidError, got %T", err)
	}
	if paidErr.SaleID != uint64(saleID) {
		t.Errorf("saleId extraído = %d, want 33191", paidErr.SaleID)
	}
	if paidErr.AmountCOP != 10000 {
		t.Errorf("amountCop = %d, want 10000", paidErr.AmountCOP)
	}
	if paidErr.Status != models.QRIntentStatusApproved {
		t.Errorf("status = %s, want APROBADA", paidErr.Status)
	}

	// Guardianes de persistencia: nada se mutó.
	for _, st := range f.stmts {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, "INSERT INTO \"POS_QR_PAYMENT_INTENTS\"") {
			t.Errorf("Enqueue sobre venta pagada NO debe INSERT: %s", st.SQL)
		}
		if strings.HasPrefix(strings.TrimSpace(up), "UPDATE") && strings.Contains(up, "POS_QR_PAYMENT_INTENTS") {
			for _, forbidden := range []string{"QUEUED_AT", "SALE_CLIENT_TX_ID", "CART_SNAPSHOT"} {
				if strings.Contains(up, forbidden) {
					t.Errorf("Enqueue sobre venta pagada NO debe tocar %s: %s", forbidden, st.SQL)
				}
			}
		}
	}
}

// TestQrPaymentService_Enqueue_SobreCanceladaCreaNuevaIntencion es el
// contraste: cuando V tiene una CANCELADA (terminal no-paid), /encolar
// SÍ crea nueva intención (CANCELADA / EXPIRADA habilitan reintento).
func TestQrPaymentService_Enqueue_SobreCanceladaCreaNuevaIntencion(t *testing.T) {
	f := &svcFakeSQL{respond: func(q string, _ []interface{}) svcFakeResult {
		up := strings.ToUpper(q)
		// Paid-check: no hay paid.
		if strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "POS_QR_PAYMENT_INTENTS") &&
			strings.Contains(up, "STATUS IN") {
			return svcFakeResult{}
		}
		// Live-pending FOR UPDATE: no hay PENDIENTE viva.
		if strings.Contains(up, "FOR UPDATE") {
			return svcFakeResult{}
		}
		// INSERT nuevo.
		if strings.Contains(up, "INSERT INTO \"POS_QR_PAYMENT_INTENTS\"") {
			return svcFakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(200)}}}
		}
		return svcFakeResult{}
	}}
	repo := repositories.NewQrPaymentRepository(newSvcGormDB(t, f))
	svc := NewQrPaymentService(repo, sse.NewQRHub(), nil).
		WithClock(func() time.Time { return time.Date(2026, 10, 23, 12, 5, 0, 0, time.UTC) })

	cart := []byte(`[{"barcode":"B","quantity":1,"unitPrice":5000,"subtotal":5000}]`)
	out, err := svc.Enqueue(context.Background(), EnqueueInput{
		VentaTempID:  "V-cancelada",
		CajaID:       "CAJA-1",
		ActorDNI:     "EMP-9",
		AmountCOP:    5000,
		ClientTxID:   strings.Repeat("z", 24),
		CartSnapshot: cart,
	})
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	if out == nil {
		t.Fatal("se esperaba output no-nil tras creación exitosa")
	}
	if out.IntentID != 200 {
		t.Errorf("intentId = %d, want 200", out.IntentID)
	}
	if out.Status != models.QRIntentStatusPending {
		t.Errorf("status = %s, want PENDIENTE", out.Status)
	}
}

// -----------------------------------------------------------------------------
// AssignEventToIntent: V ya pagada → *IntentAlreadyPaidError
// -----------------------------------------------------------------------------

func TestQrPaymentService_AssignEventToIntent_SobreVentaYaPagada_Devuelve409(t *testing.T) {
	saleID := int64(33191)
	now := time.Date(2026, 10, 23, 12, 10, 0, 0, time.UTC)
	received := now.Add(-5 * time.Minute)
	f := &svcFakeSQL{respond: func(q string, _ []interface{}) svcFakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "POS_QR_PAYMENT_INTENTS") &&
			strings.Contains(up, "STATUS IN"):
			// Paid-check en AssignEventToIntent devuelve APROBADA.
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
					int64(53), "V-paid-asignar", "CAJA-1", "EMP-1",
					int64(10000), models.QRIntentStatusApproved,
					now.Add(-1 * time.Hour), now.Add(5 * time.Minute),
					now.Add(-1 * time.Hour), models.QRApprovalSourceBoldOfficial, "bld-xyz",
					int64(1), nil, nil, nil, nil, nil, saleID,
				}},
			}
		case strings.HasPrefix(strings.TrimSpace(up), "SELECT") && strings.Contains(up, "POS_QR_WEBHOOK_EVENTS"):
			return svcFakeResult{
				Columns: []string{
					"id", "received_at", "source", "event_type", "external_id",
					"fingerprint", "amount_cop", "processed_at", "processed_status",
					"matched_intent_id", "note",
				},
				Rows: [][]driver.Value{{
					int64(99), received, "BRIDGE_NOTIFICATION", "PUSH_NOTIFICATION", nil,
					"fp-abc", int64(10000), received, "UNMATCHED",
					nil, "resumen",
				}},
			}
		}
		return svcFakeResult{}
	}}
	repo := repositories.NewQrPaymentRepository(newSvcGormDB(t, f))
	svc := NewQrPaymentService(repo, sse.NewQRHub(), nil).
		WithClock(func() time.Time { return now })

	out, err := svc.AssignEventToIntent(context.Background(), AssignEventInput{
		VentaTempID: "V-paid-asignar",
		EventID:     99,
		ActorDNI:    "EMP-9",
	})
	if out != nil {
		t.Errorf("AssignEventToIntent debe devolver nil output cuando AlreadyPaid, got %+v", out)
	}
	if !errors.Is(err, ErrQRIntentAlreadyPaid) {
		t.Fatalf("errors.Is debe reconocer ErrQRIntentAlreadyPaid, got %v", err)
	}
	var paidErr *IntentAlreadyPaidError
	if !errors.As(err, &paidErr) {
		t.Fatalf("errors.As debe extraer *IntentAlreadyPaidError, got %T", err)
	}
	if paidErr.SaleID != uint64(saleID) {
		t.Errorf("saleId = %d, want 33191", paidErr.SaleID)
	}
}
