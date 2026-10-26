// Handler HTTP del flujo de cobro QR Bold / Bre-B (migración 026).
//
// Rutas POS (dentro de `protected`, autenticadas, rol empleado):
//
//   - POST /api/pos/pagos-qr/iniciar
//     Body: { caja_id, monto:int64, venta_temp_id }
//     Crea (o reusa) la intención PENDIENTE con TTL de 5 min.
//
//   - GET /api/pos/pagos-qr/stream?venta_temp_id=...
//     SSE. Autenticado por Authorization: Bearer (como /api/sse). El
//     frontend lo consume con fetch streaming — nunca token en query.
//
//   - GET /api/pos/pagos-qr/estado?venta_temp_id=...
//     Snapshot JSON del estado actual. Útil para reconexión.
//
//   - POST /api/pos/pagos-qr/confirmar-manual
//     Confirma manualmente cuando el match automático fue 0 o ambiguo.
//     Auditado con DNI del contexto (jamás del body).
//
//   - POST /api/pos/pagos-qr/cancelar
//     Cancela la intención PENDIENTE (botón "Cancelar / Cambiar
//     método" del modal).
//
// Rutas públicas (fuera de `protected`, autenticación criptográfica):
//
//   - POST /api/webhooks/bold
//     Webhook oficial Bold. Verifica HMAC-SHA256 con BOLD_SECRET_KEY
//     cuando está configurada. Body máximo 16 KB.
//
//   - POST /api/webhooks/bold-notificacion
//     Puente MacroDroid. Verifica token BOLD_BRIDGE_TOKEN en tiempo
//     constante. Body máximo 16 KB.
//
// Contrato de seguridad:
//
//   - El OTP/token/firma JAMÁS viajan al cliente.
//   - El DNI auditor viene SOLO del contexto JWT (userDni), nunca del
//     body.
//   - Los webhooks responden 200 OK aun cuando UNMATCHED/AMBIGUOUS/
//     DUPLICATE — Bold y MacroDroid NO deben reintentar.
//   - Los webhooks responden 401 cuando firma/token inválido, 400 en
//     payload malformado, 413 cuando body > límite, 429 por rate-limit.
package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"backPOS-go/internal/infrastructure/sse"

	"github.com/gin-gonic/gin"
)

// qrIniciarMaxBodyBytes acota el body de POST /iniciar a 128 KB.
// El payload legacy pesa <300 B; el payload con snapshot durable
// (cart/client/totals) puede acercarse a decenas de KB con carritos
// grandes. El servicio refuerza con un cap de 64 KB por snapshot
// (JSONB opaco) como defensa anti-DoS en la capa de negocio.
const qrIniciarMaxBodyBytes = 128 * 1024

// PosQrHandler agrupa los endpoints del flujo QR.
type PosQrHandler struct {
	svc  *services.QrPaymentService
	repo *repositories.QrPaymentRepository
	hub  *sse.QRHub
}

// NewPosQrHandler construye el handler. El `repo` se usa sólo para
// la lectura inicial del snapshot en /stream (reduce round-trip del
// servicio).
func NewPosQrHandler(svc *services.QrPaymentService, repo *repositories.QrPaymentRepository, hub *sse.QRHub) *PosQrHandler {
	return &PosQrHandler{svc: svc, repo: repo, hub: hub}
}

// =========================================================================
// POST /iniciar
// =========================================================================

type iniciarPayload struct {
	CajaID      string `json:"caja_id"`
	Monto       int64  `json:"monto"`
	VentaTempID string `json:"venta_temp_id"`

	// Opcionales — payload "con snapshot durable". Cuando el frontend
	// los envía al abrir el QR, el handler persiste cart/client/totals
	// snapshot + sale_client_tx_id con queued_at NULL. El POST
	// posterior de /encolar reutiliza la MISMA fila (match por
	// venta_temp_id + monto en el repo) y sólo marca queued_at.
	// Si no se envían, el flujo legacy (3 campos obligatorios) sigue
	// válido y la intención se emite sin snapshot.
	ClientTxID  string          `json:"client_tx_id,omitempty"`
	ClientDNI   string          `json:"client_dni,omitempty"`
	CashierName string          `json:"cashier_name,omitempty"`
	SalePayload json.RawMessage `json:"sale_payload,omitempty"`
}

type iniciarResponse struct {
	OK                bool   `json:"ok"`
	IntentID          uint64 `json:"intentId"`
	VentaTempID       string `json:"ventaTempId"`
	Status            string `json:"status"`       // ej: "PENDIENTE" (status DB)
	StreamStatus      string `json:"streamStatus"` // ej: "PENDIENTE" (status SSE)
	ExpiresAt         string `json:"expiresAt"`
	ExpiresInSeconds  int    `json:"expiresInSeconds"`
	Reused            bool   `json:"reused"`
	SameAmountPending int    `json:"sameAmountPending"`
	// AlreadyPaid=true cuando el venta_temp_id ya tiene una intención
	// APROBADA/CONFIRMADA_MANUAL. Status viaja como "APROBADA" o
	// "CONFIRMADA_MANUAL" y StreamStatus como "APROBADO" para que el
	// frontend cierre el modal/bandeja sin reabrir el cobro.
	AlreadyPaid bool `json:"alreadyPaid,omitempty"`
	// SaleID carga related_sale_id cuando el materializador asíncrono
	// ya cerró la venta (0 → omitempty si todavía no existe). El modal
	// lo usa para redirigir al ticket.
	SaleID uint64 `json:"saleId,omitempty"`
	// AmountCOP es el monto del cobro ya aprobado. Permite al modal
	// pintar "Se cobró $X" sin consultar /estado.
	AmountCOP int64 `json:"amountCop,omitempty"`
}

