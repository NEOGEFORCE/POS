package handlers

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"

	"github.com/gin-gonic/gin"
)

// =========================================================================
// Enlazar pago QR sin asignar → venta registrada (sólo admin)
// =========================================================================

// writeLinkError traduce los errores del enlace a HTTP con mensaje en español.
func writeLinkError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, services.ErrQRLinkForbidden):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": models.ErrCodeQRIntentWrongActor})
	case errors.Is(err, services.ErrQRInvalidInput):
		c.JSON(http.StatusBadRequest, gin.H{"error": "parámetros inválidos", "code": models.ErrCodeQRBadRequest})
	case errors.Is(err, services.ErrQREventNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "El pago no existe.", "code": models.ErrCodeQREventNotFound})
	case errors.Is(err, services.ErrQREventAlreadyAssigned):
		c.JSON(http.StatusConflict, gin.H{"error": "El pago ya fue asignado o está fuera de la ventana de 24 h.", "code": models.ErrCodeQREventAlreadyAssigned})
	case errors.Is(err, services.ErrQRAmountMismatch):
		c.JSON(http.StatusConflict, gin.H{"error": "El monto del pago no coincide.", "code": models.ErrCodeQRAmountMismatch})
	case errors.Is(err, services.ErrQRLinkSaleNotFound),
		errors.Is(err, services.ErrQRLinkInsufficientCash),
		errors.Is(err, services.ErrQREditUnavailable):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": models.ErrCodeQRBadRequest})
	default:
		msg := err.Error()
		// Errores de negocio en español de CheckQREditTarget (venta anulada,
		// permisos). Los internos se ocultan.
		if strings.Contains(msg, "venta") && !strings.Contains(msg, "qr:") {
			c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": models.ErrCodeQRBadRequest})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No se pudo completar el enlace.", "code": models.ErrCodeQRRequestFailed})
	}
}

// VentasCandidatas maneja GET /api/pos/pagos-qr/pagos-sin-asignar/:eventId/ventas.
// Sugiere ventas del ±12 h cuyo efectivo cubre el monto del pago.
func (h *PosQrHandler) VentasCandidatas(c *gin.Context) {
	if actorDNI(c) == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida", "code": ErrUnauthorized})
		return
	}
	eventID, err := strconv.ParseUint(strings.TrimSpace(c.Param("eventId")), 10, 64)
	if err != nil || eventID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "pago inválido", "code": models.ErrCodeQRBadRequest})
		return
	}
	items, err := h.svc.ListSaleCandidatesForEvent(c.Request.Context(), eventID, actorIsAdmin(c))
	if err != nil {
		writeLinkError(c, err)
		return
	}
	out := make([]gin.H, 0, len(items))
	for _, it := range items {
		out = append(out, gin.H{
			"saleId":             it.SaleID,
			"saleDate":           it.SaleDate.UTC().Format(time.RFC3339),
			"totalAmount":        it.TotalAmount,
			"cashAmount":         it.CashNet,
			"transferAmount":     it.TransferAmount,
			"paymentMethod":      it.PaymentMethod,
			"employeeName":       it.EmployeeName,
			"clientName":         it.ClientName,
			"minutesFromPayment": it.MinutesFromPayment,
			"exactAmount":        it.ExactAmount,
		})
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "items": out, "total": len(out)})
}

type enlazarVentaPayload struct {
	EventID uint64 `json:"event_id"`
	SaleID  uint   `json:"sale_id"`
}

// EnlazarVenta maneja POST /api/pos/pagos-qr/enlazar-venta {event_id, sale_id}.
// El DNI auditor sale del JWT, nunca del body.
func (h *PosQrHandler) EnlazarVenta(c *gin.Context) {
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida", "code": ErrUnauthorized})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, models.QRIntentIniciarMaxBodyBytes)
	var body enlazarVentaPayload
	if err := c.ShouldBindJSON(&body); err != nil || body.EventID == 0 || body.SaleID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "event_id y sale_id son obligatorios", "code": models.ErrCodeQRBadRequest})
		return
	}
	out, err := h.svc.LinkEventToSale(c.Request.Context(), services.LinkEventToSaleInput{
		EventID:      body.EventID,
		SaleID:       body.SaleID,
		ActorDNI:     dni,
		ActorName:    actorName(c),
		ActorIsAdmin: actorIsAdmin(c),
		IP:           c.ClientIP(),
		Device:       c.Request.UserAgent(),
	})
	if err != nil {
		writeLinkError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":        true,
		"saleId":    body.SaleID,
		"eventId":   out.EventID,
		"intentId":  out.IntentID,
		"amountCop": out.AmountCOP,
		"status":    out.Status,
	})
}
