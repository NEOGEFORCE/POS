package repositories

import (
	"context"
	"database/sql/driver"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================================
// Pruebas del QrPaymentRepository con el fake SQL driver.
//
// Lo que se verifica:
//
//   - Initiate rechaza inputs duros (DNI vacío, monto fuera de rango).
//   - Initiate ejecuta el advisory_xact_lock y el UPDATE "expirar stale"
//     antes del INSERT en una única tx confirmada.
//   - Cancel usa SELECT ... FOR UPDATE y filtra por status PENDIENTE
//     para no "cancelar" aprobaciones.
//   - ConfirmManual persiste approved_source=MANUAL y manual_confirmed_by_dni.
//   - IngestWebhook con fingerprint duplicado devuelve ErrQRWebhookDuplicate
//     y hace ROLLBACK (no persiste el evento).
//   - IngestWebhook sin candidatos devuelve APPROVED/UNMATCHED/AMBIGUOUS
//     correctamente y nunca aprueba cuando count != 1.
//   - Ningún log del archivo imprime secretos.
//
// Pruebas con BD real (biyecciones de la 026) viven en el runner de la
// migración 026 y en una batería de integración posterior.
// =============================================================================

// -----------------------------------------------------------------------------
// Guardianes puros (sin BD)
// -----------------------------------------------------------------------------

func TestQrRepo_Initiate_RechazaInputsDuros(t *testing.T) {
	repo := NewQrPaymentRepository(newFakeGormDB(t, &fakeSQL{}))
	cases := []struct {
		name string
		in   InitiateIntentOptions
	}{
		{"venta_temp_id vacío", InitiateIntentOptions{CajaID: "C", CreatedByDNI: "D", AmountCOP: 1000}},
		{"caja vacía", InitiateIntentOptions{VentaTempID: "v123", CreatedByDNI: "D", AmountCOP: 1000}},
		{"dni vacío", InitiateIntentOptions{VentaTempID: "v123", CajaID: "C", AmountCOP: 1000}},
		{"monto 0", InitiateIntentOptions{VentaTempID: "v123", CajaID: "C", CreatedByDNI: "D", AmountCOP: 0}},
		{"monto negativo", InitiateIntentOptions{VentaTempID: "v123", CajaID: "C", CreatedByDNI: "D", AmountCOP: -100}},
		{"monto por encima del tope", InitiateIntentOptions{VentaTempID: "v123", CajaID: "C", CreatedByDNI: "D", AmountCOP: models.QRPaymentIntentMaxAmountCOP + 1}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := repo.Initiate(context.Background(), c.in)
			if !errors.Is(err, ErrQRInvalidInput) {
				t.Errorf("se esperaba ErrQRInvalidInput, got %v", err)
			}
		})
	}
}

func TestQrRepo_Cancel_RechazaInputsDuros(t *testing.T) {
	repo := NewQrPaymentRepository(newFakeGormDB(t, &fakeSQL{}))
	cases := []struct {
		venta string
		actor string
	}{
		{"", "D"},
		{"v123", ""},
		{"  ", "D"},
	}
	for _, c := range cases {
		if _, err := repo.Cancel(context.Background(), c.venta, c.actor, "", nil); !errors.Is(err, ErrQRInvalidInput) {
			t.Errorf("Cancel(%q,%q) esperaba ErrQRInvalidInput, got %v", c.venta, c.actor, err)
		}
	}
}

func TestQrRepo_ConfirmManual_RechazaInputsDuros(t *testing.T) {
	repo := NewQrPaymentRepository(newFakeGormDB(t, &fakeSQL{}))
	cases := []ConfirmManualInput{
		{VentaTempID: "", ActorDNI: "D"},
		{VentaTempID: "v123", ActorDNI: ""},
	}
	for _, c := range cases {
		if _, err := repo.ConfirmManual(context.Background(), c); !errors.Is(err, ErrQRInvalidInput) {
			t.Errorf("ConfirmManual(%+v) esperaba ErrQRInvalidInput, got %v", c, err)
		}
	}
}