// Iniciar maneja POST /api/pos/pagos-qr/iniciar.
//
// Dos modos operativos sobre el mismo endpoint:
//
//  1. Legacy ({caja_id, monto, venta_temp_id}): emite una intención
//     PENDIENTE sin snapshot. Compatible con instalaciones previas.
//
//  2. Con snapshot durable (añade client_tx_id + sale_payload):
//     persiste la foto del carrito/cliente/totales como JSONB y
//     reserva el sale_client_tx_id de idempotencia. queued_at queda
//     NULL (el cajero sigue viendo el modal). El /encolar posterior
//     reutiliza la MISMA intención (match por venta_temp_id + monto)
//     y sólo marca queued_at.
//
// El cap del body es 128 KB para que (2) quepa; (1) ocupa <300 B y
// no se afecta.
func (h *PosQrHandler) Iniciar(c *gin.Context) {
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "sesión requerida",
			"code":  ErrUnauthorized,
		})
		return
	}
	// Cap 128 KB: soporta snapshot durable opcional. El payload legacy
	// pesa ~300 bytes y no se ve afectado por el cap elevado.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, qrIniciarMaxBodyBytes)

	var body iniciarPayload
	if err := c.ShouldBindJSON(&body); err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{
				"error": "payload demasiado grande",
				"code":  models.ErrCodeQRBadRequest,
			})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "payload inválido",
			"code":  models.ErrCodeQRBadRequest,
		})
		return
	}

	// Modo con snapshot: detectado por la presencia de client_tx_id
	// o sale_payload. Si viene uno pero no el otro, el servicio
	// rechaza con ErrQRInvalidInput y se traduce a 400.
	hasSnapshot := strings.TrimSpace(body.ClientTxID) != "" ||
		len(bytes.TrimSpace([]byte(body.SalePayload))) > 0

	if hasSnapshot {
		snaps, serr := extractQRSnapshotsFromPayload(body.SalePayload, body.ClientDNI, "")
		if serr != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": serr.Error(),
				"code":  models.ErrCodeQRBadRequest,
			})
			return
		}
		if !h.validateQRSnapshotOrAbort(c, snaps, body.Monto, dni) {
			return
		}
		out, err := h.svc.InitiateWithSnapshot(c.Request.Context(), services.InitiateWithSnapshotInput{
			VentaTempID:    body.VentaTempID,
			CajaID:         body.CajaID,
			ActorDNI:       dni,
			AmountCOP:      body.Monto,
			ClientTxID:     body.ClientTxID,
			CartSnapshot:   snaps.Cart,
			ClientSnapshot: snaps.Client,
			TotalsSnapshot: snaps.Totals,
		})
		if err != nil {
			switch {
			case errors.Is(err, services.ErrQRInvalidInput):
				c.JSON(http.StatusBadRequest, gin.H{
					"error": "datos inválidos para iniciar el cobro QR",
					"code":  models.ErrCodeQRBadRequest,
				})
			default:
				c.JSON(http.StatusInternalServerError, gin.H{
					"error": "No se pudo iniciar el cobro.",
					"code":  models.ErrCodeQRRequestFailed,
				})
			}
			return
		}
		c.JSON(http.StatusOK, iniciarResponse{
			OK:                true,
			IntentID:          out.IntentID,
			VentaTempID:       out.VentaTempID,
			Status:            out.Status,
			StreamStatus:      models.MapIntentStatusToStream(out.Status),
			ExpiresAt:         out.ExpiresAt.UTC().Format(time.RFC3339),
			ExpiresInSeconds:  out.ExpiresInSeconds,
			Reused:            out.Reused,
			AlreadyPaid:       out.AlreadyPaid,
			SaleID:            out.SaleID,
			AmountCOP:         out.AmountCOP,
			SameAmountPending: h.countSameAmountPending(c.Request.Context(), body.Monto, out.IntentID),
		})
		return
	}

	// Modo legacy.
	out, err := h.svc.Initiate(c.Request.Context(), body.VentaTempID, body.CajaID, dni, body.Monto)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrQRInvalidInput):
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "caja_id, monto y venta_temp_id son obligatorios y deben ser válidos",
				"code":  models.ErrCodeQRBadRequest,
			})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "No se pudo iniciar el cobro. Intente de nuevo.",
				"code":  models.ErrCodeQRRequestFailed,
			})
		}
		return
	}

	c.JSON(http.StatusOK, iniciarResponse{
		OK:                true,
		IntentID:          out.IntentID,
		VentaTempID:       out.VentaTempID,
		Status:            out.Status,
		StreamStatus:      models.MapIntentStatusToStream(out.Status),
		ExpiresAt:         out.ExpiresAt.UTC().Format(time.RFC3339),
		ExpiresInSeconds:  out.ExpiresInSeconds,
		Reused:            out.Reused,
		AlreadyPaid:       out.AlreadyPaid,
		SaleID:            out.SaleID,
		AmountCOP:         out.AmountCOP,
		SameAmountPending: h.countSameAmountPending(c.Request.Context(), body.Monto, out.IntentID),
	})
}

// countSameAmountPending es un helper interno que degrada a 0 cuando
// el servicio no está wired o falla la consulta: el `sameAmountPending`
// es una señal informativa (banner UX en la bandeja); jamás debe
// romper el flujo /iniciar o /encolar.
func (h *PosQrHandler) countSameAmountPending(ctx context.Context, amount int64, excludeIntentID uint64) int {
	if h == nil || h.svc == nil {
		return 0
	}
	count, err := h.svc.CountSameAmountPending(ctx, amount, excludeIntentID)
	if err != nil {
		return 0
	}
	return count
}

// =========================================================================
// GET /estado
// =========================================================================

type estadoResponse struct {
	OK                bool   `json:"ok"`
	VentaTempID       string `json:"ventaTempId"`
	Status            string `json:"status"`
	StreamStatus      string `json:"streamStatus"`
	AmountCOP         int64  `json:"amountCop"`
	ExpiresAt         string `json:"expiresAt"`
	ApprovedAt        string `json:"approvedAt,omitempty"`
	ApprovedReference string `json:"approvedReference,omitempty"`
	ApprovedSource    string `json:"approvedSource,omitempty"`
}

// Estado maneja GET /api/pos/pagos-qr/estado.
func (h *PosQrHandler) Estado(c *gin.Context) {
	if actorDNI(c) == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida", "code": ErrUnauthorized})
		return
	}
	ventaTempID := strings.TrimSpace(c.Query("venta_temp_id"))
	if ventaTempID == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "venta_temp_id es obligatorio",
			"code":  models.ErrCodeQRBadRequest,
		})
		return
	}
	snap, err := h.svc.GetSnapshot(c.Request.Context(), ventaTempID)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrQRInvalidInput):
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "venta_temp_id inválido",
				"code":  models.ErrCodeQRBadRequest,
			})
		case errors.Is(err, services.ErrQRIntentNotFound):
			c.JSON(http.StatusNotFound, gin.H{
				"error": "No hay cobro QR activo para esa venta.",
				"code":  models.ErrCodeQRIntentNotFound,
			})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "No se pudo consultar el estado.",
				"code":  models.ErrCodeQRRequestFailed,
			})
		}
		return
	}
	resp := estadoResponse{
		OK:                true,
		VentaTempID:       snap.VentaTempID,
		Status:            snap.Status,
		StreamStatus:      snap.StreamStatus,
		AmountCOP:         snap.AmountCOP,
		ExpiresAt:         snap.ExpiresAt.UTC().Format(time.RFC3339),
		ApprovedReference: snap.ApprovedReference,
		ApprovedSource:    snap.ApprovedSource,
	}
	if snap.ApprovedAt != nil {
		resp.ApprovedAt = snap.ApprovedAt.UTC().Format(time.RFC3339)
	}
	c.JSON(http.StatusOK, resp)
}

// =========================================================================
// POST /cancelar
// =========================================================================

type cancelarPayload struct {
	VentaTempID string `json:"venta_temp_id"`
	Motivo      string `json:"motivo,omitempty"`
}

// Cancelar maneja POST /api/pos/pagos-qr/cancelar.
func (h *PosQrHandler) Cancelar(c *gin.Context) {
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida", "code": ErrUnauthorized})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, models.QRIntentIniciarMaxBodyBytes)

	var body cancelarPayload
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "payload inválido",
			"code":  models.ErrCodeQRBadRequest,
		})
		return
	}
	snap, err := h.svc.Cancel(c.Request.Context(), body.VentaTempID, dni, body.Motivo)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrQRInvalidInput):
			c.JSON(http.StatusBadRequest, gin.H{"error": "venta_temp_id inválido", "code": models.ErrCodeQRBadRequest})
		case errors.Is(err, services.ErrQRIntentNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "No hay intención viva.", "code": models.ErrCodeQRIntentNotFound})
		case errors.Is(err, services.ErrQRIntentNotPending):
			c.JSON(http.StatusConflict, gin.H{"error": "La intención ya está en un estado terminal.", "code": models.ErrCodeQRIntentAlreadyTerminal})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "No se pudo cancelar.", "code": models.ErrCodeQRRequestFailed})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":           true,
		"ventaTempId":  snap.VentaTempID,
		"status":       snap.Status,
		"streamStatus": snap.StreamStatus,
	})
}

// =========================================================================
// POST /confirmar-manual
// =========================================================================

type confirmarManualPayload struct {
	VentaTempID string `json:"venta_temp_id"`
	Nota        string `json:"nota,omitempty"`
}

