package services

import (
	"fmt"
	"strings"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================================
// Normalización y validación de egresos pagados con Bold QR
//
// Historia:
//
//   - Antes de la migración 028 (2026-10-24) no existía columna física
//     `expenses.bold_qr_amount`. El canal se identificaba sólo por el
//     texto `paymentSource='BOLD_QR'` y las cinco columnas desglosadas
//     quedaban en cero; cualquier intento de mezclar BOLD con otro canal
//     se rechazaba porque no había donde desglosar el pedazo Bold.
//
//   - Con la migración 028 BOLD_QR es un bolsillo físico al mismo nivel
//     que cash_amount, nequi_amount, daviplata_amount, fondo_amount y
//     coins_amount. Un egreso ya puede combinar BOLD + otro canal
//     (p. ej. $200.000 BOLD_QR + $100.000 CAJA) con cada parte
//     descontándose correctamente del bolsillo correspondiente.
//
// Esta función conserva DOS responsabilidades mínimas, puras:
//
//  1. NORMALIZACIÓN del canal Bold "puro": si `paymentSource` identifica
//     BOLD QR por texto SIN separadores de pago mixto ("/"), reescribe
//     el valor a la constante canónica `models.PaymentSourceBoldQR`
//     ("BOLD_QR"). Esto permite que los agregadores SQL agrupen todas
//     las variantes (bold-qr, BOLDQR, bold qr, "BOLD_QR_BRE_B", etc.)
//     bajo la misma clave.
//
//  2. VALIDACIÓN de SUMA: luego de que `parsePaymentSourceAmounts`
//     reparte los seis bolsillos, la suma total debe ser menor o igual al
//     `amount + tax_amount` del egreso más una tolerancia pequeña por
//     redondeos COP (±5). Un payload malicioso o malformado que diga
//     "amount=30000, nequi=20000, bold_qr=20000" exige rechazo antes de
//     tocar la base. Nota: la validación de suma vive en
//     `validateExpenseChannelSum` para no acoplar la normalización con
//     el chequeo numérico, y así poder reutilizarla desde `SettleExpense`
//     y futuros flujos.
// =============================================================================

// validateAndNormalizeBoldQRExpense normaliza `paymentSource` cuando el
// egreso identifica al canal Bold QR "puro" (sin tokens "CAJA: $X").
// Nunca aborta un flujo que no mencione BOLD. Deja de rechazar
// combinaciones: el desglose se guarda en los bolsillos físicos y la
// validación numérica corre después en `validateExpenseChannelSum`.
func validateAndNormalizeBoldQRExpense(expense *models.Expense) error {
	if expense == nil {
		return nil
	}
	src := expense.PaymentSource
	if !models.IsBoldQRPaymentSource(src) {
		return nil
	}
	// Si el texto es un `paymentSource` mixto ("CAJA: $X / BOLD_QR: $Y"
	// o cualquier combinación con '/'), se conserva tal cual: el regex
	// de `parsePaymentSourceAmounts` lo interpreta y pobla cada bolsillo
	// por su cuenta.
	if strings.Contains(src, "/") {
		return nil
	}
	// Bold puro: normalizamos a la constante canónica para que el
	// agregador SQL agrupe todas las variantes bajo la misma clave
	// `UPPER(paymentSource)='BOLD_QR'`.
	expense.PaymentSource = models.PaymentSourceBoldQR
	return nil
}

// validateExpenseChannelSum garantiza que la suma de los seis bolsillos
// no exceda `amount + tax_amount` del egreso más una pequeña tolerancia
// COP. Se llama DESPUÉS de `parsePaymentSourceAmounts` para que el
// desglose por tokens ("NEQUI: $20000 / BOLD_QR: $10000") ya esté
// poblado en las columnas.
//
// Devuelve nil cuando los seis bolsillos están en cero (el egreso vive
// sólo por su texto, p. ej. legacy pre-028) o cuando la suma cuadra.
// Rechaza cuando la suma excede el monto total: eso significa que el
// cliente envió columnas inconsistentes y guardarlas rompería la
// invariante del arqueo.
func validateExpenseChannelSum(expense *models.Expense) error {
	if expense == nil {
		return nil
	}
	// PENDING / PRESTAMO: la plata no salió todavía y los bolsillos no
	// deben haber sido tocados por parsePaymentSourceAmounts. No
	// validamos para no rechazar deudas que esperan abono.
	if strings.EqualFold(expense.Status, "PENDING") || models.IsLoanFundedExpense(expense) {
		return nil
	}
	sum := expense.CashAmount + expense.NequiAmount + expense.DaviplataAmount +
		expense.FondoAmount + expense.CoinsAmount + expense.BoldQrAmount
	if sum == 0 {
		return nil
	}
	total := expense.Amount + expense.TaxAmount
	// Tolerancia alineada con la validación de pagos mixtos en
	// `postgres_product_inventory.BulkReceive` (±5 COP por redondeos).
	const toleranceCOP = 5.0
	if sum-total > toleranceCOP {
		return fmt.Errorf("la suma de canales ($%.0f) excede el monto del egreso ($%.0f)", sum, total)
	}
	return nil
}