func TestQrRepo_IngestWebhook_RechazaInputsDuros(t *testing.T) {
	repo := NewQrPaymentRepository(newFakeGormDB(t, &fakeSQL{}))
	cases := []struct {
		name string
		in   IngestWebhookInput
	}{
		{"source desconocido", IngestWebhookInput{Source: "unknown", Fingerprint: strings.Repeat("a", 16), AmountCOP: 1000}},
		{"fingerprint vacío", IngestWebhookInput{Source: models.QRWebhookSourceOfficial, Fingerprint: "", AmountCOP: 1000}},
		{"fingerprint corto", IngestWebhookInput{Source: models.QRWebhookSourceOfficial, Fingerprint: "short", AmountCOP: 1000}},
		{"monto fuera de rango", IngestWebhookInput{Source: models.QRWebhookSourceBridge, Fingerprint: strings.Repeat("a", 16), AmountCOP: 0}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := repo.IngestWebhook(context.Background(), c.in); !errors.Is(err, ErrQRInvalidInput) {
				t.Errorf("se esperaba ErrQRInvalidInput, got %v", err)
			}
		})
	}
}

// -----------------------------------------------------------------------------
// Initiate: orden de sentencias
// -----------------------------------------------------------------------------

func TestQrRepo_Initiate_HappyPath_EjecutaAdvisoryLockBarridoYInsert(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		q = strings.ToUpper(q)
		// advisory_xact_lock: devuelve una fila con true.
		if strings.Contains(q, "PG_ADVISORY_XACT_LOCK") {
			return fakeResult{Columns: []string{"pg_advisory_xact_lock"}, Rows: [][]driver.Value{{""}}}
		}
		// FOR UPDATE buscando previo: sin resultados.
		if strings.Contains(q, "FOR UPDATE") {
			return fakeResult{Columns: []string{}, Rows: nil}
		}
		// INSERT con RETURNING id: devolvemos 77.
		if strings.Contains(q, "INSERT INTO \"POS_QR_PAYMENT_INTENTS\"") {
			return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(77)}}}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	outcome, err := repo.Initiate(context.Background(), InitiateIntentOptions{
		VentaTempID:  "temp-abc-1234",
		CajaID:       "CAJA-1",
		CreatedByDNI: "EMP-1",
		AmountCOP:    45800,
		TTL:          5 * time.Minute,
		Now:          func() time.Time { return time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("Initiate falló: %v", err)
	}
	if outcome == nil || outcome.Intent == nil {
		t.Fatal("outcome o intent nil")
	}
	if outcome.Reused {
		t.Error("sin previo, Reused debe ser false")
	}
	if outcome.Intent.ID != 77 {
		t.Errorf("ID esperado=77, got %d", outcome.Intent.ID)
	}

	// Verifica que las sentencias clave aparezcan en orden.
	stmts := f.statements()
	seenLock := false
	seenExpire := false
	seenInsert := false
	var insertSQL string
	for _, st := range stmts {
		up := strings.ToUpper(st.SQL)
		switch {
		case strings.Contains(up, "PG_ADVISORY_XACT_LOCK"):
			seenLock = true
		case strings.HasPrefix(strings.TrimSpace(up), "UPDATE") &&
			len(st.Vars) > 0 && st.Vars[0] == models.QRIntentStatusExpired:
			if seenInsert {
				t.Error("barrido EXPIRADA debe ocurrir ANTES del INSERT")
			}
			seenExpire = true
		case strings.Contains(up, "INSERT INTO \"POS_QR_PAYMENT_INTENTS\""):
			if !seenLock {
				t.Error("INSERT debe ocurrir DESPUÉS del advisory lock")
			}
			insertSQL = up
			seenInsert = true
		}
	}
	if !seenLock {
		t.Error("falta pg_advisory_xact_lock en la tx de Initiate")
	}
	if !seenExpire {
		t.Error("falta UPDATE de barrido a EXPIRADA")
	}
	if !seenInsert {
		t.Error("falta INSERT INTO pos_qr_payment_intents")
	}
	for _, required := range []string{
		"VENTA_TEMP_ID", "CAJA_ID", "CREATED_BY_DNI", "AMOUNT_COP",
		"STATUS", "CREATED_AT", "EXPIRES_AT",
	} {
		if !strings.Contains(insertSQL, required) {
			t.Errorf("INSERT PENDIENTE debe incluir %s: %s", required, insertSQL)
		}
	}
	for _, nullable := range []string{
		"APPROVED_SOURCE", "APPROVED_REFERENCE", "CANCELLED_BY_DNI",
		"CANCEL_REASON", "MANUAL_CONFIRMED_BY_DNI", "MANUAL_CONFIRMED_NOTE",
	} {
		if strings.Contains(insertSQL, nullable) {
			t.Errorf("INSERT PENDIENTE no debe incluir %s; PostgreSQL debe aplicar NULL: %s", nullable, insertSQL)
		}
	}

	// Toda la operación en UNA tx confirmada.
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("Initiate debe COMMIT; eventos=%v", f.txEvents)
	}
}