// ConfirmarManual maneja POST /api/pos/pagos-qr/confirmar-manual.
//
// Auditoría crítica con DNI del contexto. El body NUNCA contiene DNI
// autoritativo — si se añade un campo `dni_autorizador` en el futuro,
// debe ser información opcional, nunca reemplazar al middleware.
func (h *PosQrHandler) ConfirmarManual(c *gin.Context) {
	// Chequeo estricto de sesión. NO usamos GetContextUser aquí porque
	// esa helper tiene un fallback a "admin" para compatibilidad con
	// código legado — y la auditoría crítica no admite fallbacks.
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida", "code": ErrUnauthorized})
		return
	}
	name := actorName(c)
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, models.QRIntentIniciarMaxBodyBytes)

	var body confirmarManualPayload
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido", "code": models.ErrCodeQRBadRequest})
		return
	}

	ip := c.ClientIP()
	device := c.Request.UserAgent()

	out, err := h.svc.ConfirmManual(c.Request.Context(), body.VentaTempID, dni, name, body.Nota, ip, device)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrQRInvalidInput):
			c.JSON(http.StatusBadRequest, gin.H{"error": "venta_temp_id inválido", "code": models.ErrCodeQRBadRequest})
		case errors.Is(err, services.ErrQRIntentNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "No hay intención.", "code": models.ErrCodeQRIntentNotFound})
		case errors.Is(err, services.ErrQRIntentExpired):
			c.JSON(http.StatusGone, gin.H{"error": "La intención expiró.", "code": models.ErrCodeQRIntentExpired})
		case errors.Is(err, services.ErrQRIntentNotPending):
			c.JSON(http.StatusConflict, gin.H{"error": "La intención ya está en un estado terminal.", "code": models.ErrCodeQRIntentAlreadyTerminal})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "No se pudo confirmar.", "code": models.ErrCodeQRRequestFailed})
		}
		return
	}
	// `approvedVia` replica approved_source (siempre MANUAL por esta
	// ruta). Fallback hard-coded si el repo omitió el valor para no
	// filtrar nunca `""` al frontend — el modal lo necesita para
	// diferenciar entre MANUAL, BOLD_OFFICIAL y BRIDGE_NOTIFICATION
	// cuando compone el callback `onApproved`.
	approvedVia := out.ApprovedSource
	if approvedVia == "" {
		approvedVia = models.QRApprovalSourceManual
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":                true,
		"ventaTempId":       out.VentaTempID,
		"status":            out.Status,
		"streamStatus":      models.MapIntentStatusToStream(out.Status),
		"approvedAt":        out.ApprovedAt.UTC().Format(time.RFC3339),
		"approvedReference": out.ApprovedReference,
		"approvedVia":       approvedVia,
	})
}

// =========================================================================
// GET /stream (SSE por venta_temp_id)
// =========================================================================

// Stream maneja GET /api/pos/pagos-qr/stream?venta_temp_id=... con
// autenticación por Authorization: Bearer (middleware). NUNCA se
// acepta token en query (así lo pidió el dueño).
func (h *PosQrHandler) Stream(c *gin.Context) {
	if actorDNI(c) == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida", "code": ErrUnauthorized})
		return
	}
	ventaTempID := strings.TrimSpace(c.Query("venta_temp_id"))
	if !models.IsValidQRVentaTempID(ventaTempID) {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "venta_temp_id inválido",
			"code":  models.ErrCodeQRBadRequest,
		})
		return
	}

	// Headers SSE.
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	c.Writer.Header().Set("Transfer-Encoding", "chunked")

	// Suscribirse al hub.
	ch, cancel := h.hub.Subscribe(ventaTempID)
	defer cancel()

	// Primer frame: snapshot actual (desde la BD; la memoria es sólo
	// caché/notificación — la BD es autoridad).
	h.svc.EmitSnapshotTo(c.Request.Context(), ventaTempID)

	// Timer de heartbeat (15s).
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	clientGone := c.Request.Context().Done()

	c.Stream(func(w io.Writer) bool {
		select {
		case <-clientGone:
			return false
		case ev, ok := <-ch:
			if !ok {
				// Canal cerrado (cancel idempotente): salir.
				return false
			}
			frame, err := sse.FormatQREvent(ev)
			if err != nil {
				return true
			}
			if _, err := io.WriteString(w, frame); err != nil {
				return false
			}
			// Si recibimos un estado terminal, cerramos.
			switch ev.Status {
			case models.QRStreamStatusApproved,
				models.QRStreamStatusExpired,
				models.QRStreamStatusCancelled,
				models.QRStreamStatusError:
				return false
			}
			return true
		case now := <-heartbeat.C:
			if _, err := io.WriteString(w, sse.FormatQRHeartbeat(now)); err != nil {
				return false
			}
			return true
		}
	})
}

// =========================================================================
// POST /api/webhooks/bold (oficial)
// =========================================================================

// WebhookOficial maneja POST /api/webhooks/bold. Ruta pública,
// autenticada criptográficamente por HMAC-SHA256 cuando
// BOLD_SECRET_KEY está configurada.
//
// Responde SIEMPRE 200 cuando se logró procesar el payload (match
// exacto, UNMATCHED, AMBIGUOUS, DUPLICATE o ignored). El campo
// `status` del body expone qué pasó para que el cliente del webhook
// (Bold) pueda auditar sin reintentar. Sólo errores reales de BD /
// crypto devuelven 500.
func (h *PosQrHandler) WebhookOficial(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, models.QRWebhookMaxBodyBytes)

	rawBody, readErr := io.ReadAll(c.Request.Body)
	if readErr != nil {
		if strings.Contains(readErr.Error(), "request body too large") {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{
				"error": "payload demasiado grande",
				"code":  models.ErrCodeQRWebhookTooLarge,
			})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "no se pudo leer el body",
			"code":  models.ErrCodeQRBadRequest,
		})
		return
	}

	// Header de firma: nombre configurable (default X-Bold-Signature).
	// Es un string normal: si Bold cambia el nombre, lo rotamos vía ENV.
	signatureHeader := c.GetHeader(getSignatureHeaderName())

	outcome, err := h.svc.IngestOfficialWebhook(c.Request.Context(), rawBody, signatureHeader)
	// Blindaje: no retener rawBody más allá del call (si GIN tiene un
	// panic recoverer que logee c.Request). Pisamos la referencia local.
	for i := range rawBody {
		rawBody[i] = 0
	}
	rawBody = nil
	_ = rawBody

	if err != nil {
		switch {
		case errors.Is(err, services.ErrQRWebhookTooLarge):
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{
				"error": "payload demasiado grande",
				"code":  models.ErrCodeQRWebhookTooLarge,
			})
		case errors.Is(err, services.ErrQRWebhookUnauthorized):
			// 401 sin filtrar detalles (no decimos "firma inválida" para
			// no filtrar que la firma se validó).
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "credencial inválida",
				"code":  models.ErrCodeQRWebhookUnauthorized,
			})
		case errors.Is(err, services.ErrQRWebhookBadPayload):
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "payload inválido",
				"code":  models.ErrCodeQRBadRequest,
			})
		case errors.Is(err, services.ErrQRWebhookRejected):
			// 200 OK idempotente: Bold no debe reintentar.
			c.JSON(http.StatusOK, gin.H{"ok": true, "status": "ignored"})
		case errors.Is(err, services.ErrQRWebhookDuplicate):
			c.JSON(http.StatusOK, gin.H{"ok": true, "status": models.QRWebhookStatusDuplicate})
		default:
			// Fallo transitorio real (BD, crypto): respondemos 500
			// para que Bold reintente.
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "fallo transitorio",
				"code":  models.ErrCodeQRRequestFailed,
			})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "status": webhookOutcomeStatus(outcome)})
}

// =========================================================================
// POST /api/webhooks/bold-notificacion (bridge MacroDroid)
// =========================================================================

