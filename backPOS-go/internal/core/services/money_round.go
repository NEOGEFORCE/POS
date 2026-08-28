package services

import "math"

// ============================================================================
// REDONDEO A PESOS COLOMBIANOS
// ============================================================================
//
// El sistema opera en COP y no maneja centavos, pero los totales se acumulan en
// float64 sobre miles de operaciones. Eso hacía que el dashboard mostrara cosas
// como $35.890.820,78 y que dos cifras que deberían ser iguales difirieran en
// fracciones invisibles.
//
// Se redondea explícitamente campo por campo. Se descartó hacerlo por reflexión
// porque el DashboardOverview contiene structs de terceros (time.Time,
// models.Expense) con campos no exportados, y escribir sobre ellos por
// reflexión provoca panic en tiempo de ejecución.
//
// Si se agrega un campo monetario nuevo al overview, agregarlo también acá.
// ============================================================================

func cop(v float64) float64 { return math.Round(v) }

func roundMoneyMap(m map[string]float64) {
	for k, v := range m {
		m[k] = math.Round(v)
	}
}

func roundOverviewMoney(r *DashboardOverview) {
	if r == nil {
		return
	}

	r.TotalSalesAmount = cop(r.TotalSalesAmount)
	r.TotalExpensesAmount = cop(r.TotalExpensesAmount)
	r.Profit = cop(r.Profit)
	r.TodaySalesAmount = cop(r.TodaySalesAmount)
	r.ShiftSalesAmount = cop(r.ShiftSalesAmount)
	r.TodayCollectedDebts = cop(r.TodayCollectedDebts)
	r.MonthlyCollectedDebts = cop(r.MonthlyCollectedDebts)

	r.SystemBalance = cop(r.SystemBalance)
	r.ReportedBalance = cop(r.ReportedBalance)
	r.GlobalDifference = cop(r.GlobalDifference)
	r.TotalExpensesPaid = cop(r.TotalExpensesPaid)
	r.TotalCashExpensesPaid = cop(r.TotalCashExpensesPaid)
	r.EstimatedNetProfit = cop(r.EstimatedNetProfit)
	r.InventoryCostValue = cop(r.InventoryCostValue)
	r.InventoryRetailValue = cop(r.InventoryRetailValue)
	r.TodayNetProfit = cop(r.TodayNetProfit)

	r.VaultBalance = cop(r.VaultBalance)
	r.VaultExpenses = cop(r.VaultExpenses)
	r.CoinsSavings = cop(r.CoinsSavings)
	r.BillsBalance = cop(r.BillsBalance)
	r.TotalLiquidity = cop(r.TotalLiquidity)
	r.Coins100 = cop(r.Coins100)
	r.Coins200 = cop(r.Coins200)
	r.Coins500 = cop(r.Coins500)
	r.Coins1000 = cop(r.Coins1000)

	r.GlobalHistoricalExpected = cop(r.GlobalHistoricalExpected)
	r.GlobalHistoricalReal = cop(r.GlobalHistoricalReal)
	r.ShiftEfectivoFisico = cop(r.ShiftEfectivoFisico)
	r.ShiftIngresosDigitales = cop(r.ShiftIngresosDigitales)
	r.ShiftEgresosEfectivo = cop(r.ShiftEgresosEfectivo)
	r.ShiftVentaReal = cop(r.ShiftVentaReal)

	r.RealCashFlow.Cash = cop(r.RealCashFlow.Cash)
	r.RealCashFlow.Nequi = cop(r.RealCashFlow.Nequi)
	r.RealCashFlow.Daviplata = cop(r.RealCashFlow.Daviplata)
	r.TodayCashFlow.Cash = cop(r.TodayCashFlow.Cash)
	r.TodayCashFlow.Nequi = cop(r.TodayCashFlow.Nequi)
	r.TodayCashFlow.Daviplata = cop(r.TodayCashFlow.Daviplata)

	r.PendingDebts.Amount = cop(r.PendingDebts.Amount)
	r.TodayExpenses.Amount = cop(r.TodayExpenses.Amount)

	roundMoneyMap(r.SalesByDay)
	roundMoneyMap(r.TodaySalesByMethod)
	roundMoneyMap(r.ShiftSalesByMethod)
	roundMoneyMap(r.SalesByPayment)

	for i := range r.DailySalesLast7 {
		r.DailySalesLast7[i].Amount = cop(r.DailySalesLast7[i].Amount)
	}

	// Monthly lleva los mapas del gráfico de análisis comparativo, que era donde
	// se veían los centavos ($35.890.820,78 en ventas de agosto).
	for _, v := range r.Monthly {
		if m, ok := v.(map[string]float64); ok {
			roundMoneyMap(m)
		}
	}
}
