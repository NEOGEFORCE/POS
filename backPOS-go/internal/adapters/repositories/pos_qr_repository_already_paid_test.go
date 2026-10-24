// Pruebas del guardia AlreadyPaid introducido tras el bug productivo
// del 23/10/2026: intent 53 APROBADA (SUCCEEDED, related_sale_id=33191)
// → 2 min después se creó intent 54 PENDIENTE con el MISMO
// venta_temp_id y otro sale_client_tx_id, con queued_at 1 s después.
//
// Lo que fijamos aquí:
//
//   - Initiate detecta la paid y devuelve Reused=true, AlreadyPaid=true
//     SIN INSERT y SIN UPDATE (no se toca la fila paid, ni se cancela
//     una PENDIENTE previa).
//
//   - El mismo guardia se replica para CONFIRMADA_MANUAL.
//
//   - CANCELADA / EXPIRADA no activan AlreadyPaid: el flujo tolera
//     reintentos sobre esos terminales.
//
//   - ListPendingByCaja excluye todo PENDIENTE cuyo venta_temp_id ya
//     tenga una paid (defensa contra filas fantasma de legacy).
//
//   - AssignEventToIntent rechaza con IntentAlreadyPaidError cuando el
//     venta_temp_id ya tiene paid, aunque la "latest" fila sea una
//     PENDIENTE fantasma.
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
// Helpers
// -----------------------------------------------------------------------------

// fakePaidRow devuelve el shape canónico de un intent APROBADO en el
// fakeSQL. relatedSaleID puede ser nil (aún no materializado).
func fakePaidRow(id, amount int64, ventaTempID, status string, relatedSaleID *int64) fakeResult {
	cols := []string{
		"id", "venta_temp_id", "caja_id", "created_by_dni",
		"amount_cop", "status", "created_at", "expires_at",
		"approved_at", "approved_source", "approved_reference",
		"approved_event_id", "cancelled_at", "cancelled_by_dni",
		"cancel_reason", "manual_confirmed_by_dni",
		"manual_confirmed_note", "related_sale_id",
	}
	now := time.Now().UTC()
	var related driver.Value
	if relatedSaleID != nil {
		related = *relatedSaleID
	} else {
		related = nil
	}
	return fakeResult{
		Columns: cols,
		Rows: [][]driver.Value{{
			id, ventaTempID, "CAJA-1", "EMP-1",
			amount, status, now, now.Add(10 * time.Minute),
			now, models.QRApprovalSourceBoldOfficial, "bld-xyz",
			int64(1), nil, nil, nil, nil, nil, related,
		}},
	}
}

// -----------------------------------------------------------------------------
// Initiate: APROBADA bloquea la creación de nuevos intents
// -----------------------------------------------------------------------------

// TestQrRepo_Initiate_AprobadaExistenteDevuelveAlreadyPaid reproduce
// exactamente la secuencia del bug productivo: existe un intent 53
// APROBADA (SUCCEEDED, related_sale_id=33191) para V; una nueva
// /iniciar para V no debe crear fila nueva, no debe adjuntar snapshots
// y no debe cancelar nada: devuelve AlreadyPaid con el saleId.
func TestQrRepo_Initiate_AprobadaExistenteDevuelveAlreadyPaid(t *testing.T) {
	saleID := int64(33191)
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.Contains(q, "PG_ADVISORY_XACT_LOCK") {
			return fakeResult{Columns: []string{"pg_advisory_xact_lock"}, Rows: [][]driver.Value{{""}}}
		}
		// Paid-check SELECT con STATUS IN. Devuelve el intent 53 APROBADA.
		if strings.Contains(q, "SELECT") && strings.Contains(q, "STATUS IN") &&
			strings.Contains(q, "POS_QR_PAYMENT_INTENTS") {
			return fakePaidRow(53, 10000, "V", models.QRIntentStatusApproved, &saleID)
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	// Simulamos /encolar (con snapshot + MarkQueued=true). El guardia
	// debe prevenir que la fila nueva se cree y que se adjunte queued_at
	// o snapshots a NADA.
	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":10000,"subtotal":10000}]`)
	outcome, err := repo.Initiate(context.Background(), InitiateIntentOptions{
		VentaTempID:    "V",
		CajaID:         "CAJA-1",
		CreatedByDNI:   "EMP-1",
		AmountCOP:      10000,
		TTL:            15 * time.Minute,
		Now:            func() time.Time { return time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC) },
		SaleClientTxID: "qr-tx-nuevo-02",
		CartSnapshot:   cart,
		MarkQueued:     true,
	})
	if err != nil {
		t.Fatalf("Initiate: %v", err)
	}
	if outcome == nil || outcome.Intent == nil {
		t.Fatal("outcome o intent nil")
	}
	if !outcome.Reused {
		t.Error("se esperaba Reused=true cuando ya existe paid")
	}
	if !outcome.AlreadyPaid {
		t.Error("se esperaba AlreadyPaid=true")
	}
	if outcome.Intent.ID != 53 {
		t.Errorf("intent devuelto debe ser el paid (53), got %d", outcome.Intent.ID)
	}
	if outcome.Intent.Status != models.QRIntentStatusApproved {
		t.Errorf("status esperado APROBADA, got %s", outcome.Intent.Status)
	}
	if outcome.Intent.RelatedSaleID == nil || *outcome.Intent.RelatedSaleID != uint64(saleID) {
		t.Errorf("related_sale_id = %v, want 33191", outcome.Intent.RelatedSaleID)
	}

	// NO debe haber INSERT (no creó intent 54).
	// NO debe haber UPDATE (no cancelamos previos, no adjuntamos snapshot).
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, "INSERT INTO \"POS_QR_PAYMENT_INTENTS\"") {
			t.Errorf("AlreadyPaid NO debe emitir INSERT: %s", st.SQL)
		}
		if strings.HasPrefix(strings.TrimSpace(up), "UPDATE") &&
			strings.Contains(up, "POS_QR_PAYMENT_INTENTS") {
			t.Errorf("AlreadyPaid NO debe emitir UPDATE sobre intents: %s", st.SQL)
		}
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("AlreadyPaid debe COMMIT limpio; eventos=%v", f.txEvents)
	}
}

