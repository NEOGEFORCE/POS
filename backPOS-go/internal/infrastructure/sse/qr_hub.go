// Package sse — hub dedicado para el stream SSE del flujo QR Bold/Bre-B.
//
// El `SSEService` singleton de este mismo paquete hace broadcast GLOBAL
// (todos los clientes reciben todos los eventos), lo que es correcto
// para INVENTORY_UPDATE / NEW_SALE / AUDIT_UPDATE pero *inaceptable*
// para el flujo QR: los eventos de aprobación/expiración viajan por
// venta_temp_id y no deben filtrarse a otras cajas.
//
// `QRHub` resuelve exactamente eso:
//
//   - `map[string]set[chan QREvent]` keyed por venta_temp_id, protegido
//     por `sync.RWMutex` (la "memoria sync.RWMutex" que pidió el dueño).
//   - `Subscribe(ventaTempID) → (<-chan QREvent, func())` entrega un canal
//     tipado y un cancel idempotente que libera el slot.
//   - `Publish(ventaTempID, event)` entrega el evento SÓLO a los
//     suscriptores de ese venta_temp_id. Nunca a otros.
//   - El publisher se llama DESPUÉS del COMMIT de la tx (el servicio
//     lo invoca una vez que la BD confirmó la transición). Replicamos
//     el patrón del repo OTP (migración 025): la emisión en el canal
//     fuera de la tx.
//   - Heartbeat independiente por conexión. No tocamos el `startHeartbeat`
//     global del singleton. 15 s de ping tipo "ping" basta para que los
//     proxies no cierren el stream.
//
// Reglas:
//
//   - `QRHub` NO depende de Gin. Sólo entrega canales; el handler se
//     encarga del protocolo SSE (headers, formato "event:/data:").
//   - El hub NO lee BD. La fuente de verdad es `pos_qr_payment_intents`.
//     La memoria es sólo caché/notificación.
//   - Al cerrarse un canal (unsubscribe o conexión caída), se vacía el
//     slot del map. Si el map queda vacío para un venta_temp_id, se
//     borra la clave para no filtrar memoria.
package sse

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// QREvent es el payload tipado del stream por venta_temp_id. Se
// serializa a JSON para la línea `data:` del protocolo SSE. Mantener
// los campos exportados y los `json:"..."` fijos: el frontend los
// decodifica directamente.
type QREvent struct {
	// Status es el estado "de transporte" que el frontend conoce
	// (PENDIENTE / APROBADO / EXPIRADO / CANCELADO / UNMATCHED /
	// AMBIGUOUS / ERROR). Se derivan del status durable con
	// `models.MapIntentStatusToStream` o se emiten como hint
	// desde los webhooks (UNMATCHED/AMBIGUOUS).
	Status string `json:"status"`
	// Reason acompaña UNMATCHED/AMBIGUOUS/ERROR con una explicación
	// corta sin PII, p.ej. "2 pendientes al mismo monto". Puede
	// estar vacío.
	Reason string `json:"reason,omitempty"`
	// Reference es el bold_code o fingerprint corto cuando aplica
	// (APROBADO). Lo que la UX muestra como "comprobante #".
	Reference string `json:"reference,omitempty"`
	// ApprovedAt es el timestamp UTC ISO-8601 de la aprobación.
	// Vacío si Status != APROBADO.
	ApprovedAt string `json:"approvedAt,omitempty"`
	// ApprovedVia replica la columna `approved_source` de la
	// intención (BOLD_OFFICIAL / BRIDGE_NOTIFICATION / MANUAL)
	// cuando el status alcanza APROBADO. Permite al modal del
	// frontend diferenciar la vía de aprobación en el callback
	// `onApproved` (p.ej. para marcar la venta como MIXTO o para
	// pintar un badge distinto en la UI). Vacío mientras Status
	// sea PENDIENTE/UNMATCHED/AMBIGUOUS/EXPIRADO/CANCELADO/ERROR.
	ApprovedVia string `json:"approvedVia,omitempty"`
	// ExpiresAt es el timestamp UTC del cierre de ventana. Útil
	// para que el modal arranque un countdown consistente tras
	// recibir el primer frame.
	ExpiresAt string `json:"expiresAt,omitempty"`
	// SaleID es el id de la venta materializada por el flujo
	// asíncrono (migración 027). Sólo se emite en el frame
	// APROBADO que publica el dispatcher DESPUÉS de que
	// SaleService.CreateSale cerró exitosamente y
	// MarkFinalizationSucceeded vinculó related_sale_id. El modal
	// usa este valor para disparar la impresión del ticket y la
	// bandeja global para resaltar la venta cerrada.
	SaleID uint64 `json:"saleId,omitempty"`
	// AmountCOP es el monto exacto cobrado por el QR, en pesos
	// enteros. Se emite junto con SaleID para que el modal pueda
	// pintar un resumen "Se cobró $X" sin volver a consultar el
	// snapshot. Vacío mientras SaleID sea 0.
	AmountCOP int64 `json:"amountCop,omitempty"`
}

