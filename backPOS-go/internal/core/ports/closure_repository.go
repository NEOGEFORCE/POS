package ports

import (
	"backPOS-go/internal/core/domain/models"
	"time"
)

type ClosureRepository interface {
	Transaction(fn func(tx interface{}) error) error
	Save(closure *models.CashierClosure) error
	SaveWithTx(tx interface{}, closure *models.CashierClosure) error
	GetByDateRange(from, to time.Time) ([]models.CashierClosure, error)
	GetAll() ([]models.CashierClosure, error)
	GetByID(id uint) (*models.CashierClosure, error)
	// GetByIDWithTx recarga un cierre dentro de una transacción.
	GetByIDWithTx(tx interface{}, id uint) (*models.CashierClosure, error)
	GetLast() (*models.CashierClosure, error)
	GetGlobalReportedBalance() (float64, error)
	GetGlobalReportedBalanceByMethod() (map[string]float64, error)
	GetGlobalCoins() (map[string]float64, error)
	GetGlobalDifferenceSum() (float64, error)
	GetGlobalHistoricalSum() (expected float64, real float64, err error)
	GetDailyReconstructedSales(from time.Time, to time.Time) (map[string]float64, error)
	GetMonthlyReconstructedSales() (map[string]float64, error)
	Delete(id uint) error
	Update(id uint, updates map[string]interface{}) error
	// UpdateWithTx ejecuta el UPDATE con allowlist dentro de una transacción.
	UpdateWithTx(tx interface{}, id uint, updates map[string]interface{}) error
	// FindIDByClientTxID consulta la columna de idempotencia (migración
	// 018) dentro de una transacción activa. Tolerante a migración
	// no aplicada: devuelve (0, nil, nil).
	FindIDByClientTxID(tx interface{}, clientTxID string) (uint, *models.CashierClosure, error)
}
