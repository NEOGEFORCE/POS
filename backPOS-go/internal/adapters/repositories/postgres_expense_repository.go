package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
)

type PostgresExpenseRepository struct {
	db *gorm.DB
}

func NewPostgresExpenseRepository(db *gorm.DB) *PostgresExpenseRepository {
	return &PostgresExpenseRepository{db: db}
}

func (r *PostgresExpenseRepository) Save(expense *models.Expense) error {
	return r.db.Create(expense).Error
}

func (r *PostgresExpenseRepository) GetAll() ([]models.Expense, error) {
	expenses := []models.Expense{}
	err := r.db.Find(&expenses).Error
	return expenses, err
}

func (r *PostgresExpenseRepository) GetByDateRange(from, to string) ([]models.Expense, error) {
	expenses := []models.Expense{}
	query := r.db.Model(&models.Expense{})
	if from != "" {
		query = query.Where("date >= ?", from)
	}
	if to != "" {
		query = query.Where("date <= ?", to)
	}
	err := query.Find(&expenses).Error
	return expenses, err
}

func (r *PostgresExpenseRepository) Delete(id uint) error {
	return r.db.Delete(&models.Expense{}, id).Error
}

func (r *PostgresExpenseRepository) Count() (int64, error) {
	var count int64
	err := r.db.Model(&models.Expense{}).Count(&count).Error
	return count, err
}

func (r *PostgresExpenseRepository) Update(id uint, expense *models.Expense) error {
	return r.db.Model(&models.Expense{}).Where("id = ?", id).Updates(expense).Error
}
