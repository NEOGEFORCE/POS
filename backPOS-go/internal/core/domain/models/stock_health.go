package models

import "math"

// ============================================================================
// SEMAFORO DE INVENTARIO — REGLA PERMANENTE DEL DUENO (agosto 2026)
// ============================================================================
//
// La banda del semaforo NO se toca (regla del dueno de agosto 2026):
//
//   minStock <= 0:
//       ROJO   si stock <= 0.
//       UNSET  si stock > 0 (no se juzga contra el minimo).
//   minStock > 0, ratio = stock / minStock:
//       ROJO     si ratio < 0.25.
//       AMARILLO si 0.25 <= ratio < 0.75.
//       VERDE    si ratio >= 0.75.
//
// Estos cortes viven en el paquete models (no en services) para que la
// recomendacion de pedido —que vive en el mismo paquete— pueda consumirlos
// sin crear un ciclo.
//
// ============================================================================
// EL MINIMO ES UNA ALARMA — REGLA DE PEDIDOS (Fase 1, agosto 2026)
// ============================================================================
//
// Sobre la banda del semaforo se apoya la regla de pedidos, pero con un
// umbral DISTINTO: la reposicion apunta a llegar al 75% del minimo (el
// borde inferior de la banda verde). El pedido calculado sale del MAYOR
// entre:
//
//   (a) objetivo:   ceil( max(0, minStock * RestockTargetRatio - available) )
//   (b) demanda:    max(0, idealStock - available)
//
// donde available = currentStock + inTransitQty. Aplica a TODAS las clases
// ABC — Fase 1 elimino el veto historico contra clase C, que dejaba sin
// pedido a productos que si tenian rotacion aunque baja.
//
// El semaforo se conserva porque es lo que muestra la UI. El objetivo de
// reposicion es una constante SEPARADA (RestockTargetRatio) para que un
// cambio operativo en el semaforo no arrastre la regla de pedidos, y
// viceversa.
// ============================================================================

const (
	// StockBandRedRatio es el corte inferior del semaforo:
	// ratio < 0.25 cuenta como ROJO.
	StockBandRedRatio = 0.25
	// StockBandGreenRatio es el corte superior del semaforo:
	// ratio >= 0.75 cuenta como VERDE.
	StockBandGreenRatio = 0.75

	// RestockTargetRatio es el objetivo de reposicion contra el minimo:
	// se pide hasta llegar al 75% del minimo. Es una constante SEPARADA
	// del semaforo (aunque coincida numericamente con el corte verde), a
	// proposito, para que puedan evolucionar por separado sin arrastres
	// silenciosos.
	RestockTargetRatio = 0.75

	// MinMeaningfulOrderQty es el piso de cantidad para que valga la pena
	// meter un producto en el pedido.
	//
	// REGLA DEL DUEÑO (2026-09-04, textual): "si no es necesario no se pide,
	// porque en muchos productos me esta pidiendo que pida de a 1 y si pido de
	// a 1 de muchos productos pues no sirve de nada porque la factura se va a
	// hacer grande y no es la idea, la idea es pedir lo que mas se necesite y
	// lo que mas se venda".
	//
	// Motivo economico: cada linea del pedido cuesta plata y tiempo. Veinte
	// productos pidiendo 1 unidad cada uno inflan la factura sin resolver el
	// abastecimiento de ninguno. Es mejor dejar esa necesidad marginal para el
	// proximo pedido, cuando ya se haya acumulado.
	//
	// EXCEPCION QUE NO SE NEGOCIA: si el producto esta AGOTADO (existencia +
	// transito <= 0) se pide igual, aunque sea 1 unidad. Un agotado es venta
	// perdida y estante vacio; ahi el criterio de "factura grande" no aplica.
	//
	// Es un piso de RECOMENDACION, no un limite de captura: el dueño siempre
	// puede escribir a mano la cantidad que quiera en la tarjeta.
	MinMeaningfulOrderQty = 3.0
)

// Nombres serializados al frontend en el campo stockBand del JSON.
const (
	StockBandRed    = "RED"
	StockBandYellow = "YELLOW"
	StockBandGreen  = "GREEN"
	// StockBandUnset se emite solo cuando no hay minimo configurado y hay
	// stock positivo: el producto no se puede juzgar contra un minimo que
	// no existe. Los consumidores del semaforo lo tratan como VERDE.
	StockBandUnset = "UNSET"
)

// Motivos de la sugerencia de cambio de minimo. El sistema SUGIERE; el
// dueno APLICA. Ninguna ruta automatica escribe minStock (regla vigilada
// por TestNoAutoWriteToMinStock).
const (
	MinStockSuggestionIncrease = "increase" // idealStock > minStock*1.25
	MinStockSuggestionDecrease = "decrease" // idealStock < minStock*0.5
	MinStockSuggestionNone     = ""         // el minimo esta bien puesto
)

// ClassifyStockBand aplica la regla permanente del dueno y devuelve la banda
// del semaforo para el par (stock, minStock).
//
// El input es float64 porque el POS acepta cantidades decimales (peso,
// fracciones). Los umbrales son ratios exactos, no cifras enteras.
func ClassifyStockBand(stock, minStock float64) string {
	if minStock <= 0 {
		if stock <= 0 {
			return StockBandRed
		}
		return StockBandUnset
	}
	ratio := stock / minStock
	if ratio < StockBandRedRatio {
		return StockBandRed
	}
	if ratio < StockBandGreenRatio {
		return StockBandYellow
	}
	return StockBandGreen
}