// QRHub es el hub por venta_temp_id. Thread-safe.
type QRHub struct {
	mu   sync.RWMutex
	subs map[string]map[chan QREvent]struct{}
	// subsCaja: canal paralelo por caja_id para la bandeja global.
	// Un cajero suscrito a su caja recibe eventos agregados de TODAS
	// las intenciones que viven en esa caja (ENQUEUED/APPROVED/
	// AMBIGUOUS/UNMATCHED/EXPIRED/CANCELLED/ERROR). Mismo patrón
	// RWMutex, drop-oldest con buffer más amplio.
	subsCaja    map[string]map[chan QRTrayEvent]struct{}
	chanBufCaja int
	// subsGlobal: canal "fan-out" para supervisores (admin/superadmin).
	// Recibe TODOS los QRTrayEvent de TODAS las cajas, para que la
	// bandeja global del dashboard pueda saber si falta confirmar un
	// cobro QR sin estar atado a una caja concreta. El hub nunca
	// autoriza: la autorización es responsabilidad del handler
	// (CajaStream con scope=all debe exigir rol admin). Mismo patrón
	// drop-oldest con buffer amplio para no retrasar al publicador.
	subsGlobal map[chan QRTrayEvent]struct{}
	// chanBuf acota el buffer de cada canal para no bloquear al
	// publisher si un cliente lento no drena. 8 eventos son más que
	// suficientes para el ciclo de 5 min (en la práctica mandamos 1 o
	// 2 eventos por intent + heartbeats).
	chanBuf int
}

// NewQRHub construye un hub vacío. El buffer de cada canal es 8 por
// default, suficiente para el caso típico (1 PENDIENTE snapshot + 1
// evento terminal + heartbeats).
func NewQRHub() *QRHub {
	return &QRHub{
		subs:        make(map[string]map[chan QREvent]struct{}),
		subsCaja:    make(map[string]map[chan QRTrayEvent]struct{}),
		subsGlobal:  make(map[chan QRTrayEvent]struct{}),
		chanBuf:     8,
		chanBufCaja: 16,
	}
}

// Subscribe registra un canal nuevo para un venta_temp_id. Devuelve el
// canal (sólo lectura) y una función de cancel idempotente que libera
// el slot. Si el venta_temp_id viene vacío o malformado, devuelve un
// canal vacío cerrado y un cancel no-op; el handler debe validar antes.
func (h *QRHub) Subscribe(ventaTempID string) (<-chan QREvent, func()) {
	id := strings.TrimSpace(ventaTempID)
	if id == "" {
		closed := make(chan QREvent)
		close(closed)
		return closed, func() {}
	}

	ch := make(chan QREvent, h.chanBuf)
	h.mu.Lock()
	set, ok := h.subs[id]
	if !ok {
		set = make(map[chan QREvent]struct{}, 1)
		h.subs[id] = set
	}
	set[ch] = struct{}{}
	h.mu.Unlock()

	var cancelOnce sync.Once
	cancel := func() {
		cancelOnce.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			set, ok := h.subs[id]
			if !ok {
				return
			}
			if _, exists := set[ch]; exists {
				delete(set, ch)
				close(ch)
			}
			if len(set) == 0 {
				delete(h.subs, id)
			}
		})
	}
	return ch, cancel
}