// WebhookBridge maneja POST /api/webhooks/bold-notificacion. Ruta
// LAN autenticada por BOLD_BRIDGE_TOKEN. Prefiere el header
// `X-Bridge-Token`, conserva `X-Bold-Bridge-Token` y `token` JSON como
// compatibilidad; la comparación ocurre en tiempo constante.
//
// Responde SIEMPRE 200 cuando se logró procesar la notificación
// (APPROVED / UNMATCHED / AMBIGUOUS / DUPLICATE / ignored). El campo
// `status` del body expone qué pasó para que MacroDroid pueda
// mantener su propia bitácora sin reintentar innecesariamente. Sólo
// errores reales de BD devuelven 500.
//
// Importante: UNMATCHED se persiste como evento de conciliación
// (append-only en pos_qr_webhook_events) y NUNCA intenta crear
// venta. AMBIGUOUS también se persiste y NUNCA factura
// automáticamente. Esta es la regla "falso negativo antes que doble
// aprobación".
func (h *PosQrHandler) WebhookBridge(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, models.QRWebhookMaxBodyBytes)

	rawBody, readErr := io.ReadAll(c.Request.Body)
	if readErr != nil {
		if strings.Contains(readErr.Error(), "request body too large") {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{
				"error": "payload demasiado grande",
				"code":  models.ErrCodeQRWebhookTooLarge,
			})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "no se pudo leer el body",
			"code":  models.ErrCodeQRBadRequest,
		})
		return
	}

	headerToken := bridgeTokenFromHeaders(c)

	outcome, err := h.svc.IngestBridgeWebhook(c.Request.Context(), rawBody, headerToken)
	// Blanquear buffer local tras procesar.
	for i := range rawBody {
		rawBody[i] = 0
	}
	// Blanquear la variable local del header para no retener el valor
	// más de lo necesario (defensa parcial).
	headerToken = ""
	_ = headerToken

	if err != nil {
		switch {
		case errors.Is(err, services.ErrQRWebhookTooLarge):
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{
				"error": "payload demasiado grande",
				"code":  models.ErrCodeQRWebhookTooLarge,
			})
		case errors.Is(err, services.ErrQRWebhookUnauthorized):
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "credencial inválida",
				"code":  models.ErrCodeQRWebhookUnauthorized,
			})
		case errors.Is(err, services.ErrQRWebhookBadPayload):
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "payload inválido",
				"code":  models.ErrCodeQRBadRequest,
			})
		case errors.Is(err, services.ErrQRWebhookRejected):
			// Negador detectado / app ajena / monto no parseable: 200
			// con status=ignored. MacroDroid no debe reintentar.
			c.JSON(http.StatusOK, gin.H{"ok": true, "status": "ignored"})
		case errors.Is(err, services.ErrQRWebhookDuplicate):
			c.JSON(http.StatusOK, gin.H{"ok": true, "status": models.QRWebhookStatusDuplicate})
		default:
			// Error real de BD (ROLLBACK por CHECK, timeout). 500 para
			// que MacroDroid reintente (ventana corta de replay).
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "fallo transitorio",
				"code":  models.ErrCodeQRRequestFailed,
			})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "status": webhookOutcomeStatus(outcome)})
}

// webhookOutcomeStatus traduce el resultado de IngestWebhook en un
// status semántico expuesto al cliente del webhook. Nunca filtra
// datos sensibles (bold_code queda fuera, el status es sólo el enum
// APPROVED/UNMATCHED/AMBIGUOUS).
func webhookOutcomeStatus(outcome *repositories.IngestWebhookOutcome) string {
	if outcome == nil || outcome.Event == nil {
		return "ignored"
	}
	switch outcome.Event.ProcessedStatus {
	case models.QRWebhookStatusApproved,
		models.QRWebhookStatusUnmatched,
		models.QRWebhookStatusAmbiguous,
		models.QRWebhookStatusDuplicate:
		return outcome.Event.ProcessedStatus
	default:
		return "ignored"
	}
}

// =========================================================================
// Helpers
// =========================================================================

// bridgeTokenFromHeaders devuelve el header canónico del puente LAN. El alias
// anterior se conserva para no romper dispositivos MacroDroid ya instalados.
func bridgeTokenFromHeaders(c *gin.Context) string {
	if c == nil {
		return ""
	}
	token := strings.TrimSpace(c.GetHeader("X-Bridge-Token"))
	if token == "" {
		token = strings.TrimSpace(c.GetHeader("X-Bold-Bridge-Token"))
	}
	return token
}

// getSignatureHeaderName devuelve el nombre del header de firma. Es
// configurable por ENV porque el nombre canónico Bold NO VERIFICADO al
// momento de redactar; default razonable "X-Bold-Signature".
func getSignatureHeaderName() string {
	// Lectura directa; sin cache (envíos son infrecuentes).
	name := strings.TrimSpace(os.Getenv("BOLD_SIGNATURE_HEADER"))
	if name == "" {
		return "X-Bold-Signature"
	}
	return name
}

// =========================================================================
// POST /encolar — bandeja global (migración 027)
// =========================================================================

type encolarPayload struct {
	CajaID      string `json:"caja_id"`
	Monto       int64  `json:"monto"`
	VentaTempID string `json:"venta_temp_id"`
	ClientTxID  string `json:"client_tx_id"`
	ClientDNI   string `json:"client_dni"`
	CashierName string `json:"cashier_name"`
	// SalePayload es un JSON opaco: el servicio lo valida con json.Valid.
	// Debe traer al menos {details: [...], ...} con los campos que
	// el DispatchAutoSale decodifica (ver qrSaleCartItem/qrSaleTotals).
	// Se envía como json.RawMessage para preservar bytes exactos.
	SalePayload json.RawMessage `json:"sale_payload"`
}

// encolarPayloadSalePayload es el shape auxiliar donde el handler
// extrae `details`, `client` y `totals` del salePayload del frontend
// para persistirlos en columnas JSONB separadas.
type encolarSalePayloadView struct {
	Details json.RawMessage `json:"details"`
	Totals  json.RawMessage `json:"totals"`
	Client  json.RawMessage `json:"client"`
	// Fallbacks cuando el frontend no agrupa:
	CashAmount        float64 `json:"cashAmount,omitempty"`
	TransferAmount    float64 `json:"transferAmount,omitempty"`
	TransferNequi     float64 `json:"transferNequi,omitempty"`
	TransferDaviplata float64 `json:"transferDaviplata,omitempty"`
	CreditAmount      float64 `json:"creditAmount,omitempty"`
	TransferSource    string  `json:"transferSource,omitempty"`
	Change            float64 `json:"change,omitempty"`
	PaymentMethod     string  `json:"paymentMethod,omitempty"`
	EmployeeDNI       string  `json:"employeeDni,omitempty"`
	TotalAmount       float64 `json:"totalAmount,omitempty"`
	AmountPaid        float64 `json:"amountPaid,omitempty"`
	DebtPending       float64 `json:"debtPending,omitempty"`
	ClientDNI         string  `json:"clientDni,omitempty"`
	ClientName        string  `json:"clientName,omitempty"`
	// EditSaleID (A2): venta existente que el QR debe ACTUALIZAR en vez
	// de crear una nueva. Entero > 0; omitido = venta nueva.
	EditSaleID uint64 `json:"editSaleId,omitempty"`
	// AbonoClientDNI: el cobro QR es un abono de fiado de este cliente.
	AbonoClientDNI string `json:"abonoClientDni,omitempty"`
}

