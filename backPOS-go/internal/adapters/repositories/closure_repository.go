package repositories

import (
	"errors"
	"strings"
	"sync/atomic"
	"time"

	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
)

// atomicLoadInt32 / atomicStoreInt32 son envoltorios finos sobre sync/atomic
// para que el repositorio exprese de forma legible la bandera cacheada
// de la migración 018 (ver clientTxIDColumnExists).
func atomicLoadInt32(ptr *int32) int32     { return atomic.LoadInt32(ptr) }
func atomicStoreInt32(ptr *int32, v int32) { atomic.StoreInt32(ptr, v) }

type closureRepository struct {
	db *gorm.DB
}

func NewClosureRepository(db *gorm.DB) *closureRepository {
	return &closureRepository{db: db}
}

func (r *closureRepository) Save(closure *models.CashierClosure) error {
	return r.db.Save(closure).Error
}

func (r *closureRepository) Transaction(fn func(tx interface{}) error) error {
	return r.db.Transaction(func(tx *gorm.DB) error { return fn(tx) })
}

func (r *closureRepository) SaveWithTx(tx interface{}, closure *models.CashierClosure) error {
	gormTx, ok := tx.(*gorm.DB)
	if !ok {
		return gorm.ErrInvalidDB
	}
	return gormTx.Save(closure).Error
}

func (r *closureRepository) GetByDateRange(from, to time.Time) ([]models.CashierClosure, error) {
	var closures []models.CashierClosure
	err := r.db.Where("date >= ? AND date <= ?", from, to).Order("date ASC").Find(&closures).Error
	return closures, err
}

func (r *closureRepository) GetAll() ([]models.CashierClosure, error) {
	var closures []models.CashierClosure
	err := r.db.Order("date DESC, id DESC").Find(&closures).Error
	return closures, err
}

func (r *closureRepository) GetByID(id uint) (*models.CashierClosure, error) {
	var closure models.CashierClosure
	err := r.db.First(&closure, id).Error
	if err != nil {
		return nil, err
	}
	return &closure, nil
}

func (r *closureRepository) GetLast() (*models.CashierClosure, error) {
	var closure models.CashierClosure
	err := r.db.Order("date DESC, id DESC").First(&closure).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &closure, nil
}
func (r *closureRepository) GetGlobalReportedBalance() (float64, error) {
	var total float64
	err := r.db.Model(&models.CashierClosure{}).
		Select("COALESCE(SUM(total_cash_real + total_nequi_real + total_daviplata_real), 0)").
		Scan(&total).Error
	return total, err
}
func (r *closureRepository) GetGlobalReportedBalanceByMethod() (map[string]float64, error) {
	var result struct {
		Cash      float64 `gorm:"column:cash"`
		Nequi     float64 `gorm:"column:nequi"`
		Daviplata float64 `gorm:"column:daviplata"`
	}
	err := r.db.Model(&models.CashierClosure{}).
		Select("COALESCE(SUM(physical_cash), 0) as cash, COALESCE(SUM(total_nequi_real), 0) as nequi, COALESCE(SUM(total_daviplata_real), 0) as daviplata").
		Scan(&result).Error

	balances := make(map[string]float64)
	if err == nil {
		balances["EFECTIVO"] = result.Cash
		balances["NEQUI"] = result.Nequi
		balances["DAVIPLATA"] = result.Daviplata
	}
	return balances, err
}
func (r *closureRepository) GetGlobalCoins() (map[string]float64, error) {
	var result struct {
		C100  float64
		C200  float64
		C500  float64
		C1000 float64
	}
	// Filtrar monedas solo desde el 1 del mes actual (ej. 1 de Agosto)
	loc := time.FixedZone("America/Bogota", -5*60*60)
	nowLocal := time.Now().In(loc)
	startOfMonth := time.Date(nowLocal.Year(), nowLocal.Month(), 1, 0, 0, 0, 0, loc)

	err := r.db.Model(&models.CashierClosure{}).
		Where("date >= ? OR end_date >= ?", startOfMonth, startOfMonth).
		Select("COALESCE(SUM(coins100), 0) as c100, COALESCE(SUM(coins200), 0) as c200, COALESCE(SUM(coins500), 0) as c500, COALESCE(SUM(coins1000), 0) as c1000").
		Scan(&result).Error

	coins := make(map[string]float64)
	if err == nil {
		coins["100"] = result.C100
		coins["200"] = result.C200
		coins["500"] = result.C500
		coins["1000"] = result.C1000
	}
	return coins, err
}
func (r *closureRepository) GetGlobalDifferenceSum() (float64, error) {
	var total float64
	err := r.db.Model(&models.CashierClosure{}).
		Select("COALESCE(SUM(difference), 0)").
		Scan(&total).Error
	return total, err
}

