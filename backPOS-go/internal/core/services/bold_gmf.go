package services

import "math"

// =============================================================================
// 4×1000 (GMF) de Bold sobre los egresos
// =============================================================================
//
// Bold cobra el Gravamen a los Movimientos Financieros (4 por mil = 0,4 %)
// sobre cada pago o transferencia que SALE de la cuenta. Los ingresos por QR
// no lo pagan. Por eso, cuando un egreso se paga desde Bold, el saldo real de
// la cuenta baja el monto del egreso MÁS el 4×1000.
//
// No hay columna para el GMF (sin migración): se deriva del monto pagado por
// Bold en cada egreso. Sólo afecta los SALDOS de Bold (dashboard, flujo del
// día y reporte del turno); el monto del egreso registrado no cambia.

// BoldGMFRate es la tarifa del 4×1000.
const BoldGMFRate = 0.004

// BoldGMF devuelve el 4×1000 de un egreso pagado por Bold, redondeado a
// centavos como lo muestra la cuenta Bold. Montos <= 0 no generan GMF.
func BoldGMF(amount float64) float64 {
	if amount <= 0 {
		return 0
	}
	return math.Round(amount*BoldGMFRate*100) / 100
}

// WithBoldGMF devuelve lo que realmente sale de la cuenta Bold por un egreso:
// el monto más su 4×1000.
func WithBoldGMF(amount float64) float64 {
	return amount + BoldGMF(amount)
}

// withBoldGMFBucket devuelve una copia del mapa de egresos por canal donde
// BOLD_QR incluye el 4×1000. No muta el original (lo usan otros cálculos).
func withBoldGMFBucket(buckets map[string]float64) map[string]float64 {
	out := make(map[string]float64, len(buckets))
	for k, v := range buckets {
		out[k] = v
	}
	out["BOLD_QR"] = WithBoldGMF(out["BOLD_QR"])
	return out
}
