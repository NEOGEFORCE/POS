package sse

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// =============================================================================
// Pruebas del QRHub (hub SSE dedicado por venta_temp_id).
//
// Lo que se verifica:
//
//   - Un Publish entrega SÓLO a los suscriptores de ese venta_temp_id.
//   - Dos venta_temp_id distintos están aislados (no se cruzan eventos).
//   - El cancel es idempotente y libera el slot del map.
//   - El canal buffered no bloquea al publisher si el cliente no drena.
//   - FormatQREvent respeta el protocolo "event:/data:\n\n".
//   - Concurrencia: Subscribe/Publish/Cancel simultáneos no corrompen
//     el map ni fugan memoria.
//
// Nada toca BD; el hub es pura memoria.
// =============================================================================

func TestQRHub_Subscribe_InputVacio_DevuelveCanalCerrado(t *testing.T) {
	h := NewQRHub()
	ch, cancel := h.Subscribe("")
	// Cancel es no-op pero debe existir y no panicar.
	cancel()
	// El canal viene ya cerrado.
	_, ok := <-ch
	if ok {
		t.Error("Subscribe('') debe entregar canal cerrado")
	}
	if h.ActiveKeys() != 0 {
		t.Errorf("Subscribe('') no debe registrar nada; ActiveKeys=%d", h.ActiveKeys())
	}
}

func TestQRHub_PublishEntregaSoloASuscriptoresDeEsaVenta(t *testing.T) {
	h := NewQRHub()
	chA, cancelA := h.Subscribe("temp-A")
	chB, cancelB := h.Subscribe("temp-B")
	defer cancelA()
	defer cancelB()

	ev := QREvent{Status: "APROBADO", Reference: "bold-123"}
	delivered := h.Publish("temp-A", ev)
	if delivered != 1 {
		t.Errorf("entrega esperada=1, got=%d", delivered)
	}
	// A recibe
	select {
	case got := <-chA:
		if got.Status != "APROBADO" || got.Reference != "bold-123" {
			t.Errorf("A recibió evento mal mapeado: %+v", got)
		}
	case <-time.After(50 * time.Millisecond):
		t.Fatal("A no recibió el evento en 50ms")
	}
	// B NO debe recibir nada
	select {
	case got := <-chB:
		t.Errorf("B NO debe recibir evento de A: %+v", got)
	case <-time.After(10 * time.Millisecond):
		// esperado
	}
}

func TestQRHub_MultiSuscriptor_MismaVenta(t *testing.T) {
	h := NewQRHub()
	ch1, cancel1 := h.Subscribe("temp-1")
	ch2, cancel2 := h.Subscribe("temp-1")
	defer cancel1()
	defer cancel2()

	if h.Subscribers("temp-1") != 2 {
		t.Fatalf("se esperaba 2 suscriptores en temp-1, got %d", h.Subscribers("temp-1"))
	}

	delivered := h.Publish("temp-1", QREvent{Status: "PENDIENTE"})
	if delivered != 2 {
		t.Errorf("se esperaba entrega=2 (dos suscriptores), got %d", delivered)
	}
	for i, ch := range []<-chan QREvent{ch1, ch2} {
		select {
		case ev := <-ch:
			if ev.Status != "PENDIENTE" {
				t.Errorf("suscriptor %d recibió status inesperado: %s", i+1, ev.Status)
			}
		case <-time.After(50 * time.Millisecond):
			t.Fatalf("suscriptor %d no recibió el evento", i+1)
		}
	}
}

func TestQRHub_CancelIdempotente(t *testing.T) {
	h := NewQRHub()
	ch, cancel := h.Subscribe("temp-X")
	if h.Subscribers("temp-X") != 1 {
		t.Fatalf("se esperaba 1 suscriptor, got %d", h.Subscribers("temp-X"))
	}
	cancel()
	// Doble cancel no debe panicar
	cancel()
	cancel()
	if h.Subscribers("temp-X") != 0 {
		t.Errorf("tras cancel debe quedar 0 suscriptores, got %d", h.Subscribers("temp-X"))
	}
	if h.ActiveKeys() != 0 {
		t.Errorf("tras cancel sin otros subs, ActiveKeys debe ser 0, got %d", h.ActiveKeys())
	}
	// El canal viene cerrado tras cancel; una lectura más devuelve zero-value.
	_, ok := <-ch
	if ok {
		t.Error("canal cerrado por cancel debe no entregar valores pendientes")
	}
}

