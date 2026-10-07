package repositories

import (
	"errors"

	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type activeShiftRepository struct {
	db *gorm.DB
}

func NewActiveShiftRepository(db *gorm.DB) *activeShiftRepository {
	return &activeShiftRepository{db: db}
}

func (r *activeShiftRepository) GetActive() (*models.ActiveShift, error) {
	var shift models.ActiveShift
	err := r.db.Where("status = ?", "OPEN").First(&shift).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &shift, nil
}

func (r *activeShiftRepository) Save(shift *models.ActiveShift) error {
	return r.db.Save(shift).Error
}

func (r *activeShiftRepository) CloseActive() error {
	return r.db.Model(&models.ActiveShift{}).Where("status = ?", "OPEN").Update("status", "CLOSED").Error
}

func (r *activeShiftRepository) SaveWithTx(tx interface{}, shift *models.ActiveShift) error {
	gormTx, ok := tx.(*gorm.DB)
	if !ok {
		return gorm.ErrInvalidDB
	}
	return gormTx.Save(shift).Error
}

// LockActiveWithTx aplica un `SELECT ... FOR UPDATE` sobre el único turno
// OPEN dentro de la transacción `tx`. Serializa dos cierres concurrentes
// del mismo turno: la segunda petición espera a que la primera haga COMMIT
// y luego ve `status = CLOSED`, por lo que retorna `(nil, nil)` y
// `SaveClosure` aborta antes de crear un segundo `cashier_closures`.
//
// Devuelve `(nil, nil)` cuando no hay turno OPEN. El error sólo surge
// cuando el `tx` no es un `*gorm.DB` válido o el SELECT falla por
// problemas reales de BD. El lock es local a la transacción: cuando ésta
// termina (COMMIT o ROLLBACK), se libera automáticamente.
//
// Fix P1 (idempotencia + anti-doble-cierre, 2026-10-04): combina con
// `client_tx_id` para cerrar dos vectores distintos de duplicados:
//
//   - `client_tx_id`: dos POST con el MISMO UUID (reintento del mismo
//     cliente) devuelven el id previo sin tocar la BD.
//   - `FOR UPDATE`: dos POST sin UUID o con UUIDs distintos (dos
//     pestañas, dos cajeros, dos navegadores) no corren en paralelo
//     dentro del mismo turno.
func (r *activeShiftRepository) LockActiveWithTx(tx interface{}) (*models.ActiveShift, error) {
	gormTx, ok := tx.(*gorm.DB)
	if !ok {
		return nil, gorm.ErrInvalidDB
	}
	var shift models.ActiveShift
	err := gormTx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("status = ?", "OPEN").
		First(&shift).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &shift, nil
}

func (r *activeShiftRepository) CloseActiveWithTx(tx interface{}) error {
	gormTx, ok := tx.(*gorm.DB)
	if !ok {
		return gorm.ErrInvalidDB
	}
	return gormTx.Model(&models.ActiveShift{}).Where("status = ?", "OPEN").Update("status", "CLOSED").Error
}
