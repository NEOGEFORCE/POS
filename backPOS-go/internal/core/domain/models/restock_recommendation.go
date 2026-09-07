package models

import "math"

// ============================================================================
// RECOMENDACION DE PEDIDO — REGLA DE PEDIDOS (Fase 1, agosto 2026)
// ============================================================================
//
// El semaforo sigue igual (25%/75%): el minimo es una alarma visual, no una
// meta. Sobre esa banda, la regla de PEDIDOS se apoya en un objetivo
// SEPARADO (RestockTargetRatio, default 75%) y ya no bloquea la clase C:
//
//   1) Banda del semaforo (contra el minimo, ratio = stock/min):
//        ROJO     ratio < 0.25   (o stock <= 0 sin minimo)
//        AMARILLO 0.25 <= ratio < 0.75
//        VERDE    ratio >= 0.75
//
//   2) Cuanto pedir = MAX de estos dos:
//        (a) POR OBJETIVO: ceil(max(0, minStock*0.75 - available)).
//            Aplica a ROJO y AMARILLO; en VERDE naturalmente da 0.
//        (b) POR DEMANDA:  max(0, idealStock - available). Aplica a TODAS
//            las clases (incluida C).
//      En las dos ramas, lo que viene en camino cuenta como disponible.
//
// La logica canonica vive en stock_health.go (mismo paquete). Este archivo
// se ocupa solo de traducir la decision en un mensaje y un nivel para
// pintar la tarjeta.
// ============================================================================

const (
	RestockLevelUrgent = "urgent" // banda roja: agotado o < 25% del minimo
	RestockLevelOrder  = "order"  // conviene pedir (objetivo o demanda)
	RestockLevelWait   = "wait"   // ya viene mercancia o recien recibido
	RestockLevelSkip   = "skip"   // no pedir
)

// Motivos serializados al frontend (RestockSuggestionResponse.OrderReason)
// para que la UI pueda pintar el "por que" al lado del boton de agregar al
// carrito. Fase 1 introdujo "target" como reemplazo de "red_floor": el
// pedido ya no busca solo salir del rojo sino llegar al 75% del minimo.
const (
	OrderReasonTarget = "target" // se pide para llegar al 75% del minimo
	OrderReasonDemand = "demand" // se pide por demanda hasta la proxima visita
	OrderReasonNone   = "none"   // no se pide

	// OrderReasonRedFloor se conserva como alias historico del motivo
	// "objetivo". Ningun caller nuevo lo emite; se documenta aca para que
	// una integracion vieja no rompa si aparece en logs.
	OrderReasonRedFloor = "red_floor"
)

// RestockDecisionInput agrupa las senales de una fila del sugerido de
// compras. Todos los campos entran ya calculados por el caller; esta
// funcion NO consulta base de datos.
type RestockDecisionInput struct {
	ABCCategory        string
	CurrentStock       float64
	InTransitQty       float64
	SuggestedOrderQty  float64 // autoritativo: si > 0 se pide; si 0 no se pide
	AvgDailySales      float64
	DaysSinceReception *int
	SoldSinceReception float64

	// MinStock es el minimo configurado (products."minStock"). Puede venir
	// en 0 cuando el dueno no lo puso: en ese caso la banda solo emite ROJO
	// si el stock <= 0, y no hay objetivo de reposicion.
	MinStock float64
}

// MinStockShortfall se conserva por retrocompatibilidad con callers historicos
// (batch nocturno, tests). Bajo la Fase 1 ya no se usa como piso del pedido
// (el objetivo es el 75%, no el 100%).
func MinStockShortfall(minStock, currentStock, inTransitQty float64) float64 {
	if minStock <= 0 {
		return 0
	}
	missing := minStock - (currentStock + inTransitQty)
	if missing <= 0 {
		return 0
	}
	return missing
}