// Publish entrega el evento a TODOS los suscriptores de venta_temp_id.
// No bloquea: si un canal está lleno, descarta el evento para ese
// suscriptor (el frontend consulta /estado al reconectarse). Devuelve
// cuántos suscriptores recibieron (0 si no hay ninguno).
//
// Debe llamarse SIEMPRE después del COMMIT. Llamarlo dentro de una tx
// crea el riesgo de emitir un APPROVED que la BD aún no confirmó.
func (h *QRHub) Publish(ventaTempID string, event QREvent) int {
	id := strings.TrimSpace(ventaTempID)
	if id == "" {
		return 0
	}
	h.mu.RLock()
	set, ok := h.subs[id]
	if !ok {
		h.mu.RUnlock()
		return 0
	}
	// Copiamos los canales bajo lock corto para no mantener el RLock
	// mientras intentamos escribir.
	targets := make([]chan QREvent, 0, len(set))
	for ch := range set {
		targets = append(targets, ch)
	}
	h.mu.RUnlock()

	delivered := 0
	for _, ch := range targets {
		select {
		case ch <- event:
			delivered++
		default:
			// Canal lleno: skip. El cliente recibirá el estado real
			// al reconectar (el handler envía snapshot inicial).
		}
	}
	return delivered
}

// Subscribers cuenta los suscriptores vivos para un venta_temp_id.
// Útil para métricas/tests; no afecta a la operación.
func (h *QRHub) Subscribers(ventaTempID string) int {
	id := strings.TrimSpace(ventaTempID)
	if id == "" {
		return 0
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subs[id])
}

// ActiveKeys cuenta las ventas con al menos un suscriptor. Útil para
// detectar leaks en tests y en /admin/health/details.
func (h *QRHub) ActiveKeys() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subs)
}

// =========================================================================
// Formato SSE
// =========================================================================

// FormatQREvent devuelve el frame "event: qr_intent_update\ndata:
// {json}\n\n" listo para escribir en el writer HTTP. El tipo de evento
// (`qr_intent_update`) está fijo: así el frontend puede filtrarlo
// cuando use EventSource/parse manual (aunque como el stream es
// dedicado por venta_temp_id, no hay otros tipos).
func FormatQREvent(event QREvent) (string, error) {
	data, err := json.Marshal(event)
	if err != nil {
		return "", fmt.Errorf("sse qr format: %w", err)
	}
	return fmt.Sprintf("event: qr_intent_update\ndata: %s\n\n", string(data)), nil
}

// FormatQRHeartbeat devuelve el frame de heartbeat "event: ping\n...".
// Idéntico al heartbeat del singleton; cada handler lo emite por su
// cuenta usando su propio ticker.
func FormatQRHeartbeat(now time.Time) string {
	return fmt.Sprintf("event: ping\ndata: {\"heartbeat\":\"%s\"}\n\n",
		now.UTC().Format(time.RFC3339))
}

// =========================================================================
// QRTrayEvent + canal por caja_id
// =========================================================================

// QRTrayEvent es el payload del canal SSE agregado por caja. Esta
// definición se mantiene en el paquete sse para que el hub no dependa
// de `models` (evitar ciclos). El servicio del flujo QR traduce entre
// `models.QRTrayEvent` y esta estructura con una copia explícita.
type QRTrayEvent struct {
	Kind        string `json:"kind"`
	VentaTempID string `json:"ventaTempId"`
	IntentID    uint64 `json:"intentId,omitempty"`
	CajaID      string `json:"cajaId,omitempty"`
	AmountCOP   int64  `json:"amountCop,omitempty"`
	SaleID      uint64 `json:"saleId,omitempty"`
	Reference   string `json:"reference,omitempty"`
	ApprovedAt  string `json:"approvedAt,omitempty"`
	ApprovedVia string `json:"approvedVia,omitempty"`
	Reason      string `json:"reason,omitempty"`
	ClientDNI   string `json:"clientDni,omitempty"`
	CashierName string `json:"cashierName,omitempty"`
	OccurredAt  string `json:"occurredAt,omitempty"`
}