func (r *closureRepository) GetGlobalHistoricalSum() (expected float64, real float64, err error) {
	var result struct {
		Expected float64 `gorm:"column:expected"`
		Real     float64 `gorm:"column:real"`
	}
	err = r.db.Model(&models.CashierClosure{}).
		Select("COALESCE(SUM(total_cash + total_credit_collected - total_expenses), 0) as expected, COALESCE(SUM(physical_cash), 0) as real").
		Scan(&result).Error

	return result.Expected, result.Real, err
}

func (r *closureRepository) GetDailyReconstructedSales(from time.Time, to time.Time) (map[string]float64, error) {
	dailySales := make(map[string]float64)

	var results []struct {
		Day   string
		Total float64
	}

	err := r.db.Table("cashier_closures").
		Select("TO_CHAR(date AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') as day, SUM(physical_cash + total_nequi + total_daviplata + total_card + total_bancolombia + total_other_transfer + total_expenses) as total").
		Where("date >= ? AND date <= ?", from, to).
		Group("day").
		Scan(&results).Error

	if err != nil {
		return nil, err
	}

	for _, res := range results {
		dailySales[res.Day] = res.Total
	}

	return dailySales, nil
}

func (r *closureRepository) GetMonthlyReconstructedSales() (map[string]float64, error) {
	monthlySales := make(map[string]float64)

	var results []struct {
		Month string
		Total float64
	}

	err := r.db.Table("cashier_closures").
		Select("TO_CHAR(date AT TIME ZONE 'America/Bogota', 'YYYY-MM') as month, SUM(physical_cash + total_nequi + total_daviplata + total_card + total_bancolombia + total_other_transfer + total_expenses) as total").
		Group("month").
		Scan(&results).Error

	if err != nil {
		return nil, err
	}

	for _, res := range results {
		monthlySales[res.Month] = res.Total
	}

	return monthlySales, nil
}

func (r *closureRepository) Delete(id uint) error {
	return r.db.Unscoped().Delete(&models.CashierClosure{}, id).Error
}

func (r *closureRepository) Update(id uint, updates map[string]interface{}) error {
	return r.db.Model(&models.CashierClosure{}).Where("id = ?", id).Updates(updates).Error
}

// UpdateWithTx aplica un UPDATE restringido a un conjunto de columnas
// dentro de una transacción ya abierta. Replica el patrón de
// SaveWithTx (interface{} para no romper el port) y permite al servicio
// recalcular arqueo y escribir en la misma transacción (fix P1 —
// UpdateClosure transaccional, 2026-10-04).
func (r *closureRepository) UpdateWithTx(tx interface{}, id uint, updates map[string]interface{}) error {
	gormTx, ok := tx.(*gorm.DB)
	if !ok {
		return gorm.ErrInvalidDB
	}
	return gormTx.Model(&models.CashierClosure{}).Where("id = ?", id).Updates(updates).Error
}

