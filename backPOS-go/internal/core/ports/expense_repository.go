package ports

import "backPOS-go/internal/core/domain/models"

type ExpenseRepository interface {
	Save(expense *models.Expense) error
	GetAll() ([]models.Expense, error)
	GetByID(id uint) (*models.Expense, error)
	GetByDateRange(from, to string) ([]models.Expense, error)
	Delete(id uint) error
	Count() (int64, error)
	Update(id uint, expense *models.Expense) error
	GetMonthlyTotals() (map[string]float64, error)
	GetPendingDebtsSummary() (float64, int64, error)
	GetExpensesByStatus(status string) ([]models.Expense, error)
	GetGlobalTotalPaidExpenses() (float64, error)
	GetGlobalPaidExpensesByMethod() (map[string]float64, error)
	GetPaidAmountByRange(from, to string) (float64, error)
}
