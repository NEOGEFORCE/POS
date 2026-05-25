package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/refresher"
	"backPOS-go/internal/infrastructure/sse"
	"fmt"
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

func (r *GormReturnRepository) CreateWithTransaction(
	ret *models.Return,
	employeeDNI string,
	employeeName string,
	adjustments map[string]float64,
	movements []*models.StockMovement,
) error {
	err := r.db.Transaction(func(tx *gorm.DB) error {
		// 1. Guardar movimientos de stock
		for _, mv := range movements {
			if err := tx.Create(mv).Error; err != nil {
				return fmt.Errorf("error guardando movimiento de stock: %w", err)
			}
		}

		// 2. Ajustar cantidades de stock de productos
		for barcode, delta := range adjustments {
			if err := tx.Model(&models.Product{}).Where("barcode = ? AND quantity != -1", barcode).
				Update("quantity", gorm.Expr("ROUND((quantity - ?)::numeric, 3)", delta)).Error; err != nil {
				return fmt.Errorf("error actualizando stock de producto %s: %w", barcode, err)
			}
		}

		// 3. Guardar registro de la devolución
		if err := tx.Create(ret).Error; err != nil {
			return fmt.Errorf("error guardando devolución: %w", err)
		}

		return nil
	})

	if err == nil {
		cache.InvalidateCache(cache.CacheKeyProducts)
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
	err := r.db.Preload("Employee").Preload("Details").Preload("Details.Product").Order("date desc").Find(&returns).Error
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
