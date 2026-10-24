// Tests específicos del repositorio para el flujo asíncrono QR
// (migración 027). Enfoque:
//
//   - Initiate con MarkQueued=true + snapshots: INSERT nuevo cuando
//     no hay PENDIENTE previa.
//
//   - Initiate con MarkQueued=true + snapshots: UPDATE atómico
//     (adjunto) cuando hay PENDIENTE previa con el MISMO monto y
//     SIN snapshots. NO se crea una segunda intención.
//
//   - Initiate con MarkQueued=true: idempotente ante doble llamada
//     con los mismos snapshots.
//
//   - El INSERT NUNCA referencia columnas inexistentes
//     (`cashier_name` ni `client_dni`).
//
//   - ListPendingByCaja no selecciona `cashier_name`.

package repositories

import (
	"context"
	"database/sql/driver"
	"strings"
	"testing"
	"time"
)

var _ = time.Now // mantiene time importado si algún test deja de usarlo

// -----------------------------------------------------------------------------
// Guardianes de columnas que NO existen en la 027
// -----------------------------------------------------------------------------

func TestQrRepo_InsertPendiente_NoReferenciaColumnasInexistentes(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.Contains(q, "PG_ADVISORY_XACT_LOCK") {
			return fakeResult{Columns: []string{"pg_advisory_xact_lock"}, Rows: [][]driver.Value{{""}}}
		}
		if strings.Contains(q, "FOR UPDATE") {
			return fakeResult{}
		}
		if strings.Contains(q, "INSERT INTO \"POS_QR_PAYMENT_INTENTS\"") {
			return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(42)}}}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":1000,"subtotal":1000}]`)
	_, err := repo.Initiate(context.Background(), InitiateIntentOptions{
		VentaTempID:    "temp-encolar-ok",
		CajaID:         "CAJA-1",
		CreatedByDNI:   "EMP-1",
		AmountCOP:      45800,
		TTL:            15 * time.Minute,
		Now:            func() time.Time { return time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC) },
		SaleClientTxID: "qr-tx-12345678",
		CartSnapshot:   cart,
		MarkQueued:     true,
	})
	if err != nil {
		t.Fatalf("Initiate: %v", err)
	}
	// Verificar que ningún INSERT emitido mencione cashier_name o
	// client_dni (columnas que la 027 NO define).
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if !strings.Contains(up, "INSERT INTO \"POS_QR_PAYMENT_INTENTS\"") {
			continue
		}
		for _, forbidden := range []string{"CASHIER_NAME", "CLIENT_DNI"} {
			if strings.Contains(up, forbidden) {
				t.Errorf("INSERT referencia columna inexistente %q: %s", forbidden, st.SQL)
			}
		}
		// Debe incluir las columnas del flujo asíncrono que SÍ existen.
		for _, needed := range []string{
			"SALE_CLIENT_TX_ID", "CART_SNAPSHOT", "QUEUED_AT",
		} {
			if !strings.Contains(up, needed) {
				t.Errorf("INSERT con snapshots debe incluir %q: %s", needed, st.SQL)
			}
		}
	}
}

// -----------------------------------------------------------------------------
// Reuse con adjunto atómico de snapshots (/encolar reutiliza /iniciar)
// -----------------------------------------------------------------------------

