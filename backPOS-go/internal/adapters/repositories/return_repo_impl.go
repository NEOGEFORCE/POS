package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/cache"
	"log"
	"gorm.io/gorm"
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
	
	// Refresh Materialized View in background
	go func() {
		if err := r.db.Exec("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_dashboard_stats_monthly").Error; err != nil {
			log.Printf("⚠️ [MV Refresh - Return] Fallo concurrente: %v", err)
			r.db.Exec("REFRESH MATERIALIZED VIEW mv_dashboard_stats_monthly")
		}
	}()
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

func (r *GormReturnRepository) GetByDateRange(from, to string) ([]models.Return, error) {
	var returns []models.Return
	query := r.db.Preload("Details").Model(&models.Return{})
	if from != "" {
		query = query.Where("date >= ?", from)
	}
	if to != "" {
		query = query.Where("date <= ?", to)
	}
	err := query.Order("date desc").Find(&returns).Error
	return returns, err
}
