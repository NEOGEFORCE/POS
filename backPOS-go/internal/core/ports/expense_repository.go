package ports

import "backPOS-go/internal/core/domain/models"

type ExpenseRepository interface {
	Save(expense *models.Expense) error
	GetAll() ([]models.Expense, error)
	GetByDateRange(from, to string) ([]models.Expense, error)
	Delete(id uint) error
	Count() (int64, error)
	Update(id uint, expense *models.Expense) error
	GetMonthlyTotals() (map[string]float64, error)
}
