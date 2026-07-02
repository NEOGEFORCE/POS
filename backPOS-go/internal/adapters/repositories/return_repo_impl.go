package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
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
			if err := tx.Model(&models.Product{}).Where("barcode = ?", barcode).
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

func (r *GormReturnRepository) ProcessAdvancedReturnTransaction(req ports.ProcessReturnReq, originalSale *models.Sale, employeeDNI string, employeeName string, stockAdjustments map[string]float64, movements []*models.StockMovement) (*models.Return, error) {
	var createdReturn *models.Return
	err := r.db.Transaction(func(tx *gorm.DB) error {
		// 1. Kárdex Movements
		for _, mv := range movements {
			if err := tx.Create(mv).Error; err != nil {
				return fmt.Errorf("error guardando movimiento de stock: %w", err)
			}
		}

		// 2. Adjust Stock
		for barcode, delta := range stockAdjustments {
			if err := tx.Model(&models.Product{}).Where("barcode = ?", barcode).
				Update("quantity", gorm.Expr("ROUND((quantity + ?)::numeric, 3)", delta)).Error; err != nil {
				return fmt.Errorf("error actualizando stock de producto %s: %w", barcode, err)
			}
		}

		// 3. Mark original sale as hasReturn
		if originalSale != nil && originalSale.SaleID > 0 {
			if err := tx.Model(&models.Sale{}).Where("\"saleId\" = ?", originalSale.SaleID).Update("hasReturn", true).Error; err != nil {
				return fmt.Errorf("error actualizando estado de venta original: %w", err)
			}
		}

		// 4. Create the Return record
		var details []models.ReturnDetail
		for _, item := range req.ReturnedItems {
			details = append(details, models.ReturnDetail{
				Barcode:    item.Barcode,
				Quantity:   item.Qty,
				IsExchange: false,
			})
		}
		for _, item := range req.ReplacementItems {
			details = append(details, models.ReturnDetail{
				Barcode:    item.Barcode,
				Quantity:   item.Qty,
				IsExchange: true,
			})
		}

		ret := &models.Return{
			SaleID:        req.InvoiceRef,
			Date:          time.Now(),
			TotalReturned: req.RefundAmount,
			Reason:        "DEVOLUCION_AVANZADA",
			ReturnType:    req.Type,
			EmployeeDNI:   employeeDNI,
			Details:       details,
		}
		if err := tx.Create(ret).Error; err != nil {
			return fmt.Errorf("error guardando registro de devolución: %w", err)
		}
		createdReturn = ret

		// Update returnRef on originalSale
		if originalSale != nil && originalSale.SaleID > 0 {
			if err := tx.Model(&models.Sale{}).Where("\"saleId\" = ?", originalSale.SaleID).Update("returnRef", ret.ID).Error; err != nil {
				return fmt.Errorf("error vinculando devolucion a factura: %w", err)
			}
		}

		// 5. Cash Handling
		if req.Type == "REFUND" && req.RefundAmount > 0 {
			// Egreso de caja
			expense := &models.Expense{
				Date:         time.Now(),
				Amount:       req.RefundAmount,
				Description:  "DEVOLUCION_EFECTIVO",
				CreatedByDNI: employeeDNI,
				Category:     "Devoluciones",
			}
			if err := tx.Create(expense).Error; err != nil {
				return fmt.Errorf("error registrando egreso de caja: %w", err)
			}
		} else if req.Type == "EXCHANGE" && req.ChargeAmount > 0 {
			clientDni := "0"
			if originalSale != nil && originalSale.ClientDNI != "" {
				clientDni = originalSale.ClientDNI
			}

			// Ingreso de caja (Mini-venta)
			miniSale := &models.Sale{
				SaleDate:      time.Now(),
				EmployeeDNI:   employeeDNI,
				ClientDNI:     clientDni,
				TotalAmount:   req.ChargeAmount,
				PaymentMethod: req.ChargeMethod,
				Status:        "PAID",
			}
			switch req.ChargeMethod {
			case "EFECTIVO", "CASH":
				miniSale.CashAmount = req.ChargeAmount
				miniSale.AmountPaid = req.ChargeAmount
			case "TRANSFERENCIA", "TRANSFER":
				miniSale.TransferAmount = req.ChargeAmount
				miniSale.AmountPaid = req.ChargeAmount
			default:
				// Fallback to transfer just in case
				miniSale.TransferAmount = req.ChargeAmount
				miniSale.AmountPaid = req.ChargeAmount
			}
			if err := tx.Create(miniSale).Error; err != nil {
				return fmt.Errorf("error registrando cobro adicional: %w", err)
			}
		}

		return nil
	})

	if err == nil {
		cache.InvalidateCache(cache.CacheKeyProducts)
		r.invalidateDashboardCache()
	}
	return createdReturn, err
}

func (r *GormReturnRepository) DeleteWithTransaction(id uint, adminDNI string, adminName string) error {
	// TODO: implement full deletion logic with transaction
	return nil
}