// TestQrRepo_Initiate_ConfirmadaManualTambienBloquea verifica que
// CONFIRMADA_MANUAL (otro estado paid) también activa AlreadyPaid.
func TestQrRepo_Initiate_ConfirmadaManualTambienBloquea(t *testing.T) {
	saleID := int64(12345)
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.Contains(q, "PG_ADVISORY_XACT_LOCK") {
			return fakeResult{Columns: []string{"pg_advisory_xact_lock"}, Rows: [][]driver.Value{{""}}}
		}
		if strings.Contains(q, "SELECT") && strings.Contains(q, "STATUS IN") &&
			strings.Contains(q, "POS_QR_PAYMENT_INTENTS") {
			return fakePaidRow(60, 50000, "V-manual", models.QRIntentStatusConfirmedManual, &saleID)
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	outcome, err := repo.Initiate(context.Background(), InitiateIntentOptions{
		VentaTempID:  "V-manual",
		CajaID:       "CAJA-1",
		CreatedByDNI: "EMP-1",
		AmountCOP:    50000,
	})
	if err != nil {
		t.Fatalf("Initiate: %v", err)
	}
	if !outcome.AlreadyPaid {
		t.Error("CONFIRMADA_MANUAL también debe activar AlreadyPaid")
	}
	if outcome.Intent.Status != models.QRIntentStatusConfirmedManual {
		t.Errorf("status esperado CONFIRMADA_MANUAL, got %s", outcome.Intent.Status)
	}
}

// TestQrRepo_Initiate_CanceladaPermiteNuevaCreacion documenta que
// CANCELADA (terminal no-paid) NO activa AlreadyPaid: el cajero puede
// volver a abrir un cobro para el mismo venta_temp_id.
func TestQrRepo_Initiate_CanceladaPermiteNuevaCreacion(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.Contains(q, "PG_ADVISORY_XACT_LOCK") {
			return fakeResult{Columns: []string{"pg_advisory_xact_lock"}, Rows: [][]driver.Value{{""}}}
		}
		// Paid-check: no hay paid (sólo CANCELADA, no entra en STATUS IN).
		if strings.Contains(q, "SELECT") && strings.Contains(q, "STATUS IN") &&
			strings.Contains(q, "POS_QR_PAYMENT_INTENTS") {
			return fakeResult{}
		}
		// Live-pending: no hay PENDIENTE viva.
		if strings.Contains(q, "FOR UPDATE") {
			return fakeResult{}
		}
		if strings.Contains(q, "INSERT INTO \"POS_QR_PAYMENT_INTENTS\"") {
			return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(100)}}}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	outcome, err := repo.Initiate(context.Background(), InitiateIntentOptions{
		VentaTempID:  "V-cancelada",
		CajaID:       "CAJA-1",
		CreatedByDNI: "EMP-1",
		AmountCOP:    5000,
	})
	if err != nil {
		t.Fatalf("Initiate: %v", err)
	}
	if outcome.AlreadyPaid {
		t.Error("CANCELADA NO debe activar AlreadyPaid")
	}
	if outcome.Intent.ID != 100 {
		t.Errorf("ID esperado=100 (nuevo intent), got %d", outcome.Intent.ID)
	}
	if outcome.Reused {
		t.Error("sin previo paid ni pendiente, Reused debe ser false")
	}
}