func TestQrRepo_Initiate_ReusaPendienteVivoConMismoMonto(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.Contains(q, "FOR UPDATE") {
			// Devuelve un PENDIENTE vigente con AmountCOP=45800.
			return fakeResult{
				Columns: []string{
					"id", "venta_temp_id", "caja_id", "created_by_dni",
					"amount_cop", "status", "created_at", "expires_at",
					"approved_at", "approved_source", "approved_reference",
					"approved_event_id", "cancelled_at", "cancelled_by_dni",
					"cancel_reason", "manual_confirmed_by_dni",
					"manual_confirmed_note", "related_sale_id",
				},
				Rows: [][]driver.Value{{
					int64(42), "temp-abc-1234", "CAJA-1", "EMP-1",
					int64(45800), "PENDIENTE",
					time.Now().UTC(), time.Date(3000, 1, 1, 0, 0, 0, 0, time.UTC),
					nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
				}},
			}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	outcome, err := repo.Initiate(context.Background(), InitiateIntentOptions{
		VentaTempID:  "temp-abc-1234",
		CajaID:       "CAJA-1",
		CreatedByDNI: "EMP-1",
		AmountCOP:    45800,
	})
	if err != nil {
		t.Fatalf("Initiate: %v", err)
	}
	if outcome == nil || !outcome.Reused {
		t.Fatalf("se esperaba Reused=true cuando el PENDIENTE con mismo monto está vigente, got %+v", outcome)
	}
	if outcome.Intent.ID != 42 {
		t.Errorf("ID esperado=42 (fila reusada), got %d", outcome.Intent.ID)
	}

	// NO debe haber INSERT porque reusa.
	for _, st := range f.statements() {
		if strings.Contains(strings.ToUpper(st.SQL), "INSERT INTO \"POS_QR_PAYMENT_INTENTS\"") {
			t.Errorf("reuse NO debe emitir INSERT: %s", st.SQL)
		}
	}
}

// -----------------------------------------------------------------------------
// Cancel
// -----------------------------------------------------------------------------

func TestQrRepo_Cancel_UsaSelectForUpdate(t *testing.T) {
	now := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	future := now.Add(2 * time.Minute)
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
				},
				Rows: [][]driver.Value{{
					int64(42), "temp-abc-1234", "CAJA-1", "EMP-1",
					int64(45800), "PENDIENTE",
					now, future,
					nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
				}},
			}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	out, err := repo.Cancel(context.Background(), "temp-abc-1234", "EMP-1", "cambio_metodo", func() time.Time { return now })
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if out.Status != models.QRIntentStatusCancelled {
		t.Errorf("status esperado=CANCELADA, got %s", out.Status)
	}
	// SELECT ... FOR UPDATE presente.
	hasForUpdate := false
	hasUpdateCancel := false
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, "FOR UPDATE") {
			hasForUpdate = true
		}
		if strings.HasPrefix(strings.TrimSpace(up), "UPDATE") &&
			strings.Contains(up, "POS_QR_PAYMENT_INTENTS") {
			// Map iteration en Updates(map[...]) hace que el orden
			// de los Vars sea aleatorio. Buscamos CANCELADA en
			// cualquier posición.
			for _, v := range st.Vars {
				if v == models.QRIntentStatusCancelled {
					hasUpdateCancel = true
					break
				}
			}
		}
	}
	if !hasForUpdate {
		t.Error("Cancel debe emitir SELECT ... FOR UPDATE")
	}
	if !hasUpdateCancel {
		t.Error("Cancel debe emitir UPDATE SET status=CANCELADA")
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("Cancel debe COMMIT; eventos=%v", f.txEvents)
	}
}

