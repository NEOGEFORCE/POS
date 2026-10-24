package services

import "math"

// =============================================================================
// FLUJO DEL DÍA POR CANAL — contrato del widget "Flujo Hoy" por bolsillo.
// =============================================================================
//
// Problema (B2, 2026-10-23): el widget "Flujo Hoy" muestra UN saldo neto por
// día pero el dueño pide ver ingresos, egresos y saldo POR CANAL (efectivo,
// Nequi, Daviplata y Bold QR) para hacer control de cuadre día a día.
//
// El shape existente `todayCashFlow` (CashFlowSummary) se CONSERVA para no
// romper consumidores actuales; agregamos un campo nuevo
// `todayCashFlowDetail` con tres mapas: ingresos, egresos y saldo neto.
//
// Doble conteo del cálculo actual (reportado al humano, corregido aquí):
//
//   • `GetSalesBreakdownByRange` del repo (postgres_sale_repository.go ~863)
//     YA UNE credit_payments en EFECTIVO y en las transferencias (NEQUI/
//     DAVIPLATA/etc). Es la "foto completa de plata entrada por canal".
//   • `dayCollectedByMethod` del service (dashboard_service.go ~720) RECORRE
//     los MISMOS credit_payments del día y los acumula por método.
//   • La fórmula actual de `TodayCashFlow` sumaba AMBOS, duplicando los
//     abonos del día en cada canal.
//
// Este archivo expone la función pura `BuildTodayCashFlowDetail` que:
//
//   - Toma `salesByMethod` (que YA incluye credit_payments vía
//     GetSalesBreakdownByRange),
//   - Resta devoluciones en efectivo del canal EFECTIVO (misma regla que
//     usa el `TodayCashFlow` canónico), y
//   - Resta egresos del día por canal.
//
// El `balance` es la suma algebraica de los cuatro canales. Todo se redondea
// al peso colombiano (money_round.go) — el sistema no maneja centavos.

// TodayCashFlowDetail es el shape que consume el frontend para pintar los
// tarjetones del widget "Flujo Hoy". Mapa literal con las claves EFECTIVO,
// NEQUI, DAVIPLATA y BOLD_QR (siempre presentes aun con 0).
type TodayCashFlowDetail struct {
	Income  map[string]float64 `json:"income"`
	Expense map[string]float64 `json:"expense"`
	Balance float64            `json:"balance"`
}

// todayCashFlowDetailChannels define las claves canónicas y el ORDEN con el
// que se expone el detalle. Siempre están presentes aun con valor 0 para
// simplificar el consumo del frontend.
var todayCashFlowDetailChannels = [...]string{"EFECTIVO", "NEQUI", "DAVIPLATA", "BOLD_QR"}

// BuildTodayCashFlowDetail construye el detalle "Flujo Hoy por canal" a
// partir de los agregados crudos del dashboard. Es pura: no toca BD, no
// escribe, sólo lee y agrupa.
//
// Parámetros:
//
//   - salesByMethod: mapa normalizado de ventas por método del día. Debe
//     venir de `GetSalesBreakdownByRange` del repo (SSOT que YA UNE
//     credit_payments). Se asumen claves en MAYÚSCULAS.
//   - expensesByMethod: mapa de egresos por canal del día. Debe venir de
//     `ExpenseChannelBuckets` (SSOT que ya aplica exclusiones de PENDING,
//     préstamos y devoluciones). Claves EFECTIVO, NEQUI, DAVIPLATA,
//     BOLD_QR, FONDO, MONEDAS.
//   - cashReturns: devoluciones en efectivo del día (resta del canal
//     EFECTIVO, misma regla que el campo `todayCashFlow.Cash`).
//
// El resultado se redondea al peso. Para evitar `-$0` numéricos cuando una
// diferencia es microscópicamente negativa por acumulación float, el 0
// absoluto se normaliza a +0.
func BuildTodayCashFlowDetail(salesByMethod, expensesByMethod map[string]float64, cashReturns float64) TodayCashFlowDetail {
	income := make(map[string]float64, len(todayCashFlowDetailChannels))
	expense := make(map[string]float64, len(todayCashFlowDetailChannels))

	var balance float64
	for _, ch := range todayCashFlowDetailChannels {
		inc := salesByMethod[ch]
		if ch == "EFECTIVO" {
			// Las devoluciones en efectivo pesan sobre el canal
			// EFECTIVO del ingreso neto, mismo criterio que el campo
			// `todayCashFlow.Cash` canónico.
			inc -= cashReturns
		}
		exp := expensesByMethod[ch]

		incR := math.Round(inc)
		expR := math.Round(exp)
		// Normaliza "-0" a 0 para no exponer el signo negativo al JSON.
		if incR == 0 {
			incR = 0
		}
		if expR == 0 {
			expR = 0
		}
		income[ch] = incR
		expense[ch] = expR
		balance += incR - expR
	}

	balanceR := math.Round(balance)
	if balanceR == 0 {
		balanceR = 0
	}

	return TodayCashFlowDetail{
		Income:  income,
		Expense: expense,
		Balance: balanceR,
	}
}
