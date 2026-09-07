package models

import "math"

// ============================================================================
// EMPAQUE APRENDIDO: PRODUCTOS QUE SOLO SE PIDEN POR CAJA
// ============================================================================
//
// Regla del dueño (2026-09-05), textual:
//
//	"hay productos que no los puedo pedir por unidad, si no con una cantidad
//	 establecida digamos que en unas cuchillas llegan de a 12... esto lo tiene
//	 que tomar de cuando se registra la recepcion de pedidos"
//	"deberia ser como una memoria, si siempre pongo x cantidad y los registros
//	 siempre tienen esa cantidad pues ya se guarda y el sistema aprende"
//
// COMO SE APRENDE: por REPETICION, no por divisor comun.
//
// Se mira el historial de recepciones del producto y se busca la cantidad que
// MAS SE REPITE. Si esa cantidad domina el historial, es el empaque.
//
// Se descarto el maximo comun divisor a proposito: con recepciones de 12, 18 y 6
// el MCD da 6, pero eso no significa que el proveedor venda cajas de 6 — pueden
// ser tres pedidos sueltos distintos. La repeticion es evidencia de que el
// proveedor SIEMPRE entrega esa cantidad, que es justo lo que el dueño describio.
//
// PARA QUE SIRVE: un producto con empaque de 12 no puede sugerir "pedir 1". Se
// redondea hacia arriba al multiplo, asi que cuando el stock baja lo suficiente
// se pide la caja completa. Esto ademas resuelve por si solo la queja de "muchos
// productos me dicen pedir 1".

const (
	// PackLearnMinReceptions son las recepciones necesarias para creerle al
	// historial. Con dos coincidencias podria ser casualidad; con tres ya hay
	// patron.
	PackLearnMinReceptions = 3

	// PackLearnDominanceRatio es la proporcion del historial que debe tener la
	// cantidad repetida para aceptarla como empaque. Con 0.6 se tolera alguna
	// recepcion suelta (un faltante, un ajuste) sin perder el patron, pero no se
	// acepta un empaque cuando las cantidades son mayormente distintas.
	PackLearnDominanceRatio = 0.6
)

// ReceptionQuantityCount es una cantidad recibida y cuantas veces se repitio.
// Viene agrupada desde la base para no traer el historial entero.
type ReceptionQuantityCount struct {
	Quantity float64
	Times    int
}

// LearnPackSize deduce el tamaño de empaque a partir del historial de
// recepciones agrupado por cantidad.
//
// Devuelve 0 cuando NO hay evidencia suficiente, y 0 significa "se pide por
// unidad". Es deliberadamente conservador: equivocarse inventando un empaque
// obliga al dueño a pedir mas de lo que necesita, lo cual es peor que no tener
// la funcion.
//
// Reglas:
//   - Se ignoran cantidades <= 1: un empaque de 1 es lo mismo que no tener
//     empaque, y las recepciones de 1 suelen ser ajustes o faltantes.
//   - Se exige un minimo de PackLearnMinReceptions recepciones en total.
//   - La cantidad mas repetida debe cubrir al menos PackLearnDominanceRatio del
//     total de recepciones consideradas.
//   - Ante empate en repeticiones gana la cantidad MAYOR: si el proveedor
//     entrega 12 y 24 con la misma frecuencia, 24 es multiplo de 12 y pedir en
//     multiplos de 12 sigue siendo valido, pero elegir el mayor evita proponer
//     medias cajas cuando el empaque real es el grande.
func LearnPackSize(history []ReceptionQuantityCount) float64 {
	total := 0
	bestQty := 0.0
	bestTimes := 0
	smallest := 0.0
	smallestTimes := 0
	candidates := make([]float64, 0, len(history))

	for _, entry := range history {
		if entry.Quantity <= 1 || entry.Times <= 0 {
			continue
		}
		// Solo cantidades enteras: media unidad no es un empaque.
		if entry.Quantity != math.Trunc(entry.Quantity) {
			continue
		}
		total += entry.Times
		candidates = append(candidates, entry.Quantity)
		if smallest == 0 || entry.Quantity < smallest {
			smallest = entry.Quantity
			smallestTimes = entry.Times
		}
		if entry.Times > bestTimes || (entry.Times == bestTimes && entry.Quantity > bestQty) {
			bestTimes = entry.Times
			bestQty = entry.Quantity
		}
	}

	if total < PackLearnMinReceptions || bestTimes == 0 {
		return 0
	}

	// CASO CAJAS MULTIPLES: si todas las cantidades recibidas son multiplos de la
	// mas chica Y esa mas chica SE REPITIO, el empaque es la mas chica y las
	// otras son varias cajas. Ejemplo real: un proveedor que entrega 12 y 24
	// vende cajas de 12; pedir en multiplos de 12 es correcto en los dos casos.
	//
	// LA REPETICION ES IMPRESCINDIBLE. Sin ese requisito esta rama degenera en el
	// maximo comun divisor, que es justo lo que se quiere evitar: con recepciones
	// de 12, 18 y 6 una sola vez cada una, el MCD daria 6 y se inventaria un
	// empaque que nadie confirmo. La evidencia de que 6 es una caja es que el
	// proveedor haya entregado 6 mas de una vez.
	//
	// Se evalua antes de la dominancia porque con 12 y 24 las repeticiones se
	// reparten y ninguna sola alcanzaria el umbral, aunque el patron sea claro.
	if smallest > 1 && smallestTimes >= 2 {
		todosMultiplos := true
		for _, qty := range candidates {
			if math.Mod(qty, smallest) != 0 {
				todosMultiplos = false
				break
			}
		}
		if todosMultiplos {
			return smallest
		}
	}

	// CASO CANTIDAD DOMINANTE: una sola cantidad se repite lo suficiente.
	if float64(bestTimes)/float64(total) < PackLearnDominanceRatio {
		return 0
	}
	return bestQty
}

