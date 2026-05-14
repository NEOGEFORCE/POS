package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/cache"
	"log"
	"strings"
	"backPOS-go/internal/infrastructure/refresher"
	"backPOS-go/internal/infrastructure/sse"
	"gorm.io/gorm"
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
	err := r.db.Preload("Creator").Order("date DESC").Limit(100).Find(&expenses).Error
	return expenses, err
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
	err := query.Order("date DESC").Limit(500).Find(&expenses).Error
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
	err := r.db.Model(&models.Expense{}).Where("id = ?", id).Updates(expense).Error
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
		Where("UPPER(status) = ? OR UPPER(\"paymentSource\") IN ('PRESTAMO', 'PREST.')", "PENDING").
		Select("COALESCE(SUM(amount + tax_amount), 0) as amount, COUNT(*) as count").
		Scan(&result).Error
	return result.Amount, result.Count, err
}

func (r *PostgresExpenseRepository) GetExpensesByStatus(status string) ([]models.Expense, error) {
	expenses := []models.Expense{}
	// If searching for PENDING, also include PRESTAMO/PREST. sources
	if strings.ToUpper(status) == "PENDING" {
		err := r.db.Where("UPPER(status) = ? OR UPPER(\"paymentSource\") IN ('PRESTAMO', 'PREST.')", "PENDING").
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
	rows, err := r.db.Table("expenses").
		Select("COALESCE(\"paymentSource\", 'EFECTIVO'), COALESCE(SUM(amount + tax_amount), 0) as total").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(\"paymentSource\") NOT IN ('PRESTAMO', 'PREST.')").
		Group("\"paymentSource\"").
		Rows()
	if err != nil {
		log.Printf("❌ [GetGlobalPaidExpensesByMethod] Error: %v", err)
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var source string
		var total float64
		if err := rows.Scan(&source, &total); err != nil {
			return nil, err
		}
		if source == "" { source = "EFECTIVO" }
		results[strings.ToUpper(source)] = total
	}
	return results, nil
}

func (r *PostgresExpenseRepository) GetPaidAmountByRange(from, to time.Time) (float64, error) {
	var total float64
	err := r.db.Model(&models.Expense{}).
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
func (r *PostgresExpenseRepository) GetGlobalPaidExpensesByMethodInRange(from, to time.Time) (map[string]float64, error) {
	results := make(map[string]float64)
	rows, err := r.db.Table("expenses").
		Select("COALESCE(\"paymentSource\", 'EFECTIVO'), COALESCE(SUM(amount + tax_amount), 0) as total").
		Where("UPPER(status) = 'PAID'").
		Where("date >= ? AND date <= ?", from, to).
		Group("\"paymentSource\"").
		Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var source string
		var total float64
		rows.Scan(&source, &total)
		results[strings.ToUpper(source)] = total
	}
	return results, nil
}
