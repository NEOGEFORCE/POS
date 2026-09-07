package services

// ============================================================================
// VENTA FIJADA EN MESES YA CERRADOS
// ============================================================================
//
// QUÉ ES ESTO
//
// La venta mensual del dashboard se reconstruye sumando los cierres de caja
// (ver GetOverview -> salesByMonth, que usa ComputeClosureMetrics). Este
// archivo permite FIJAR el valor de un mes YA CERRADO en la cifra que el dueño
// auditó y dio por definitiva, en lugar de recalcularlo.
//
// POR QUÉ EXISTE
//
// Decisión del dueño del 2026-08-31. La venta de julio 2026 que salía del
// recálculo estaba inflada, y el dueño dio como definitiva la cifra de
// $49.198.976 que le quedó cerrada del mes.
//
// Se optó por fijar el mes cerrado en vez de cambiar la fórmula porque
// cambiar el cálculo afecta TAMBIÉN al mes en curso, y el dueño pidió
// expresamente no arriesgar los datos del mes que está corriendo.
//
// LA CAUSA DE FONDO SIGUE ABIERTA
//
// Hay un bug identificado y NO arreglado: parseExpenseChannels
// (export_service_consolidated.go) sólo conoce cuatro canales de egreso
// (efectivo, Nequi, Daviplata, fondo) y NO conoce la alcancía. Un egreso
// pagado con monedas llega con CoinsAmount cargado y los otros cuatro en
// cero, así que la suma da cero, cae al caso por defecto y se clasifica como
// EFECTIVO DE CAJA. Y como
//
//	VentasCajero = EfectivoFísico + Digital + EgresosEnEfectivo + Devoluciones
//
// cada egreso pagado con la alcancía se suma a la venta del mes por su valor
// completo. Mientras eso no se arregle, los meses siguientes van a inflarse
// igual y habrá que fijarlos a mano acá, o arreglar la causa.
//
// CÓMO SE QUITA ESTO
//
// Borrar la entrada del mapa (o el archivo entero) y el mes vuelve a
// calcularse solo desde los cierres. No hay ningún dato mutado en la base:
// esto sólo cambia lo que el dashboard MUESTRA, los cierres guardados quedan
// intactos.
//
// LÍMITES QUE ESTE MECANISMO NO CRUZA
//
//  1. Nunca pisa el mes en curso. applyClosedMonthSalesOverrides recibe el mes
//     actual y lo salta, incluso si alguien lo agrega al mapa por error.
//  2. No toca totalSalesAmount (la tarjeta de venta del período), que se
//     alimenta sólo del mes en curso.
//  3. No toca dailySalesMap: el detalle día por día del mes fijado sigue
//     mostrando lo que dicen los cierres. O sea, los días de un mes fijado no
//     necesariamente suman el total fijado. Es deliberado: repartir la cifra
//     entre los días sería inventar datos que nadie auditó.
//  4. No afecta /reports ni el historial de cierres, que siguen leyendo
//     ComputeClosureMetrics directo. Para ese mes el dashboard y el reporte
//     pueden mostrar cifras distintas, y eso es esperable hasta que se
//     arregle la causa de fondo.
//
// ============================================================================

// closedMonthSalesOverride fija la venta de meses cerrados. La clave es el mes
// en formato "2006-01" y el valor son pesos.
//
// Autorizado por el dueño el 2026-08-31.
var closedMonthSalesOverride = map[string]float64{
	// Julio 2026: cifra de cierre dada por el dueño. El recálculo desde los
	// cierres venía inflado por los egresos pagados con la alcancía (ver arriba).
	"2026-07": 49_198_976,
}

// applyClosedMonthSalesOverrides sobreescribe en salesByMonth los meses que el
// dueño fijó a mano, y devuelve la lista de meses efectivamente fijados para
// dejar traza en el log.
//
// currentMonth (formato "2006-01") NUNCA se sobreescribe: el mes en curso
// siempre sale del cálculo real, pase lo que pase con el mapa.
func applyClosedMonthSalesOverrides(salesByMonth map[string]float64, currentMonth string) []string {
	if salesByMonth == nil {
		return nil
	}
	pinned := make([]string, 0, len(closedMonthSalesOverride))
	for month, audited := range closedMonthSalesOverride {
		if month == currentMonth {
			// Candado: el mes en curso se calcula, no se fija.
			continue
		}
		if audited <= 0 {
			continue
		}
		salesByMonth[month] = audited
		pinned = append(pinned, month)
	}
	return pinned
}