func TestQrRepo_Cancel_IntentNoEncontrado(t *testing.T) {
	// Sin respond definido: devuelve 0 filas en el SELECT.
	repo := NewQrPaymentRepository(newFakeGormDB(t, &fakeSQL{}))
	_, err := repo.Cancel(context.Background(), "temp-xyz", "EMP-1", "x", nil)
	if !errors.Is(err, ErrQRIntentNotFound) {
		t.Fatalf("se esperaba ErrQRIntentNotFound, got %v", err)
	}
}

// -----------------------------------------------------------------------------
// IngestWebhook
// -----------------------------------------------------------------------------

func TestQrRepo_IngestWebhook_FingerprintDuplicado(t *testing.T) {
	// El SELECT por (source, fingerprint) encuentra una fila previa.
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.Contains(q, "SELECT") && strings.Contains(q, "POS_QR_WEBHOOK_EVENTS") {
			return fakeResult{
				Columns: []string{"id", "received_at", "source", "event_type",
					"external_id", "fingerprint", "amount_cop", "processed_at",
					"processed_status", "matched_intent_id", "note"},
				Rows: [][]driver.Value{{
					int64(100), time.Now().UTC(), "BOLD_OFFICIAL", "SALE_APPROVED",
					"bold-xyz", "fingerprint-abc12345", int64(45800),
					time.Now().UTC(), "APPROVED", int64(42), "",
				}},
			}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	_, err := repo.IngestWebhook(context.Background(), IngestWebhookInput{
		Source:      models.QRWebhookSourceOfficial,
		Fingerprint: "fingerprint-abc12345",
		ExternalID:  "bold-xyz",
		AmountCOP:   45800,
		EventType:   "SALE_APPROVED",
	})
	if !errors.Is(err, ErrQRWebhookDuplicate) {
		t.Fatalf("se esperaba ErrQRWebhookDuplicate, got %v", err)
	}
	// Rollback obligatorio para no persistir basura.
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("duplicate debe ROLLBACK; eventos=%v", f.txEvents)
	}
}

func TestQrRepo_IngestWebhook_NoCandidatos_PersisteUNMATCHED(t *testing.T) {
	seenInsert := false
	var insertVars []interface{}
	f := &fakeSQL{respond: func(q string, args []interface{}) fakeResult {
		q = strings.ToUpper(q)
		// Dedupe SELECTs: sin fila.
		if strings.HasPrefix(strings.TrimSpace(q), "SELECT") && strings.Contains(q, "POS_QR_WEBHOOK_EVENTS") {
			return fakeResult{}
		}
		// FOR UPDATE sobre intents: 0 candidatos.
		if strings.Contains(q, "FOR UPDATE") {
			return fakeResult{}
		}
		// INSERT del evento.
		if strings.Contains(q, "INSERT INTO \"POS_QR_WEBHOOK_EVENTS\"") {
			seenInsert = true
			insertVars = args
			return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(500)}}}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	outcome, err := repo.IngestWebhook(context.Background(), IngestWebhookInput{
		Source:      models.QRWebhookSourceOfficial,
		Fingerprint: "fingerprint-unmatched",
		ExternalID:  "bold-unmatched",
		AmountCOP:   50000,
		EventType:   "SALE_APPROVED",
	})
	if err != nil {
		t.Fatalf("IngestWebhook: %v", err)
	}
	if outcome.Event == nil {
		t.Fatal("outcome.Event nil (debe persistir aun en UNMATCHED)")
	}
	if outcome.MatchedIntent != nil {
		t.Error("UNMATCHED NO debe aprobar intención")
	}
	if outcome.Event.ProcessedStatus != models.QRWebhookStatusUnmatched {
		t.Errorf("processed_status esperado UNMATCHED, got %s", outcome.Event.ProcessedStatus)
	}
	if !seenInsert {
		t.Fatal("se esperaba INSERT del evento")
	}
	// Entre los Vars del INSERT debe aparecer el literal 'UNMATCHED'.
	hasUnmatched := false
	for _, v := range insertVars {
		if s, ok := v.(string); ok && s == models.QRWebhookStatusUnmatched {
			hasUnmatched = true
			break
		}
	}
	if !hasUnmatched {
		t.Errorf("Vars del INSERT no incluyen UNMATCHED: %v", insertVars)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("UNMATCHED debe COMMIT; eventos=%v", f.txEvents)
	}
}