// SubscribeCaja registra un canal nuevo para una caja (bandeja global).
// Mismo contrato que Subscribe: devuelve canal + cancel idempotente.
func (h *QRHub) SubscribeCaja(cajaID string) (<-chan QRTrayEvent, func()) {
	id := strings.TrimSpace(cajaID)
	if id == "" {
		closed := make(chan QRTrayEvent)
		close(closed)
		return closed, func() {}
	}
	ch := make(chan QRTrayEvent, h.chanBufCaja)
	h.mu.Lock()
	set, ok := h.subsCaja[id]
	if !ok {
		set = make(map[chan QRTrayEvent]struct{}, 1)
		h.subsCaja[id] = set
	}
	set[ch] = struct{}{}
	h.mu.Unlock()

	var cancelOnce sync.Once
	cancel := func() {
		cancelOnce.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			set, ok := h.subsCaja[id]
			if !ok {
				return
			}
			if _, exists := set[ch]; exists {
				delete(set, ch)
				close(ch)
			}
			if len(set) == 0 {
				delete(h.subsCaja, id)
			}
		})
	}
	return ch, cancel
}

// PublishToCaja entrega el evento a TODOS los suscriptores de la caja.
// Mismo contrato que Publish: no bloquea, drop-oldest con buffer lleno.
//
// Fan-out global: además del canal específico de la caja, retransmite
// el evento al canal "subsGlobal" para que admin/superadmin suscritos
// a la bandeja global del dashboard reciban los eventos de TODAS las
// cajas. Un supervisor nunca pierde un cobro QR en espera. La semántica
// es "mirror": el evento se emite tal cual al canal de la caja y una
// copia al canal global; nunca al revés.
func (h *QRHub) PublishToCaja(cajaID string, event QRTrayEvent) int {
	id := strings.TrimSpace(cajaID)
	if id == "" {
		return 0
	}
	h.mu.RLock()
	set, ok := h.subsCaja[id]
	global := h.subsGlobal
	// Copiamos targets bajo lock corto para no sostener el RLock
	// mientras intentamos escribir.
	targets := make([]chan QRTrayEvent, 0, len(set)+len(global))
	if ok {
		for ch := range set {
			targets = append(targets, ch)
		}
	}
	for ch := range global {
		targets = append(targets, ch)
	}
	h.mu.RUnlock()

	delivered := 0
	for _, ch := range targets {
		// Drop-oldest: si el canal está lleno, drenamos un slot y
		// metemos el nuevo. Nunca bloqueamos al productor.
		select {
		case ch <- event:
			delivered++
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- event:
				delivered++
			default:
			}
		}
	}
	return delivered
}

// SubscribeGlobal registra un canal nuevo para la bandeja GLOBAL (admin/
// superadmin). Recibe todos los QRTrayEvent de todas las cajas vía el
// fan-out de PublishToCaja. Devuelve el canal y un cancel idempotente.
//
// El hub NO verifica roles: la autorización se hace en el handler. El
// único rol legítimo para esta suscripción es admin/superadmin; si un
// handler se descuida, cualquier cliente autenticado podría espiar
// bandejas ajenas. Por eso el router sólo expone el modo global tras
// chequear `actorIsAdmin`.
func (h *QRHub) SubscribeGlobal() (<-chan QRTrayEvent, func()) {
	ch := make(chan QRTrayEvent, h.chanBufCaja)
	h.mu.Lock()
	h.subsGlobal[ch] = struct{}{}
	h.mu.Unlock()

	var cancelOnce sync.Once
	cancel := func() {
		cancelOnce.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			if _, exists := h.subsGlobal[ch]; exists {
				delete(h.subsGlobal, ch)
				close(ch)
			}
		})
	}
	return ch, cancel
}

// GlobalSubscribers reporta cuántos suscriptores globales viven. Útil
// para métricas, health y tests.
func (h *QRHub) GlobalSubscribers() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subsGlobal)
}

// CajaSubscribers reporta cuántos suscriptores viven en una caja.
func (h *QRHub) CajaSubscribers(cajaID string) int {
	id := strings.TrimSpace(cajaID)
	if id == "" {
		return 0
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subsCaja[id])
}

// FormatQRTrayEvent devuelve el frame "event: qr_tray_update\ndata:
// {json}\n\n" listo para escribir en el writer HTTP.
func FormatQRTrayEvent(event QRTrayEvent) (string, error) {
	data, err := json.Marshal(event)
	if err != nil {
		return "", fmt.Errorf("sse qr tray format: %w", err)
	}
	return fmt.Sprintf("event: qr_tray_update\ndata: %s\n\n", string(data)), nil
}
