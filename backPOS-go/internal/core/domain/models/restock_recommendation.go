package models

import "math"

// ============================================================================
// RECOMENDACION DE PEDIDO
// ============================================================================
//
// Combina tres señales para decir si conviene pedir un producto:
//
//   1. La ultima recepcion: si acaba de llegar mercancia no tiene sentido pedir.
//   2. Las ventas: la demanda diaria ya viene corregida por dias sin stock.
//   3. La cobertura: stock actual mas lo que ya viene en camino.
//
// Devuelve un texto para el operador y un nivel para pintarlo en pantalla.
// ============================================================================

const (
	RestockLevelUrgent = "urgent" // agotado con demanda
	RestockLevelOrder  = "order"  // conviene pedir
	RestockLevelWait   = "wait"   // ya pedido o recien recibido
	RestockLevelSkip   = "skip"   // no pedir
)

// RestockDecisionInput agrupa lo necesario para decidir sin tocar base de datos.
type RestockDecisionInput struct {
	ABCCategory        string
	CurrentStock       float64
	InTransitQty       float64
	SuggestedOrderQty  float64
	AvgDailySales      float64
	DaysSinceReception *int
	SoldSinceReception float64
}

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

// BuildRestockRecommendation traduce las señales en una recomendación clara.
func BuildRestockRecommendation(input RestockDecisionInput) (string, string) {
	// Ya viene mercancia en camino: no se vuelve a pedir.
	if input.InTransitQty > 0 {
		return "Ya pedido: " + formatQuantity(input.InTransitQty) + " en camino", RestockLevelWait
	}

	// Agotado y con rotacion: es lo mas urgente del listado.
	if input.CurrentStock <= 0 && input.AvgDailySales > 0 {
		return "Pedir urgente: agotado con venta de " + formatQuantity(input.AvgDailySales) + " al día", RestockLevelUrgent
	}

	// Recien recibido y con existencias: la mercancia acaba de entrar.
	if input.DaysSinceReception != nil && *input.DaysSinceReception <= 1 && input.CurrentStock > 0 {
		if *input.DaysSinceReception == 0 {
			return "No pedir: recibido hoy", RestockLevelWait
		}
		return "No pedir: recibido ayer", RestockLevelWait
	}

	// Sin rotacion registrada: pedir seria inmovilizar plata.
	if input.AvgDailySales <= 0 {
		if input.CurrentStock <= 0 {
			return "No pedir: sin ventas registradas", RestockLevelSkip
		}
		return "No pedir: sin rotación y con existencias", RestockLevelSkip
	}

	if input.ABCCategory == "C" {
		return "No pedir: baja rotación (clase C)", RestockLevelSkip
	}

	if input.SuggestedOrderQty <= 0 {
		return "No pedir: cobertura suficiente", RestockLevelSkip
	}

	message := "Pedir " + formatQuantity(input.SuggestedOrderQty)
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
	return message, RestockLevelOrder
}
