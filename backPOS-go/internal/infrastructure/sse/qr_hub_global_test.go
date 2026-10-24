package sse

import (
	"testing"
	"time"
)

// =============================================================================
// B5 — Canal GLOBAL para bandeja de admin/superadmin
// =============================================================================
//
// PublishToCaja hace fan-out al canal específico de la caja Y al canal
// global. Un suscriptor global ve eventos de TODAS las cajas; los
// suscriptores por caja siguen viendo sólo los suyos. Autorización vive
// en el handler (el hub nunca autoriza).

func TestQRHub_SubscribeGlobal_RecibeEventosDeCualquierCaja(t *testing.T) {
	h := NewQRHub()

	chG, cancelG := h.SubscribeGlobal()
	defer cancelG()

	if h.GlobalSubscribers() != 1 {
		t.Fatalf("GlobalSubscribers = %d; want 1", h.GlobalSubscribers())
	}

	ev1 := QRTrayEvent{Kind: "APPROVED", VentaTempID: "temp-A", CajaID: "caja-01", AmountCOP: 1000}
	ev2 := QRTrayEvent{Kind: "ENQUEUED", VentaTempID: "temp-B", CajaID: "caja-02", AmountCOP: 2000}

	// Publicar eventos de dos cajas distintas.
	h.PublishToCaja("caja-01", ev1)
	h.PublishToCaja("caja-02", ev2)

	// El canal global debe recibir ambos, en orden.
	got1 := receiveTrayWithTimeout(t, chG, 100*time.Millisecond)
	got2 := receiveTrayWithTimeout(t, chG, 100*time.Millisecond)
	if got1.VentaTempID != "temp-A" || got1.CajaID != "caja-01" {
		t.Errorf("primer evento global = %+v; want temp-A/caja-01", got1)
	}
	if got2.VentaTempID != "temp-B" || got2.CajaID != "caja-02" {
		t.Errorf("segundo evento global = %+v; want temp-B/caja-02", got2)
	}
}

func TestQRHub_PublishToCaja_FanOutMantieneSuscriptoresPorCaja(t *testing.T) {
	h := NewQRHub()

	chGlobal, cancelG := h.SubscribeGlobal()
	defer cancelG()

	chCaja, cancelC := h.SubscribeCaja("caja-01")
	defer cancelC()

	ev := QRTrayEvent{Kind: "APPROVED", VentaTempID: "temp-X", CajaID: "caja-01", AmountCOP: 999}
	delivered := h.PublishToCaja("caja-01", ev)
	// 2 entregas: suscriptor por caja + suscriptor global.
	if delivered != 2 {
		t.Errorf("delivered = %d; want 2 (1 caja + 1 global)", delivered)
	}

	gotCaja := receiveTrayWithTimeout(t, chCaja, 100*time.Millisecond)
	gotGlobal := receiveTrayWithTimeout(t, chGlobal, 100*time.Millisecond)
	if gotCaja.VentaTempID != "temp-X" {
		t.Errorf("caja recibió evento erróneo: %+v", gotCaja)
	}
	if gotGlobal.VentaTempID != "temp-X" {
		t.Errorf("global recibió evento erróneo: %+v", gotGlobal)
	}
}

func TestQRHub_SubscribeGlobal_CancelLiberaSlot(t *testing.T) {
	h := NewQRHub()
	_, cancel := h.SubscribeGlobal()
	if h.GlobalSubscribers() != 1 {
		t.Fatalf("GlobalSubscribers inicial = %d; want 1", h.GlobalSubscribers())
	}
	cancel()
	if h.GlobalSubscribers() != 0 {
		t.Fatalf("GlobalSubscribers tras cancel = %d; want 0", h.GlobalSubscribers())
	}
	// Doble cancel es idempotente — no panic.
	cancel()
}

func TestQRHub_SubscribeGlobal_SinSubscriptores_PublishToCajaNoBloquea(t *testing.T) {
	h := NewQRHub()
	// No hay suscriptores globales ni por caja.
	delivered := h.PublishToCaja("caja-01", QRTrayEvent{Kind: "APPROVED"})
	if delivered != 0 {
		t.Errorf("delivered sin suscriptores = %d; want 0", delivered)
	}
}

func TestQRHub_MultiplesSuscriptoresGlobales(t *testing.T) {
	h := NewQRHub()
	ch1, cancel1 := h.SubscribeGlobal()
	defer cancel1()
	ch2, cancel2 := h.SubscribeGlobal()
	defer cancel2()

	if h.GlobalSubscribers() != 2 {
		t.Fatalf("GlobalSubscribers = %d; want 2", h.GlobalSubscribers())
	}

	h.PublishToCaja("caja-X", QRTrayEvent{Kind: "APPROVED", VentaTempID: "temp"})
	// Ambos reciben.
	receiveTrayWithTimeout(t, ch1, 100*time.Millisecond)
	receiveTrayWithTimeout(t, ch2, 100*time.Millisecond)
}

// Suscriptor global ve eventos de cajas de las que NO está suscrito por
// caja. Esta es la propiedad clave para la bandeja de admin/superadmin.
func TestQRHub_SuscripcionGlobalVeTodasLasCajas(t *testing.T) {
	h := NewQRHub()
	chG, cancelG := h.SubscribeGlobal()
	defer cancelG()

	// 5 cajas distintas, un evento cada una.
	cajas := []string{"caja-01", "caja-02", "caja-03", "caja-04", "caja-05"}
	for _, caja := range cajas {
		h.PublishToCaja(caja, QRTrayEvent{Kind: "ENQUEUED", CajaID: caja, VentaTempID: "temp-" + caja})
	}
	// Deben llegar los 5 eventos.
	received := map[string]bool{}
	for i := 0; i < len(cajas); i++ {
		ev := receiveTrayWithTimeout(t, chG, 200*time.Millisecond)
		received[ev.CajaID] = true
	}
	for _, c := range cajas {
		if !received[c] {
			t.Errorf("suscriptor global NO recibió evento de %s", c)
		}
	}
}

func receiveTrayWithTimeout(t *testing.T, ch <-chan QRTrayEvent, d time.Duration) QRTrayEvent {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(d):
		t.Fatal("timeout esperando evento tray")
		return QRTrayEvent{}
	}
}