// BuildRestockRecommendation traduce las senales en (mensaje, nivel).
//
// La decision autoritativa "se pide o no se pide" YA la tomo el caller a
// traves de SuggestedOrderQty. Este metodo se ocupa de:
//
//   - Elegir el nivel visual (urgent/order/wait/skip) segun la banda.
//   - Elegir un motivo humano y coherente con la banda que pinta la tarjeta.
//     Nunca dice "cobertura suficiente" en un producto en rojo.
//   - Explicar POR QUE se pide (objetivo 75% del minimo, o demanda hasta la
//     proxima visita) o POR QUE no se pide (banda verde, recibido hoy,
//     sin ventas o stock suficiente).
//
// Fase 1 (agosto 2026): la clase C ya no dispara un "No pedir: baja rotacion".
// El motivo real es la cobertura por objetivo/demanda, no la clase.
func BuildRestockRecommendation(input RestockDecisionInput) (string, string) {
	band := ClassifyStockBand(input.CurrentStock, input.MinStock)

	if input.SuggestedOrderQty > 0 {
		return buildOrderMessage(input, band)
	}

	// SuggestedOrderQty == 0. No se pide. La razon debe ser coherente con la
	// banda que ve el operador en la tarjeta.

	if input.InTransitQty > 0 {
		message := "Ya pedido: " + formatQuantity(input.InTransitQty) + " en camino"
		switch band {
		case StockBandRed:
			// Aparente contradiccion: banda roja pero no se pide. Solo pasa
			// cuando el transito ya cubre el objetivo 75%. Se lo decimos al
			// operador para que no piense que la tarjeta miente.
			message += "; cubren el objetivo de reposición"
		case StockBandYellow:
			message += "; alcanzan para cubrir la demanda"
		}
		return message, RestockLevelWait
	}

	// Banda roja sin transito y sin sugerencia: solo puede pasar cuando no
	// hay minimo configurado y el stock es 0 con demanda 0. El caller no
	// sabe cuanto pedir, pero la banda dice que el producto esta agotado.
	if band == StockBandRed {
		if input.AvgDailySales > 0 {
			return "Pedir urgente: agotado con venta de " +
				formatQuantity(input.AvgDailySales) + " al día", RestockLevelUrgent
		}
		return "No pedir: agotado sin ventas registradas", RestockLevelSkip
	}

	// Producto recibido ayer/hoy con stock: dejar pasar un ciclo.
	if input.DaysSinceReception != nil && *input.DaysSinceReception <= 1 && input.CurrentStock > 0 {
		if *input.DaysSinceReception == 0 {
			return "No pedir: recibido hoy", RestockLevelWait
		}
		return "No pedir: recibido ayer", RestockLevelWait
	}

	if input.AvgDailySales <= 0 {
		if input.CurrentStock <= 0 {
			return "No pedir: sin ventas registradas", RestockLevelSkip
		}
		return "No pedir: sin rotación y con existencias", RestockLevelSkip
	}

	// Fase 1 (agosto 2026): la clase C YA NO se veta como "baja rotacion".
	// Si la cobertura por demanda alcanza, se dice por que sin culpar a la
	// clase. Si no alcanza, la sugerencia habria sido > 0 y ya no estariamos
	// en esta rama.

	// Banda amarilla o verde con demanda que YA esta cubierta: el pedido
	// calculado dio 0, la cobertura por demanda alcanza. NO se dice
	// "cobertura suficiente" en rojo porque ese caso ya salio arriba.
	switch band {
	case StockBandGreen:
		return "No pedir: stock en verde", RestockLevelSkip
	case StockBandYellow:
		return "No pedir: stock en amarillo, cobertura por demanda cumplida", RestockLevelSkip
	}
	// Sin minimo, stock positivo, con demanda cubierta.
	return "No pedir: cobertura por demanda cumplida", RestockLevelSkip
}

