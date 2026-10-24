package services

import (
	"errors"
	"strings"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================================
// Normalización y validación de egresos pagados con Bold QR (B4, 2026-10-23)
// =============================================================================
//
// REGLA
//
// Bold QR / Bre-B es un canal digital con una particularidad: NO EXISTE una
// columna física para desglosarlo en la tabla `expenses` (`bold_qr_amount`
// requeriría migración de esquema). Para que los agregadores SQL legacy
// (postgres_expense_repository.go, que agrupa por UPPER(paymentSource))
// puedan presentar la plata bajo la clave "BOLD_QR", el canal se identifica
// por texto en el campo `paymentSource` y las cinco columnas desglosadas
// (cash/nequi/davi/fondo/coins) quedan en cero.
//
// Por eso un egreso Bold QR MIXTO con otro canal es imposible desde el
// esquema actual: si llegara un payload con, p.ej., `paymentSource="BOLD_QR"`
// y `cashAmount=50000`, el agregador agruparía los 50 mil bajo EFECTIVO (por
// las columnas) y además bajo BOLD_QR (por el texto): doble conteo.
//
// Esta función pura centraliza la regla:
//
//   1. Si el PaymentSource NO menciona BOLD, no toca nada.
//   2. Si el PaymentSource es Bold QR puro (variantes "BOLD_QR", "BOLDQR",
//      "BOLD-QR", "BOLD QR", "bold_qr", etc.), lo normaliza a la constante
//      canónica `models.PaymentSourceBoldQR` para que el agregador SQL
//      agrupe todo bajo la misma clave sin importar casing/espacios.
//   3. Si el PaymentSource combina BOLD con otros canales (string
//      concatenado con '/' o cualquier columna desglosada > 0), RECHAZA
//      con un error en español legible por humano.
//
// AMBITO
//
// La función se llama ANTES de parsePaymentSourceAmounts tanto en el alta
// como en la edición de egresos y en el abono (SettleExpense). Un
// PaymentSource puede combinarse con otros canales legalmente para
// EFECTIVO/NEQUI/DAVIPLATA/FONDO/MONEDAS (regex "CAJA: $X / NEQUI: $Y"),
// pero NUNCA con BOLD mientras no exista la columna física.

// errBoldQrNoCombinable es el mensaje normalizado que lanza la validación.
// Variable exportada por si otro módulo necesita comparar con errors.Is
// (hoy el único consumidor es ExpenseService).
var errBoldQrNoCombinable = errors.New("Bold QR no se puede combinar con otros medios de pago")

// validateAndNormalizeBoldQRExpense aplica la regla descrita arriba sobre
// `expense` IN-PLACE. Devuelve `nil` cuando no se detecta un canal BOLD o
// cuando el egreso ya cumple la regla; devuelve `errBoldQrNoCombinable`
// cuando el egreso es mixto con BOLD. Nunca aborta un flujo que no tenga
// marca de BOLD.
func validateAndNormalizeBoldQRExpense(expense *models.Expense) error {
	if expense == nil {
		return nil
	}
	src := expense.PaymentSource
	if !models.IsBoldQRPaymentSource(src) {
		// No hay marca de Bold QR en el PaymentSource: no es asunto
		// de esta función (p.ej. "CAJA", "NEQUI: $X / CAJA: $Y").
		return nil
	}

	// Combinado por texto: "BOLD_QR / CAJA: $X" o similares. La
	// presencia de un '/' en un source que contiene BOLD basta como
	// señal de mezcla.
	if strings.Contains(src, "/") {
		return errBoldQrNoCombinable
	}

	// Combinado por columnas desglosadas: si llegó algún otro bolsillo
	// > 0 junto a la marca BOLD, es mezcla. Como no hay columna física
	// para BOLD_QR, aquí NO verificamos BoldQrAmount (es `gorm:"-"` y
	// se puebla en runtime, no se persiste).
	if expense.CashAmount > 0 || expense.NequiAmount > 0 ||
		expense.DaviplataAmount > 0 || expense.FondoAmount > 0 ||
		expense.CoinsAmount > 0 {
		return errBoldQrNoCombinable
	}

	// Bold QR puro: normalizamos el PaymentSource a la constante
	// canónica para que el agregador SQL agrupe todas las variantes
	// bajo la misma clave UPPER(paymentSource)="BOLD_QR".
	expense.PaymentSource = models.PaymentSourceBoldQR
	return nil
}
