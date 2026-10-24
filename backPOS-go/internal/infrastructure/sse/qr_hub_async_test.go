// Tests para los campos y el canal agregados por el flujo asíncrono
// del QR Bold/Bre-B (migración 027). Dos cosas se verifican:
//
//   - QREvent serializa SaleID y AmountCOP únicamente cuando están
//     presentes (omitempty); el modal del frontend los consume para
//     disparar la impresión del ticket post-commit.
//   - El canal paralelo `subsCaja` (bandeja global por caja_id) entrega
//     eventos sólo a los suscriptores de ESA caja, cancel idempotente,
//     y FormatQRTrayEvent respeta el protocolo "event: qr_tray_update".
//
// Ninguna de estas pruebas toca BD; el hub es pura memoria.

package sse

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// -----------------------------------------------------------------------------
// SaleID + AmountCOP en el frame SSE del stream por venta_temp_id
// -----------------------------------------------------------------------------

func TestQREvent_SaleIDySuMontoSalenSoloCuandoHayVentaMaterializada(t *testing.T) {
	// Caso 1: APROBADO con venta materializada → saleId + amountCop
	frame, err := FormatQREvent(QREvent{
		Status:      "APROBADO",
		Reference:   "bold-code-xyz",
		ApprovedAt:  "2026-10-20T10:00:00Z",
		ApprovedVia: "BOLD_OFFICIAL",
		SaleID:      1234,
		AmountCOP:   45800,
	})
	if err != nil {
		t.Fatalf("FormatQREvent: %v", err)
	}
	if !strings.Contains(frame, `"saleId":1234`) {
		t.Errorf("APROBADO con saleId no incluye el valor: %q", frame)
	}
	if !strings.Contains(frame, `"amountCop":45800`) {
		t.Errorf("APROBADO con amountCop no incluye el valor: %q", frame)
	}
	// Snake_case prohibido.
	for _, snake := range []string{`"sale_id"`, `"amount_cop"`} {
		if strings.Contains(frame, snake) {
			t.Errorf("campo snake_case prohibido %q en frame: %q", snake, frame)
		}
	}

	// Roundtrip: el frontend decodifica saleId y amountCop.
	idx := strings.Index(frame, "data: ")
	if idx < 0 {
		t.Fatalf("falta 'data:' en frame: %q", frame)
	}
	raw := strings.TrimSuffix(frame[idx+len("data: "):], "\n\n")
	var parsed QREvent
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		t.Fatalf("roundtrip JSON: %v", err)
	}
	if parsed.SaleID != 1234 || parsed.AmountCOP != 45800 {
		t.Errorf("roundtrip pierde campos: %+v", parsed)
	}
}

func TestQREvent_SaleIDOmitidoCuandoCero(t *testing.T) {
	// Estado PENDIENTE no debe incluir saleId/amountCop.
	frame, _ := FormatQREvent(QREvent{Status: "PENDIENTE"})
	for _, forbidden := range []string{"saleId", "amountCop"} {
		if strings.Contains(frame, forbidden) {
			t.Errorf("PENDIENTE no debe emitir %q: %q", forbidden, frame)
		}
	}
}

// -----------------------------------------------------------------------------
// Canal paralelo por caja_id (bandeja global)
// -----------------------------------------------------------------------------

func TestQRHub_SubscribeCaja_InputVacio_DevuelveCanalCerrado(t *testing.T) {
	h := NewQRHub()
	ch, cancel := h.SubscribeCaja("")
	cancel()
	if _, ok := <-ch; ok {
		t.Error("SubscribeCaja('') debe entregar canal cerrado")
	}
	if h.CajaSubscribers("") != 0 {
		t.Error("CajaSubscribers('') debe ser 0")
	}
}

