package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

type ExpenseService struct {
	repo ports.ExpenseRepository
}

func NewExpenseService(repo ports.ExpenseRepository) *ExpenseService {
	return &ExpenseService{repo: repo}
}

func (s *ExpenseService) CreateExpense(expense *models.Expense) error {
	return s.repo.Save(expense)
}

func (s *ExpenseService) GetAllExpenses() ([]models.Expense, error) {
	return s.repo.GetAll()
}

func (s *ExpenseService) DeleteExpense(id uint) error {
	return s.repo.Delete(id)
}

func (s *ExpenseService) UpdateExpense(id uint, expense *models.Expense) error {
	return s.repo.Update(id, expense)
}
