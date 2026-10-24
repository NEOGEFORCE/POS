// Pruebas del QrPaymentRepository para los endpoints de asignación
// manual y conteo auxiliar (sprint SMS):
//
//   - CountPendingLiveByAmount: query parametrizada, excluye intent id
//     cuando se pide, filtra por status PENDIENTE y expires_at > now.
//
//   - ListUnassignedEvents: filtra por processed_status IN (AMBIGUOUS,
//     UNMATCHED), matched_intent_id NULL y received_at >= since, orden
//     received_at DESC, límite acotado.
//
//   - AssignEventToIntent: advisory lock por monto, FOR UPDATE del
//     evento y de la intención, chequeo de monto, UPDATE con sufijo
//     " | asignado:<dni>" en note (recortado a 255), transición de la
//     intención a APROBADA con approved_reference "ASIG-<eventId>".
//     Rechaza:
//       * evento sin matched_intent_id pero con processed_status fuera
//         de AMBIGUOUS/UNMATCHED → ErrQREventAlreadyAssigned.
//       * evento recibido fuera de ventana (>60 min) → ErrQREventAlreadyAssigned.
//       * intent con amount_cop distinto → ErrQRAmountMismatch.
//       * intent en estado terminal → ErrQRIntentNotPending.

package repositories

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// -----------------------------------------------------------------------------
// CountPendingLiveByAmount
// -----------------------------------------------------------------------------