func TestQRHub_PublishToCaja_AisladoEntreCajas(t *testing.T) {
	h := NewQRHub()
	chA, cancelA := h.SubscribeCaja("CAJA-1")
	chB, cancelB := h.SubscribeCaja("CAJA-2")
	defer cancelA()
	defer cancelB()

	ev := QRTrayEvent{Kind: "ENQUEUED", VentaTempID: "temp-A", CajaID: "CAJA-1", AmountCOP: 45800}
	delivered := h.PublishToCaja("CAJA-1", ev)
	if delivered != 1 {
		t.Errorf("entrega esperada=1, got=%d", delivered)
	}
	select {
	case got := <-chA:
		if got.Kind != "ENQUEUED" || got.VentaTempID != "temp-A" {
			t.Errorf("CAJA-1 recibió evento mal mapeado: %+v", got)
		}
	case <-time.After(50 * time.Millisecond):
		t.Fatal("CAJA-1 no recibió el evento en 50ms")
	}
	// CAJA-2 nunca debe recibir evento de CAJA-1.
	select {
	case got := <-chB:
		t.Errorf("CAJA-2 recibió evento ajeno: %+v", got)
	case <-time.After(20 * time.Millisecond):
		// esperado
	}
}

func TestQRHub_PublishToCaja_DropOldestNoBloqueaPublisher(t *testing.T) {
	h := NewQRHub()
	h.chanBufCaja = 1
	ch, cancel := h.SubscribeCaja("CAJA-1")
	defer cancel()

	// Primer evento ocupa el único slot. Segundo y tercero deben
	// desplazar al anterior sin bloquear al publisher.
	h.PublishToCaja("CAJA-1", QRTrayEvent{Kind: "ENQUEUED", VentaTempID: "a"})
	done := make(chan struct{})
	go func() {
		h.PublishToCaja("CAJA-1", QRTrayEvent{Kind: "APPROVED", VentaTempID: "b"})
		h.PublishToCaja("CAJA-1", QRTrayEvent{Kind: "APPROVED", VentaTempID: "c"})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("PublishToCaja bloqueó cuando debería drop-oldest")
	}
	// Drenamos: debe haber UN evento (el más reciente).
	select {
	case got := <-ch:
		if got.Kind != "APPROVED" {
			t.Errorf("drop-oldest debe dejar el evento más reciente, got %s", got.Kind)
		}
	case <-time.After(50 * time.Millisecond):
		t.Fatal("no se recibió evento tras drop-oldest")
	}
}

func TestQRHub_SubscribeCaja_CancelIdempotente(t *testing.T) {
	h := NewQRHub()
	ch, cancel := h.SubscribeCaja("CAJA-X")
	if h.CajaSubscribers("CAJA-X") != 1 {
		t.Fatalf("se esperaba 1 suscriptor, got %d", h.CajaSubscribers("CAJA-X"))
	}
	cancel()
	cancel()
	cancel()
	if h.CajaSubscribers("CAJA-X") != 0 {
		t.Errorf("tras cancel múltiple, debe quedar 0; got %d", h.CajaSubscribers("CAJA-X"))
	}
	if _, ok := <-ch; ok {
		t.Error("canal cerrado por cancel debe no entregar valores")
	}
}

