package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
	"time"
)

type closureRepository struct {
	db *gorm.DB
}

func NewClosureRepository(db *gorm.DB) *closureRepository {
	return &closureRepository{db: db}
}

func (r *closureRepository) Save(closure *models.CashierClosure) error {
	return r.db.Save(closure).Error
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
	err := r.db.Model(&models.CashierClosure{}).
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

