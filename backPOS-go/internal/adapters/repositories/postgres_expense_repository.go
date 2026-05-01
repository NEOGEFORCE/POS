package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"strings"
	"gorm.io/gorm"
)

type PostgresExpenseRepository struct {
	db *gorm.DB
}

func NewPostgresExpenseRepository(db *gorm.DB) *PostgresExpenseRepository {
	return &PostgresExpenseRepository{db: db}
}

func (r *PostgresExpenseRepository) Save(expense *models.Expense) error {
	return r.db.Create(expense).Error
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

func (r *PostgresExpenseRepository) GetByDateRange(from, to string) ([]models.Expense, error) {
	expenses := []models.Expense{}
	query := r.db.Model(&models.Expense{})
	if from != "" {
		query = query.Where("date >= ?", from)
	}
	if to != "" {
		query = query.Where("date <= ?", to)
	}
	err := query.Order("date DESC").Limit(100).Find(&expenses).Error
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
	return r.db.Model(&models.Expense{}).Where("id = ?", id).Updates(expense).Error
}
func (r *PostgresExpenseRepository) GetMonthlyTotals() (map[string]float64, error) {
	results := make(map[string]float64)
	rows, err := r.db.Table("expenses").
		Select("TO_CHAR(date, 'YYYY-MM') as month, SUM(amount) as total").
		Group("month").
		Rows()
	if err != nil {
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
		Select("COALESCE(SUM(amount), 0) as amount, COUNT(*) as count").
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
		Select("COALESCE(SUM(amount), 0)").Scan(&total).Error
	return total, err
}

func (r *PostgresExpenseRepository) GetGlobalPaidExpensesByMethod() (map[string]float64, error) {
	results := make(map[string]float64)
	rows, err := r.db.Table("expenses").
		Select("\"paymentSource\", SUM(amount) as total").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(\"paymentSource\") NOT IN ('PRESTAMO', 'PREST.')").
		Group("\"paymentSource\"").
		Rows()
	if err != nil {
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

func (r *PostgresExpenseRepository) GetPaidAmountByRange(from, to string) (float64, error) {
	var total float64
	err := r.db.Model(&models.Expense{}).
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(\"paymentSource\") NOT IN ('PRESTAMO', 'PREST.')").
		Where("date >= ? AND date < ?", from, to).
		Select("COALESCE(SUM(amount), 0)").Scan(&total).Error
	return total, err
}