func TestQRHub_SubscribeCaja_Concurrencia(t *testing.T) {
	h := NewQRHub()
	const nSubs = 15
	const nMsgs = 40
	var wg sync.WaitGroup

	cancels := make([]func(), nSubs)
	chans := make([]<-chan QRTrayEvent, nSubs)
	for i := 0; i < nSubs; i++ {
		caja := "CAJA-1"
		if i%2 == 1 {
			caja = "CAJA-2"
		}
		ch, cancel := h.SubscribeCaja(caja)
		cancels[i] = cancel
		chans[i] = ch
	}
	for i := 0; i < nMsgs; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			h.PublishToCaja("CAJA-1", QRTrayEvent{Kind: "APPROVED", VentaTempID: "v-1"})
		}()
		go func() {
			defer wg.Done()
			h.PublishToCaja("CAJA-2", QRTrayEvent{Kind: "ENQUEUED", VentaTempID: "v-2"})
		}()
	}
	wg.Wait()

	// Verificar aislamiento (ningún CAJA-1 recibió evento de CAJA-2
	// y viceversa).
	for i, ch := range chans {
		expectedVenta := "v-1"
		if i%2 == 1 {
			expectedVenta = "v-2"
		}
	drain:
		for {
			select {
			case ev := <-ch:
				if ev.VentaTempID != expectedVenta {
					t.Errorf("suscriptor %d (esperaba %s) recibió %s",
						i, expectedVenta, ev.VentaTempID)
				}
			default:
				break drain
			}
		}
	}
	for _, c := range cancels {
		c()
	}
	if h.CajaSubscribers("CAJA-1") != 0 || h.CajaSubscribers("CAJA-2") != 0 {
		t.Error("tras cancel, suscriptores de ambas cajas deben ser 0")
	}
}

// -----------------------------------------------------------------------------
// Formato del frame de tray
// -----------------------------------------------------------------------------

func TestFormatQRTrayEvent_RespetaProtocoloYShapeMinimo(t *testing.T) {
	frame, err := FormatQRTrayEvent(QRTrayEvent{
		Kind:        "APPROVED",
		VentaTempID: "temp-123",
		IntentID:    99,
		CajaID:      "CAJA-1",
		AmountCOP:   45800,
		SaleID:      500,
		Reference:   "bold-ref-123",
		ApprovedAt:  "2026-10-20T10:00:00Z",
		ApprovedVia: "BOLD_OFFICIAL",
		OccurredAt:  "2026-10-20T10:00:01Z",
	})
	if err != nil {
		t.Fatalf("FormatQRTrayEvent: %v", err)
	}
	// Debe empezar con "event: qr_tray_update\n".
	if !strings.HasPrefix(frame, "event: qr_tray_update\n") {
		t.Errorf("frame no empieza con 'event: qr_tray_update\\n': %q", frame)
	}
	// Y terminar con \n\n.
	if !strings.HasSuffix(frame, "\n\n") {
		t.Errorf("frame no termina con '\\n\\n': %q", frame)
	}
	// Campos camelCase presentes para que el frontend los decodifique.
	for _, needle := range []string{
		`"kind":"APPROVED"`,
		`"ventaTempId":"temp-123"`,
		`"intentId":99`,
		`"cajaId":"CAJA-1"`,
		`"amountCop":45800`,
		`"saleId":500`,
		`"reference":"bold-ref-123"`,
		`"approvedVia":"BOLD_OFFICIAL"`,
	} {
		if !strings.Contains(frame, needle) {
			t.Errorf("tray frame no contiene %q: %q", needle, frame)
		}
	}
	// Snake_case prohibido en el output.
	for _, snake := range []string{
		`"venta_temp_id"`, `"intent_id"`, `"caja_id"`, `"amount_cop"`,
		`"sale_id"`, `"approved_via"`,
	} {
		if strings.Contains(frame, snake) {
			t.Errorf("frame no debe emitir %q: %q", snake, frame)
		}
	}
}

func TestFormatQRTrayEvent_CamposOpcionalesOmititimos(t *testing.T) {
	// Un ENQUEUED sin aprobación ni venta: saleId/approvedAt deben
	// quedar fuera del JSON.
	frame, _ := FormatQRTrayEvent(QRTrayEvent{
		Kind:        "ENQUEUED",
		VentaTempID: "temp-vacio",
		CajaID:      "CAJA-1",
		AmountCOP:   100,
	})
	for _, forbidden := range []string{
		"approvedAt", "approvedVia", "saleId", "reference", "reason",
	} {
		if strings.Contains(frame, forbidden) {
			t.Errorf("ENQUEUED vacío no debe emitir %q: %q", forbidden, frame)
		}
	}
}