// PackOrderQuantity decide cuanto pedir de un producto que solo llega en cajas.
//
// REGLA DEL DUEÑO (2026-09-05), textual:
//
//	"no me gusta porque quedariamos con mucho producto de uno y faltando el otro,
//	 entonces es mejor que si llega a 3 o menos ahi si pedir porque los productos
//	 normalmente llegan entre 1 y 2 dias entonces esos 3 aguantan y ya cuando
//	 lleguen quedamos en 15"
//
// Se pide UNA CAJA COMPLETA, pero SOLO cuando el stock cae al umbral ROJO (25%
// del minimo). Con minimo 12 eso es 3: dispara en 3 y queda en 15.
//
// EL MOTIVO ES DE FLUJO DE CAJA, NO DE INVENTARIO. Comprar por caja siempre deja
// el stock por encima del minimo, asi que adelantar la compra no ahorra nada:
// solo inmoviliza plata que otro producto puede estar necesitando. Como el
// proveedor repone en 1-2 dias, 3 unidades aguantan hasta que llegue.
//
// El objetivo del 75% (RestockTargetRatio) se conserva para los productos que se
// piden POR UNIDAD, donde pedir menos si ahorra plata.
//
// Detalles:
//   - Lo que viene EN CAMINO cuenta como disponible: no se pide otra caja si ya
//     hay una en transito.
//   - Sin minimo configurado no hay umbral rojo que medir, asi que manda la
//     demanda. Un producto sin minimo pero con rotacion no puede quedar sin
//     pedirse.
//   - Si no hace falta nada, no se pide caja.
func PackOrderQuantity(idealStock, currentStock, inTransitQty, minStock, packSize float64) float64 {
	if packSize <= 1 {
		return 0
	}
	disponible := currentStock + inTransitQty

	if minStock > 0 {
		// Disparador: solo en banda ROJA (stock <= 25% del minimo).
		if disponible > minStock*StockBandRedRatio {
			return 0
		}
		// En rojo se pide al menos una caja. Si la necesidad real es mayor
		// (minimo grande con caja chica) se piden las cajas que hagan falta.
		necesidad := RawOrderNeed(idealStock, currentStock, inTransitQty, minStock)
		if necesidad < packSize {
			necesidad = packSize
		}
		return RoundToPackSize(necesidad, packSize)
	}

	// Sin minimo: manda la demanda.
	return RoundToPackSize(RawOrderNeed(idealStock, currentStock, inTransitQty, 0), packSize)
}

// RoundToPackSize lleva una cantidad a pedir al siguiente multiplo del empaque.
//
// Es lo que impide que un producto que llega de a 12 sugiera "pedir 1": si hace
// falta 1, se pide la caja de 12; si hacen falta 13, se piden 24.
//
//   - packSize <= 1 (sin empaque conocido) devuelve la cantidad tal cual.
//   - quantity <= 0 devuelve 0: si no hace falta nada, no se pide una caja.
func RoundToPackSize(quantity, packSize float64) float64 {
	if packSize <= 1 || quantity <= 0 {
		return math.Max(0, quantity)
	}
	return math.Ceil(quantity/packSize) * packSize
}
