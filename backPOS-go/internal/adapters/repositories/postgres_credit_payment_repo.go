package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"time"
	"gorm.io/gorm"
)

type PostgresCreditPaymentRepository struct {
	db *gorm.DB
}

func NewPostgresCreditPaymentRepository(db *gorm.DB) *PostgresCreditPaymentRepository {
	return &PostgresCreditPaymentRepository{db: db}
}

func (r *PostgresCreditPaymentRepository) Save(payment *models.CreditPayment) error {
	return r.db.Create(payment).Error
}

func (r *PostgresCreditPaymentRepository) GetByClient(dni string) ([]models.CreditPayment, error) {
	var payments []models.CreditPayment
	err := r.db.Where("\"clientDni\" = ?", dni).Order("\"paymentDate\" desc").Find(&payments).Error
	return payments, err
}

func (r *PostgresCreditPaymentRepository) GetByDateRange(start, end time.Time) ([]models.CreditPayment, error) {
	var payments []models.CreditPayment
	err := r.db.Where("\"paymentDate\" BETWEEN ? AND ?", start, end).Find(&payments).Error
	return payments, err
}
