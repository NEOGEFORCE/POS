package services

import (
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// La alcancía es un canal propio: el dinero sale del tarro de monedas, no de la
// caja ni del fondo. Antes no existía ese caso y los egresos de monedas se
// descontaban del efectivo, así que el dashboard nunca cuadraba con el cierre.

func TestAssignExpenseChannelSeparatesCoinsFromCash(t *testing.T) {
	cases := []struct {
		source string
		expect func(models.Expense) float64
		name   string
	}{
		{source: "MONEDAS", name: "monedas", expect: func(e models.Expense) float64 { return e.CoinsAmount }},
		{source: "ALCANCIA", name: "alcancia", expect: func(e models.Expense) float64 { return e.CoinsAmount }},
		{source: "ALCANCÍA", name: "alcancia con acento", expect: func(e models.Expense) float64 { return e.CoinsAmount }},
		{source: "FONDO", name: "fondo", expect: func(e models.Expense) float64 { return e.FondoAmount }},
		{source: "CAJA", name: "caja", expect: func(e models.Expense) float64 { return e.CashAmount }},
		{source: "NEQUI", name: "nequi", expect: func(e models.Expense) float64 { return e.NequiAmount }},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			expense := models.Expense{}
			assignExpenseChannel(&expense, test.source, 50000)
			if got := test.expect(expense); got != 50000 {
				t.Fatalf("%s no recibió el monto: %+v", test.source, expense)
			}
			if test.source != "CAJA" && expense.CashAmount != 0 {
				t.Fatalf("%s contaminó el efectivo de caja: %+v", test.source, expense)
			}
		})
	}
}

func TestNormalizeClosureExpensesSplitsMixedChannelsWithCoins(t *testing.T) {
	// Caso real: ALTIPAL pagado con caja, fondo y alcancía.
	expenses := []models.Expense{{
		Status:        "PAID",
		Amount:        189469,
		PaymentSource: "CAJA: $59469/FONDO: $80000/ALCANCIA: $50000",
	}}

	if err := normalizeClosureExpenses(expenses); err != nil {
		t.Fatalf("normalizeClosureExpenses devolvió error: %v", err)
	}

	got := expenses[0]
	if got.CashAmount != 59469 {
		t.Fatalf("efectivo = %v, want 59469", got.CashAmount)
	}
	if got.FondoAmount != 80000 {
		t.Fatalf("fondo = %v, want 80000", got.FondoAmount)
	}
	if got.CoinsAmount != 50000 {
		t.Fatalf("alcancía = %v, want 50000", got.CoinsAmount)
	}

	total := got.CashAmount + got.FondoAmount + got.CoinsAmount + got.NequiAmount + got.DaviplataAmount
	if total != 189469 {
		t.Fatalf("la suma de canales = %v, want 189469", total)
	}
}

func TestNormalizeClosureExpensesKeepsCoinsOnlyExpense(t *testing.T) {
	expenses := []models.Expense{{
		Status:        "PAID",
		Amount:        42500,
		PaymentSource: "ALCANCIA",
	}}

	if err := normalizeClosureExpenses(expenses); err != nil {
		t.Fatalf("normalizeClosureExpenses devolvió error: %v", err)
	}

	got := expenses[0]
	if got.CoinsAmount != 42500 {
		t.Fatalf("alcancía = %v, want 42500", got.CoinsAmount)
	}
	if got.CashAmount != 0 || got.FondoAmount != 0 {
		t.Fatalf("un egreso de monedas no debe tocar caja ni fondo: %+v", got)
	}
}

func TestNormalizeClosureExpensesRespectsAlreadySplitCoins(t *testing.T) {
	// Si el egreso ya trae los canales desglosados no se debe recalcular.
	expenses := []models.Expense{{
		Status:      "PAID",
		Amount:      42500,
		CoinsAmount: 42500,
	}}

	if err := normalizeClosureExpenses(expenses); err != nil {
		t.Fatalf("normalizeClosureExpenses devolvió error: %v", err)
	}
	if expenses[0].CashAmount != 0 {
		t.Fatalf("se duplicó el egreso en caja: %+v", expenses[0])
	}
	if expenses[0].CoinsAmount != 42500 {
		t.Fatalf("alcancía = %v, want 42500", expenses[0].CoinsAmount)
	}
}
