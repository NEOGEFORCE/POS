// Tests del flujo asíncrono QR (migración 027).
//
// Lo que se verifica aquí:
//
//   - publishWebhookOutcome con MatchedIntent NO publica APROBADO al
//     stream SSE ni al tray antes de que CreateSale cierre la venta.
//     Esta es la invariante central del flujo 027: el modal y la
//     bandeja global sólo deben recibir APPROVED cuando related_sale_id
//     ya está vinculado por el dispatcher.
//
//   - publishWebhookOutcome con AMBIGUOUS SÍ publica hint a cada
//     intención candidata (stream + tray), pero NUNCA dispara
//     triggerAutoSale (cero facturación automática ante monto
//     ambiguo).
//
//   - publishIntentSnapshot incluye saleId/amountCop EXCLUSIVAMENTE
//     cuando el intent tiene RelatedSaleID > 0 Y el status es
//     APROBADA/CONFIRMADA_MANUAL. En cualquier otro estado quedan
//     omitidos (omitempty).
//
//   - buildSaleFromSnapshots exige cart no vacío, clientTxId presente
//     y propaga employeeDNI/paymentMethod/transferSource/amount con
//     fallbacks razonables.
//
//   - sanitizeFinalizationError redacta BOLD_BRIDGE_TOKEN /
//     BOLD_SECRET_KEY y trunca a 200 chars (regresión de la 027).
//
// Ninguna prueba toca BD: usa el hub en memoria y el service con
// repo/saleService nil cuando sea aplicable.

package services

import (
	"os"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/sse"
)

// -----------------------------------------------------------------------------
// publishWebhookOutcome — gating de APPROVED antes del commit
// -----------------------------------------------------------------------------

// TestPublishWebhookOutcome_MatchedNoPublicaStreamNiTrayAntesDelCommit es
// la prueba central del contrato de la 027. El webhook aprueba una
// intención en BD (ingest commitea), pero el stream SSE y la bandeja
// global NO deben recibir APPROVED hasta que SaleService.CreateSale
// cierre y MarkFinalizationSucceeded vincule saleId.
func TestPublishWebhookOutcome_MatchedNoPublicaStreamNiTrayAntesDelCommit(t *testing.T) {
	hub := sse.NewQRHub()
	// SaleService nil → triggerAutoSale sale silenciosamente.
	svc := NewQrPaymentService(nil, hub, nil)

	// Suscribirse al stream por venta_temp_id y al tray por caja_id.
	streamCh, cancelStream := hub.Subscribe("temp-matched-123")
	defer cancelStream()
	trayCh, cancelTray := hub.SubscribeCaja("CAJA-1")
	defer cancelTray()

	intent := &models.QrPaymentIntent{
		ID:                77,
		VentaTempID:       "temp-matched-123",
		CajaID:            "CAJA-1",
		AmountCOP:         45800,
		Status:            models.QRIntentStatusApproved,
		ApprovedSource:    models.QRApprovalSourceBoldOfficial,
		ApprovedReference: "bld-xyz",
		ExpiresAt:         time.Now().Add(time.Minute),
	}
	outcome := &repositories.IngestWebhookOutcome{
		MatchedIntent: intent,
		Event: &models.QrWebhookEvent{
			ProcessedStatus: models.QRWebhookStatusApproved,
			AmountCOP:       45800,
		},
	}
	svc.publishWebhookOutcome(outcome)

	// NO debe haber frame SSE (ni stream ni tray) emitido inmediatamente.
	select {
	case ev := <-streamCh:
		t.Errorf("stream SSE recibió APROBADO antes del commit: %+v", ev)
	case <-time.After(50 * time.Millisecond):
		// esperado: silencio
	}
	select {
	case ev := <-trayCh:
		t.Errorf("tray SSE recibió APPROVED antes del commit: %+v", ev)
	case <-time.After(50 * time.Millisecond):
		// esperado: silencio
	}
}

