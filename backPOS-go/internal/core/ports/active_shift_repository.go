package ports

import (
	"backPOS-go/internal/core/domain/models"
)

type ActiveShiftRepository interface {
	GetActive() (*models.ActiveShift, error)
	Save(shift *models.ActiveShift) error
	CloseActive() error
}