// Encolar maneja POST /api/pos/pagos-qr/encolar.
func (h *PosQrHandler) Encolar(c *gin.Context) {
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida", "code": ErrUnauthorized})
		return
	}
	cashierName := strings.TrimSpace(actorName(c))

	// Body cap más alto que /iniciar porque incluye el snapshot. 128 KB
	// basta para un carrito normal; el servicio corta cada JSONB a 64 KB.
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, qrIniciarMaxBodyBytes)

	var body encolarPayload
	if err := c.ShouldBindJSON(&body); err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{
				"error": "payload demasiado grande",
				"code":  models.ErrCodeQRBadRequest,
			})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "payload inválido",
			"code":  models.ErrCodeQRBadRequest,
		})
		return
	}

	// Separar sale_payload en cart/client/totals para persistir en
	// columnas distintas (lo que el dispatcher espera). Helper
	// compartido con /iniciar: una sola fuente de verdad para
	// transformar el payload del frontend en los tres JSONB.
	snaps, perr := extractQRSnapshotsFromPayload(body.SalePayload, body.ClientDNI, "")
	if perr != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": perr.Error(),
			"code":  models.ErrCodeQRBadRequest,
		})
		return
	}
	// Validación B (pago mixto QR): la suma de canales + la parte QR
	// debe cuadrar con el total del carrito y éste con la suma de
	// details. Si no cuadra, 400 claro en vez de dejar que el
	// dispatcher falle tarde con `pago insuficiente`. Si trae editSaleId
	// (A2) también valida que la venta sea editable por el actor.
	if !h.validateQRSnapshotOrAbort(c, snaps, body.Monto, dni) {
		return
	}

	out, err := h.svc.Enqueue(c.Request.Context(), services.EnqueueInput{
		VentaTempID:    body.VentaTempID,
		CajaID:         body.CajaID,
		ActorDNI:       dni,
		CashierName:    cashierName,
		AmountCOP:      body.Monto,
		ClientTxID:     body.ClientTxID,
		ClientDNI:      body.ClientDNI,
		CartSnapshot:   snaps.Cart,
		ClientSnapshot: snaps.Client,
		TotalsSnapshot: snaps.Totals,
	})
	if err != nil {
		var paidErr *services.IntentAlreadyPaidError
		if errors.As(err, &paidErr) {
			// Nunca re-abrir un cobro ya cerrado. 409 con saleId para
			// que el frontend redirija al ticket y cierre la bandeja.
			resp := gin.H{
				"error":     "La venta ya tiene un cobro aprobado por este QR.",
				"code":      models.ErrCodeQRIntentAlreadyPaid,
				"amountCop": paidErr.AmountCOP,
			}
			if paidErr.SaleID > 0 {
				resp["saleId"] = paidErr.SaleID
			}
			c.JSON(http.StatusConflict, resp)
			return
		}
		switch {
		case errors.Is(err, services.ErrQRInvalidInput):
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "datos inválidos para encolar el cobro QR",
				"code":  models.ErrCodeQRBadRequest,
			})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "No se pudo encolar el cobro.",
				"code":  models.ErrCodeQRRequestFailed,
			})
		}
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":                true,
		"intentId":          out.IntentID,
		"ventaTempId":       out.VentaTempID,
		"status":            out.Status,
		"streamStatus":      out.StreamStatus,
		"expiresAt":         out.ExpiresAt.UTC().Format(time.RFC3339),
		"expiresInSeconds":  out.ExpiresInSeconds,
		"reused":            out.Reused,
		"sameAmountPending": h.countSameAmountPending(c.Request.Context(), body.Monto, out.IntentID),
	})
}

// qrSnapshotsBundle agrupa los tres JSONB opacos que el repo persiste
// en pos_qr_payment_intents. El handler los produce desde el
// sale_payload que envía el frontend; el dispatcher los consume al
// materializar la venta.
type qrSnapshotsBundle struct {
	Cart   []byte
	Client []byte
	Totals []byte
}

// extractQRSnapshotsFromPayload decodifica `sale_payload` y produce
// los tres JSONB (cart/client/totals). Es la única fuente de verdad
// para transformar el shape del frontend (/sales/new/page.tsx) en el
// shape que persistimos. Reutilizada por POST /iniciar (modo con
// snapshot durable) y POST /encolar.
//
// Reglas:
//
//   - sale_payload debe traer `details` NO vacío. Sin cart no hay
//     forma de materializar la venta canónica.
//   - `totals` opcional: si no viene, se construye desde los campos
//     flat (cashAmount, transferAmount, etc.) por retrocompat con
//     clientes que envían el payload "sin agrupar".
//   - `client` opcional: si no viene, se construye desde ClientDNI /
//     ClientName del payload flat; si tampoco están, queda vacío y
//     el materializador cae al cliente anónimo 0000.
//
// El `fallbackClientDNI` sobreescribe cualquier dni vacío del
// sale_payload cuando el body root trae uno (coherencia /encolar).
// El `fallbackClientName` tiene la misma semántica.
func extractQRSnapshotsFromPayload(raw json.RawMessage, fallbackClientDNI, fallbackClientName string) (qrSnapshotsBundle, error) {
	var out qrSnapshotsBundle
	if len(bytes.TrimSpace([]byte(raw))) == 0 {
		return out, errors.New("sale_payload es obligatorio con snapshot durable")
	}
	var view encolarSalePayloadView
	if err := json.Unmarshal(raw, &view); err != nil {
		return out, errors.New("sale_payload inválido")
	}
	out.Cart = []byte(view.Details)
	if len(bytes.TrimSpace(out.Cart)) == 0 {
		return out, errors.New("sale_payload.details es obligatorio")
	}
	out.Totals = []byte(view.Totals)
	if len(bytes.TrimSpace(out.Totals)) == 0 {
		totalsMap := map[string]interface{}{
			"totalAmount":       view.TotalAmount,
			"amountPaid":        view.AmountPaid,
			"change":            view.Change,
			"cashAmount":        view.CashAmount,
			"transferAmount":    view.TransferAmount,
			"transferNequi":     view.TransferNequi,
			"transferDaviplata": view.TransferDaviplata,
			"creditAmount":      view.CreditAmount,
			"debtPending":       view.DebtPending,
			"transferSource":    view.TransferSource,
			"paymentMethod":     view.PaymentMethod,
			"employeeDni":       view.EmployeeDNI,
		}
		if view.EditSaleID > 0 {
			totalsMap["editSaleId"] = view.EditSaleID
		}
		if strings.TrimSpace(view.AbonoClientDNI) != "" {
			totalsMap["abonoClientDni"] = strings.TrimSpace(view.AbonoClientDNI)
		}
		built, _ := json.Marshal(totalsMap)
		out.Totals = built
	}
	out.Client = []byte(view.Client)
	if len(bytes.TrimSpace(out.Client)) == 0 {
		dni := strings.TrimSpace(view.ClientDNI)
		if dni == "" {
			dni = strings.TrimSpace(fallbackClientDNI)
		}
		name := strings.TrimSpace(view.ClientName)
		if name == "" {
			name = strings.TrimSpace(fallbackClientName)
		}
		if dni != "" || name != "" {
			built, _ := json.Marshal(map[string]string{
				"dni":  dni,
				"name": name,
			})
			out.Client = built
		} else {
			out.Client = nil // deja que el repo omita la columna
		}
	}
	return out, nil
}

// qrSnapshotFlatView replica los campos escalares que /sales/new emite
// en `sale_payload.totals` cuando el pago es MIXTO (QR + efectivo /
// Nequi / Daviplata / fiado). El handler lo parsea una vez para
// validar que las partes cuadran con el total del carrito y con el
// monto QR del body `monto`. NO reemplaza la escritura del JSONB
// opaco: sólo lo audita.
type qrSnapshotFlatView struct {
	TotalAmount       float64 `json:"totalAmount"`
	CashAmount        float64 `json:"cashAmount"`
	TransferAmount    float64 `json:"transferAmount"`
	TransferNequi     float64 `json:"transferNequi"`
	TransferDaviplata float64 `json:"transferDaviplata"`
	CreditAmount      float64 `json:"creditAmount"`
}

// qrSnapshotDetailView replica los campos mínimos de cada línea del
// carrito para validar la suma de subtotales == totalAmount.
type qrSnapshotDetailView struct {
	Quantity  float64 `json:"quantity"`
	UnitPrice float64 `json:"unitPrice"`
	Subtotal  float64 `json:"subtotal"`
}

