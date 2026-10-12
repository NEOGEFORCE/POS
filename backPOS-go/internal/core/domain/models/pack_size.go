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
// FUENTE UNICA: stock_movements con reason='RECEPTION'. No se mira
// confirmed_order_items (pedidos confirmados pueden no reflejar lo que llego)
// ni se crea migracion para persistir el empaque. La verdad vive en el
// historial real de recepciones.
//
// EXCLUSIONES al calcular el empaque (en el CTE empaque_aprendido):
//   - RECEPTION_BONUS (bonificaciones) → distinto reason.
//   - PACK_RECEPTION_BULK (actualizacion de pacas) → distinto reason.
//   - PRICE_UPDATE_NO_STOCK (precio sin stock)   → distinto reason.
//   - ADJUSTMENT_UP/DOWN (ajustes de recepcion)  → distinto reason (texto libre).
//   - RETURN / RETURN_REVERT (devoluciones)      → distinto reason.
//   - Productos pesables (isWeighted=TRUE)       → filtrados en SQL.
//   - Cantidades <= 1 (ajustes de un peso)       → filtradas en SQL y Go.
//   - Cantidades fraccionarias (peso real)       → filtradas por LearnPackSize.
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

	// PackReorderRatio es la fraccion del empaque que marca el umbral de
	// reposicion habitual: cuando el stock + transito queda a menos del 20%
	// del tamaño del empaque, se dispara una caja habitual completa.
	//
	// Convive con StockBandRedRatio (25% del minimo configurado) a traves de
	// PackReorderThreshold, que toma el MAYOR entre los dos umbrales. Asi:
	//
	//   - Si el dueno no puso minimo (minStock<=0) manda PackReorderRatio sola:
	//     cuando el stock cae al 20% del empaque, se pide una caja.
	//   - Si el minimo es GRANDE (ej. minStock=100 con empaque de 12) gana el
	//     25% del minimo (25) sobre el 20% del empaque (3): el pedido sale
	//     cuando el stock cae a 25, no cuando llega a 3. Asi el minimo del
	//     dueno no queda ignorado por un empaque chico.
	//   - Si el minimo es CHICO (ej. minStock=4 con empaque de 12) gana el 20%
	//     del empaque (3) sobre el 25% del minimo (1). El habitual no se
	//     dispara en 1 cuando el proveedor entrega 12: pedir casi 2 cajas
	//     tarde cuesta mas que pedir 1 caja temprano.
	PackReorderRatio = 0.20
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

// PackReorderThreshold devuelve el stock (existencia + transito) a partir del
// cual se dispara una reposicion por empaque habitual.
//
// Es el MAYOR entre:
//   - ceil(packSize * PackReorderRatio) → 20% de la caja.
//   - ceil(minStock * StockBandRedRatio) → 25% del minimo configurado.
//
// Convive con el umbral rojo del semaforo: el 25% del minimo sigue siendo la
// senal del dueno de "estamos en apuros"; el 20% del empaque se agrega para
// cubrir el caso en que no hay minimo configurado o es muy chico frente al
// tamaño de la caja. El MAX asegura que ninguna de las dos reglas quede
// anulada por la otra.
//
// Para packSize <= 1 devuelve 0 porque no hay empaque que disparar; en ese caso
// el llamador cae al pedido unitario (SuggestedOrderQty).
func PackReorderThreshold(packSize, minStock float64) float64 {
	if packSize <= 1 {
		return 0
	}
	byPack := math.Ceil(packSize * PackReorderRatio)
	byMin := 0.0
	if minStock > 0 {
		byMin = math.Ceil(minStock * StockBandRedRatio)
	}
	return math.Max(byPack, byMin)
}

