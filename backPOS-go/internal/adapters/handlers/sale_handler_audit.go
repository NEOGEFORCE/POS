package handlers

import (
	"encoding/json"
	"math"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
)

// Este archivo centraliza el formato de la auditoria para los endpoints de
// correccion de medio de pago (admin: UpdatePayment, empleado:
// CorrectPaymentChannel). Antes el admin pasaba `changes="{}"` y la fila de
// auditoria mostraba un cambio critico sin DECIR que cambio. Esto permite
// comparar un dia con otro y resolver reclamos de "esta venta se cobro mal".
//
// Lo que escribimos:
//
//	{"before": {...}, "after": {...}, "deltas": {...}}
//
// Las claves se emiten solo cuando aportan: canales que no cambiaron no
// aparecen en deltas.

// loadPaymentSnapshot captura el estado de canales de pago de la venta tal
// como esta hoy en la BD. Se usa dos veces en UpdatePayment: para capturar
// el "antes" (sin bloquear) y luego para capturar el "despues" ya aplicado.
//
// Si la venta no existe retorna un snapshot vacio: la auditoria dira que
// todos los canales venian en 0, lo que es menos ruidoso que fallar.
func (h *SaleHandler) loadPaymentSnapshot(saleID uint) services.SaleChannelSnapshot {
	sale, err := h.service.GetSale(saleID)
	if err != nil || sale == nil {
		return services.SaleChannelSnapshot{}
	}
	return paymentSnapshotFromSale(sale)
}

func paymentSnapshotFromSale(s *models.Sale) services.SaleChannelSnapshot {
	return services.SaleChannelSnapshot{
		CashAmount:        s.CashAmount,
		TransferAmount:    s.TransferAmount,
		TransferNequi:     s.TransferNequi,
		TransferDaviplata: s.TransferDaviplata,
		TransferSource:    s.TransferSource,
		PaymentMethod:     s.PaymentMethod,
	}
}

// buildPaymentChangesJSON serializa before/after + deltas monetarios de los
// canales que cambiaron. Devuelve "{}" solo si el snapshot anterior y el
// nuevo son iguales (defensivo: si eso pasara, igual queda registrado el
// evento con before/after redundante).
func buildPaymentChangesJSON(before, after services.SaleChannelSnapshot) string {
	payload := map[string]interface{}{
		"before": before,
		"after":  after,
	}
	if deltas := diffPaymentSnapshots(before, after); len(deltas) > 0 {
		payload["deltas"] = deltas
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

// buildPaymentSnapshotJSON es un alias semantico para el flujo de correccion
// por empleado (devuelve exactamente el mismo shape; se mantiene como
// funcion separada porque los dos handlers pueden evolucionar
// independientemente).
func buildPaymentSnapshotJSON(before, after services.SaleChannelSnapshot) string {
	return buildPaymentChangesJSON(before, after)
}

// diffPaymentSnapshots devuelve solo los canales que cambiaron. Tolerancia
// de 1 centavo para evitar ruido por aritmetica de floats.
func diffPaymentSnapshots(a, b services.SaleChannelSnapshot) map[string]float64 {
	out := map[string]float64{}
	addIfChanged := func(name string, before, after float64) {
		if math.Abs(after-before) > 0.01 {
			out[name] = roundToCents(after - before)
		}
	}
	addIfChanged("cashAmount", a.CashAmount, b.CashAmount)
	addIfChanged("transferAmount", a.TransferAmount, b.TransferAmount)
	addIfChanged("transferNequi", a.TransferNequi, b.TransferNequi)
	addIfChanged("transferDaviplata", a.TransferDaviplata, b.TransferDaviplata)
	return out
}

func roundToCents(v float64) float64 {
	return math.Round(v*100) / 100
}
