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
// POR QUÉ VIVE EN TEXTO Y EN COLUMNA
// ----------------------------------------------------------------------------
// La migración 028 (2026-10-24) agregó `expenses.bold_qr_amount DECIMAL(10,2)
// NOT NULL DEFAULT 0`. Antes de esa fecha el canal se identificaba sólo por
// texto en `paymentSource` y los egresos mixtos BOLD + otro canal no se
// podían desglosar. Ahora el canal convive como texto (para preservar la
// identificación del medio de pago y los agregadores legacy sobre
// `paymentSource`) y como columna física al mismo nivel que
// `cash_amount`, `nequi_amount`, `daviplata_amount`, `fondo_amount` y
// `coins_amount`:
//
//   - Egresos puros BOLD_QR  → `bold_qr_amount = amount`, demás bolsillos
//                              en cero, `paymentSource='BOLD_QR'`. Los
//                              agregadores suman `SUM(bold_qr_amount)` a
//                              la clave "BOLD_QR"; la rama legacy por
//                              texto queda únicamente para filas pre-028
//                              que todavía no hayan sido tocadas por el
//                              backfill o por un UPDATE.
//   - Egresos mixtos         → cada bolsillo guarda su parte y
//                              `paymentSource` lleva el string
//                              concatenado "CAJA: $X / BOLD_QR: $Y" para
//                              trazabilidad y para que `parseExpenseChannelsFull`
//                              siga reconstruyendo el reparto cuando se
//                              consulta un egreso heredado.

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