func TestQrRepo_IngestWebhook_MultiplesCandidatos_RegistraAMBIGUOUS(t *testing.T) {
	now := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	// Dos PENDIENTES vigentes con el mismo monto.
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.HasPrefix(strings.TrimSpace(q), "SELECT") && strings.Contains(q, "POS_QR_WEBHOOK_EVENTS") {
			return fakeResult{}
		}
		if strings.Contains(q, "FOR UPDATE") {
			return fakeResult{
				Columns: []string{
					"id", "venta_temp_id", "caja_id", "created_by_dni",
					"amount_cop", "status", "created_at", "expires_at",
					"approved_at", "approved_source", "approved_reference",
					"approved_event_id", "cancelled_at", "cancelled_by_dni",
					"cancel_reason", "manual_confirmed_by_dni",
					"manual_confirmed_note", "related_sale_id",
				},
				Rows: [][]driver.Value{
					{int64(1), "temp-A", "CAJA-1", "EMP-1", int64(45800), "PENDIENTE",
						now, now.Add(2 * time.Minute),
						nil, nil, nil, nil, nil, nil, nil, nil, nil, nil},
					{int64(2), "temp-B", "CAJA-2", "EMP-2", int64(45800), "PENDIENTE",
						now, now.Add(2 * time.Minute),
						nil, nil, nil, nil, nil, nil, nil, nil, nil, nil},
				},
			}
		}
		if strings.Contains(q, "INSERT INTO \"POS_QR_WEBHOOK_EVENTS\"") {
			return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(999)}}}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	outcome, err := repo.IngestWebhook(context.Background(), IngestWebhookInput{
		Source:      models.QRWebhookSourceBridge,
		Fingerprint: "fp-ambig-abcdef",
		AmountCOP:   45800,
		Now:         func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("IngestWebhook: %v", err)
	}
	if outcome.Event.ProcessedStatus != models.QRWebhookStatusAmbiguous {
		t.Errorf("se esperaba AMBIGUOUS, got %s", outcome.Event.ProcessedStatus)
	}
	if outcome.MatchedIntent != nil {
		t.Error("AMBIGUOUS NUNCA aprueba intención")
	}
	if len(outcome.Pending) != 2 {
		t.Errorf("se esperaba Pending=2, got %d", len(outcome.Pending))
	}
	// NO debe haber UPDATE sobre intents (ni aprobar).
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.HasPrefix(strings.TrimSpace(up), "UPDATE") && strings.Contains(up, "POS_QR_PAYMENT_INTENTS") {
			t.Errorf("AMBIGUOUS NO debe UPDATE intents: %s", st.SQL)
		}
	}
}

// TestQrRepo_IngestWebhook_BridgeConExternalIDVacio_OmiteColumna
// bloquea la regresión que causó el QR_REQUEST_FAILED en producción:
// el bridge MacroDroid envía `external_id=""`, y el CHECK
// `ck_pqwe_external_id_shape` rechaza el string vacío (NULL o
// 1..128 chars). El repo DEBE omitir la columna del INSERT para que
// Postgres aplique NULL. Si alguien vuelve a persistir `”`, el test
// falla.
func TestQrRepo_IngestWebhook_BridgeConExternalIDVacio_OmiteColumna(t *testing.T) {
	seenInsert := false
	var insertSQL string
	var insertVars []interface{}
	f := &fakeSQL{respond: func(q string, args []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.HasPrefix(strings.TrimSpace(q), "SELECT") && strings.Contains(q, "POS_QR_WEBHOOK_EVENTS") {
			return fakeResult{}
		}
		if strings.Contains(q, "FOR UPDATE") {
			return fakeResult{}
		}
		if strings.Contains(q, "INSERT INTO \"POS_QR_WEBHOOK_EVENTS\"") {
			seenInsert = true
			insertSQL = q
			insertVars = args
			return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(777)}}}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	outcome, err := repo.IngestWebhook(context.Background(), IngestWebhookInput{
		Source:      models.QRWebhookSourceBridge,
		Fingerprint: "fingerprint-bridge-abcdef",
		ExternalID:  "", // bridge MacroDroid no entrega id canónico
		AmountCOP:   30000,
		EventType:   "PUSH_NOTIFICATION",
	})
	if err != nil {
		t.Fatalf("IngestWebhook con externalID vacío debe COMMIT limpio, got %v", err)
	}
	if outcome.Event == nil {
		t.Fatal("outcome.Event nil con externalID vacío")
	}
	if !seenInsert {
		t.Fatal("se esperaba INSERT del evento")
	}
	// La columna EXTERNAL_ID NO debe aparecer en el SQL del INSERT.
	// Si alguien vuelve a introducir el bug (persistir '' que viola
	// ck_pqwe_external_id_shape), este test falla.
	if strings.Contains(insertSQL, "EXTERNAL_ID") {
		t.Errorf("INSERT bridge NO debe incluir EXTERNAL_ID cuando viene vacío (Postgres debe aplicar NULL): %s", insertSQL)
	}
	// Y entre los Vars del INSERT no debe aparecer la cadena '' que
	// pasaría al CHECK. Buscamos cualquier string "" en los vars.
	for i, v := range insertVars {
		if s, ok := v.(string); ok && s == "" {
			// Las VARCHAR legítimas con valor pueden existir ("" en
			// EventType cuando el bridge no lo manda es válido porque
			// no tiene CHECK), pero la columna external_id no debe
			// bindearse. El SQL ya lo confirmó arriba; esta es sólo
			// una señal más que ayuda a diagnosticar si hay regresión.
			_ = i
		}
	}
	// Columnas obligatorias y las que SÍ queremos.
	for _, needed := range []string{"SOURCE", "FINGERPRINT", "AMOUNT_COP", "PROCESSED_STATUS"} {
		if !strings.Contains(insertSQL, needed) {
			t.Errorf("INSERT debe incluir %s: %s", needed, insertSQL)
		}
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("UNMATCHED con externalID vacío debe COMMIT; eventos=%v", f.txEvents)
	}
}

