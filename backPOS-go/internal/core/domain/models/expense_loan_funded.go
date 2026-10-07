package models

import "strings"

// =============================================================================
// Egresos financiados con PRÉSTAMO (opción "pagar con préstamo")
// =============================================================================
//
// Un Expense cuyo PaymentSource es "PRESTAMO" o "PREST." REPRESENTA la
// aplicación de dinero del principal de un préstamo contra una deuda o
// contra un gasto nuevo. Lo crea el endpoint
//   POST /api/loans/:id/pay-expense
// dentro de la misma transacción que inserta la bitácora loan_expenses, y
// no debe participar en NINGÚN cuadre de caja.
//
// Reglas de dinero (confirmadas por el dueño, opción 1):
//
//   - El egreso NO sale de ningún canal de la tienda: ni caja (`CashAmount`),
//     ni bóveda/fondo (`FondoAmount`), ni alcancía (`CoinsAmount`), ni
//     Nequi/Daviplata. El egreso real recién ocurre cuando se paga una cuota
//     del préstamo con un canal real (eso ya existe:
//     POST /loans/:id/installments/:number/pay).
//
//   - El egreso SÍ descuenta del disponible del préstamo
//     (principal - SUM(loan_expenses.amount_used)) a través de la bitácora
//     `loan_expenses`, cuyo invariante lo valida el repo con un SELECT
//     ... FOR UPDATE.
//
//   - El egreso SÍ puede listarse en /expenses como registro informativo con
//     etiqueta "PRÉSTAMO". No es "deuda viva" (ya está PAID), no infla
//     egresos del mes, no suma en el arqueo, no entra al PDF ni a Telegram.
//
// POR QUÉ EL HELPER
// ----------------------------------------------------------------------------
// La convención textual `PaymentSource IN ('PRESTAMO', 'PREST.')` estaba
// repetida como literal en 10+ puntos del backend: dashboard, PDF,
// clasificación por canal, reportes mensuales, working-capital. Un solo
// helper evita que un `else if strings.Contains(src, "PRESTM")` olvidado
// deje una fuga por donde se cuele un egreso de préstamo al arqueo o al KPI.
//
// Los repositorios SQL deben usar `LoanFundedExpenseSQLPredicate` dentro de
// un `WHERE NOT (...)` para filtrarlos de agregados monetarios.

// IsLoanFundedPaymentSource indica si un PaymentSource normalizado identifica
// a un egreso pagado con dinero del préstamo. Compara en MAYÚSCULAS y acepta
// las dos variantes históricas ("PRESTAMO" y "PREST.").
func IsLoanFundedPaymentSource(paymentSource string) bool {
	src := strings.ToUpper(strings.TrimSpace(paymentSource))
	if src == "" {
		return false
	}
	// Match exacto para "PRESTAMO" y "PREST.", y defensa en profundidad por
	// prefijo "PREST" para variantes futuras ("PRESTAM.", "PRESTAMOS") que
	// algún script heredado pudiera haber dejado. El bucle de normalización
	// textual ya trata "PREST*" como "no mueve caja", así que esta regla
	// endurece el filtro sin cambiar su alcance.
	if src == "PRESTAMO" || src == "PREST." {
		return true
	}
	return strings.HasPrefix(src, "PREST")
}

// IsLoanFundedExpense es el helper equivalente para un *Expense. Devuelve
// false sobre nil para no reventar llamadas defensivas.
func IsLoanFundedExpense(e *Expense) bool {
	if e == nil {
		return false
	}
	return IsLoanFundedPaymentSource(e.PaymentSource)
}

// LoanFundedExpenseSQLPredicate es la condición SQL que identifica a los
// egresos financiados con préstamo. Se usa dentro de un
//
//	WHERE NOT (` + models.LoanFundedExpenseSQLPredicate + `)
//
// o combinada en consultas que necesitan excluirlos de agregados monetarios
// (totales mensuales, pagos por método, mercancía pagada, etc.). Mantener
// una única constante evita que un filtro divergente deje un hueco por donde
// un egreso de préstamo infle el KPI del dashboard.
const LoanFundedExpenseSQLPredicate = `UPPER(COALESCE("paymentSource", '')) IN ('PRESTAMO', 'PREST.')`
