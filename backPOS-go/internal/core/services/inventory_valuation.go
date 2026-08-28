package services

import (
	"fmt"
	"time"
)

// =============================================================
// inventory_valuation.go — Valor de la mercancía del local al inicio y
// al final del período (a precio de costo).
//
// La tabla products solo guarda el stock ACTUAL. El valor histórico se
// reconstruye con el libro de movimientos (stock_movements), que registra
// cada entrada y salida con su fecha:
//
//	valor_en_fecha_T = valor_actual
//	                 + (salidas posteriores a T)  * costo
//	                 - (entradas posteriores a T) * costo
//
// Ambas fotos se valoran al costo de compra ACTUAL del producto, porque
// stock_movements no guarda el costo histórico de cada movimiento. Esto
// hace comparables las dos fechas (misma vara de medir) y aísla el efecto
// de la cantidad de mercancía, que es lo que interesa al dueño.
// =============================================================

// InventoryValuation es la comparación del inventario entre dos fechas.
type InventoryValuation struct {
	Opening float64 `json:"opening"` // valor al inicio del período
	Closing float64 `json:"closing"` // valor al final del período
	Delta   float64 `json:"delta"`   // Closing - Opening
	Live    float64 `json:"live"`    // valor actual (referencia)
	HasData bool    `json:"hasData"`
}

// GetInventoryValuation reconstruye el valor del inventario al inicio y
// al final del período indicado.
func (s *ExportService) GetInventoryValuation(from, to time.Time) (*InventoryValuation, error) {
	v := &InventoryValuation{}

	// Valor actual de la mercancía en estantes y bodega.
	s.db.Table("products").
		Where(`deleted_at IS NULL`).
		Select(`COALESCE(SUM(quantity * "purchasePrice"), 0)`).
		Scan(&v.Live)

	// Ajuste para retroceder hasta una fecha: se revierten los
	// movimientos posteriores (las entradas se restan, las salidas se suman).
	rewindTo := func(t time.Time) float64 {
		var adj float64
		s.db.Table("stock_movements AS m").
			Joins(`JOIN products p ON p.barcode = m.barcode`).
			Where(`m.date > ?`, t).
			Where(`p.deleted_at IS NULL`).
			Select(`COALESCE(SUM(
				CASE WHEN UPPER(m.type) = 'IN' THEN -m.quantity ELSE m.quantity END
				* p."purchasePrice"), 0)`).
			Scan(&adj)
		return adj
	}

	v.Closing = v.Live + rewindTo(to)
	v.Opening = v.Live + rewindTo(from)
	if v.Closing < 0 {
		v.Closing = 0
	}
	if v.Opening < 0 {
		v.Opening = 0
	}
	v.Delta = v.Closing - v.Opening
	v.HasData = v.Live > 0 || v.Opening > 0 || v.Closing > 0
	return v, nil
}

// formatSpanishDate devuelve "1 de julio de 2026". La librería estándar
// de Go no localiza fechas ("enero" no es un token de layout válido), así
// que el nombre del mes se toma de spanishMonths (ai_bot_service.go).
func formatSpanishDate(t time.Time) string {
	return fmt.Sprintf("%d de %s de %d", t.Day(), spanishMonths[int(t.Month())-1], t.Year())
}

// InventoryNarrative redacta la comparación en lenguaje humano.
func InventoryNarrative(from, to time.Time, opening, closing float64) string {
	base := fmt.Sprintf(
		"Al %s iniciamos con %s en mercancía y al %s finalizamos con %s.",
		formatSpanishDate(from), fmtCOP(opening),
		formatSpanishDate(to), fmtCOP(closing),
	)
	delta := closing - opening
	switch {
	case delta > 0:
		return base + fmt.Sprintf(
			" Hay %s más en mercancía dentro del local, lo que representa ganancia del mes reinvertida en producto.",
			fmtCOP(delta))
	case delta < 0:
		return base + fmt.Sprintf(
			" Hay %s menos en mercancía: se vendió más de lo que se surtió, así que esa parte de la plata salió del estante hacia la caja.",
			fmtCOP(-delta))
	default:
		return base + " El surtido del local quedó igual que al empezar el mes."
	}
}