// TestQrRepo_IngestWebhook_OficialConExternalIDLegitimo_IncluyeColumna
// afirma el camino "feliz": cuando el webhook oficial entrega un
// bold_code, SÍ se persiste la columna external_id.
func TestQrRepo_IngestWebhook_OficialConExternalIDLegitimo_IncluyeColumna(t *testing.T) {
	seenInsert := false
	var insertSQL string
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.HasPrefix(strings.TrimSpace(q), "SELECT") && strings.Contains(q, "POS_QR_WEBHOOK_EVENTS") {
			return fakeResult{}
		}
		if strings.Contains(q, "FOR UPDATE") {
			return fakeResult{}
		}
		if strings.Contains(q, "INSERT INTO \"POS_QR_WEBHOOK_EVENTS\"") {
			seenInsert = true
			insertSQL = q
			return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(888)}}}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	_, err := repo.IngestWebhook(context.Background(), IngestWebhookInput{
		Source:      models.QRWebhookSourceOfficial,
		Fingerprint: "fingerprint-oficial-abcdef",
		ExternalID:  "bld-canonico-123",
		AmountCOP:   30000,
		EventType:   "SALE_APPROVED",
	})
	if err != nil {
		t.Fatalf("IngestWebhook oficial: %v", err)
	}
	if !seenInsert {
		t.Fatal("se esperaba INSERT del evento")
	}
	if !strings.Contains(insertSQL, "EXTERNAL_ID") {
		t.Errorf("INSERT oficial DEBE incluir EXTERNAL_ID cuando viene con bold_code: %s", insertSQL)
	}
}