// validateQRPaymentBreakdown chequea las reglas B (pago mixto QR):
//
//  1. La suma de details.subtotal (o quantity*unitPrice como fallback)
//     debe empatar con totalAmount (tolerancia 1 COP).
//  2. La suma del desglose de pago cash + nequi + davi + credit +
//     qrAmount debe empatar con totalAmount (tolerancia 1 COP). Es
//     decir, los canales reportados + la parte QR cubren el carrito.
//  3. transferNequi + transferDaviplata nunca exceden transferAmount
//     (que el frontend reporta como Nequi + Daviplata + parte QR).
//
// `qrAmountCOP` es `body.monto` (parte del QR, parámetro oficial del
// POST). Si el frontend manda un snapshot sin breakdown explícito
// (cash=nequi=davi=credit=0), tratamos la venta como "sólo QR" y
// esperamos totalAmount == qrAmount.
//
// Un desvío fuera de la tolerancia devuelve un error en español listo
// para 400. La función es pura (sin BD, sin logs) y la cubren tests
// de tabla.
func validateQRPaymentBreakdown(totals []byte, cart []byte, qrAmountCOP int64) error {
	if len(bytes.TrimSpace(totals)) == 0 {
		return errors.New("totals vacío en el snapshot")
	}
	var flat qrSnapshotFlatView
	if err := json.Unmarshal(totals, &flat); err != nil {
		return errors.New("totals inválido en el snapshot")
	}
	if flat.CashAmount < 0 || flat.TransferAmount < 0 || flat.TransferNequi < 0 ||
		flat.TransferDaviplata < 0 || flat.CreditAmount < 0 {
		return errors.New("los montos del pago no pueden ser negativos")
	}
	// (1) suma de details == totalAmount (±1 COP).
	if len(bytes.TrimSpace(cart)) > 0 {
		var details []qrSnapshotDetailView
		if err := json.Unmarshal(cart, &details); err == nil && len(details) > 0 {
			var sumDetails float64
			for _, d := range details {
				sub := d.Subtotal
				if sub == 0 {
					sub = d.Quantity * d.UnitPrice
				}
				sumDetails += sub
			}
			if math.Abs(sumDetails-flat.TotalAmount) > 1.0 {
				return fmt.Errorf("totalAmount (%.2f) no cuadra con la suma de los detalles (%.2f); diferencia %.2f COP",
					flat.TotalAmount, sumDetails, flat.TotalAmount-sumDetails)
			}
		}
	}
	// (2) Nequi+Daviplata no excede TransferAmount (si TransferAmount>0).
	// Tolerancia 1 COP para redondeo. Fuera de tolerancia es incoherente.
	if flat.TransferAmount > 0 {
		if flat.TransferNequi+flat.TransferDaviplata-flat.TransferAmount > 1.0 {
			return fmt.Errorf("transferNequi + transferDaviplata (%.2f) exceden transferAmount (%.2f)",
				flat.TransferNequi+flat.TransferDaviplata, flat.TransferAmount)
		}
	}
	// (3) suma cash + nequi + davi + credit + qrAmount == totalAmount.
	//
	// transferAmount en el contrato del frontend es (Nequi + Daviplata +
	// parte QR). Para no doble-contar, la suma del desglose es:
	//     cash + nequi + daviplata + credit + qrAmount
	// y la parte QR = transferAmount - (nequi + daviplata).
	//
	// Si el snapshot no reporta breakdown mixto (todos los canales
	// escalares en 0) tratamos el QR como pago único y comparamos
	// contra qrAmount directamente.
	totalBreakdown := flat.CashAmount + flat.TransferNequi + flat.TransferDaviplata + flat.CreditAmount + float64(qrAmountCOP)
	if math.Abs(totalBreakdown-flat.TotalAmount) > 1.0 {
		return fmt.Errorf("los pagos no cuadran: cash %.2f + nequi %.2f + daviplata %.2f + crédito %.2f + QR %d = %.2f, pero el total del carrito es %.2f",
			flat.CashAmount, flat.TransferNequi, flat.TransferDaviplata, flat.CreditAmount, qrAmountCOP,
			totalBreakdown, flat.TotalAmount)
	}
	// (4) La parte QR declarada en el snapshot (transferAmount - Nequi -
	// Daviplata) debe ser exactamente el monto de la intención: el
	// emparejamiento por monto del webhook usa `monto`, y el dispatcher
	// persiste la porción genérica como BOLD_QR. Si difieren, la venta
	// quedaría con un Bold distinto del que realmente entró.
	if flat.TransferAmount > 0 || qrAmountCOP > 0 {
		qrPart := flat.TransferAmount - flat.TransferNequi - flat.TransferDaviplata
		if math.Abs(qrPart-float64(qrAmountCOP)) > 1.0 {
			return fmt.Errorf("la parte QR del pago (transferAmount - nequi - daviplata = %.2f) no coincide con el monto del cobro QR (%d)",
				qrPart, qrAmountCOP)
		}
	}
	return nil
}

// validateQRSnapshotOrAbort aplica las validaciones B (desglose) y A2
// (editSaleId) sobre el snapshot de /iniciar y /encolar. Si alguna falla,
// responde 400 QR_BAD_REQUEST con el mensaje en español y devuelve false.
func (h *PosQrHandler) validateQRSnapshotOrAbort(c *gin.Context, snaps qrSnapshotsBundle, monto int64, actor string) bool {
	if verr := validateQRPaymentBreakdown(snaps.Totals, snaps.Cart, monto); verr != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": verr.Error(), "code": models.ErrCodeQRBadRequest})
		return false
	}
	editSaleID, eerr := extractEditSaleIDFromTotals(snaps.Totals)
	if eerr != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": eerr.Error(), "code": models.ErrCodeQRBadRequest})
		return false
	}
	if editSaleID > 0 {
		if verr := h.svc.ValidateQREditTarget(editSaleID, actor); verr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": verr.Error(), "code": models.ErrCodeQRBadRequest})
			return false
		}
	}
	// Abono de fiado por QR: debe ser sólo QR (los demás canales se
	// registran como abono aparte) y no puede mezclarse con edición.
	if abonoDNI := extractAbonoClientDNIFromTotals(snaps.Totals); abonoDNI != "" {
		if editSaleID > 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "un abono por QR no puede editar una venta", "code": models.ErrCodeQRBadRequest})
			return false
		}
		if extraChannelsInTotals(snaps.Totals) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "el abono por QR debe cobrarse completo por QR; registra el efectivo como otro abono", "code": models.ErrCodeQRBadRequest})
			return false
		}
	}
	return true
}

// extractAbonoClientDNIFromTotals lee `abonoClientDni` del totals snapshot.
func extractAbonoClientDNIFromTotals(totals []byte) string {
	var v struct {
		AbonoClientDNI string `json:"abonoClientDni"`
	}
	if len(bytes.TrimSpace(totals)) == 0 || json.Unmarshal(totals, &v) != nil {
		return ""
	}
	dni := strings.TrimSpace(v.AbonoClientDNI)
	if dni == "0" || dni == "0000" {
		return ""
	}
	return dni
}

// extraChannelsInTotals reporta si el snapshot trae canales distintos del QR.
func extraChannelsInTotals(totals []byte) bool {
	var f qrSnapshotFlatView
	if json.Unmarshal(totals, &f) != nil {
		return false
	}
	return f.CashAmount > 0.5 || f.TransferNequi > 0.5 || f.TransferDaviplata > 0.5 || f.CreditAmount > 0.5
}

// extractEditSaleIDFromTotals lee `editSaleId` del totals snapshot ya
// armado (A2). 0 = venta nueva. Un valor no entero/negativo es error.
func extractEditSaleIDFromTotals(totals []byte) (uint64, error) {
	if len(bytes.TrimSpace(totals)) == 0 {
		return 0, nil
	}
	var view struct {
		EditSaleID *json.Number `json:"editSaleId"`
	}
	if err := json.Unmarshal(totals, &view); err != nil {
		return 0, errors.New("editSaleId inválido")
	}
	if view.EditSaleID == nil {
		return 0, nil
	}
	n, err := strconv.ParseUint(view.EditSaleID.String(), 10, 32)
	if err != nil || n == 0 {
		return 0, errors.New("editSaleId debe ser un número de venta válido")
	}
	return n, nil
}

