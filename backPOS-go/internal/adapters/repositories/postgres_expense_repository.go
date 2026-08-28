package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/refresher"
	"backPOS-go/internal/infrastructure/sse"
	"gorm.io/gorm"
	"log"
	"strings"
	"time"
)

type PostgresExpenseRepository struct {
	db *gorm.DB
}

func NewPostgresExpenseRepository(db *gorm.DB) *PostgresExpenseRepository {
	return &PostgresExpenseRepository{db: db}
}

func (r *PostgresExpenseRepository) invalidateDashboardCache() {
	// Invalidate RAM cache
	cache.InvalidateCache(cache.CacheKeyDashboardOverview)

	// Solicitar refresco asíncrono y debounced
	refresher.GetRefresherService(r.db).RequestRefresh("mv_dashboard_stats_monthly")

	// Notificar sincronización global
	sse.GetSSEService().BroadcastExpenseUpdate(nil)
}

func (r *PostgresExpenseRepository) Save(expense *models.Expense) error {
	err := r.db.Create(expense).Error
	if err == nil {
		r.invalidateDashboardCache()
	}
	return err
}

func (r *PostgresExpenseRepository) GetAll() ([]models.Expense, error) {
	expenses := []models.Expense{}
	err := r.db.Preload("Creator").Order("date DESC").Limit(1000).Find(&expenses).Error
	return expenses, err
}

func (r *PostgresExpenseRepository) SaveWithTx(tx interface{}, expense *models.Expense) error {
	gormTx, ok := tx.(*gorm.DB)
	if !ok {
		return gorm.ErrInvalidDB
	}
	return gormTx.Create(expense).Error
}

func (r *PostgresExpenseRepository) GetAllFiltered(supplier, concept string) ([]models.Expense, error) {
	expenses := []models.Expense{}
	query := r.db.Preload("Creator").Model(&models.Expense{})

	if supplier != "" {
		// Use a join to filter by supplier name, or filter by exact supplier_id if we had it.
		// Since expense has supplier_id, we can join with suppliers table.
		query = query.Joins("LEFT JOIN suppliers ON suppliers.id = expenses.supplier_id").
			Where("suppliers.name ILIKE ?", "%"+supplier+"%")
	}

	if concept != "" {
		query = query.Where("description ILIKE ?", "%"+concept+"%")
	}

	err := query.Order("date DESC").Limit(1000).Find(&expenses).Error
	return expenses, err
}

func (r *PostgresExpenseRepository) GetExpensesPaginated(filter ports.ExpenseFilter) ([]models.Expense, int64, error) {
	var expenses []models.Expense
	var total int64

	query := r.db.Model(&models.Expense{})

	if filter.Supplier != "" {
		query = query.Joins("LEFT JOIN suppliers ON suppliers.id = expenses.supplier_id").
			Where("suppliers.name ILIKE ?", "%"+filter.Supplier+"%")
	}

	if filter.Concept != "" {
		query = query.Where("description ILIKE ?", "%"+filter.Concept+"%")
	}

	err := query.Count(&total).Error
	if err != nil {
		return nil, 0, err
	}

	offset := (filter.Page - 1) * filter.PageSize
	err = query.Preload("Creator").Order("date DESC").Offset(offset).Limit(filter.PageSize).Find(&expenses).Error

	return expenses, total, err
}

func (r *PostgresExpenseRepository) GetByID(id uint) (*models.Expense, error) {
	var expense models.Expense
	err := r.db.Preload("Creator").First(&expense, id).Error
	return &expense, err
}

