package ports

import (
	"backPOS-go/internal/core/domain/models"
)

type ActiveShiftRepository interface {
	GetActive() (*models.ActiveShift, error)
	Save(shift *models.ActiveShift) error
	SaveWithTx(tx interface{}, shift *models.ActiveShift) error
	CloseActive() error
	CloseActiveWithTx(tx interface{}) error
}