// TargetShortfall devuelve cuanto falta para que la existencia+transito
// llegue al objetivo de reposicion (RestockTargetRatio del minimo).
//
// Es el motor del pedido por objetivo introducido en Fase 1 (agosto 2026):
//
//   - Aplica en las bandas ROJA y AMARILLA (donde el ratio contra el minimo
//     esta debajo de 0.75).
//   - En banda VERDE naturalmente devuelve 0 porque available >= 75% del
//     minimo. Se aprovecha esa aritmetica para no repetir la condicion de
//     banda; el numero manda.
//   - Redondea hacia arriba: no se pueden pedir 2.5 unidades reales y el
//     operador esperaria un entero.
//   - Devuelve 0 cuando no hay minimo configurado. En ese caso la regla de
//     pedidos degrada limpio al bloque por demanda.
func TargetShortfall(minStock, currentStock, inTransitQty float64) float64 {
	if minStock <= 0 {
		return 0
	}
	target := minStock * RestockTargetRatio
	missing := target - (currentStock + inTransitQty)
	if missing <= 0 {
		return 0
	}
	return math.Ceil(missing)
}

// RedFloorShortfall se conserva por retrocompatibilidad con callers que
// exponen "cuanto falta para salir de la banda ROJA" como metrica propia
// (heuristica de alta rotacion en InventoryService, fallback de Telegram
// en cron_jobs). No es lo mismo que TargetShortfall: apunta al 25% del
// minimo, no al 75%, y solo dispara cuando la banda actual es ROJA.
//
// La regla NUEVA de pedidos usa TargetShortfall, no RedFloorShortfall.
// Este helper queda como valor de referencia informativo para las alertas.
func RedFloorShortfall(minStock, currentStock, inTransitQty float64) float64 {
	if minStock <= 0 {
		return 0
	}
	if ClassifyStockBand(currentStock, minStock) != StockBandRed {
		return 0
	}
	target := minStock * StockBandRedRatio
	missing := target - (currentStock + inTransitQty)
	if missing <= 0 {
		return 0
	}
	return math.Ceil(missing)
}

// SuggestMinStockChange propone un minimo mas realista para revision manual.
//
// OJO CON QUE IDEAL SE LE PASA (regla del dueno, 2026-09-05):
//
//	"lo de la recomendacion de bajar o subir el stock minimo, ya es para
//	 productos que lleven mucho mucho tiempo sin vender lo que dice el stock
//	 minimo"
//
// Desde que la demanda de pedidos pasa a apoyarse en los ULTIMOS 14 DIAS, esta
// funcion NO puede recibir ese ideal reciente: dos semanas flojas —una feria, un
// puente, el producto agotado— alcanzarian para proponer bajar un minimo que
// esta bien puesto. Cambiar un minimo es una decision estructural y necesita
// evidencia larga.
//
// Por eso el llamador debe pasarle un ideal calculado con la ventana de 90 dias
// (ver longTermIdealStock en el repositorio). El pedido reacciona rapido; el
// minimo se mueve despacio. Son dos preguntas distintas y a proposito usan
// ventanas distintas.
//
// Reglas dictadas por el dueno (agosto 2026):
//
//   - Subir cuando el ideal es materialmente mayor que el minimo actual
//     (idealStock > minStock * 1.25). El valor sugerido es ceil(idealStock).
//     Reason = MinStockSuggestionIncrease.
//   - Bajar cuando el ideal es materialmente menor que el minimo actual
//     (idealStock < minStock * 0.5). El valor sugerido es max(1, ceil(ideal))
//     — un cero no ayuda al operador. Reason = MinStockSuggestionDecrease.
//   - Entre bandas (0.5 * minStock <= ideal <= 1.25 * minStock) no hay
//     sugerencia: el minimo actual es coherente con la venta.
//   - Sin minimo configurado (minStock <= 0) con demanda real
//     (idealStock > 0): sugerir subir a ceil(idealStock). El operador
//     tiene un producto con rotacion pero sin alarma.
//   - Sin minimo y sin demanda: no sugerir.
//
// El sistema SUGIERE, NUNCA aplica: la escritura a products.minStock esta
// vigilada por TestNoAutoWriteToMinStock.
func SuggestMinStockChange(idealStock, minStock float64) (float64, string) {
	if minStock <= 0 {
		if idealStock > 0 {
			return math.Ceil(idealStock), MinStockSuggestionIncrease
		}
		return 0, MinStockSuggestionNone
	}
	// Subir: el ideal esta 25%+ por encima del minimo.
	if idealStock > minStock*1.25 {
		return math.Ceil(idealStock), MinStockSuggestionIncrease
	}
	// Bajar: el ideal esta debajo de la mitad del minimo.
	if idealStock < minStock*0.5 {
		suggestion := math.Ceil(idealStock)
		if suggestion < 1 {
			suggestion = 1
		}
		return suggestion, MinStockSuggestionDecrease
	}
	return 0, MinStockSuggestionNone
}

// SuggestedMinStock se conserva para callers historicos que solo necesitan
// el numero (sin la razon). Devuelve 0 cuando no hay sugerencia.
//
// Nuevas rutas deberian usar SuggestMinStockChange para exponer el motivo
// al frontend.
func SuggestedMinStock(idealStock, minStock float64) float64 {
	value, _ := SuggestMinStockChange(idealStock, minStock)
	return value
}
