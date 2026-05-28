package ports

import (
	"backPOS-go/internal/core/domain/models"
	"time"
)

type ExpenseRepository interface {
	Save(expense *models.Expense) error
	GetAll() ([]models.Expense, error)
	GetAllFiltered(supplier, concept string) ([]models.Expense, error)
	GetByID(id uint) (*models.Expense, error)
	GetByDateRange(from, to time.Time) ([]models.Expense, error)
	GetPendingRestockExpensesBySupplier(supplierID uint) ([]models.Expense, error)
	Delete(id uint) error
	Count() (int64, error)
	Update(id uint, expense *models.Expense) error
	Settle(id uint, paymentSource string) error
	GetMonthlyTotals() (map[string]float64, error)
	GetPendingDebtsSummary() (float64, int64, error)
	GetExpensesByStatus(status string) ([]models.Expense, error)
	GetGlobalTotalPaidExpenses() (float64, error)
	GetGlobalPaidExpensesByMethod() (map[string]float64, error)
	GetPaidAmountByRange(from, to time.Time) (float64, error)
	GetGlobalPaidExpensesByMethodInRange(from, to time.Time) (map[string]float64, error)
}