func TestQrRepo_CountPendingLiveByAmount_FiltraPorStatusYMonto(t *testing.T) {
	var seenSQL string
	var seenVars []interface{}
	f := &fakeSQL{respond: func(q string, args []interface{}) fakeResult {
		up := strings.ToUpper(q)
		if strings.Contains(up, "SELECT COUNT(") && strings.Contains(up, "POS_QR_PAYMENT_INTENTS") {
			seenSQL = up
			seenVars = append(seenVars, args...)
			return fakeResult{Columns: []string{"count"}, Rows: [][]driver.Value{{int64(3)}}}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	count, err := repo.CountPendingLiveByAmount(context.Background(), 45800, 42, time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("CountPendingLiveByAmount: %v", err)
	}
	if count != 3 {
		t.Errorf("count = %d, want 3", count)
	}
	for _, needed := range []string{"AMOUNT_COP", "STATUS", "EXPIRES_AT", "ID"} {
		if !strings.Contains(seenSQL, needed) {
			t.Errorf("SELECT COUNT debe incluir %s: %s", needed, seenSQL)
		}
	}
}

func TestQrRepo_CountPendingLiveByAmount_RechazaInputsDuros(t *testing.T) {
	repo := NewQrPaymentRepository(newFakeGormDB(t, &fakeSQL{}))
	for _, amount := range []int64{0, -5, models.QRPaymentIntentMaxAmountCOP + 1} {
		if _, err := repo.CountPendingLiveByAmount(context.Background(), amount, 0, time.Now()); !errors.Is(err, ErrQRInvalidInput) {
			t.Errorf("CountPendingLiveByAmount(amount=%d) debe ErrQRInvalidInput, got %v", amount, err)
		}
	}
}

// -----------------------------------------------------------------------------
// ListUnassignedEvents
// -----------------------------------------------------------------------------

func TestQrRepo_ListUnassignedEvents_FiltraYOrdena(t *testing.T) {
	var seenSQL string
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		if strings.HasPrefix(strings.TrimSpace(up), "SELECT") && strings.Contains(up, "POS_QR_WEBHOOK_EVENTS") {
			seenSQL = up
			now := time.Now().UTC()
			return fakeResult{
				Columns: []string{"id", "amount_cop", "received_at", "processed_status", "source", "note"},
				Rows: [][]driver.Value{
					{int64(10), int64(45800), now.Add(-5 * time.Minute), "AMBIGUOUS", "BRIDGE_NOTIFICATION", "Recibiste $45.800 de JUAN"},
					{int64(11), int64(50000), now.Add(-10 * time.Minute), "UNMATCHED", "BRIDGE_NOTIFICATION", "Transferencia recibida $50.000"},
				},
			}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	items, err := repo.ListUnassignedEvents(context.Background(), time.Now().Add(-30*time.Minute), 50)
	if err != nil {
		t.Fatalf("ListUnassignedEvents: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("len=%d want 2", len(items))
	}
	if !strings.Contains(seenSQL, "MATCHED_INTENT_ID") {
		t.Error("SELECT debe filtrar matched_intent_id IS NULL")
	}
	if !strings.Contains(seenSQL, "PROCESSED_STATUS") {
		t.Error("SELECT debe filtrar processed_status")
	}
	if !strings.Contains(seenSQL, "RECEIVED_AT DESC") {
		t.Error("SELECT debe ordenar por received_at DESC")
	}
	if !strings.Contains(seenSQL, "LIMIT") {
		t.Error("SELECT debe tener LIMIT")
	}
}

func TestQrRepo_ListUnassignedEvents_LimiteAcotado(t *testing.T) {
	var limitArg int
	f := &fakeSQL{respond: func(q string, args []interface{}) fakeResult {
		up := strings.ToUpper(q)
		if strings.HasPrefix(strings.TrimSpace(up), "SELECT") && strings.Contains(up, "POS_QR_WEBHOOK_EVENTS") {
			// Buscar el valor de LIMIT en los argumentos: suele ser el último.
			for _, a := range args {
				if n, ok := a.(int64); ok {
					limitArg = int(n)
				}
				if n, ok := a.(int); ok {
					limitArg = n
				}
			}
			return fakeResult{}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	// Pedimos 1000 → debe acotar a 50.
	if _, err := repo.ListUnassignedEvents(context.Background(), time.Now().Add(-1*time.Hour), 1000); err != nil {
		t.Fatalf("ListUnassignedEvents: %v", err)
	}
	if limitArg != 50 {
		t.Errorf("LIMIT no fue acotado a 50, got %d", limitArg)
	}
}

func TestQrRepo_ListUnassignedEvents_RechazaSinceCero(t *testing.T) {
	repo := NewQrPaymentRepository(newFakeGormDB(t, &fakeSQL{}))
	if _, err := repo.ListUnassignedEvents(context.Background(), time.Time{}, 50); !errors.Is(err, ErrQRInvalidInput) {
		t.Errorf("since.IsZero() debe ErrQRInvalidInput, got %v", err)
	}
}

// -----------------------------------------------------------------------------
// AssignEventToIntent
// -----------------------------------------------------------------------------

// Helper que construye un fakeResult con las columnas canónicas de un
// evento pos_qr_webhook_events.
func fakeEventRow(id, amount int64, status, source string, receivedAt time.Time, note string, matchedIntentID *int64) fakeResult {
	cols := []string{
		"id", "received_at", "source", "event_type", "external_id",
		"fingerprint", "amount_cop", "processed_at", "processed_status",
		"matched_intent_id", "note",
	}
	var matched driver.Value
	if matchedIntentID != nil {
		matched = *matchedIntentID
	} else {
		matched = nil
	}
	rows := [][]driver.Value{{
		id, receivedAt, source, "PUSH_NOTIFICATION", nil,
		"fp-abcdef12", amount, receivedAt, status,
		matched, note,
	}}
	return fakeResult{Columns: cols, Rows: rows}
}

func fakeIntentRow(id, amount int64, status string, expiresAt time.Time) fakeResult {
	cols := []string{
		"id", "venta_temp_id", "caja_id", "created_by_dni",
		"amount_cop", "status", "created_at", "expires_at",
		"approved_at", "approved_source", "approved_reference",
		"approved_event_id", "cancelled_at", "cancelled_by_dni",
		"cancel_reason", "manual_confirmed_by_dni",
		"manual_confirmed_note", "related_sale_id",
	}
	return fakeResult{Columns: cols, Rows: [][]driver.Value{{
		id, "temp-asignar", "CAJA-1", "EMP-1",
		amount, status, expiresAt.Add(-5 * time.Minute), expiresAt,
		nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
	}}}
}

func TestQrRepo_AssignEventToIntent_HappyPath(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	received := now.Add(-5 * time.Minute)
	futureExpires := now.Add(10 * time.Minute)

	// SELECT secuencia: 1) evento sin lock, 2) paid-check (STATUS IN,
	// vacío porque no hay paid), 3) evento con FOR UPDATE, 4) intent.
	call := 0
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, "POS_QR_PAYMENT_INTENTS") &&
			strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "STATUS IN"):
			// Paid-check: ninguna intención paid existe.
			return fakeResult{}
		case strings.Contains(up, "POS_QR_WEBHOOK_EVENTS") && strings.HasPrefix(strings.TrimSpace(up), "SELECT"):
			call++
			return fakeEventRow(99, 45800, "AMBIGUOUS", "BRIDGE_NOTIFICATION", received, "Recibiste $45.800", nil)
		case strings.Contains(up, "POS_QR_PAYMENT_INTENTS") && strings.HasPrefix(strings.TrimSpace(up), "SELECT"):
			return fakeIntentRow(42, 45800, "PENDIENTE", futureExpires)
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	outcome, err := repo.AssignEventToIntent(context.Background(), AssignEventOptions{
		VentaTempID: "temp-asignar",
		EventID:     99,
		ActorDNI:    "EMP-7",
		Now:         func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("AssignEventToIntent: %v", err)
	}
	if outcome == nil || outcome.Intent == nil || outcome.Event == nil {
		t.Fatal("outcome incompleto")
	}
	if outcome.Intent.Status != models.QRIntentStatusApproved {
		t.Errorf("intent status = %s, want APROBADA", outcome.Intent.Status)
	}
	if outcome.Event.ProcessedStatus != models.QRWebhookStatusApproved {
		t.Errorf("event processed_status = %s, want APPROVED", outcome.Event.ProcessedStatus)
	}
	if outcome.Event.MatchedIntentID == nil || *outcome.Event.MatchedIntentID != 42 {
		t.Errorf("matched_intent_id debe apuntar a 42, got %v", outcome.Event.MatchedIntentID)
	}
	if outcome.Intent.ApprovedReference != "ASIG-99" {
		t.Errorf("approved_reference = %q, want 'ASIG-99'", outcome.Intent.ApprovedReference)
	}
	if !strings.Contains(outcome.Event.Note, "| asignado:EMP-7") {
		t.Errorf("note no incluye el sufijo auditable: %q", outcome.Event.Note)
	}

	// Advisory lock por qr_match:<amount>
	foundLock := false
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, "PG_ADVISORY_XACT_LOCK") {
			for _, v := range st.Vars {
				if s, ok := v.(string); ok && strings.HasPrefix(s, "qr_match:") {
					foundLock = true
					break
				}
			}
		}
	}
	if !foundLock {
		t.Error("AssignEventToIntent debe emitir pg_advisory_xact_lock('qr_match:...')")
	}
	// Tx confirmada.
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("AssignEventToIntent debe COMMIT; txEvents=%v", f.txEvents)
	}
}

func TestQrRepo_AssignEventToIntent_EventNotFound(t *testing.T) {
	repo := NewQrPaymentRepository(newFakeGormDB(t, &fakeSQL{}))
	_, err := repo.AssignEventToIntent(context.Background(), AssignEventOptions{
		VentaTempID: "temp-x",
		EventID:     1,
		ActorDNI:    "EMP-1",
		Now:         time.Now,
	})
	if !errors.Is(err, ErrQREventNotFound) {
		t.Errorf("se esperaba ErrQREventNotFound, got %v", err)
	}
}

func TestQrRepo_AssignEventToIntent_EventYaAprobado(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	received := now.Add(-3 * time.Minute)
	matched := int64(42)
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		if strings.HasPrefix(strings.TrimSpace(up), "SELECT") && strings.Contains(up, "POS_QR_WEBHOOK_EVENTS") {
			return fakeEventRow(99, 45800, "APPROVED", "BRIDGE_NOTIFICATION", received, "ya emparejado", &matched)
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	_, err := repo.AssignEventToIntent(context.Background(), AssignEventOptions{
		VentaTempID: "temp-x",
		EventID:     99,
		ActorDNI:    "EMP-1",
		Now:         func() time.Time { return now },
	})
	if !errors.Is(err, ErrQREventAlreadyAssigned) {
		t.Errorf("evento APPROVED debe ErrQREventAlreadyAssigned, got %v", err)
	}
}

func TestQrRepo_AssignEventToIntent_FueraDeVentana(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	received := now.Add(-2 * time.Hour) // 120 min atrás
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		if strings.HasPrefix(strings.TrimSpace(up), "SELECT") && strings.Contains(up, "POS_QR_WEBHOOK_EVENTS") {
			return fakeEventRow(99, 45800, "UNMATCHED", "BRIDGE_NOTIFICATION", received, "antiguo", nil)
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	_, err := repo.AssignEventToIntent(context.Background(), AssignEventOptions{
		VentaTempID: "temp-x",
		EventID:     99,
		ActorDNI:    "EMP-1",
		Now:         func() time.Time { return now },
	})
	if !errors.Is(err, ErrQREventAlreadyAssigned) {
		t.Errorf("evento fuera de ventana (60 min) debe ErrQREventAlreadyAssigned, got %v", err)
	}
}

func TestQrRepo_AssignEventToIntent_AmountMismatch(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	received := now.Add(-5 * time.Minute)
	futureExpires := now.Add(10 * time.Minute)
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, "POS_QR_PAYMENT_INTENTS") &&
			strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "STATUS IN"):
			return fakeResult{} // sin paid
		case strings.Contains(up, "POS_QR_WEBHOOK_EVENTS") && strings.HasPrefix(strings.TrimSpace(up), "SELECT"):
			return fakeEventRow(99, 45800, "UNMATCHED", "BRIDGE_NOTIFICATION", received, "x", nil)
		case strings.Contains(up, "POS_QR_PAYMENT_INTENTS") && strings.HasPrefix(strings.TrimSpace(up), "SELECT"):
			return fakeIntentRow(42, 99999, "PENDIENTE", futureExpires) // ← monto distinto
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	_, err := repo.AssignEventToIntent(context.Background(), AssignEventOptions{
		VentaTempID: "temp-asignar",
		EventID:     99,
		ActorDNI:    "EMP-1",
		Now:         func() time.Time { return now },
	})
	if !errors.Is(err, ErrQRAmountMismatch) {
		t.Errorf("monto distinto debe ErrQRAmountMismatch, got %v", err)
	}
}

func TestQrRepo_AssignEventToIntent_IntentTerminal(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	received := now.Add(-5 * time.Minute)
	futureExpires := now.Add(10 * time.Minute)
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, "POS_QR_PAYMENT_INTENTS") &&
			strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "STATUS IN"):
			return fakeResult{} // sin paid
		case strings.Contains(up, "POS_QR_WEBHOOK_EVENTS") && strings.HasPrefix(strings.TrimSpace(up), "SELECT"):
			return fakeEventRow(99, 45800, "UNMATCHED", "BRIDGE_NOTIFICATION", received, "x", nil)
		case strings.Contains(up, "POS_QR_PAYMENT_INTENTS") && strings.HasPrefix(strings.TrimSpace(up), "SELECT"):
			return fakeIntentRow(42, 45800, "CANCELADA", futureExpires)
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	_, err := repo.AssignEventToIntent(context.Background(), AssignEventOptions{
		VentaTempID: "temp-x",
		EventID:     99,
		ActorDNI:    "EMP-1",
		Now:         func() time.Time { return now },
	})
	if !errors.Is(err, ErrQRIntentNotPending) {
		t.Errorf("intent CANCELADA debe ErrQRIntentNotPending, got %v", err)
	}
}

func TestQrRepo_AssignEventToIntent_IntentNotFound(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	received := now.Add(-5 * time.Minute)
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, "POS_QR_PAYMENT_INTENTS") &&
			strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "STATUS IN"):
			return fakeResult{} // sin paid
		case strings.Contains(up, "POS_QR_WEBHOOK_EVENTS") && strings.HasPrefix(strings.TrimSpace(up), "SELECT"):
			return fakeEventRow(99, 45800, "UNMATCHED", "BRIDGE_NOTIFICATION", received, "x", nil)
		case strings.Contains(up, "POS_QR_PAYMENT_INTENTS") && strings.HasPrefix(strings.TrimSpace(up), "SELECT"):
			return fakeResult{} // 0 filas
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	_, err := repo.AssignEventToIntent(context.Background(), AssignEventOptions{
		VentaTempID: "temp-x",
		EventID:     99,
		ActorDNI:    "EMP-1",
		Now:         func() time.Time { return now },
	})
	if !errors.Is(err, ErrQRIntentNotFound) {
		t.Errorf("intent inexistente debe ErrQRIntentNotFound, got %v", err)
	}
}

func TestQrRepo_AssignEventToIntent_RechazaInputs(t *testing.T) {
	repo := NewQrPaymentRepository(newFakeGormDB(t, &fakeSQL{}))
	cases := []AssignEventOptions{
		{VentaTempID: "", EventID: 1, ActorDNI: "D"},
		{VentaTempID: "temp-x", EventID: 0, ActorDNI: "D"},
		{VentaTempID: "temp-x", EventID: 1, ActorDNI: ""},
	}
	for _, c := range cases {
		if _, err := repo.AssignEventToIntent(context.Background(), c); !errors.Is(err, ErrQRInvalidInput) {
			t.Errorf("AssignEventToIntent(%+v) debe ErrQRInvalidInput, got %v", c, err)
		}
	}
}
