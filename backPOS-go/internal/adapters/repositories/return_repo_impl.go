package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/refresher"
	"backPOS-go/internal/infrastructure/sse"
	"gorm.io/gorm"
	"time"
)

type GormReturnRepository struct {
	db *gorm.DB
}

func NewGormReturnRepository(db *gorm.DB) *GormReturnRepository {
	return &GormReturnRepository{db: db}
}

func (r *GormReturnRepository) invalidateDashboardCache() {
	// Invalidate RAM cache
	cache.CacheManager.Delete(cache.CacheKeyDashboardOverview)
	
	// Solicitar refresco asíncrono y debounced
	refresher.GetRefresherService(r.db).RequestRefresh("mv_dashboard_stats_monthly")

	// Notificar sincronización global
	sse.GetSSEService().BroadcastDashboardUpdate()
}

func (r *GormReturnRepository) Create(ret *models.Return) error {
	err := r.db.Create(ret).Error
	if err == nil {
		r.invalidateDashboardCache()
	}
	return err
}

func (r *GormReturnRepository) GetByID(id uint) (*models.Return, error) {
	var ret models.Return
	err := r.db.Preload("Details.Product").Preload("Sale").First(&ret, id).Error
	return &ret, err
}

func (r *GormReturnRepository) GetAll() ([]models.Return, error) {
	var returns []models.Return
	err := r.db.Preload("Employee").Order("date desc").Find(&returns).Error
	return returns, err
}

func (r *GormReturnRepository) GetByDateRange(from, to time.Time) ([]models.Return, error) {
	var returns []models.Return
	query := r.db.Preload("Details").Model(&models.Return{})
	if !from.IsZero() {
		query = query.Where("date >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("date <= ?", to)
	}
	err := query.Order("date desc").Find(&returns).Error
	return returns, err
}

func (r *GormReturnRepository) GetTotalReturnedByRange(from, to time.Time) (float64, error) {
	var total float64
	query := r.db.Model(&models.Return{})
	if !from.IsZero() {
		query = query.Where("date >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("date <= ?", to)
	}
	err := query.Select("COALESCE(SUM(\"totalReturned\"), 0)").Scan(&total).Error
	return total, err
}
