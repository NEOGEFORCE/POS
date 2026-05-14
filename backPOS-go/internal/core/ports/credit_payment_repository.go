package ports

import (
	"backPOS-go/internal/core/domain/models"
	"time"
)

type CreditPaymentRepository interface {
	Save(payment *models.CreditPayment) error
	GetByClient(dni string) ([]models.CreditPayment, error)
	GetByDateRange(start, end time.Time) ([]models.CreditPayment, error)
	GetTotalCollectedByDateRange(start, end time.Time) (float64, error)
	GetDailyCollectedByRange(from, to time.Time) (map[string]float64, error)
}