func TestQrRepo_Initiate_ReuseAdjuntaSnapshotsEnMismaTx(t *testing.T) {
	now := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	future := now.Add(10 * time.Minute)
	// El SELECT FOR UPDATE devuelve un PENDIENTE existente SIN
	// snapshots (cart_snapshot='' sale_client_tx_id='' queued_at NULL),
	// lo que simula el escenario /iniciar seguido de /encolar.
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.Contains(q, "FOR UPDATE") {
			return fakeResult{
				Columns: []string{
					"id", "venta_temp_id", "caja_id", "created_by_dni",
					"amount_cop", "status", "created_at", "expires_at",
					"approved_at", "approved_source", "approved_reference",
					"approved_event_id", "cancelled_at", "cancelled_by_dni",
					"cancel_reason", "manual_confirmed_by_dni",
					"manual_confirmed_note", "related_sale_id",
					"cart_snapshot", "client_snapshot", "totals_snapshot",
					"sale_client_tx_id", "queued_at",
					"finalization_status", "finalization_started_at",
					"finalization_completed_at", "finalization_attempts",
					"finalization_last_error", "finalization_next_retry_at",
					"cashier_notified_at",
				},
				Rows: [][]driver.Value{{
					int64(42), "temp-reuse", "CAJA-1", "EMP-1",
					int64(45800), "PENDIENTE", now, future,
					nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
					nil, nil, nil, nil, nil,
					"NOT_STARTED", nil, nil, int64(0), nil, nil, nil,
				}},
			}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	cart := []byte(`[{"barcode":"X","quantity":1,"unitPrice":45800,"subtotal":45800}]`)
	outcome, err := repo.Initiate(context.Background(), InitiateIntentOptions{
		VentaTempID:    "temp-reuse",
		CajaID:         "CAJA-1",
		CreatedByDNI:   "EMP-1",
		AmountCOP:      45800,
		TTL:            15 * time.Minute,
		Now:            func() time.Time { return now },
		SaleClientTxID: "qr-tx-reuse-01",
		CartSnapshot:   cart,
		MarkQueued:     true,
	})
	if err != nil {
		t.Fatalf("Initiate: %v", err)
	}
	if !outcome.Reused {
		t.Error("se esperaba Reused=true cuando ya existe PENDIENTE con mismo monto")
	}
	if outcome.Intent.ID != 42 {
		t.Errorf("ID esperado=42 (reuso), got %d", outcome.Intent.ID)
	}

	// Verificar que NO se emitió un segundo INSERT (reutilizó).
	for _, st := range f.statements() {
		if strings.Contains(strings.ToUpper(st.SQL), "INSERT INTO \"POS_QR_PAYMENT_INTENTS\"") {
			t.Errorf("reuse NO debe emitir INSERT: %s", st.SQL)
		}
	}
	// Verificar que SÍ se emitió un UPDATE con sale_client_tx_id,
	// cart_snapshot, queued_at (adjunto atómico).
	seenUpdate := false
	hasClientTx := false
	hasCart := false
	hasQueued := false
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if !strings.HasPrefix(strings.TrimSpace(up), "UPDATE") || !strings.Contains(up, "POS_QR_PAYMENT_INTENTS") {
			continue
		}
		if strings.Contains(up, "SALE_CLIENT_TX_ID") {
			hasClientTx = true
		}
		if strings.Contains(up, "CART_SNAPSHOT") {
			hasCart = true
		}
		if strings.Contains(up, "QUEUED_AT") {
			hasQueued = true
		}
		if hasClientTx || hasCart || hasQueued {
			seenUpdate = true
		}
	}
	if !seenUpdate {
		t.Fatal("se esperaba UPDATE con adjunto atómico de snapshots")
	}
	if !hasClientTx {
		t.Error("UPDATE debe setear sale_client_tx_id")
	}
	if !hasCart {
		t.Error("UPDATE debe setear cart_snapshot")
	}
	if !hasQueued {
		t.Error("UPDATE debe setear queued_at")
	}

	// Y la fila devuelta refleja los adjuntos en memoria.
	if outcome.Intent.SaleClientTxID != "qr-tx-reuse-01" {
		t.Errorf("outcome.Intent.SaleClientTxID = %q, want qr-tx-reuse-01", outcome.Intent.SaleClientTxID)
	}
	if outcome.Intent.CartSnapshot == "" {
		t.Error("outcome.Intent.CartSnapshot debe estar poblado en reuse")
	}
	if outcome.Intent.QueuedAt == nil {
		t.Error("outcome.Intent.QueuedAt debe estar poblado en reuse")
	}
}

// TestQrRepo_Initiate_ReuseIdempotenteNoReescribeSnapshotsExistentes:
// si la fila existente YA tiene snapshots (p.ej. /encolar llamó dos
// veces), el segundo Initiate NO debe sobrescribirlos.
func TestQrRepo_Initiate_ReuseIdempotenteNoReescribeSnapshotsExistentes(t *testing.T) {
	now := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	future := now.Add(10 * time.Minute)
	queuedAt := now.Add(-1 * time.Minute)
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.Contains(q, "FOR UPDATE") {
			return fakeResult{
				Columns: []string{
					"id", "venta_temp_id", "caja_id", "created_by_dni",
					"amount_cop", "status", "created_at", "expires_at",
					"approved_at", "approved_source", "approved_reference",
					"approved_event_id", "cancelled_at", "cancelled_by_dni",
					"cancel_reason", "manual_confirmed_by_dni",
					"manual_confirmed_note", "related_sale_id",
					"cart_snapshot", "client_snapshot", "totals_snapshot",
					"sale_client_tx_id", "queued_at",
					"finalization_status", "finalization_started_at",
					"finalization_completed_at", "finalization_attempts",
					"finalization_last_error", "finalization_next_retry_at",
					"cashier_notified_at",
				},
				Rows: [][]driver.Value{{
					int64(42), "temp-idem", "CAJA-1", "EMP-1",
					int64(45800), "PENDIENTE", now, future,
					nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
					`[{"barcode":"PREV","quantity":1,"unitPrice":45800,"subtotal":45800}]`,
					nil, nil,
					"qr-tx-previo-01", queuedAt,
					"NOT_STARTED", nil, nil, int64(0), nil, nil, nil,
				}},
			}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	outcome, err := repo.Initiate(context.Background(), InitiateIntentOptions{
		VentaTempID:    "temp-idem",
		CajaID:         "CAJA-1",
		CreatedByDNI:   "EMP-1",
		AmountCOP:      45800,
		TTL:            15 * time.Minute,
		Now:            func() time.Time { return now },
		SaleClientTxID: "qr-tx-NUEVO-02", // valor distinto
		CartSnapshot:   []byte(`[{"barcode":"NUEVO","quantity":1,"unitPrice":45800,"subtotal":45800}]`),
		MarkQueued:     true,
	})
	if err != nil {
		t.Fatalf("Initiate: %v", err)
	}
	if !outcome.Reused {
		t.Error("se esperaba Reused=true")
	}
	// NO debe haber UPDATE que modifique sale_client_tx_id ni cart_snapshot
	// (ya estaban poblados en la fila existente).
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if !strings.HasPrefix(strings.TrimSpace(up), "UPDATE") || !strings.Contains(up, "POS_QR_PAYMENT_INTENTS") {
			continue
		}
		if strings.Contains(up, "SALE_CLIENT_TX_ID") {
			t.Errorf("UPDATE idempotente NO debe tocar sale_client_tx_id: %s", st.SQL)
		}
		if strings.Contains(up, "CART_SNAPSHOT") {
			t.Errorf("UPDATE idempotente NO debe tocar cart_snapshot: %s", st.SQL)
		}
		if strings.Contains(up, "QUEUED_AT") {
			t.Errorf("UPDATE idempotente NO debe tocar queued_at: %s", st.SQL)
		}
	}
}

