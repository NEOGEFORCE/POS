package services

import (
	"testing"

	"backPOS-go/internal/core/domain/models"
)

func TestNormalizeClosureExpensesParsesExplicitChannels(t *testing.T) {
	t.Parallel()

	expenses := []models.Expense{{
		Amount:        15000,
		PaymentSource: "NEQUI: $10.000 / CAJA: $5.000",
		Status:        "PAID",
	}}
	if err := normalizeClosureExpenses(expenses); err != nil {
		t.Fatal(err)
	}
	if expenses[0].NequiAmount != 10000 || expenses[0].CashAmount != 5000 {
		t.Fatalf("canales normalizados = %+v; want NEQUI 10000 y CAJA 5000", expenses[0])
	}
}

func TestNormalizeClosureExpensesRejectsMalformedChannelAmount(t *testing.T) {
	t.Parallel()

	expenses := []models.Expense{{Amount: 1000, PaymentSource: "CAJA: $abc", Status: "PAID"}}
	if err := normalizeClosureExpenses(expenses); err == nil {
		t.Fatal("normalizeClosureExpenses() error = nil; want monto inválido")
	}
}

func TestApplyCashBreakdownCalculatesPhysicalCash(t *testing.T) {
	t.Parallel()

	closure := &models.CashierClosure{
		CashBreakdown: `{"bills":{"50000":"2","20000":"1"},"coins":{}}`,
		Coins1000:     3000,
		Coins500:      1000,
	}
	if err := applyCashBreakdown(closure); err != nil {
		t.Fatal(err)
	}
	if closure.CashBills != 120000 {
		t.Fatalf("CashBills = %.2f; want 120000", closure.CashBills)
	}
	if closure.PhysicalCash != 124000 {
		t.Fatalf("PhysicalCash = %.2f; want 124000", closure.PhysicalCash)
	}
}

func TestApplyCashBreakdownRejectsInvalidJSON(t *testing.T) {
	t.Parallel()

	closure := &models.CashierClosure{CashBreakdown: `{invalid`}
	if err := applyCashBreakdown(closure); err == nil {
		t.Fatal("applyCashBreakdown() error = nil; want JSON inválido")
	}
}
