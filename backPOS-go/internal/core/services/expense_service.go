package services

import (
	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

type ExpenseService struct {
	repo         ports.ExpenseRepository
	supplierRepo *repositories.PostgresSupplierRepository
}

func NewExpenseService(repo ports.ExpenseRepository, supplierRepo *repositories.PostgresSupplierRepository) *ExpenseService {
	return &ExpenseService{
		repo:         repo,
		supplierRepo: supplierRepo,
	}
}

func (s *ExpenseService) CreateExpense(expense *models.Expense) error {
	// Si viene un nombre de proveedor nuevo, crearlo primero
	if expense.NewSupplierName != "" && expense.Category == "Proveedores" {
		newSup := &models.Supplier{
			Name: expense.NewSupplierName,
		}
		if err := s.supplierRepo.Save(newSup); err == nil {
			expense.SupplierID = &newSup.ID
			expense.Description = "PAGO PROVEEDOR: " + newSup.Name
		}
	}
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