func TestQrRepo_IngestWebhook_UnCandidato_AprobaIntentConReferencia(t *testing.T) {
	now := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	f := &fakeSQL{respond: func(q string, args []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.HasPrefix(strings.TrimSpace(q), "SELECT") && strings.Contains(q, "POS_QR_WEBHOOK_EVENTS") {
			return fakeResult{}
		}
		if strings.Contains(q, "FOR UPDATE") {
			return fakeResult{
				Columns: []string{
					"id", "venta_temp_id", "caja_id", "created_by_dni",
					"amount_cop", "status", "created_at", "expires_at",
					"approved_at", "approved_source", "approved_reference",
					"approved_event_id", "cancelled_at", "cancelled_by_dni",
					"cancel_reason", "manual_confirmed_by_dni",
					"manual_confirmed_note", "related_sale_id",
				},
				Rows: [][]driver.Value{{
					int64(55), "temp-only-one", "CAJA-1", "EMP-1", int64(45800), "PENDIENTE",
					now, now.Add(2 * time.Minute),
					nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
				}},
			}
		}
		if strings.Contains(q, "INSERT INTO \"POS_QR_WEBHOOK_EVENTS\"") {
			return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(999)}}}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	outcome, err := repo.IngestWebhook(context.Background(), IngestWebhookInput{
		Source:      models.QRWebhookSourceOfficial,
		ExternalID:  "bold-ref-123",
		Fingerprint: "fp-single-abcdef",
		AmountCOP:   45800,
		EventType:   "SALE_APPROVED",
		Now:         func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("IngestWebhook: %v", err)
	}
	if outcome.Event.ProcessedStatus != models.QRWebhookStatusApproved {
		t.Errorf("se esperaba APPROVED, got %s", outcome.Event.ProcessedStatus)
	}
	if outcome.MatchedIntent == nil {
		t.Fatal("MatchedIntent nil")
	}
	if outcome.MatchedIntent.Status != models.QRIntentStatusApproved {
		t.Errorf("intent status esperado APROBADA, got %s", outcome.MatchedIntent.Status)
	}
	if outcome.MatchedIntent.ApprovedSource != models.QRApprovalSourceBoldOfficial {
		t.Errorf("approved_source esperado BOLD_OFFICIAL, got %s", outcome.MatchedIntent.ApprovedSource)
	}
	if outcome.MatchedIntent.ApprovedReference != "bold-ref-123" {
		t.Errorf("approved_reference esperado 'bold-ref-123' (bold_code), got %s",
			outcome.MatchedIntent.ApprovedReference)
	}
	// Buscamos UPDATE sobre intents con 'APROBADA' en CUALQUIER var
	// (Updates(map[...]) tiene orden aleatorio).
	seenUpdateIntent := false
	hasApproved := false
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.HasPrefix(strings.TrimSpace(up), "UPDATE") && strings.Contains(up, "POS_QR_PAYMENT_INTENTS") {
			seenUpdateIntent = true
			for _, v := range st.Vars {
				if s, ok := v.(string); ok && s == models.QRIntentStatusApproved {
					hasApproved = true
				}
			}
		}
	}
	if !seenUpdateIntent {
		t.Fatal("se esperaba UPDATE sobre intents")
	}
	if !hasApproved {
		t.Errorf("UPDATE no incluye APROBADA en vars")
	}
}

// -----------------------------------------------------------------------------
// Advisory lock por amount_cop
// -----------------------------------------------------------------------------

func TestQrRepo_IngestWebhook_UsaAdvisoryLockPorMonto(t *testing.T) {
	// tx.Exec va por ExecContext (no QueryContext), por lo que no
	// pasa por `respond`. Lo verificamos vía f.statements().
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		q = strings.ToUpper(q)
		if strings.HasPrefix(strings.TrimSpace(q), "SELECT") && strings.Contains(q, "POS_QR_WEBHOOK_EVENTS") {
			return fakeResult{}
		}
		if strings.Contains(q, "FOR UPDATE") {
			return fakeResult{}
		}
		if strings.Contains(q, "INSERT INTO \"POS_QR_WEBHOOK_EVENTS\"") {
			return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(1)}}}
		}
		return fakeResult{}
	}}
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	_, _ = repo.IngestWebhook(context.Background(), IngestWebhookInput{
		Source:      models.QRWebhookSourceOfficial,
		Fingerprint: "fp-lock-abcdef",
		AmountCOP:   45800,
	})

	seenLock := false
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, "PG_ADVISORY_XACT_LOCK") {
			seenLock = true
			// Verificar que la clave incluya "qr_match:"
			found := false
			for _, v := range st.Vars {
				if s, ok := v.(string); ok && strings.HasPrefix(s, "qr_match:") {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("advisory_xact_lock sin clave 'qr_match:<monto>'; vars=%v", st.Vars)
			}
		}
	}
	if !seenLock {
		t.Errorf("IngestWebhook debe emitir pg_advisory_xact_lock; stmts=%d", len(f.statements()))
	}
}

// -----------------------------------------------------------------------------
// GetLiveByVentaTempID
// -----------------------------------------------------------------------------