func (r *PostgresExpenseRepository) GetByDateRange(from, to time.Time) ([]models.Expense, error) {
	expenses := []models.Expense{}
	query := r.db.Model(&models.Expense{})
	if !from.IsZero() {
		query = query.Where("date >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("date <= ?", to)
	}
	err := query.Order("date DESC").Find(&expenses).Error
	return expenses, err
}

func (r *PostgresExpenseRepository) GetPendingRestockExpensesBySupplier(supplierID uint) ([]models.Expense, error) {
	expenses := []models.Expense{}
	err := r.db.Preload("Creator").Where("category = ?", "Proveedores").Where("supplier_id = ?", supplierID).Where("is_restocked = ?", false).Order("date DESC").Find(&expenses).Error
	return expenses, err
}

func (r *PostgresExpenseRepository) Delete(id uint) error {
	return r.db.Delete(&models.Expense{}, id).Error
}

func (r *PostgresExpenseRepository) Count() (int64, error) {
	var count int64
	err := r.db.Model(&models.Expense{}).Count(&count).Error
	return count, err
}

func (r *PostgresExpenseRepository) Update(id uint, expense *models.Expense) error {
	// Usamos un mapa explícito para que los campos en cero también se actualicen.
	// Con Updates(struct) GORM ignora los campos con valor cero, causando que los
	// canales anteriores (ej. cashAmount) no se limpien al cambiar a otro canal.
	updates := map[string]interface{}{
		"description":   expense.Description,
		"amount":        expense.Amount,
		"tax_amount":    expense.TaxAmount,
		"date":          expense.Date,
		"paymentSource": expense.PaymentSource,
		"category":      expense.Category,
		"status":        expense.Status,
		"supplier_id":   expense.SupplierID,
		"lenderName":    expense.LenderName,
		// Montos por canal — se fuerzan a cero si no aplican
		"cash_amount":      expense.CashAmount,
		"nequi_amount":     expense.NequiAmount,
		"daviplata_amount": expense.DaviplataAmount,
		"fondo_amount":     expense.FondoAmount,
		"coins_amount":     expense.CoinsAmount,
		"paid_amount":      expense.PaidAmount,
		"remaining_amount": expense.RemainingAmount,
	}
	err := r.db.Model(&models.Expense{}).Where("id = ?", id).Updates(updates).Error
	if err == nil {
		r.invalidateDashboardCache()
	}
	return err
}

func (r *PostgresExpenseRepository) Settle(id uint, paymentSource string) error {
	err := r.db.Model(&models.Expense{}).
		Where("id = ?", id).
		Updates(map[string]interface{}{
			"status":        "PAID",
			"paymentSource": paymentSource,
		}).Error
	if err == nil {
		r.invalidateDashboardCache()
	}
	return err
}
func (r *PostgresExpenseRepository) GetMonthlyTotals() (map[string]float64, error) {
	results := make(map[string]float64)
	rows, err := r.db.Table("expenses").
		Select("TO_CHAR(date, 'YYYY-MM') as month, COALESCE(SUM(amount + tax_amount), 0) as total").
		Group("month").
		Rows()
	if err != nil {
		log.Printf("❌ [GetMonthlyTotals Expenses] Error: %v", err)
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var month string
		var total float64
		if err := rows.Scan(&month, &total); err != nil {
			return nil, err
		}
		results[month] = total
	}
	return results, nil
}
func (r *PostgresExpenseRepository) GetPendingDebtsSummary() (float64, int64, error) {
	var result struct {
		Amount float64
		Count  int64
	}
	err := r.db.Model(&models.Expense{}).
		Where("(UPPER(status) = ? OR UPPER(\"paymentSource\") IN ('PRESTAMO', 'PREST.')) AND UPPER(status) NOT IN ('PAID', 'SETTLED')", "PENDING").
		Select("COALESCE(SUM(CASE WHEN remaining_amount > 0 THEN remaining_amount ELSE amount END + tax_amount), 0) as amount, COUNT(*) as count").
		Scan(&result).Error
	return result.Amount, result.Count, err
}

func (r *PostgresExpenseRepository) GetExpensesByStatus(status string) ([]models.Expense, error) {
	expenses := []models.Expense{}
	// If searching for PENDING, also include PRESTAMO/PREST. sources but EXCLUDE already PAID or SETTLED ones
	if strings.ToUpper(status) == "PENDING" {
		err := r.db.Where("(UPPER(status) = ? OR UPPER(\"paymentSource\") IN ('PRESTAMO', 'PREST.')) AND UPPER(status) NOT IN ('PAID', 'SETTLED')", "PENDING").
			Order("date DESC").Find(&expenses).Error
		return expenses, err
	}
	err := r.db.Where("UPPER(status) = ?", strings.ToUpper(status)).Order("date DESC").Find(&expenses).Error
	return expenses, err
}
func (r *PostgresExpenseRepository) GetGlobalTotalPaidExpenses() (float64, error) {
	var total float64
	err := r.db.Model(&models.Expense{}).
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(\"paymentSource\") NOT IN ('PRESTAMO', 'PREST.')").
		Select("COALESCE(SUM(amount + tax_amount), 0)").Scan(&total).Error
	if err != nil {
		log.Printf("❌ [GetGlobalTotalPaidExpenses] Error: %v", err)
		return 0, nil
	}
	return total, nil
}

func (r *PostgresExpenseRepository) GetGlobalPaidExpensesByMethod() (map[string]float64, error) {
	results := make(map[string]float64)

	// Primero: Egresos que tienen columnas desglosadas (cash_amount, nequi_amount, etc.)
	type MethodTotal struct {
		TotalCash      float64
		TotalNequi     float64
		TotalDaviplata float64
		TotalFondo     float64
		TotalCoins     float64
	}
	var mt MethodTotal
	err := r.db.Table("expenses").
		Select(`
			COALESCE(SUM(cash_amount), 0) as total_cash,
			COALESCE(SUM(nequi_amount), 0) as total_nequi,
			COALESCE(SUM(daviplata_amount), 0) as total_daviplata,
			COALESCE(SUM(fondo_amount), 0) as total_fondo,
			COALESCE(SUM(coins_amount), 0) as total_coins
		`).
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(COALESCE(\"paymentSource\", '')) NOT IN ('PRESTAMO', 'PREST.')").
		Where("(cash_amount > 0 OR nequi_amount > 0 OR daviplata_amount > 0 OR fondo_amount > 0 OR coins_amount > 0)").
		Scan(&mt).Error
	if err != nil {
		log.Printf("❌ [GetGlobalPaidExpensesByMethod] Error columnas desglosadas: %v", err)
	} else {
		results["EFECTIVO"] += mt.TotalCash
		results["NEQUI"] += mt.TotalNequi
		results["DAVIPLATA"] += mt.TotalDaviplata
		results["FONDO"] += mt.TotalFondo
		results["MONEDAS"] += mt.TotalCoins
	}

	// Segundo: Egresos legacy que NO tienen columnas desglosadas (usan paymentSource string)
	rows, err := r.db.Table("expenses").
		Select("COALESCE(\"paymentSource\", 'EFECTIVO'), COALESCE(SUM(amount + tax_amount), 0) as total").
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(COALESCE(\"paymentSource\", '')) NOT IN ('PRESTAMO', 'PREST.')").
		Where("cash_amount = 0 AND nequi_amount = 0 AND daviplata_amount = 0 AND fondo_amount = 0 AND coins_amount = 0").
		Group("\"paymentSource\"").
		Rows()
	if err != nil {
		log.Printf("❌ [GetGlobalPaidExpensesByMethod] Error legacy: %v", err)
		return results, nil
	}
	defer rows.Close()

	for rows.Next() {
		var source string
		var total float64
		if err := rows.Scan(&source, &total); err != nil {
			continue
		}
		if source == "" {
			source = "EFECTIVO"
		}
		srcUpper := strings.ToUpper(strings.TrimSpace(source))
		if strings.Contains(srcUpper, "MONEDA") || strings.Contains(srcUpper, "ALCANCIA") || strings.Contains(srcUpper, "ALCANCÍA") {
			results["MONEDAS"] += total
		} else {
			results[srcUpper] += total
		}
	}

	// Agregar impuestos de nequi (4x1000) que se guardan en tax_amount
	var totalNequiTax float64
	r.db.Table("expenses").
		Select("COALESCE(SUM(tax_amount), 0)").
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("nequi_amount > 0 AND tax_amount > 0").
		Scan(&totalNequiTax)
	results["NEQUI"] += totalNequiTax

	return results, nil
}

func (r *PostgresExpenseRepository) GetPaidAmountByRange(from, to time.Time) (float64, error) {
	var total float64
	err := r.db.Model(&models.Expense{}).
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(\"paymentSource\") NOT IN ('PRESTAMO', 'PREST.')").
		Where("date >= ? AND date <= ?", from, to).
		Select("COALESCE(SUM(amount + tax_amount), 0)").Scan(&total).Error
	if err != nil {
		log.Printf("❌ [GetPaidAmountByRange] Error: %v", err)
		return 0, nil // Fallback a 0
	}
	return total, nil
}
func (r *PostgresExpenseRepository) GetTotalAmountByDateRange(from, to time.Time) (float64, error) {
	var total float64
	err := r.db.Model(&models.Expense{}).
		Where("date >= ? AND date <= ?", from, to).
		Select("COALESCE(SUM(amount + tax_amount), 0)").
		Scan(&total).Error
	if err != nil {
		return 0, err
	}
	return total, nil
}

func (r *PostgresExpenseRepository) GetGlobalPaidExpensesByMethodInRange(from, to time.Time) (map[string]float64, error) {
	results := make(map[string]float64)

	// Primero: Egresos con columnas desglosadas (cash_amount, nequi_amount, daviplata_amount, fondo_amount, coins_amount)
	type MethodTotal struct {
		TotalCash      float64
		TotalNequi     float64
		TotalDaviplata float64
		TotalFondo     float64
		TotalCoins     float64
	}
	var mt MethodTotal
	err := r.db.Table("expenses").
		Select(`
			COALESCE(SUM(cash_amount), 0) as total_cash,
			COALESCE(SUM(nequi_amount), 0) as total_nequi,
			COALESCE(SUM(daviplata_amount), 0) as total_daviplata,
			COALESCE(SUM(fondo_amount), 0) as total_fondo,
			COALESCE(SUM(coins_amount), 0) as total_coins
		`).
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(COALESCE(\"paymentSource\", '')) NOT IN ('PRESTAMO', 'PREST.')").
		Where("date >= ? AND date <= ?", from, to).
		Where("(cash_amount > 0 OR nequi_amount > 0 OR daviplata_amount > 0 OR fondo_amount > 0 OR coins_amount > 0)").
		Scan(&mt).Error
	if err == nil {
		results["EFECTIVO"] += mt.TotalCash
		results["NEQUI"] += mt.TotalNequi
		results["DAVIPLATA"] += mt.TotalDaviplata
		results["FONDO"] += mt.TotalFondo
		results["MONEDAS"] += mt.TotalCoins
	}

	// Segundo: Egresos legacy que NO tienen columnas desglosadas (usan paymentSource string)
	rows, err := r.db.Table("expenses").
		Select("COALESCE(\"paymentSource\", 'EFECTIVO'), COALESCE(SUM(amount + tax_amount), 0) as total").
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(COALESCE(\"paymentSource\", '')) NOT IN ('PRESTAMO', 'PREST.')").
		Where("date >= ? AND date <= ?", from, to).
		Where("cash_amount = 0 AND nequi_amount = 0 AND daviplata_amount = 0 AND fondo_amount = 0 AND coins_amount = 0").
		Group("\"paymentSource\"").
		Rows()
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var source string
			var total float64
			if err := rows.Scan(&source, &total); err == nil {
				srcUpper := strings.ToUpper(strings.TrimSpace(source))
				if strings.Contains(srcUpper, "MONEDA") || strings.Contains(srcUpper, "ALCANCIA") || strings.Contains(srcUpper, "ALCANCÍA") {
					results["MONEDAS"] += total
				} else if strings.Contains(srcUpper, "FONDO") || strings.Contains(srcUpper, "BOVEDA") || strings.Contains(srcUpper, "BÓVEDA") {
					results["FONDO"] += total
				} else if strings.Contains(srcUpper, "NEQUI") {
					results["NEQUI"] += total
				} else if strings.Contains(srcUpper, "DAVIPLATA") {
					results["DAVIPLATA"] += total
				} else {
					results[srcUpper] += total
				}
			}
		}
	}

	// Agregar impuestos de nequi (4x1000) que se guardan en tax_amount
	var totalNequiTax float64
	r.db.Table("expenses").
		Select("COALESCE(SUM(tax_amount), 0)").
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("date >= ? AND date <= ?", from, to).
		Where("nequi_amount > 0 AND tax_amount > 0").
		Scan(&totalNequiTax)
	results["NEQUI"] += totalNequiTax

	return results, nil
}
