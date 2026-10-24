package models

import "strings"

// =============================================================================
// Bold QR / Bre-B — canal de pago digital propio
// =============================================================================
//
// Las ventas cobradas con el QR Bre-B de Bold se materializan vía el
// dispatcher asíncrono (pos_qr_async_dispatcher.go) con
// `transferSource = "BOLD_QR"` y `paymentMethod = "BOLD_QR"`. Antes del
// 2026-10-23 ese canal no tenía reconocimiento propio en el dashboard ni en
// los egresos: las ventas se diluían dentro de "TRANSFERENCIA" (TotalOtherTransfer
// del cierre) y los egresos pagados por BOLD_QR caían en EFECTIVO por el
// fallback de parsePaymentSourceAmounts.
//
// Este archivo centraliza la detección por texto para que el dashboard, los
// agregadores por canal, el modal del cierre y el PDF compartan la misma
// definición. Mismo patrón que `expense_loan_funded.go`.
//
// POR QUÉ TEXTO Y NO COLUMNA
// ----------------------------------------------------------------------------
// Agregar una columna `expenses.bold_qr_amount` sería ideal para egresos
// mixtos (BOLD_QR + CAJA en el mismo pago), pero exige una migración de
// esquema y el dueño pidió evitarla en este sprint. Por eso se trata como
// texto en `paymentSource`:
//   - Egresos puros BOLD_QR  → cash_amount=0, nequi=0, davi=0, fondo=0,
//                              coins=0, paymentSource='BOLD_QR'. Los
//                              agregadores legacy (GetGlobalPaidExpensesByMethod*)
//                              lo levantan por la rama que agrupa por
//                              UPPER(paymentSource) y lo exponen bajo la
//                              clave "BOLD_QR".
//   - Egresos mixtos         → se admite el prefijo "BOLD_QR: $N" en la
//                              cadena concatenada "CAJA: $X / BOLD_QR: $N"
//                              para el reporte, pero el componente sin
//                              columna propia no se puede agregar en SQL.
//                              Un futuro sprint puede añadir la columna
//                              con una migración 028 aditiva.

// PaymentSourceBoldQR es el valor canónico que viaja en
// `sales.transferSource` y `expenses.paymentSource` cuando el canal es Bold
// QR / Bre-B. Único punto de verdad: cualquier string igual (ignorando
// mayúsculas/espacios) o que contenga esta substring se trata como el
// mismo canal.
const PaymentSourceBoldQR = "BOLD_QR"

// IsBoldQRPaymentSource indica si una cadena identifica al canal Bold QR.
// Acepta "BOLD_QR", "BOLDQR", "BOLD-QR", "BOLD QR" y variantes con espacios.
// También acepta tokens con prefijo "QR_BOLD" por si algún script heredado
// invirtió el orden.
//
// Rechaza una "QR" solitaria sin "BOLD" para no capturar accidentalmente
// descripciones genéricas ("código QR"); el reconocimiento es por marca.
func IsBoldQRPaymentSource(paymentSource string) bool {
	src := strings.ToUpper(strings.TrimSpace(paymentSource))
	if src == "" {
		return false
	}
	// Normaliza separadores comunes para que BOLD-QR / BOLD QR / BOLDQR
	// cuenten como el mismo canal.
	normalized := strings.ReplaceAll(src, "-", "_")
	normalized = strings.ReplaceAll(normalized, " ", "_")
	if normalized == "BOLD_QR" || normalized == "BOLDQR" {
		return true
	}
	// "BOLD" como prefijo o substring: cubre "BOLD_QR_...", "QR_BOLD",
	// "PAGO BOLD", etc.
	return strings.Contains(normalized, "BOLD")
}

// IsBoldQRSaleTransferSource es el mismo helper aplicado al `transferSource`
// que llega desde las ventas. Se expone con nombre distinto para que el
// lector del código entienda a qué columna aplica.
func IsBoldQRSaleTransferSource(transferSource string) bool {
	return IsBoldQRPaymentSource(transferSource)
}