func TestQRHub_CanalLleno_NoBloqueaPublisher(t *testing.T) {
	h := NewQRHub()
	// Fuerza buffer pequeño para probar la rama default.
	h.chanBuf = 1
	ch, cancel := h.Subscribe("temp-slow")
	defer cancel()

	// Primer evento ocupa el único slot del buffer.
	h.Publish("temp-slow", QREvent{Status: "PENDIENTE"})
	// Segundo evento DEBE ser descartado silenciosamente, sin bloquear.
	done := make(chan struct{})
	go func() {
		h.Publish("temp-slow", QREvent{Status: "APROBADO"})
		close(done)
	}()
	select {
	case <-done:
		// correcto: Publish retornó aunque el canal estaba lleno.
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Publish bloqueó cuando debería haber descartado")
	}
	// Drenamos el único evento buffered: debe ser el primero.
	got := <-ch
	if got.Status != "PENDIENTE" {
		t.Errorf("el primer evento buffered debe ser PENDIENTE, got %s", got.Status)
	}
}

func TestQRHub_ActiveKeys_LimpiezaTrasCancel(t *testing.T) {
	h := NewQRHub()
	_, cancelA := h.Subscribe("temp-A")
	_, cancelB := h.Subscribe("temp-B")
	if h.ActiveKeys() != 2 {
		t.Fatalf("ActiveKeys esperado 2, got %d", h.ActiveKeys())
	}
	cancelA()
	if h.ActiveKeys() != 1 {
		t.Errorf("tras cancelA, ActiveKeys=1 esperado, got %d", h.ActiveKeys())
	}
	cancelB()
	if h.ActiveKeys() != 0 {
		t.Errorf("tras cancelar todo, ActiveKeys=0 esperado, got %d", h.ActiveKeys())
	}
}

func TestQRHub_Concurrencia(t *testing.T) {
	h := NewQRHub()
	const nSubs = 20
	const nMsgs = 50
	var wg sync.WaitGroup
	// 20 suscriptores sobre dos ventas (balanceo pseudoaleatorio
	// determinista por pares/impares).
	cancels := make([]func(), nSubs)
	chans := make([]<-chan QREvent, nSubs)
	for i := 0; i < nSubs; i++ {
		id := "temp-A"
		if i%2 == 1 {
			id = "temp-B"
		}
		ch, cancel := h.Subscribe(id)
		cancels[i] = cancel
		chans[i] = ch
	}
	// 50 mensajes a cada venta en paralelo.
	for i := 0; i < nMsgs; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			h.Publish("temp-A", QREvent{Status: "PENDIENTE", Reason: "A"})
		}(i)
		go func(i int) {
			defer wg.Done()
			h.Publish("temp-B", QREvent{Status: "PENDIENTE", Reason: "B"})
		}(i)
	}
	wg.Wait()

	// Drenamos (no todos los eventos llegan si el canal se llena —
	// cuenta sólo para no bloquear). Verificamos que ningún A
	// recibió "B" y viceversa.
	for i, ch := range chans {
		expected := "A"
		if i%2 == 1 {
			expected = "B"
		}
	drain:
		for {
			select {
			case ev := <-ch:
				if ev.Reason != expected {
					t.Errorf("suscriptor %d (venta %s) recibió evento ajeno (reason=%s)",
						i, expected, ev.Reason)
				}
			default:
				break drain
			}
		}
	}
	// Cerrar todos
	for _, c := range cancels {
		c()
	}
	if h.ActiveKeys() != 0 {
		t.Errorf("tras limpieza ActiveKeys=0 esperado, got %d", h.ActiveKeys())
	}
}

// -----------------------------------------------------------------------------
// Formato SSE
// -----------------------------------------------------------------------------

func TestFormatQREvent_RespetaProtocolo(t *testing.T) {
	frame, err := FormatQREvent(QREvent{Status: "APROBADO", Reference: "bold-abc"})
	if err != nil {
		t.Fatalf("FormatQREvent: %v", err)
	}
	// Debe empezar con "event: qr_intent_update\n".
	if !strings.HasPrefix(frame, "event: qr_intent_update\n") {
		t.Errorf("frame no empieza con 'event: qr_intent_update\\n': %q", frame)
	}
	// Debe terminar con doble newline.
	if !strings.HasSuffix(frame, "\n\n") {
		t.Errorf("frame no termina con '\\n\\n': %q", frame)
	}
	// Y la línea data: debe contener JSON válido.
	idx := strings.Index(frame, "data: ")
	if idx < 0 {
		t.Fatalf("falta 'data: ' en frame: %q", frame)
	}
	dataLine := strings.TrimSuffix(frame[idx+len("data: "):], "\n\n")
	var parsed QREvent
	if err := json.Unmarshal([]byte(dataLine), &parsed); err != nil {
		t.Fatalf("data no es JSON válido: %v (línea=%q)", err, dataLine)
	}
	if parsed.Status != "APROBADO" || parsed.Reference != "bold-abc" {
		t.Errorf("parseo roundtrip incorrecto: %+v", parsed)
	}
}

