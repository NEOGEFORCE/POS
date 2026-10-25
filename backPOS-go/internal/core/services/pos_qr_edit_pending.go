package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"backPOS-go/internal/core/domain/models"
)

// =========================================================================
// Editar un cobro QR en espera (POST /pos/pagos-qr/editar)
// =========================================================================
//
// Al "Dejar en espera" un QR, el carrito se libera y la venta vive sólo en
// el snapshot de la intención. Si el cliente pide quitar o agregar algo
// antes de pagar, el cajero pulsa "Editar" en la bandeja:
//
//  1. Se CANCELA la intención bajo lock (repo.Cancel): desde ese instante
//     un pago por ese monto ya no la aprueba (quedaría "sin asignar").
//  2. Se devuelven los productos, el cliente y el editSaleId del snapshot
//     para que el frontend reabra la venta en una factura y se cobre de
//     nuevo por el total correcto.
//
// Si el pago llegó justo antes (la intención ya está APROBADA), no se
// cancela nada y se devuelve ErrQRIntentNotPending: la venta ya se cerró.

// EditPendingItem es una línea del carrito devuelta al frontend.
type EditPendingItem struct {
	Barcode   string  `json:"barcode"`
	Quantity  float64 `json:"quantity"`
	UnitPrice float64 `json:"unitPrice"`
	Subtotal  float64 `json:"subtotal"`
}

// EditPendingOutput es la venta reabierta.
type EditPendingOutput struct {
	VentaTempID string            `json:"ventaTempId"`
	AmountCOP   int64             `json:"amountCop"`
	Items       []EditPendingItem `json:"items"`
	ClientDNI   string            `json:"clientDni,omitempty"`
	ClientName  string            `json:"clientName,omitempty"`
	EditSaleID  uint64            `json:"editSaleId,omitempty"`
	// CashAmount, TransferNequi, TransferDaviplata y CreditAmount: otras
	// partes que el cajero ya había cobrado en un pago mixto, para que las
	// vuelva a registrar al cobrar de nuevo.
	CashAmount        float64 `json:"cashAmount,omitempty"`
	TransferNequi     float64 `json:"transferNequi,omitempty"`
	TransferDaviplata float64 `json:"transferDaviplata,omitempty"`
	CreditAmount      float64 `json:"creditAmount,omitempty"`
}

// ErrQRNoSnapshot: la intención no guardó productos (flujo legacy).
var ErrQRNoSnapshot = errors.New("este cobro no tiene productos guardados; vuelva a armar la venta")

// decodeEditPending traduce (puro) los snapshots de la intención.
func decodeEditPending(intent *models.QrPaymentIntent) (*EditPendingOutput, error) {
	if intent == nil || strings.TrimSpace(intent.CartSnapshot) == "" {
		return nil, ErrQRNoSnapshot
	}
	var cart []qrSaleCartItem
	if err := json.Unmarshal([]byte(intent.CartSnapshot), &cart); err != nil || len(cart) == 0 {
		return nil, ErrQRNoSnapshot
	}
	out := &EditPendingOutput{VentaTempID: intent.VentaTempID, AmountCOP: intent.AmountCOP}
	for _, it := range cart {
		if strings.TrimSpace(it.Barcode) == "" || it.Quantity <= 0 {
			continue
		}
		out.Items = append(out.Items, EditPendingItem{
			Barcode: it.Barcode, Quantity: it.Quantity, UnitPrice: it.UnitPrice, Subtotal: it.Subtotal,
		})
	}
	if len(out.Items) == 0 {
		return nil, ErrQRNoSnapshot
	}
	if raw := strings.TrimSpace(intent.ClientSnapshot); raw != "" {
		var c qrSaleClient
		if json.Unmarshal([]byte(raw), &c) == nil {
			dni := strings.TrimSpace(c.DNI)
			if dni != "0" && dni != "0000" {
				out.ClientDNI = dni
			}
			out.ClientName = strings.TrimSpace(c.Name)
		}
	}
	if raw := strings.TrimSpace(intent.TotalsSnapshot); raw != "" {
		var t qrSaleTotals
		if json.Unmarshal([]byte(raw), &t) == nil {
			// Un enlace de pago a venta existente no es un carrito editable.
			if t.LinkPaymentOnly {
				return nil, ErrQRNoSnapshot
			}
			out.EditSaleID = t.EditTargetSaleID
			out.CashAmount = t.CashAmount
			out.TransferNequi = t.TransferNequi
			out.TransferDaviplata = t.TransferDaviplata
			out.CreditAmount = t.CreditAmount
		}
	}
	return out, nil
}

// EditPending cancela el cobro en espera y devuelve su venta para editarla.
func (s *QrPaymentService) EditPending(ctx context.Context, ventaTempID, actorDNI string) (*EditPendingOutput, error) {
	if !models.IsValidQRVentaTempID(ventaTempID) || strings.TrimSpace(actorDNI) == "" {
		return nil, ErrQRInvalidInput
	}
	if s == nil || s.repo == nil {
		return nil, ErrQRInvalidInput
	}
	live, err := s.repo.GetLiveByVentaTempID(ctx, ventaTempID)
	if err != nil {
		// No hay PENDIENTE: o ya se pagó, o venció/canceló.
		return nil, ErrQRIntentNotPending
	}
	// Validar ANTES de cancelar que hay productos que devolver: nunca
	// cancelar un cobro que luego no se pueda reabrir.
	if _, derr := decodeEditPending(live); derr != nil {
		return nil, derr
	}
	if _, err := s.Cancel(ctx, ventaTempID, actorDNI, "editar_venta"); err != nil {
		return nil, err
	}
	// La bandeja de las demás cajas lo retira.
	s.publishTrayFromIntent(live, models.QRTrayKindCancelled, "Cobro reabierto para editar")
	return decodeEditPending(live)
}
