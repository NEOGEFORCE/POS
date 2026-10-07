package services

import (
	"encoding/json"
	"log"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// closureWindowInputs agrupa la materia prima del arqueo de un cierre
// editado, ya leída para la ventana EFECTIVA (fechas nuevas del DTO o las
// de la fila si no llegaron).
type closureWindowInputs struct {
	Expenses []models.Expense
	Sales    []models.Sale
	Payments []models.CreditPayment
	Returns  []models.Return
}

// closureWindowChanged indica si el DTO movió la ventana del cierre.
func closureWindowChanged(closure *models.CashierClosure, effectiveStart, effectiveEnd time.Time) bool {
	return !closure.StartDate.Equal(effectiveStart) || !closure.EndDate.Equal(effectiveEnd)
}

// forgottenExpenseDate fecha un egreso olvidado dentro de la ventana
// [start, end] del cierre. Parte de closure.Date y la acota a la ventana;
// si la ventana es inválida (cero o invertida) devuelve closure.Date.
func forgottenExpenseDate(closureDate, start, end time.Time) time.Time {
	if start.IsZero() || end.IsZero() || end.Before(start) {
		return closureDate
	}
	if closureDate.Before(start) {
		return start
	}
	if closureDate.After(end) {
		return end
	}
	return closureDate
}

// cashInFromWindow replica la regla de GetCashierClosure para TotalCash:
// efectivo neto (cash - change, nunca negativo) de ventas PAID/CREDIT más
// el efectivo de los abonos de cartera.
func cashInFromWindow(sales []models.Sale, payments []models.CreditPayment) float64 {
	total := 0.0
	for _, sale := range sales {
		status := strings.ToUpper(sale.Status)
		if status != "PAID" && status != "CREDIT" {
			continue
		}
		netCash := sale.CashAmount - sale.Change
		if netCash > 0 {
			total += netCash
		}
	}
	for _, p := range payments {
		total += p.AmountCash
	}
	return total
}

// realSalesFromWindow es la venta registrada del turno (efectivo neto +
// transferencias de ventas PAID/CREDIT + abonos), igual que antes.
func realSalesFromWindow(sales []models.Sale, payments []models.CreditPayment) float64 {
	total := 0.0
	for _, sale := range sales {
		status := strings.ToUpper(sale.Status)
		if status != "PAID" && status != "CREDIT" {
			continue
		}
		netCash := sale.CashAmount - sale.Change
		if netCash < 0 {
			netCash = 0
		}
		transfer := sale.TransferAmount
		if transfer < 0 {
			transfer = 0
		}
		total += netCash + transfer
	}
	for _, p := range payments {
		total += p.TotalPaid
	}
	return total
}

// computeClosureEditUpdates calcula las columnas derivadas de un cierre
// editado. Es una función pura: no toca BD, así que se prueba con
// fixtures en memoria.
//
// Reglas:
//   - Los egresos se toman de `in.Expenses` (leídos DENTRO de la tx, así
//     que incluyen los egresos olvidados recién insertados).
//   - Si la ventana cambió, TotalCash y TotalReturns se recalculan desde
//     las ventas/abonos/devoluciones de la ventana nueva. Si no cambió, se
//     conservan los valores guardados (no se reescribe el histórico por
//     ediciones que solo corrigen el conteo físico).
//   - expected_cash = OpeningCash + TotalCash - EgresosCaja - TotalReturns.
func computeClosureEditUpdates(
	closure *models.CashierClosure,
	effectiveStart, effectiveEnd time.Time,
	physicalCash float64,
	in closureWindowInputs,
) map[string]interface{} {
	updates := map[string]interface{}{}

	expenses := make([]models.Expense, len(in.Expenses))
	copy(expenses, in.Expenses)
	for i := range expenses {
		e := &expenses[i]
		if strings.EqualFold(e.Status, "PENDING") {
			e.CashAmount = 0
			e.NequiAmount = 0
			e.DaviplataAmount = 0
			e.FondoAmount = 0
			e.CoinsAmount = 0
		}
	}
	if err := normalizeClosureExpenses(expenses); err != nil {
		log.Printf("⚠️ No se pudo normalizar los canales de egreso del cierre %d: %v", closure.ID, err)
	}
	if len(expenses) > 0 {
		eb, _ := json.Marshal(expenses)
		updates["expenses_detail"] = string(eb)
	} else {
		updates["expenses_detail"] = "[]"
	}

	totalCash := closure.TotalCash
	totalReturns := closure.TotalReturns
	if closureWindowChanged(closure, effectiveStart, effectiveEnd) {
		totalCash = cashInFromWindow(in.Sales, in.Payments)
		totalReturns = 0
		for _, r := range in.Returns {
			totalReturns += r.TotalReturned
		}
		updates["total_cash"] = totalCash
		updates["total_returns"] = totalReturns
	}

	snapshot := *closure
	snapshot.StartDate = effectiveStart
	snapshot.EndDate = effectiveEnd
	snapshot.Expenses = expenses
	snapshot.ExpensesDetail = ""
	snapshot.PhysicalCash = physicalCash
	snapshot.TotalCash = totalCash
	snapshot.TotalReturns = totalReturns

	m := ComputeClosureMetrics(&snapshot)
	egresosEfectivo := m.EgresosCaja

	expectedCash := closure.OpeningCash + totalCash - egresosEfectivo - totalReturns
	updates["expected_cash"] = expectedCash
	updates["difference"] = m.PhysicalCash - expectedCash
	updates["total_expenses"] = egresosEfectivo

	if realTotal := realSalesFromWindow(in.Sales, in.Payments); realTotal > 0 {
		updates["total_sales"] = realTotal
	} else if closure.TotalSales > 0 {
		updates["total_sales"] = closure.TotalSales
	}
	return updates
}