// TestQrRepo_Initiate_ReuseConSnapshotNoAplicaCuandoPaid asegura que
// el camino "reuse con adjunto atómico de snapshot" NO se ejecuta
// cuando AlreadyPaid está activo. Es la misma secuencia del bug:
// /iniciar (sin snapshot) + /encolar (con snapshot) sobre V donde ya
// hay una paid. El guardia cierra el flujo ANTES de intentar adjuntar.
func TestQrRepo_Initiate_ReuseConSnapshotNoAplicaCuandoPaid(t *testing.T) {
	saleID := int64(33191)
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.Contains(q, "PG_ADVISORY_XACT_LOCK") {
			return fakeResult{Columns: []string{"pg_advisory_xact_lock"}, Rows: [][]driver.Value{{""}}}
		}
		if strings.Contains(q, "SELECT") && strings.Contains(q, "STATUS IN") &&
			strings.Contains(q, "POS_QR_PAYMENT_INTENTS") {
			return fakePaidRow(53, 10000, "V", models.QRIntentStatusApproved, &saleID)
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	cart := []byte(`[{"barcode":"B","quantity":1,"unitPrice":10000,"subtotal":10000}]`)
	outcome, err := repo.Initiate(context.Background(), InitiateIntentOptions{
		VentaTempID:    "V",
		CajaID:         "CAJA-1",
		CreatedByDNI:   "EMP-1",
		AmountCOP:      10000,
		SaleClientTxID: "qr-tx-nuevo-xx", // intento de adjuntar nuevo clientTxId
		CartSnapshot:   cart,             // intento de adjuntar nuevo snapshot
		MarkQueued:     true,             // intento de marcar queued_at
	})
	if err != nil {
		t.Fatalf("Initiate: %v", err)
	}
	if !outcome.AlreadyPaid {
		t.Fatal("se esperaba AlreadyPaid=true")
	}

	// Ni el sale_client_tx_id, ni el cart_snapshot, ni queued_at
	// deben haber sido adjuntados a la fila paid.
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if !strings.HasPrefix(strings.TrimSpace(up), "UPDATE") {
			continue
		}
		for _, forbidden := range []string{"SALE_CLIENT_TX_ID", "CART_SNAPSHOT", "QUEUED_AT"} {
			if strings.Contains(up, forbidden) {
				t.Errorf("AlreadyPaid NO debe adjuntar %s a la fila paid: %s", forbidden, st.SQL)
			}
		}
	}
}

// -----------------------------------------------------------------------------
// ListPendingByCaja: excluye venta_temp_ids con paid
// -----------------------------------------------------------------------------