func TestFormatQRHeartbeat_IncluyeTimestampUTC(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 34, 56, 0, time.UTC)
	hb := FormatQRHeartbeat(now)
	if !strings.HasPrefix(hb, "event: ping\n") {
		t.Errorf("heartbeat no empieza con 'event: ping\\n': %q", hb)
	}
	if !strings.Contains(hb, "2026-10-20T12:34:56Z") {
		t.Errorf("heartbeat no contiene el timestamp UTC esperado: %q", hb)
	}
}

// -----------------------------------------------------------------------------
// Blindaje anti-leak de secretos en los campos públicos del evento
// -----------------------------------------------------------------------------

func TestQREvent_CamposPublicosNoIncluyenSecretos(t *testing.T) {
	// Nombres de campos del struct no deben insinuar nunca que lleven
	// token/signature. Un rename accidental dejaría la variable visible
	// en el bundle del frontend.
	frame, _ := FormatQREvent(QREvent{
		Status:    "APROBADO",
		Reason:    "ok",
		Reference: "bold-ref",
	})
	for _, forbidden := range []string{
		"token", "secret", "signature", "x-bold-signature",
		"BOLD_SECRET_KEY", "BOLD_BRIDGE_TOKEN", "hmac",
	} {
		if strings.Contains(strings.ToLower(frame), strings.ToLower(forbidden)) {
			t.Errorf("frame SSE del QR NO debe incluir %q: %q", forbidden, frame)
		}
	}
}

// -----------------------------------------------------------------------------
// ApprovedVia: contrato con el frontend
// -----------------------------------------------------------------------------
//
// El frontend lee `approvedVia` del evento SSE para diferenciar la vía de
// aprobación (BOLD_OFFICIAL / BRIDGE_NOTIFICATION / MANUAL) en el callback
// `onApproved`. Un rename o un `omitempty` incorrecto romperían la UX.

func TestQREvent_ApprovedViaSeSerializaConCamelCase(t *testing.T) {
	frame, err := FormatQREvent(QREvent{
		Status:      "APROBADO",
		Reference:   "bold-code-123",
		ApprovedAt:  "2026-10-20T10:00:00Z",
		ApprovedVia: "BOLD_OFFICIAL",
	})
	if err != nil {
		t.Fatalf("FormatQREvent: %v", err)
	}
	// El contrato con el frontend es camelCase (coherente con el
	// resto del handler: intentId, ventaTempId, approvedAt...).
	if !strings.Contains(frame, `"approvedVia":"BOLD_OFFICIAL"`) {
		t.Errorf(`frame no contiene approvedVia camelCase: %q`, frame)
	}
	// Snake_case NO debe aparecer bajo ninguna circunstancia.
	for _, snake := range []string{
		`"approved_via"`, `"approved_source"`, `"bold_reference"`,
	} {
		if strings.Contains(frame, snake) {
			t.Errorf("frame no debe emitir campos snake_case %q: %q", snake, frame)
		}
	}

	// Roundtrip JSON.
	idx := strings.Index(frame, "data: ")
	if idx < 0 {
		t.Fatalf("falta 'data: ' en frame: %q", frame)
	}
	data := strings.TrimSuffix(frame[idx+len("data: "):], "\n\n")
	var parsed QREvent
	if err := json.Unmarshal([]byte(data), &parsed); err != nil {
		t.Fatalf("roundtrip JSON: %v", err)
	}
	if parsed.ApprovedVia != "BOLD_OFFICIAL" {
		t.Errorf("roundtrip ApprovedVia = %q, want BOLD_OFFICIAL", parsed.ApprovedVia)
	}
}

func TestQREvent_ApprovedViaOmitidaCuandoVacia(t *testing.T) {
	// Para estados no-aprobados el campo debe quedar fuera del JSON
	// (omitempty). Esto evita que el frontend reciba un string vacío
	// que confunda su switch de UX.
	frame, _ := FormatQREvent(QREvent{Status: "PENDIENTE"})
	if strings.Contains(frame, "approvedVia") {
		t.Errorf("approvedVia debe estar ausente en estado PENDIENTE: %q", frame)
	}
}
