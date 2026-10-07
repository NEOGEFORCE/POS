package ports

import (
	"backPOS-go/internal/core/domain/models"
)

type ActiveShiftRepository interface {
	GetActive() (*models.ActiveShift, error)
	Save(shift *models.ActiveShift) error
	SaveWithTx(tx interface{}, shift *models.ActiveShift) error
	// LockActiveWithTx bloquea el turno OPEN con SELECT ... FOR UPDATE
	// dentro de la transacción recibida. Devuelve (nil, nil) si no hay
	// ninguno. Se usa en SaveClosure para serializar dos cierres
	// concurrentes del mismo turno (fix P1 — 2026-10-04).
	LockActiveWithTx(tx interface{}) (*models.ActiveShift, error)
	CloseActive() error
	CloseActiveWithTx(tx interface{}) error
}