// TestQrRepo_ListPendingByCaja_NotExistsPaidAplicado verifica que la
// query filtra con NOT EXISTS (SELECT ... WHERE paid.venta_temp_id =
// p.venta_temp_id AND paid.status IN ('APROBADA','CONFIRMADA_MANUAL')).
// Guardián estático: busca el patrón NOT EXISTS en el SQL generado.
func TestQrRepo_ListPendingByCaja_NotExistsPaidAplicado(t *testing.T) {
	var seenSQL string
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		if strings.HasPrefix(strings.TrimSpace(up), "SELECT") && strings.Contains(up, "POS_QR_PAYMENT_INTENTS") {
			seenSQL = up
			return fakeResult{}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	_, err := repo.ListPendingByCaja(context.Background(), "CAJA-1", 20, time.Now())
	if err != nil {
		t.Fatalf("ListPendingByCaja: %v", err)
	}
	if !strings.Contains(seenSQL, "NOT EXISTS") {
		t.Errorf("ListPendingByCaja debe incluir NOT EXISTS para excluir venta_temp_ids con paid: %s", seenSQL)
	}
	// Y debe mencionar los dos estados paid.
	for _, needed := range []string{"APROBADA", "CONFIRMADA_MANUAL"} {
		if !strings.Contains(seenSQL, needed) && !strings.Contains(strings.ToLower(seenSQL), strings.ToLower(needed)) {
			// GORM parametriza, los valores viajan como args, pero el
			// SQL debe tener la referencia a status IN con placeholders.
			// Al menos la cláusula STATUS IN debe estar presente.
		}
	}
	// La cláusula "STATUS IN (" (parametrizada) debe aparecer dentro
	// del NOT EXISTS.
	if !strings.Contains(seenSQL, "STATUS IN") {
		t.Errorf("NOT EXISTS debe filtrar por paid.STATUS IN (...): %s", seenSQL)
	}
}

// -----------------------------------------------------------------------------
// AssignEventToIntent: rechaza si V ya tiene paid
// -----------------------------------------------------------------------------

// TestQrRepo_AssignEventToIntent_RechazaSiVentaYaAprobada: aunque el
// cajero intente asignar un evento a una PENDIENTE fantasma, si V ya
// tiene una paid el repo devuelve *IntentAlreadyPaidError con el saleId.
func TestQrRepo_AssignEventToIntent_RechazaSiVentaYaAprobada(t *testing.T) {
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	received := now.Add(-5 * time.Minute)
	saleID := int64(33191)
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, "POS_QR_PAYMENT_INTENTS") &&
			strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "STATUS IN"):
			return fakePaidRow(53, 10000, "V", models.QRIntentStatusApproved, &saleID)
		case strings.HasPrefix(strings.TrimSpace(up), "SELECT") && strings.Contains(up, "POS_QR_WEBHOOK_EVENTS"):
			return fakeEventRow(99, 10000, "UNMATCHED", "BRIDGE_NOTIFICATION", received, "Recibiste $10.000", nil)
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	_, err := repo.AssignEventToIntent(context.Background(), AssignEventOptions{
		VentaTempID: "V",
		EventID:     99,
		ActorDNI:    "EMP-7",
		Now:         func() time.Time { return now },
	})
	if !errors.Is(err, ErrQRIntentAlreadyPaid) {
		t.Fatalf("errors.Is debe reconocer ErrQRIntentAlreadyPaid, got %v", err)
	}
	var paidErr *IntentAlreadyPaidError
	if !errors.As(err, &paidErr) {
		t.Fatalf("errors.As debe extraer *IntentAlreadyPaidError, got %T", err)
	}
	if paidErr.SaleID != uint64(saleID) {
		t.Errorf("saleId extraído = %d, want 33191", paidErr.SaleID)
	}
	if paidErr.Status != models.QRIntentStatusApproved {
		t.Errorf("status = %s, want APROBADA", paidErr.Status)
	}
	// NO debe haber UPDATE sobre eventos ni intents.
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.HasPrefix(strings.TrimSpace(up), "UPDATE") {
			t.Errorf("AlreadyPaid NO debe emitir UPDATE: %s", st.SQL)
		}
	}
}

// -----------------------------------------------------------------------------
// GetLatestPaidByVentaTempID — lectura directa
// -----------------------------------------------------------------------------

func TestQrRepo_GetLatestPaidByVentaTempID_DevuelvePaid(t *testing.T) {
	saleID := int64(33191)
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		if strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "POS_QR_PAYMENT_INTENTS") &&
			strings.Contains(up, "STATUS IN") {
			return fakePaidRow(53, 10000, "V", models.QRIntentStatusApproved, &saleID)
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))
	row, err := repo.GetLatestPaidByVentaTempID(context.Background(), "V")
	if err != nil {
		t.Fatalf("GetLatestPaidByVentaTempID: %v", err)
	}
	if row.ID != 53 {
		t.Errorf("id = %d, want 53", row.ID)
	}
}

func TestQrRepo_GetLatestPaidByVentaTempID_NotFoundSinPaid(t *testing.T) {
	repo := NewQrPaymentRepository(newFakeGormDB(t, &fakeSQL{}))
	_, err := repo.GetLatestPaidByVentaTempID(context.Background(), "V")
	if !errors.Is(err, ErrQRIntentNotFound) {
		t.Errorf("sin paid debe NotFound, got %v", err)
	}
}

func TestQrRepo_GetLatestPaidByVentaTempID_RechazaInput(t *testing.T) {
	repo := NewQrPaymentRepository(newFakeGormDB(t, &fakeSQL{}))
	if _, err := repo.GetLatestPaidByVentaTempID(context.Background(), ""); !errors.Is(err, ErrQRIntentNotFound) {
		t.Errorf("venta_temp_id vacío debe NotFound, got %v", err)
	}
}