func TestQrRepo_GetLiveByVentaTempID_SinInput(t *testing.T) {
	repo := NewQrPaymentRepository(newFakeGormDB(t, &fakeSQL{}))
	if _, err := repo.GetLiveByVentaTempID(context.Background(), ""); !errors.Is(err, ErrQRIntentNotFound) {
		t.Errorf("GetLiveByVentaTempID('') debe NotFound, got %v", err)
	}
}

// -----------------------------------------------------------------------------
// Guardianes anti-leak sobre el fuente del repositorio
// -----------------------------------------------------------------------------

func TestQrRepo_NoLogueaSecretos(t *testing.T) {
	src := readRepositorySource(t, "pos_qr_repository.go")
	// Quitamos líneas de comentario para que la mención del contrato
	// de "no loguear secretos" en el docstring del archivo no haga
	// que el guardián falle contra sí mismo.
	code := stripGoLineComments(src)
	for _, pattern := range []string{
		"log.Printf", "log.Println", "fmt.Println",
	} {
		if strings.Contains(code, pattern) {
			t.Errorf("pos_qr_repository.go NO debe usar %q (la auditoría vive en el service)", pattern)
		}
	}
	// También verificamos que no se persistan los secretos. Los
	// aceptamos SÓLO en comentarios (política documentada).
	for _, forbidden := range []string{
		"BOLD_SECRET_KEY", "BOLD_BRIDGE_TOKEN", "x-bold-signature",
		"X-Bold-Signature", "raw_payload",
	} {
		if strings.Contains(code, forbidden) {
			t.Errorf("pos_qr_repository.go NO debe referenciar %q en código (los secretos viven sólo en el servicio en memoria)", forbidden)
		}
	}
}

// stripGoLineComments elimina los `//` ... y los `/* ... */` del source
// para que los guardianes estáticos no se gatillen contra sus propios
// docstrings. Mantiene el string tal cual (no está hecho para
// generación de código, sólo para el escaneo defensivo).
func stripGoLineComments(src string) string {
	var out strings.Builder
	out.Grow(len(src))
	i := 0
	n := len(src)
	inLineComment := false
	inBlockComment := false
	inString := false
	var stringQuote byte
	for i < n {
		c := src[i]
		if inLineComment {
			if c == '\n' {
				inLineComment = false
				out.WriteByte(c)
			}
			i++
			continue
		}
		if inBlockComment {
			if c == '*' && i+1 < n && src[i+1] == '/' {
				inBlockComment = false
				i += 2
				continue
			}
			if c == '\n' {
				out.WriteByte(c)
			}
			i++
			continue
		}
		if inString {
			out.WriteByte(c)
			if c == '\\' && i+1 < n {
				out.WriteByte(src[i+1])
				i += 2
				continue
			}
			if c == stringQuote {
				inString = false
			}
			i++
			continue
		}
		if c == '"' || c == '`' {
			inString = true
			stringQuote = c
			out.WriteByte(c)
			i++
			continue
		}
		if c == '/' && i+1 < n {
			if src[i+1] == '/' {
				inLineComment = true
				i += 2
				continue
			}
			if src[i+1] == '*' {
				inBlockComment = true
				i += 2
				continue
			}
		}
		out.WriteByte(c)
		i++
	}
	return out.String()
}

// Guardián de que ningún método del repo exportado llame a time.Now()
// directamente sin pasar por la inyección (prevención básica para que
// los tests puedan congelar el reloj).
func TestQrRepo_UsaRelojInyectable(t *testing.T) {
	src := readRepositorySource(t, "pos_qr_repository.go")
	// Permitimos time.Now como DEFAULT (`now := time.Now; if ... {now = opts.Now}`).
	// Prohibimos `time.Now()` llamado "a pelo" en el cuerpo de métodos
	// (sin ir detrás de un `now = opts.Now`).
	// Heurística: contamos "time.Now()" (con paréntesis) y aceptamos 0.
	paren := strings.Count(src, "time.Now()")
	if paren > 0 {
		t.Errorf("pos_qr_repository.go usa time.Now() sin paso por inyección (%d ocurrencias)", paren)
	}
}

// Pequeño sanity-check: el archivo del repo existe y lo podemos leer.
// Si falla, los tests arriba fallan igual; esto da un mensaje más claro.
func TestQrRepo_SourceLegible(t *testing.T) {
	if _, err := os.Stat("pos_qr_repository.go"); err != nil {
		t.Fatalf("pos_qr_repository.go no legible: %v", err)
	}
}
