package services

import "math"

// Reglas de precio de venta del POS.
//
// La regla automática histórica del backend empuja a la centena siguiente
// cuando la terminación es 25 o mayor y se conserva sin cambios para precios
// sugeridos y para cualquier valor que no sea una terminación de 50.
//
// La excepción son los precios que el operador fija deliberadamente en una
// terminación de 50 (por ejemplo el huevo a 550). Esos se guardan y se cobran
// exactamente como se fijaron; de lo contrario la venta los inflaría a la
// centena siguiente.

const (
	hundredPesos = 100.0
	fiftyPesos   = 50.0
)

// isHalfHundredPrice indica que el precio termina en 50.
func isHalfHundredPrice(value float64) bool {
	pesos := math.Round(value)
	if pesos <= 0 {
		return false
	}
	return math.Mod(pesos, hundredPesos) == fiftyPesos
}

// normalizeManualSalePrice respeta terminaciones de 50 y mantiene la regla
// automática para el resto de los valores.
func normalizeManualSalePrice(value float64) float64 {
	pesos := math.Round(value)
	if isHalfHundredPrice(pesos) {
		return pesos
	}
	return applyRounding(pesos)
}

// roundSaleLineSubtotal calcula el subtotal cobrado por línea de venta.
func roundSaleLineSubtotal(unitPrice, quantity float64) float64 {
	price := math.Round(unitPrice)
	raw := price * quantity
	if isHalfHundredPrice(price) {
		return math.Round(raw/fiftyPesos) * fiftyPesos
	}
	return applyRounding(raw)
}