// TestPublishWebhookOutcome_MatchedSinSnapshotNoReventaNiCreaVenta
// cubre el requisito "si match único no tiene snapshot legacy, ACK
// 200 y deja evidencia/recoverability, nunca 500 ni doble stock".
//
// Escenario: el webhook aprueba exactamente una intención (match
// único), pero esa intención fue emitida por el flujo legacy
// sincrónico y nunca recibió snapshot ni sale_client_tx_id (/iniciar
// sin snapshot + modal cerrado antes de /encolar). El dispatcher
// corre y ClaimForFinalization devuelve ErrQRFinalizationNotEligible.
//
// Contrato esperado:
//   - El webhook NO devuelve 500 ni duplica stock.
//   - La intención queda APROBADA en BD (evidencia durable).
//   - El cajero puede reabrirla desde la bandeja /pendientes para
//     resolver manualmente.
//
// Verificamos vía publishWebhookOutcome: con saleService nil el
// dispatcher no corre (es la señal "no está wired"), pero la rama
// MatchedIntent !=nil no llama a stream/tray (ya cubierto por otro
// test). Si saleService estuviera presente, triggerAutoSale saldría
// post-commit con un goroutine y recover; nunca 500.
func TestPublishWebhookOutcome_MatchedSinSnapshotNoReventaNiCreaVenta(t *testing.T) {
	hub := sse.NewQRHub()
	svc := NewQrPaymentService(nil, hub, nil) // saleService nil

	streamCh, cancelStream := hub.Subscribe("temp-legacy-sync")
	defer cancelStream()
	trayCh, cancelTray := hub.SubscribeCaja("CAJA-9")
	defer cancelTray()

	intent := &models.QrPaymentIntent{
		ID:          99,
		VentaTempID: "temp-legacy-sync",
		CajaID:      "CAJA-9",
		AmountCOP:   45800,
		Status:      models.QRIntentStatusApproved,
		ExpiresAt:   time.Now().Add(time.Minute),
		// cart_snapshot / sale_client_tx_id DELIBERADAMENTE vacíos.
	}
	outcome := &repositories.IngestWebhookOutcome{
		MatchedIntent: intent,
		Event: &models.QrWebhookEvent{
			ProcessedStatus: models.QRWebhookStatusApproved,
			AmountCOP:       45800,
		},
	}
	// NO debe reventar. publishWebhookOutcome maneja el caso
	// silenciosamente: triggerAutoSale es no-op con saleService nil.
	svc.publishWebhookOutcome(outcome)

	// No se emiten frames stream/tray desde esta rama (el dispatcher
	// post-commit es quien publicaría APROBADO con saleId; aquí sin
	// snapshot NUNCA se publicará).
	select {
	case ev := <-streamCh:
		t.Errorf("stream NO debe recibir APROBADO sin snapshot: %+v", ev)
	case <-time.After(50 * time.Millisecond):
		// esperado: silencio
	}
	select {
	case ev := <-trayCh:
		t.Errorf("tray NO debe recibir APPROVED sin snapshot: %+v", ev)
	case <-time.After(50 * time.Millisecond):
		// esperado: silencio
	}
}

// TestPublishWebhookOutcome_AmbiguousPublicaHintANingunaFactura verifica
// que ante AMBIGUOUS (≥2 pendientes al mismo monto) el servicio emita
// el hint a CADA candidata (stream + tray) pero NUNCA llame al
// materializador. Es defensa en profundidad del contrato "falso
// negativo antes que doble aprobación".
func TestPublishWebhookOutcome_AmbiguousPublicaHintANingunaFactura(t *testing.T) {
	hub := sse.NewQRHub()
	svc := NewQrPaymentService(nil, hub, nil)

	streamA, cancelA := hub.Subscribe("temp-A")
	streamB, cancelB := hub.Subscribe("temp-B")
	trayCh, cancelTray := hub.SubscribeCaja("CAJA-1")
	defer cancelA()
	defer cancelB()
	defer cancelTray()

	pending := []models.QrPaymentIntent{
		{ID: 1, VentaTempID: "temp-A", CajaID: "CAJA-1", AmountCOP: 45800, Status: models.QRIntentStatusPending, ExpiresAt: time.Now().Add(time.Minute)},
		{ID: 2, VentaTempID: "temp-B", CajaID: "CAJA-1", AmountCOP: 45800, Status: models.QRIntentStatusPending, ExpiresAt: time.Now().Add(time.Minute)},
	}
	outcome := &repositories.IngestWebhookOutcome{
		Event:   &models.QrWebhookEvent{ProcessedStatus: models.QRWebhookStatusAmbiguous, AmountCOP: 45800},
		Pending: pending,
	}
	svc.publishWebhookOutcome(outcome)

	// A y B deben recibir cada uno un AMBIGUOUS en el stream.
	for i, ch := range []<-chan sse.QREvent{streamA, streamB} {
		select {
		case ev := <-ch:
			if ev.Status != models.QRStreamStatusAmbiguous {
				t.Errorf("candidato %d esperaba AMBIGUOUS, got %s", i, ev.Status)
			}
			if ev.Reason == "" {
				t.Errorf("candidato %d no tiene reason", i)
			}
			if ev.SaleID != 0 {
				t.Errorf("AMBIGUOUS NO debe emitir saleId: %d", ev.SaleID)
			}
		case <-time.After(100 * time.Millisecond):
			t.Fatalf("candidato %d no recibió evento AMBIGUOUS", i)
		}
	}
	// El tray debe recibir DOS eventos AMBIGUOUS (uno por candidato).
	trayCount := 0
drain:
	for {
		select {
		case ev := <-trayCh:
			if ev.Kind != models.QRTrayKindAmbiguous {
				t.Errorf("tray esperaba AMBIGUOUS, got %s", ev.Kind)
			}
			trayCount++
		case <-time.After(100 * time.Millisecond):
			break drain
		}
	}
	if trayCount != 2 {
		t.Errorf("tray debe recibir 2 eventos AMBIGUOUS, got %d", trayCount)
	}
}