// =========================================================================
// GET /pendientes — bandeja global
// =========================================================================

type pendientesItem struct {
	IntentID    uint64 `json:"intentId"`
	VentaTempID string `json:"ventaTempId"`
	CajaID      string `json:"cajaId"`
	CashierName string `json:"cashierName,omitempty"`
	CreatedBy   string `json:"createdBy,omitempty"`
	AmountCOP   int64  `json:"amountCop"`
	CreatedAt   string `json:"createdAt"`
	ExpiresAt   string `json:"expiresAt"`
	QueuedAt    string `json:"queuedAt,omitempty"`
}

// Pendientes maneja GET /api/pos/pagos-qr/pendientes?caja_id=&limit=.
//
// Modos:
//   - sin `scope` o `scope=caja`: filtra por `caja_id` (parámetro
//     obligatorio). Accesible a cualquier sesión con rol empleado.
//   - `scope=all`: bandeja GLOBAL de TODAS las cajas. SOLO para
//     admin/superadmin (verificado contra el rol del JWT en servidor).
//     Devuelve 403 para empleado. `caja_id` deja de ser obligatorio;
//     cada item lleva su propio `cajaId` (el frontend puede filtrar
//     localmente). Mismo shape que el modo normal.
func (h *PosQrHandler) Pendientes(c *gin.Context) {
	if actorDNI(c) == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida", "code": ErrUnauthorized})
		return
	}
	scope := strings.ToLower(strings.TrimSpace(c.Query("scope")))
	// Validamos y acotamos `limit` igual para ambos modos.
	limit := 20
	if l := strings.TrimSpace(c.Query("limit")); l != "" {
		if n, err := strconv.Atoi(l); err == nil {
			if n < 1 {
				n = 1
			}
			if n > 50 {
				n = 50
			}
			limit = n
		}
	}

	if scope == "all" {
		// B5 (2026-10-23): bandeja global sólo para admin/superadmin.
		// Mismo criterio de autorización que `confirmar-manual`
		// (verificación contra el rol del JWT, no un header).
		if !actorIsAdmin(c) {
			c.JSON(http.StatusForbidden, gin.H{
				"error": "sólo admin puede consultar la bandeja global de QR",
				"code":  ErrForbidden,
			})
			return
		}
		rows, err := h.svc.ListPendingGlobal(c.Request.Context(), limit)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "No se pudo listar la bandeja global.",
				"code":  models.ErrCodeQRRequestFailed,
			})
			return
		}
		items := make([]pendientesItem, 0, len(rows))
		for i := range rows {
			row := rows[i]
			item := pendientesItem{
				IntentID:    row.ID,
				VentaTempID: row.VentaTempID,
				CajaID:      row.CajaID,
				// cashierName lo resuelve el frontend desde createdBy
				// (el repo no persiste el nombre humano del cajero).
				CashierName: "",
				CreatedBy:   row.CreatedByDNI,
				AmountCOP:   row.AmountCOP,
				CreatedAt:   row.CreatedAt.UTC().Format(time.RFC3339),
				ExpiresAt:   row.ExpiresAt.UTC().Format(time.RFC3339),
			}
			if row.QueuedAt != nil {
				item.QueuedAt = row.QueuedAt.UTC().Format(time.RFC3339)
			}
			items = append(items, item)
		}
		c.JSON(http.StatusOK, gin.H{
			"ok":    true,
			"scope": "all",
			"items": items,
			"total": len(items),
		})
		return
	}

	cajaID := strings.TrimSpace(c.Query("caja_id"))
	if cajaID == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "caja_id es obligatorio",
			"code":  models.ErrCodeQRBadRequest,
		})
		return
	}
	rows, err := h.svc.ListPendingByCaja(c.Request.Context(), cajaID, limit)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrQRInvalidInput):
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "caja_id inválido",
				"code":  models.ErrCodeQRBadRequest,
			})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "No se pudo listar la bandeja.",
				"code":  models.ErrCodeQRRequestFailed,
			})
		}
		return
	}
	items := make([]pendientesItem, 0, len(rows))
	for i := range rows {
		row := rows[i]
		item := pendientesItem{
			IntentID:    row.ID,
			VentaTempID: row.VentaTempID,
			CajaID:      row.CajaID,
			// CashierName no se persiste (la 027 no define esa columna);
			// el frontend resuelve el nombre humano a partir de
			// CreatedBy consultando su catálogo local de empleados.
			CashierName: "",
			CreatedBy:   row.CreatedByDNI,
			AmountCOP:   row.AmountCOP,
			CreatedAt:   row.CreatedAt.UTC().Format(time.RFC3339),
			ExpiresAt:   row.ExpiresAt.UTC().Format(time.RFC3339),
		}
		if row.QueuedAt != nil {
			item.QueuedAt = row.QueuedAt.UTC().Format(time.RFC3339)
		}
		items = append(items, item)
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":    true,
		"items": items,
		"total": len(items),
	})
}

// =========================================================================
// GET /caja-stream — SSE agregado por caja
// =========================================================================

// CajaStream maneja GET /api/pos/pagos-qr/caja-stream?caja_id=... con
// Authorization: Bearer. Mismo contrato que /stream pero el canal es
// la bandeja global (QRTrayEvent).
//
// Modos:
//   - sin `scope` o `scope=caja`: suscripción al canal de una caja
//     concreta. `caja_id` obligatorio. Accesible al rol empleado.
//   - `scope=all`: suscripción GLOBAL (admin/superadmin). Recibe
//     eventos de TODAS las cajas vía el fan-out del hub
//     (PublishToCaja). 403 para empleado. `caja_id` deja de ser
//     obligatorio.
func (h *PosQrHandler) CajaStream(c *gin.Context) {
	if actorDNI(c) == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida", "code": ErrUnauthorized})
		return
	}
	scope := strings.ToLower(strings.TrimSpace(c.Query("scope")))

	// Cabeceras SSE comunes.
	writeSSEHeaders := func() {
		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache")
		c.Writer.Header().Set("Connection", "keep-alive")
		c.Writer.Header().Set("X-Accel-Buffering", "no")
		c.Writer.Header().Set("Transfer-Encoding", "chunked")
	}

	if scope == "all" {
		// B5: canal global solamente para admin/superadmin.
		if !actorIsAdmin(c) {
			c.JSON(http.StatusForbidden, gin.H{
				"error": "sólo admin puede suscribirse al stream global de QR",
				"code":  ErrForbidden,
			})
			return
		}

		writeSSEHeaders()
		ch, cancel := h.hub.SubscribeGlobal()
		defer cancel()

		heartbeat := time.NewTicker(15 * time.Second)
		defer heartbeat.Stop()

		clientGone := c.Request.Context().Done()
		c.Stream(func(w io.Writer) bool {
			select {
			case <-clientGone:
				return false
			case ev, ok := <-ch:
				if !ok {
					return false
				}
				frame, err := sse.FormatQRTrayEvent(ev)
				if err != nil {
					return true
				}
				if _, err := io.WriteString(w, frame); err != nil {
					return false
				}
				return true
			case now := <-heartbeat.C:
				if _, err := io.WriteString(w, sse.FormatQRHeartbeat(now)); err != nil {
					return false
				}
				return true
			}
		})
		return
	}

	cajaID := strings.TrimSpace(c.Query("caja_id"))
	if !models.IsValidQRCajaID(cajaID) {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "caja_id inválido",
			"code":  models.ErrCodeQRBadRequest,
		})
		return
	}

	writeSSEHeaders()

	ch, cancel := h.hub.SubscribeCaja(cajaID)
	defer cancel()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	clientGone := c.Request.Context().Done()

	c.Stream(func(w io.Writer) bool {
		select {
		case <-clientGone:
			return false
		case ev, ok := <-ch:
			if !ok {
				return false
			}
			frame, err := sse.FormatQRTrayEvent(ev)
			if err != nil {
				return true
			}
			if _, err := io.WriteString(w, frame); err != nil {
				return false
			}
			return true
		case now := <-heartbeat.C:
			if _, err := io.WriteString(w, sse.FormatQRHeartbeat(now)); err != nil {
				return false
			}
			return true
		}
	})
}