// buildOrderMessage arma el texto cuando SI se pide. El nivel es urgent para
// banda ROJA (agotado o por debajo del 25% del minimo), order en el resto.
func buildOrderMessage(input RestockDecisionInput, band string) (string, string) {
	qty := input.SuggestedOrderQty
	target := TargetShortfall(input.MinStock, input.CurrentStock, input.InTransitQty)

	// Nivel visual: rojo -> urgente; amarillo/verde -> pedido normal. Si el
	// stock es <= 0 tambien es urgente aunque no haya minimo configurado.
	level := RestockLevelOrder
	if band == StockBandRed || input.CurrentStock <= 0 {
		level = RestockLevelUrgent
	}

	// Rama roja con minimo configurado: hablar del objetivo y del minimo,
	// sin mentir sobre "cobertura suficiente".
	if band == StockBandRed && input.MinStock > 0 {
		return buildRedBandOrderMessage(input, qty, target), level
	}

	// Rama roja sin minimo (agotado seco): mensaje corto y directo.
	if band == StockBandRed {
		message := "Pedir " + formatQuantity(qty) + ": agotado"
		if input.AvgDailySales > 0 {
			message += ", vende " + formatQuantity(input.AvgDailySales) + " al día"
		}
		if input.InTransitQty > 0 {
			message += ", vienen " + formatQuantity(input.InTransitQty) + " en camino"
		}
		return message, level
	}

	// Rama amarilla con objetivo activo o con demanda.
	if band == StockBandYellow && input.MinStock > 0 && target > 0 {
		message := "Pedir " + formatQuantity(qty)
		if qty > target+eps {
			message += ": la demanda hasta la próxima visita pide más que el objetivo del 75%"
		} else {
			message += " para alcanzar el 75% del mínimo (" +
				formatQuantity(input.MinStock) + ")"
		}
		return message, level
	}

	// Rama verde/amarilla por demanda pura (no hay objetivo pendiente).
	message := "Pedir " + formatQuantity(qty)
	if input.DaysSinceReception != nil {
		days := *input.DaysSinceReception
		message += ": última recepción hace " + itoaFloat(int64(days)) + " día"
		if days != 1 {
			message += "s"
		}
		if input.SoldSinceReception > 0 {
			message += " y " + formatQuantity(input.SoldSinceReception) + " vendidas desde entonces"
		}
	} else {
		message += ": sin recepciones registradas"
	}
	return message, level
}

// buildRedBandOrderMessage explica el pedido en rojo. Tiene que decirle la
// verdad al operador: cuanto hay contra el objetivo (75% del minimo), si el
// transito no alcanza, y si la demanda pide por encima del objetivo.
func buildRedBandOrderMessage(input RestockDecisionInput, qty, target float64) string {
	message := "Pedir " + formatQuantity(qty) +
		" para llegar al 75% del mínimo: hay " + formatQuantity(input.CurrentStock) +
		" de mínimo " + formatQuantity(input.MinStock)

	if input.InTransitQty > 0 {
		message += ", vienen " + formatQuantity(input.InTransitQty) + " en camino"
	}

	// Diferenciar los dos motivos: la demanda pesa mas que el objetivo o
	// el objetivo es lo unico que empuja.
	switch {
	case qty > target+eps:
		message += "; la demanda hasta la próxima visita pide más que el objetivo"
	case input.AvgDailySales > 0:
		message += "; vende " + formatQuantity(input.AvgDailySales) + " al día"
	default:
		message += "; sin ventas registradas, pero el mínimo lo exige"
	}
	return message
}

// eps es la tolerancia para comparar floats en las decisiones de mensaje.
// No afecta la logica de cantidades: se usa solo para elegir el texto.
const eps = 1e-9

func formatQuantity(value float64) string {
	rounded := math.Round(value*100) / 100
	if rounded == math.Trunc(rounded) {
		return trimFloat(rounded, 0)
	}
	return trimFloat(rounded, 2)
}

func trimFloat(value float64, decimals int) string {
	if decimals == 0 {
		return itoaFloat(int64(value))
	}
	whole := int64(value)
	fraction := int64(math.Round((value - float64(whole)) * 100))
	if fraction < 0 {
		fraction = -fraction
	}
	text := itoaFloat(whole) + "," + itoaFloat(fraction)
	return text
}

func itoaFloat(value int64) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	if negative {
		return "-" + digits
	}
	return digits
}