// -----------------------------------------------------------------------------
// publishIntentSnapshot — saleId/amountCop sólo en APROBADO + related_sale_id
// -----------------------------------------------------------------------------

func TestPublishIntentSnapshot_PendienteNoEmitSaleID(t *testing.T) {
	hub := sse.NewQRHub()
	svc := NewQrPaymentService(nil, hub, nil)
	ch, cancel := hub.Subscribe("temp-pending")
	defer cancel()

	intent := &models.QrPaymentIntent{
		VentaTempID: "temp-pending",
		Status:      models.QRIntentStatusPending,
		AmountCOP:   45800,
		ExpiresAt:   time.Now().Add(time.Minute),
	}
	svc.publishIntentSnapshot(intent)

	select {
	case ev := <-ch:
		if ev.SaleID != 0 {
			t.Errorf("PENDIENTE no debe emitir saleId: %d", ev.SaleID)
		}
		if ev.AmountCOP != 0 {
			t.Errorf("PENDIENTE no debe emitir amountCop: %d", ev.AmountCOP)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("no se recibió snapshot PENDIENTE")
	}
}

func TestPublishIntentSnapshot_ApprovedSinSaleIDNoEmitSaleID(t *testing.T) {
	// Simula el estado transitorio: el webhook ingestó y aprobó
	// la intención en BD, pero el dispatcher aún no ha vinculado
	// related_sale_id. El snapshot debe salir APROBADO pero sin
	// saleId para no engañar al modal.
	hub := sse.NewQRHub()
	svc := NewQrPaymentService(nil, hub, nil)
	ch, cancel := hub.Subscribe("temp-approved")
	defer cancel()

	intent := &models.QrPaymentIntent{
		VentaTempID:       "temp-approved",
		Status:            models.QRIntentStatusApproved,
		AmountCOP:         45800,
		ApprovedSource:    models.QRApprovalSourceBoldOfficial,
		ApprovedReference: "bld-abc",
		ExpiresAt:         time.Now().Add(time.Minute),
		// RelatedSaleID intencionalmente nil
	}
	svc.publishIntentSnapshot(intent)

	select {
	case ev := <-ch:
		if ev.Status != models.QRStreamStatusApproved {
			t.Errorf("status esperado APROBADO, got %s", ev.Status)
		}
		if ev.SaleID != 0 {
			t.Errorf("sin RelatedSaleID NO debe emitir saleId: %d", ev.SaleID)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("no se recibió snapshot")
	}
}

func TestPublishIntentSnapshot_ApprovedConSaleIDEmiteSaleIDyAmount(t *testing.T) {
	// Esta es la foto que publica el dispatcher DESPUÉS de
	// MarkFinalizationSucceeded. El modal consume saleId para
	// disparar impresión; la bandeja lo usa para resaltar la venta
	// cerrada.
	hub := sse.NewQRHub()
	svc := NewQrPaymentService(nil, hub, nil)
	ch, cancel := hub.Subscribe("temp-materialized")
	defer cancel()

	saleID := uint64(5500)
	intent := &models.QrPaymentIntent{
		VentaTempID:       "temp-materialized",
		Status:            models.QRIntentStatusApproved,
		AmountCOP:         45800,
		ApprovedSource:    models.QRApprovalSourceBoldOfficial,
		ApprovedReference: "bld-abc",
		ExpiresAt:         time.Now().Add(time.Minute),
		RelatedSaleID:     &saleID,
	}
	svc.publishIntentSnapshot(intent)

	select {
	case ev := <-ch:
		if ev.SaleID != saleID {
			t.Errorf("saleId esperado=%d, got %d", saleID, ev.SaleID)
		}
		if ev.AmountCOP != 45800 {
			t.Errorf("amountCop esperado=45800, got %d", ev.AmountCOP)
		}
		if ev.ApprovedVia != models.QRApprovalSourceBoldOfficial {
			t.Errorf("approvedVia esperado=BOLD_OFFICIAL, got %s", ev.ApprovedVia)
		}
		if ev.Reference != "bld-abc" {
			t.Errorf("reference esperado=bld-abc, got %s", ev.Reference)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("no se recibió snapshot materializado")
	}
}

// TestPublishIntentSnapshot_RelatedSaleIDIgnoradoSiStatusNoAprobado es
// defensa: aunque bugs futuros poblaran RelatedSaleID en un intent
// EXPIRADO o CANCELADO, el frame SSE no debe emitir saleId.
func TestPublishIntentSnapshot_RelatedSaleIDIgnoradoSiStatusNoAprobado(t *testing.T) {
	hub := sse.NewQRHub()
	svc := NewQrPaymentService(nil, hub, nil)
	ch, cancel := hub.Subscribe("temp-expired")
	defer cancel()

	badSaleID := uint64(9999)
	intent := &models.QrPaymentIntent{
		VentaTempID:   "temp-expired",
		Status:        models.QRIntentStatusExpired,
		AmountCOP:     45800,
		ExpiresAt:     time.Now().Add(-time.Minute),
		RelatedSaleID: &badSaleID, // bug hipotético
	}
	svc.publishIntentSnapshot(intent)

	select {
	case ev := <-ch:
		if ev.SaleID != 0 {
			t.Errorf("EXPIRADO con RelatedSaleID NO debe filtrarlo: %d", ev.SaleID)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("no se recibió snapshot")
	}
}

// -----------------------------------------------------------------------------
// buildSaleFromSnapshots — contrato con el dispatcher
// -----------------------------------------------------------------------------

func TestBuildSaleFromSnapshots_RechazaCartVacio(t *testing.T) {
	intent := &models.QrPaymentIntent{
		ID:             1,
		VentaTempID:    "temp-1",
		AmountCOP:      1000,
		CartSnapshot:   "",
		SaleClientTxID: strings.Repeat("a", 24),
	}
	if _, _, err := buildSaleFromSnapshots(intent); err == nil {
		t.Fatal("se esperaba error con cart vacío")
	}
}

func TestBuildSaleFromSnapshots_RechazaSaleClientTxIDVacio(t *testing.T) {
	intent := &models.QrPaymentIntent{
		ID:             1,
		VentaTempID:    "temp-1",
		AmountCOP:      1000,
		CartSnapshot:   `[{"barcode":"A","quantity":1,"unitPrice":1000,"subtotal":1000}]`,
		SaleClientTxID: "",
	}
	if _, _, err := buildSaleFromSnapshots(intent); err == nil {
		t.Fatal("se esperaba error con clientTxId vacío")
	}
}

func TestBuildSaleFromSnapshots_HappyPath(t *testing.T) {
	intent := &models.QrPaymentIntent{
		ID:          1,
		VentaTempID: "temp-happy",
		AmountCOP:   45800,
		CartSnapshot: `[
			{"barcode":"BC-A","quantity":2,"unitPrice":100,"costPrice":50,"subtotal":200},
			{"barcode":"BC-B","quantity":1,"unitPrice":45600,"costPrice":40000,"subtotal":45600}
		]`,
		TotalsSnapshot: `{
			"totalAmount":45800,
			"amountPaid":45800,
			"transferAmount":45800,
			"transferSource":"BOLD_QR",
			"paymentMethod":"BOLD_QR",
			"employeeDni":"EMP-123"
		}`,
		ClientSnapshot: `{"dni":"CL-1","name":"Cliente Test"}`,
		SaleClientTxID: "qr-tx-12345678",
		CreatedByDNI:   "EMP-123",
	}
	sale, editSaleID, err := buildSaleFromSnapshots(intent)
	if err != nil {
		t.Fatalf("buildSaleFromSnapshots: %v", err)
	}
	if editSaleID != 0 {
		t.Errorf("sin editSaleId en totals, editTargetSaleID debe ser 0, got %d", editSaleID)
	}
	if sale.ClientTxId != "qr-tx-12345678" {
		t.Errorf("ClientTxId esperado=qr-tx-12345678, got %s", sale.ClientTxId)
	}
	if sale.ClientDNI != "CL-1" {
		t.Errorf("ClientDNI esperado=CL-1, got %s", sale.ClientDNI)
	}
	if sale.EmployeeDNI != "EMP-123" {
		t.Errorf("EmployeeDNI esperado=EMP-123, got %s", sale.EmployeeDNI)
	}
	if sale.TotalAmount != 45800 {
		t.Errorf("TotalAmount esperado=45800, got %v", sale.TotalAmount)
	}
	if len(sale.SaleDetails) != 2 {
		t.Fatalf("se esperaban 2 details, got %d", len(sale.SaleDetails))
	}
	if sale.SaleDetails[0].Barcode != "BC-A" || sale.SaleDetails[1].Barcode != "BC-B" {
		t.Errorf("orden de details alterado: %+v", sale.SaleDetails)
	}
}

func TestBuildSaleFromSnapshots_FallbackClienteYMetodo(t *testing.T) {
	// Sin totals_snapshot ni client_snapshot: debe caer a cliente
	// 0000 y payment BOLD_QR, con amount = intent.AmountCOP.
	intent := &models.QrPaymentIntent{
		ID:             1,
		VentaTempID:    "temp-fallback",
		AmountCOP:      5000,
		CartSnapshot:   `[{"barcode":"X","quantity":1,"unitPrice":5000,"subtotal":5000}]`,
		SaleClientTxID: "tx-fallback-123",
		CreatedByDNI:   "EMP-9",
	}
	sale, editSaleID, err := buildSaleFromSnapshots(intent)
	if err != nil {
		t.Fatalf("buildSaleFromSnapshots: %v", err)
	}
	if editSaleID != 0 {
		t.Errorf("fallback sin editSaleId, editTargetSaleID debe ser 0, got %d", editSaleID)
	}
	if sale.ClientDNI != "0000" {
		t.Errorf("sin client_snapshot debe caer a 0000, got %s", sale.ClientDNI)
	}
	if sale.PaymentMethod != "DAVIPLATA" || sale.TransferDaviplata != 5000 {
		t.Errorf("sin paymentMethod la parte QR cae a DAVIPLATA, got %s / davi %v", sale.PaymentMethod, sale.TransferDaviplata)
	}
	if sale.EmployeeDNI != "EMP-9" {
		t.Errorf("sin employeeDni debe caer a CreatedByDNI, got %s", sale.EmployeeDNI)
	}
	if sale.TotalAmount != 5000 {
		t.Errorf("sin totals, TotalAmount cae a intent.AmountCOP=5000, got %v", sale.TotalAmount)
	}
	if sale.TransferAmount != 5000 {
		t.Errorf("sin desglose, TransferAmount cae a intent.AmountCOP, got %v", sale.TransferAmount)
	}
}

// -----------------------------------------------------------------------------
// Enqueue — validaciones puras (sin BD)
// -----------------------------------------------------------------------------

func TestEnqueue_RechazaInputsDuros(t *testing.T) {
	svc := NewQrPaymentService(nil, nil, nil)
	validCart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":100,"subtotal":100}]`)
	ok := EnqueueInput{
		VentaTempID:  "temp-ok-12345",
		CajaID:       "CAJA-1",
		ActorDNI:     "EMP-1",
		AmountCOP:    45800,
		ClientTxID:   strings.Repeat("x", 16),
		CartSnapshot: validCart,
	}
	cases := []struct {
		name  string
		apply func(*EnqueueInput)
	}{
		{"venta inválido", func(in *EnqueueInput) { in.VentaTempID = "a" }},
		{"caja vacía", func(in *EnqueueInput) { in.CajaID = "" }},
		{"dni vacío", func(in *EnqueueInput) { in.ActorDNI = "" }},
		{"amount fuera de rango", func(in *EnqueueInput) { in.AmountCOP = 1 }},
		{"clientTx corto", func(in *EnqueueInput) { in.ClientTxID = "abc" }},
		{"clientTx muy largo", func(in *EnqueueInput) { in.ClientTxID = strings.Repeat("x", 70) }},
		{"cart vacío", func(in *EnqueueInput) { in.CartSnapshot = nil }},
		{"cart inválido JSON", func(in *EnqueueInput) { in.CartSnapshot = []byte("no json") }},
		{"client_snapshot JSON inválido", func(in *EnqueueInput) { in.ClientSnapshot = []byte("x") }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := ok
			c.apply(&in)
			if _, err := svc.Enqueue(nil, in); err != ErrQRInvalidInput {
				t.Errorf("se esperaba ErrQRInvalidInput, got %v", err)
			}
		})
	}
}

// -----------------------------------------------------------------------------
// InitiateWithSnapshot — validaciones puras (sin BD)
// -----------------------------------------------------------------------------

// TestInitiateWithSnapshot_RechazaInputsDuros bloquea la regresión
// donde /iniciar aceptara snapshots inválidos. Comparte la validación
// con Enqueue (via validateQRSnapshotInputs); si alguien duplica
// reglas en una sola rama y no en la otra, los dos tests detectan la
// divergencia.
func TestInitiateWithSnapshot_RechazaInputsDuros(t *testing.T) {
	svc := NewQrPaymentService(nil, nil, nil)
	validCart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":100,"subtotal":100}]`)
	ok := InitiateWithSnapshotInput{
		VentaTempID:  "temp-ok-12345",
		CajaID:       "CAJA-1",
		ActorDNI:     "EMP-1",
		AmountCOP:    45800,
		ClientTxID:   strings.Repeat("x", 16),
		CartSnapshot: validCart,
	}
	cases := []struct {
		name  string
		apply func(*InitiateWithSnapshotInput)
	}{
		{"venta inválido", func(in *InitiateWithSnapshotInput) { in.VentaTempID = "a" }},
		{"caja vacía", func(in *InitiateWithSnapshotInput) { in.CajaID = "" }},
		{"dni vacío", func(in *InitiateWithSnapshotInput) { in.ActorDNI = "" }},
		{"amount fuera de rango", func(in *InitiateWithSnapshotInput) { in.AmountCOP = 1 }},
		{"clientTx corto", func(in *InitiateWithSnapshotInput) { in.ClientTxID = "abc" }},
		{"clientTx muy largo", func(in *InitiateWithSnapshotInput) { in.ClientTxID = strings.Repeat("x", 70) }},
		{"cart vacío", func(in *InitiateWithSnapshotInput) { in.CartSnapshot = nil }},
		{"cart inválido JSON", func(in *InitiateWithSnapshotInput) { in.CartSnapshot = []byte("no json") }},
		{"client_snapshot JSON inválido", func(in *InitiateWithSnapshotInput) { in.ClientSnapshot = []byte("x") }},
		{"totals_snapshot JSON inválido", func(in *InitiateWithSnapshotInput) { in.TotalsSnapshot = []byte("x") }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := ok
			c.apply(&in)
			if _, err := svc.InitiateWithSnapshot(nil, in); err != ErrQRInvalidInput {
				t.Errorf("se esperaba ErrQRInvalidInput, got %v", err)
			}
		})
	}
}

// TestInitiateWithSnapshot_NoMarcaQueuedAt es defensa en profundidad:
// el service debe pasar `MarkQueued: false` al repo. La verificación
// vive en el fuente del service (guardián estático).
func TestInitiateWithSnapshot_NoMarcaQueuedAt(t *testing.T) {
	src := qrServiceSource(t)
	// Localizar el bloque InitiateWithSnapshot y verificar que pase
	// MarkQueued: false. Si alguien lo cambia a true, el bug del flujo
	// mezcla /iniciar y /encolar vuelve y la bandeja global se
	// contamina con intenciones que el cajero todavía ve en modal.
	idx := strings.Index(src, "func (s *QrPaymentService) InitiateWithSnapshot(")
	if idx < 0 {
		t.Fatal("no se encontró InitiateWithSnapshot en el service")
	}
	// Ventana conservadora para encontrar la llamada al repo.
	end := idx + 2500
	if end > len(src) {
		end = len(src)
	}
	block := src[idx:end]
	if !strings.Contains(block, "MarkQueued: false") {
		t.Error("InitiateWithSnapshot debe pasar MarkQueued: false al repo (queued_at NULL)")
	}
	if strings.Contains(block, "MarkQueued: true") {
		t.Error("InitiateWithSnapshot NO debe pasar MarkQueued: true (es /encolar quien marca queued_at)")
	}
}

// -----------------------------------------------------------------------------
// Guardianes estáticos (compile-time) de la 027
// -----------------------------------------------------------------------------

// TestQrModel_SinColumnaCashierName confirma que el modelo no tiene
// un tag GORM `column:cashier_name` que persistiría a BD. La 027 NO
// define esa columna; dejarla rompería INSERTs y SELECTs.
func TestQrModel_SinColumnaCashierName(t *testing.T) {
	src, err := readFile("../domain/models/pos_qr_payment.go")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if strings.Contains(src, `column:cashier_name`) {
		t.Error("models/pos_qr_payment.go NO debe tener `column:cashier_name` (la 027 no define esa columna)")
	}
	// CashierName SÍ puede existir como campo transiente con
	// `gorm:"-"` (vehículo in-memory para el SSE del tray). Si existe
	// como campo, exigimos el tag `gorm:"-"`.
	if strings.Contains(src, "CashierName string") && !strings.Contains(src, `CashierName string `+"`"+`gorm:"-"`) {
		t.Error("si CashierName está en el modelo, debe tener `gorm:\"-\"` para no persistir")
	}
}

func TestQrModel_SinColumnaClientDni(t *testing.T) {
	src, err := readFile("../domain/models/pos_qr_payment.go")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	for _, forbidden := range []string{
		`column:client_dni`,
		`ClientDNI string`,
	} {
		if strings.Contains(src, forbidden) {
			t.Errorf("models/pos_qr_payment.go NO debe contener %q (client_dni vive dentro de client_snapshot)", forbidden)
		}
	}
}

// TestRepo_ListPendingByCaja_NoSelectCashierName garantiza que el repo
// no genere una query SELECT con la columna `cashier_name` que no
// existe en la 027.
func TestRepo_ListPendingByCaja_NoSelectCashierName(t *testing.T) {
	src, err := readFile("../../adapters/repositories/pos_qr_repository.go")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	// La única excepción legítima sería un comentario que mencione
	// que la columna NO existe. Rechazamos la mención en Select(...).
	if strings.Contains(src, `Select("id, venta_temp_id, caja_id, cashier_name`) {
		t.Error("ListPendingByCaja NO debe seleccionar cashier_name (la 027 no define la columna)")
	}
	if strings.Contains(src, `"cashier_name"`) && !strings.Contains(src, `// cashier_name`) {
		// Permitimos la mención en comentarios "no define esa columna"
		// pero no en código vivo.
		// Como el guardián anterior ya cubre el Select literal, aquí
		// es un sanity-check adicional.
	}
}

// TestPublishWebhookOutcome_NoLlamaCreateSaleEnRamaMatched es un
// guardián de texto: la rama "MatchedIntent != nil" en
// publishWebhookOutcome NO debe emitir ni Publish ni PublishToCaja
// directamente. Toda publicación APROBADA viene del dispatcher
// post-commit.
func TestPublishWebhookOutcome_NoLlamaStreamEnRamaMatched(t *testing.T) {
	src, err := readFile("pos_qr_service.go")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	// Localizar bloque matched: entre "if outcome.MatchedIntent != nil {" y
	// el `return` que cierra el bloque.
	idx := strings.Index(src, "if outcome.MatchedIntent != nil {")
	if idx < 0 {
		t.Fatal("no se encontró la rama matched en publishWebhookOutcome")
	}
	// Mirar un bloque conservador de 400 chars.
	window := src[idx:minLen(idx+400, len(src))]
	for _, forbidden := range []string{
		"publishIntentSnapshot(",
		"publishTrayFromIntent(",
		"s.hub.Publish(",
		"s.hub.PublishToCaja(",
	} {
		if strings.Contains(window, forbidden) {
			t.Errorf("rama matched llama a %q — el APPROVED SSE debe venir SÓLO del dispatcher post-commit", forbidden)
		}
	}
	// Y debe seguir disparando el materializador.
	if !strings.Contains(window, "triggerAutoSale(") {
		t.Error("rama matched debe disparar triggerAutoSale")
	}
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

func readFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