// PackOrderQuantity decide cuanto pedir de un producto que solo llega en cajas.
//
// REGLA DEL DUEÑO (actualizada 2026-10), textual del origen (2026-09-05):
//
//	"no me gusta porque quedariamos con mucho producto de uno y faltando el otro,
//	 entonces es mejor que si llega a 3 o menos ahi si pedir porque los productos
//	 normalmente llegan entre 1 y 2 dias entonces esos 3 aguantan y ya cuando
//	 lleguen quedamos en 15"
//
// Se pide UNA CAJA COMPLETA (packSize), nunca el faltante bruto. Cuando se
// dispara, el tamaño del pedido es exactamente el empaque aprendido: con
// cajas de 12 se pide 12. Si la necesidad real supera una caja, el operador
// tiene libertad para subir la cantidad a mano en la tarjeta; el sistema
// sugiere la cantidad habitual.
//
// EL DISPARADOR es PackReorderThreshold: la union del umbral rojo del semaforo
// (25% del minimo configurado) con el 20% del empaque, tomando el MAYOR.
//
//   - Con minStock=12, pack=12 (umbral=max(3,3)=3): se dispara al llegar a 3
//     y queda en 15, exactamente como lo describio el dueno.
//   - Con minStock=100, pack=12 (umbral=max(3,25)=25): se dispara al llegar
//     a 25; se sigue pidiendo UNA caja de 12 porque el flujo de caja manda,
//     aunque el minimo del dueno sea grande. (Ajustar el pedido manual queda
//     a cargo del operador si quiere pedir mas de una caja.)
//   - Con minStock=0, pack=12 (umbral=max(3,0)=3): sin minimo configurado, el
//     20% del empaque es la unica señal; dispara a 3 y pide una caja de 12.
//   - Con minStock=4, pack=12 (umbral=max(3,1)=3): el habitual gana al minimo
//     chico; no se espera a que caiga a 1 para pedir una caja de 12.
//
// EL TRANSITO SE DESCUENTA y BLOQUEA DUPLICADOS: disponible = stock + transito.
// Si una caja ya viene en camino, el disponible supera el umbral y no se pide
// otra. No existe un camino en que se pidan dos cajas por error.
//
// Si packSize <= 1 la funcion devuelve 0: no hay empaque aprendido y el
// llamador debe decidir con SuggestedOrderQty (pedido unitario). Esto conserva
// el comportamiento historico para productos sin caja aprendida.
//
// El parametro idealStock queda por retrocompatibilidad de firma: con empaque
// la cantidad sugerida es siempre una caja, no la demanda bruta. El caller
// consume PackOrderQuantity cuando learnPackSize > 1 y SuggestedOrderQty en
// caso contrario, asi que no hay perdida de informacion.
func PackOrderQuantity(idealStock, currentStock, inTransitQty, minStock, packSize float64) float64 {
	_ = idealStock // Con empaque, el pedido es una caja habitual; la demanda
	//              no infla el tamano del pedido (regla 2026-10).
	if packSize <= 1 {
		return 0
	}
	disponible := currentStock + inTransitQty
	threshold := PackReorderThreshold(packSize, minStock)
	if disponible > threshold {
		return 0
	}
	return packSize
}

// RoundToPackSize lleva una cantidad a pedir al siguiente multiplo del empaque.
//
// Es lo que impide que un producto que llega de a 12 sugiera "pedir 1": si hace
// falta 1, se pide la caja de 12; si hacen falta 13, se piden 24.
//
//   - packSize <= 1 (sin empaque conocido) devuelve la cantidad tal cual.
//   - quantity <= 0 devuelve 0: si no hace falta nada, no se pide una caja.
//
// Se conserva como helper para callers externos (editor de pedidos, ajustes
// manuales); PackOrderQuantity ya no lo usa internamente porque la nueva regla
// sugiere exactamente una caja habitual.
func RoundToPackSize(quantity, packSize float64) float64 {
	if packSize <= 1 || quantity <= 0 {
		return math.Max(0, quantity)
	}
	return math.Ceil(quantity/packSize) * packSize
}