// GetByIDWithTx recarga un cierre dentro de una transacción activa.
// Permite al servicio releer el registro justo antes del UPDATE sin
// escaparse de la tx.
func (r *closureRepository) GetByIDWithTx(tx interface{}, id uint) (*models.CashierClosure, error) {
	gormTx, ok := tx.(*gorm.DB)
	if !ok {
		return nil, gorm.ErrInvalidDB
	}
	var closure models.CashierClosure
	if err := gormTx.First(&closure, id).Error; err != nil {
		return nil, err
	}
	return &closure, nil
}

// hasClientTxIDColumn es la memoria de arranque sobre si la migración 018
// (idempotencia anti-doble-cierre) ya está aplicada. -1 = aún no
// consultado, 0 = ausente, 1 = presente. Protege dos flujos:
//
//   - CreateIfNotExistsByClientTxID lo consulta antes de ejecutar la
//     query: si vale 0, devuelve (0, nil) y el servicio sigue adelante
//     con el flujo clásico (sin idempotencia a nivel BD, equivalente al
//     comportamiento pre-018).
//
//   - La primera consulta sincroniza vía `information_schema.columns`,
//     tolerante a `to_regclass('public.cashier_closures')` por si la
//     tabla no existe aún (caso irrealista pero defensivo).
//
// El flag no se refresca en caliente: aplicar la migración 018 requiere
// reiniciar el binario (lo mismo que ya exige nssm). Esto es intencional
// — un flip dinámico escondería que la BD cambió sin aviso.
var clientTxIDColumnPresent int32 = -1

func (r *closureRepository) clientTxIDColumnExists() bool {
	v := atomicLoadInt32(&clientTxIDColumnPresent)
	if v == 0 {
		return false
	}
	if v == 1 {
		return true
	}
	// Primera consulta: materializar el estado.
	var exists bool
	err := r.db.Raw(`
		SELECT COALESCE(
			(SELECT COUNT(*) FROM information_schema.columns
			  WHERE table_schema = current_schema()
			    AND table_name = 'cashier_closures'
			    AND column_name = 'client_tx_id'),
		0) > 0
	`).Scan(&exists).Error
	if err != nil {
		// Fallo transitorio: no cacheamos. En la próxima petición se
		// vuelve a consultar. No romper SaveClosure por un hiccup del
		// information_schema.
		return false
	}
	if exists {
		atomicStoreInt32(&clientTxIDColumnPresent, 1)
		return true
	}
	atomicStoreInt32(&clientTxIDColumnPresent, 0)
	return false
}

// FindIDByClientTxID consulta el cierre existente para un `client_tx_id`
// dado DENTRO de la transacción `tx`. Devuelve (0, nil, nil) cuando no
// existe, (id, closure, nil) cuando ya se persistió uno con ese UUID.
//
// Tolerante: si la columna `client_tx_id` no existe (migración 018 no
// aplicada), devuelve (0, nil, nil) sin consultar la BD. Ese es el
// patrón que viven label_codes/package_barcode_aliases, probado en
// producción.
//
// El SELECT va parametrizado y se ejecuta dentro de la transacción del
// INSERT: una carrera entre dos pestañas que reenvían el mismo
// `client_tx_id` queda arbitrada por el UNIQUE parcial de la 018 (el
// que llegue segundo recibe pq: duplicate key, el servicio lo detecta
// y responde con el id previo).
func (r *closureRepository) FindIDByClientTxID(tx interface{}, clientTxID string) (uint, *models.CashierClosure, error) {
	clean := strings.TrimSpace(clientTxID)
	if clean == "" {
		return 0, nil, nil
	}
	if !r.clientTxIDColumnExists() {
		return 0, nil, nil
	}
	gormTx, ok := tx.(*gorm.DB)
	if !ok {
		return 0, nil, gorm.ErrInvalidDB
	}
	var existing models.CashierClosure
	err := gormTx.Where("client_tx_id = ?", clean).Order("id ASC").First(&existing).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, nil, nil
		}
		return 0, nil, err
	}
	return existing.ID, &existing, nil
}
