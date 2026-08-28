package handlers

import (
	"testing"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
)

func TestApplyTrustedClosureDataUsesServerTotalsAndPreservesPhysicalCount(t *testing.T) {
	t.Parallel()

	target := &models.CashierClosure{
		SalesCount:         999,
		TotalSales:         999999,
		TotalCash:          999999,
		PhysicalCash:       123450,
		CashBills:          100000,
		Coins1000:          10,
		TotalCashReal:      123450,
		TotalNequiReal:     5000,
		TotalDaviplataReal: 7000,
		AuthorizedBy:       "ADMIN-1",
		Expenses: []models.Expense{
			{ID: 0, Description: "Manual autorizado", Amount: 5000},
			{ID: 99, Description: "Egreso persistido manipulado", Amount: 999999},
		},
	}
	trusted := &services.CashierClosure{
		SalesCount:           3,
		TotalSales:           75000,
		TotalCash:            50000,
		TotalTransfer:        25000,
		TotalNequi:           15000,
		TotalDaviplata:       10000,
		TotalReturns:         2000,
		TotalCreditIssued:    3000,
		TotalCreditCollected: 1000,
		OpeningCash:          20000,
		Expenses: []models.Expense{
			{ID: 7, Description: "Egreso calculado", Amount: 8000},
		},
	}

	applyTrustedClosureData(target, trusted)

	if target.SalesCount != 3 || target.TotalSales != 75000 || target.TotalCash != 50000 || target.TotalTransfer != 25000 {
		t.Fatalf("totales no provienen del backend: %+v", target)
	}
	if target.PhysicalCash != 123450 || target.CashBills != 100000 || target.Coins1000 != 10 {
		t.Fatalf("el conteo físico fue sobrescrito: %+v", target)
	}
	if target.TotalCashReal != 123450 || target.TotalNequiReal != 5000 || target.TotalDaviplataReal != 7000 || target.AuthorizedBy != "ADMIN-1" {
		t.Fatalf("campos de arqueo real fueron sobrescritos: %+v", target)
	}
	if len(target.Expenses) != 2 || target.Expenses[0].ID != 7 || target.Expenses[1].ID != 0 {
		t.Fatalf("egresos combinados = %+v; se esperaban backend + manual ID 0", target.Expenses)
	}
}