// =========================================================================
// GET /api/pos/pagos-qr/pagos-sin-asignar
// =========================================================================

// pagosSinAsignarItem es el shape por item del response. Mismos nombres
// camelCase que el resto del contrato con el modal.
type pagosSinAsignarItem struct {
	EventID    uint64 `json:"eventId"`
	AmountCOP  int64  `json:"amountCop"`
	ReceivedAt string `json:"receivedAt"`
	Status     string `json:"status"` // "AMBIGUOUS" | "UNMATCHED"
	Resumen    string `json:"resumen,omitempty"`
	Source     string `json:"source,omitempty"`
}

// PagosSinAsignar maneja GET /api/pos/pagos-qr/pagos-sin-asignar?minutos=30.
// Lista los eventos AMBIGUOUS/UNMATCHED (sin matched_intent_id)
// recibidos dentro de la ventana solicitada. `minutos` ∈ [1,120];
// `limit` fijo 50; orden `received_at DESC`.
func (h *PosQrHandler) PagosSinAsignar(c *gin.Context) {
	if actorDNI(c) == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida", "code": ErrUnauthorized})
		return
	}
	minutos := 30
	if raw := strings.TrimSpace(c.Query("minutos")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "minutos inválido",
				"code":  models.ErrCodeQRBadRequest,
			})
			return
		}
		minutos = n
	}
	if minutos < models.QRUnassignedMinutosMin || minutos > models.QRUnassignedMinutosMax {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "minutos fuera de rango (1..1440)",
			"code":  models.ErrCodeQRBadRequest,
		})
		return
	}

	events, err := h.svc.ListUnassignedWebhookEvents(c.Request.Context(), minutos)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrQRInvalidInput):
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "parámetros inválidos",
				"code":  models.ErrCodeQRBadRequest,
			})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "No se pudo listar los eventos sin asignar.",
				"code":  models.ErrCodeQRRequestFailed,
			})
		}
		return
	}
	items := make([]pagosSinAsignarItem, 0, len(events))
	for i := range events {
		items = append(items, pagosSinAsignarItem{
			EventID:    events[i].EventID,
			AmountCOP:  events[i].AmountCOP,
			ReceivedAt: events[i].ReceivedAt.UTC().Format(time.RFC3339),
			Status:     events[i].Status,
			Resumen:    events[i].Resumen,
			Source:     events[i].Source,
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":    true,
		"items": items,
		"total": len(items),
	})
}

// =========================================================================
// POST /api/pos/pagos-qr/asignar
// =========================================================================

type asignarPayload struct {
	VentaTempID string `json:"venta_temp_id"`
	EventID     uint64 `json:"event_id"`
}

// Asignar maneja POST /api/pos/pagos-qr/asignar. El cajero asocia
// manualmente un evento AMBIGUOUS/UNMATCHED a una intención PENDIENTE
// de su carrito actual. El DNI auditor viene SIEMPRE del contexto JWT
// (userDni), nunca del body.
//
// Errores estables (todos con `code` constante del dominio):
//
//   - 400 QR_BAD_REQUEST: payload inválido o faltante.
//   - 404 QR_INTENT_NOT_FOUND: venta_temp_id sin intención viva.
//   - 404 QR_EVENT_NOT_FOUND: event_id inexistente.
//   - 409 QR_EVENT_ALREADY_ASSIGNED: evento ya aprobado/asignado o
//     fuera de ventana (60 min).
//   - 409 QR_AMOUNT_MISMATCH: el monto del evento no coincide con el
//     monto de la intención.
//   - 409 QR_INTENT_ALREADY_TERMINAL: la intención ya no está PENDIENTE.
//   - 410 QR_INTENT_EXPIRED: la intención expiró entre la pantalla y
//     la llamada.
//   - 401 QR_UNAUTHORIZED: sesión requerida.
//
// Post-commit (dentro del servicio): audit_log, SSE snapshot APROBADO
// al stream + QRTrayEvent al canal de la caja + triggerAutoSale
// (materialización canónica idempotente).
func (h *PosQrHandler) Asignar(c *gin.Context) {
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida", "code": ErrUnauthorized})
		return
	}
	name := actorName(c)
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, models.QRIntentIniciarMaxBodyBytes)

	var body asignarPayload
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "payload inválido",
			"code":  models.ErrCodeQRBadRequest,
		})
		return
	}
	if strings.TrimSpace(body.VentaTempID) == "" || body.EventID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "venta_temp_id y event_id son obligatorios",
			"code":  models.ErrCodeQRBadRequest,
		})
		return
	}

	ip := c.ClientIP()
	device := c.Request.UserAgent()

	out, err := h.svc.AssignEventToIntent(c.Request.Context(), services.AssignEventInput{
		VentaTempID:  body.VentaTempID,
		EventID:      body.EventID,
		ActorDNI:     dni,
		ActorName:    name,
		ActorIsAdmin: actorIsAdmin(c),
		IP:           ip,
		Device:       device,
	})
	if err != nil {
		var paidErr *services.IntentAlreadyPaidError
		if errors.As(err, &paidErr) {
			resp := gin.H{
				"error":     "La venta ya tiene un cobro aprobado por este QR.",
				"code":      models.ErrCodeQRIntentAlreadyPaid,
				"amountCop": paidErr.AmountCOP,
			}
			if paidErr.SaleID > 0 {
				resp["saleId"] = paidErr.SaleID
			}
			c.JSON(http.StatusConflict, resp)
			return
		}
		switch {
		case errors.Is(err, services.ErrQRInvalidInput):
			c.JSON(http.StatusBadRequest, gin.H{"error": "parámetros inválidos", "code": models.ErrCodeQRBadRequest})
		case errors.Is(err, services.ErrQREventNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "El evento no existe.", "code": models.ErrCodeQREventNotFound})
		case errors.Is(err, services.ErrQRIntentNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "La intención no existe.", "code": models.ErrCodeQRIntentNotFound})
		case errors.Is(err, services.ErrQREventAlreadyAssigned):
			c.JSON(http.StatusConflict, gin.H{"error": "El evento ya fue asignado o está fuera de ventana.", "code": models.ErrCodeQREventAlreadyAssigned})
		case errors.Is(err, services.ErrQRAmountMismatch):
			c.JSON(http.StatusConflict, gin.H{"error": "El monto del evento no coincide con la intención.", "code": models.ErrCodeQRAmountMismatch})
		case errors.Is(err, services.ErrQRIntentNotPending):
			c.JSON(http.StatusConflict, gin.H{"error": "La intención ya está en un estado terminal.", "code": models.ErrCodeQRIntentAlreadyTerminal})
		case errors.Is(err, services.ErrQRIntentExpired):
			c.JSON(http.StatusGone, gin.H{"error": "La intención expiró.", "code": models.ErrCodeQRIntentExpired})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "No se pudo asignar el evento.", "code": models.ErrCodeQRRequestFailed})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":                true,
		"intentId":          out.IntentID,
		"eventId":           out.EventID,
		"ventaTempId":       out.VentaTempID,
		"amountCop":         out.AmountCOP,
		"status":            out.Status,
		"streamStatus":      out.StreamStatus,
		"approvedAt":        out.ApprovedAt.UTC().Format(time.RFC3339),
		"approvedReference": out.ApprovedReference,
		"approvedVia":       out.ApprovedVia,
	})
}

// Avoid "imported and not used: context" when the file previously
// didn't need the import.
var _ context.Context = context.TODO()
