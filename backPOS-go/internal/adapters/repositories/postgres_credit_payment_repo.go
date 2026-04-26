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
	return r.db.Omit("Client", "Employee").Create(payment).Error
}

func (r *PostgresCreditPaymentRepository) GetByClient(dni string) ([]models.CreditPayment, error) {
	var payments []models.CreditPayment
	err := r.db.Where("\"clientDni\" = ?", dni).Order("\"paymentDate\" desc").Find(&payments).Error
	return payments, err
}

func (r *PostgresCreditPaymentRepository) GetByDateRange(start, end time.Time) ([]models.CreditPayment, error) {
	var payments []models.CreditPayment
	err := r.db.Preload("Client").Where("\"paymentDate\" BETWEEN ? AND ?", start, end).Find(&payments).Error
	return payments, err
}

func (r *PostgresCreditPaymentRepository) GetTotalCollectedByDateRange(start, end string) (float64, error) {
	var total float64
	err := r.db.Model(&models.CreditPayment{}).
		Where("\"paymentDate\" >= ? AND \"paymentDate\" < ?", start, end).
		Select("COALESCE(SUM(\"totalPaid\"), 0)").
		Scan(&total).Error
	return total, err
}

func (r *PostgresCreditPaymentRepository) GetDailyCollectedByRange(from, to string) (map[string]float64, error) {
	results := make(map[string]float64)
	rows, err := r.db.Table("credit_payments").
		Select("TO_CHAR(\"paymentDate\", 'YYYY-MM-DD') as day, SUM(\"totalPaid\") as total").
		Where("\"paymentDate\" >= ? AND \"paymentDate\" < ?", from, to).
		Group("day").
		Rows()

	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var day string
		var total float64
		if err := rows.Scan(&day, &total); err != nil {
			return nil, err
		}
		results[day] = total
	}
	return results, nil
}
