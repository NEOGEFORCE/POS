package ports

import (
	"backPOS-go/internal/core/domain/models"
	"time"
)

type CreditPaymentRepository interface {
	Save(payment *models.CreditPayment) error
	GetByClient(dni string) ([]models.CreditPayment, error)
	GetByDateRange(start, end time.Time) ([]models.CreditPayment, error)
}