// -----------------------------------------------------------------------------
// ListPendingByCaja — no selecciona cashier_name
// -----------------------------------------------------------------------------

func TestQrRepo_ListPendingByCaja_NoSelectCashierName(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	_, _ = repo.ListPendingByCaja(context.Background(), "CAJA-1", 10, time.Now())

	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, "CASHIER_NAME") {
			t.Errorf("ListPendingByCaja NO debe seleccionar cashier_name: %s", st.SQL)
		}
	}
}

// -----------------------------------------------------------------------------
// Finalization lifecycle (migración 027)
// -----------------------------------------------------------------------------

// Verifica que ClaimForFinalization rechaza intenciones sin snapshot
// o sin clientTxId (precondiciones de materialización).
func TestQrRepo_ClaimForFinalization_RechazaSinSnapshot(t *testing.T) {
	now := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.Contains(q, "SELECT") && strings.Contains(q, "POS_QR_PAYMENT_INTENTS") {
			return fakeResult{
				Columns: []string{
					"id", "venta_temp_id", "caja_id", "created_by_dni",
					"amount_cop", "status", "created_at", "expires_at",
					"approved_at", "approved_source", "approved_reference",
					"approved_event_id", "cancelled_at", "cancelled_by_dni",
					"cancel_reason", "manual_confirmed_by_dni",
					"manual_confirmed_note", "related_sale_id",
					"cart_snapshot", "client_snapshot", "totals_snapshot",
					"sale_client_tx_id", "queued_at",
					"finalization_status", "finalization_started_at",
					"finalization_completed_at", "finalization_attempts",
					"finalization_last_error", "finalization_next_retry_at",
					"cashier_notified_at",
				},
				Rows: [][]driver.Value{{
					int64(42), "temp-x", "CAJA-1", "EMP-1",
					int64(45800), "APROBADA", now, now.Add(5 * time.Minute),
					now, "BOLD_OFFICIAL", "bld-xyz", int64(1), nil, nil, nil, nil, nil, nil,
					nil, nil, nil, // cart/client/totals snapshot nil
					nil, nil, // sale_client_tx_id nil
					"NOT_STARTED", nil, nil, int64(0), nil, nil, nil,
				}},
			}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))
	_, err := repo.ClaimForFinalization(context.Background(), 42, func() time.Time { return now })
	if err != ErrQRFinalizationNotEligible {
		t.Errorf("sin snapshot debe ser NotEligible, got %v", err)
	}
}

// MarkFinalizationSucceeded exige saleID != 0 (defensa).
func TestQrRepo_MarkFinalizationSucceeded_RechazaSaleIDCero(t *testing.T) {
	repo := NewQrPaymentRepository(newFakeGormDB(t, &fakeSQL{}))
	if err := repo.MarkFinalizationSucceeded(context.Background(), 1, 0, nil); err != ErrQRInvalidInput {
		t.Errorf("MarkFinalizationSucceeded(saleID=0) debe ser ErrQRInvalidInput, got %v", err)
	}
	if err := repo.MarkFinalizationSucceeded(context.Background(), 0, 1, nil); err != ErrQRInvalidInput {
		t.Errorf("MarkFinalizationSucceeded(intentID=0) debe ser ErrQRInvalidInput, got %v", err)
	}
}

// MarkFinalizationFailed limita el mensaje a 255 chars (shape CHECK
// ck_pqpi_finalization_last_error_shape de la 027).
func TestQrRepo_MarkFinalizationFailed_RechazaIntentIDCero(t *testing.T) {
	repo := NewQrPaymentRepository(newFakeGormDB(t, &fakeSQL{}))
	if err := repo.MarkFinalizationFailed(context.Background(), 0, "boom", nil); err != ErrQRInvalidInput {
		t.Errorf("MarkFinalizationFailed(intentID=0) debe ser ErrQRInvalidInput, got %v", err)
	}
}
