package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/refresher"
	"backPOS-go/internal/infrastructure/sse"
	"encoding/json"
	"errors"
	"fmt"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"time"
)

type GormReturnRepository struct {
	db *gorm.DB
}

func NewGormReturnRepository(db *gorm.DB) *GormReturnRepository {
	return &GormReturnRepository{db: db}
}

func (r *GormReturnRepository) invalidateDashboardCache() {
	// Invalidate RAM cache: TODAS las variantes del overview (hay una entrada
	// por rango de fechas).
	cache.InvalidateDashboard()

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

		// 2. Ajustar cantidades: delta positivo entra, delta negativo sale.
		for barcode, delta := range adjustments {
			if err := tx.Model(&models.Product{}).Where("barcode = ?", barcode).
				Update("quantity", gorm.Expr("ROUND((quantity + ?)::numeric, 3)", delta)).Error; err != nil {
				return fmt.Errorf("error actualizando stock de producto %s: %w", barcode, err)
			}
		}

		// 3. Guardar registro y enlazar la venta original.
		ret.FinancialTraceReady = true
		if ret.Date.IsZero() {
			ret.Date = time.Now()
		}
		if err := tx.Create(ret).Error; err != nil {
			return fmt.Errorf("error guardando devolución: %w", err)
		}
		if ret.ReturnType == "REFUND" && ret.TotalReturned > 0 {
			expense := &models.Expense{
				Date: ret.Date, Amount: ret.TotalReturned, Description: "DEVOLUCION_EFECTIVO",
				PaymentSource: "EFECTIVO", Category: "Devoluciones", Status: "PAID",
				CreatedByDNI: employeeDNI, ReturnRef: &ret.ID,
			}
			if err := tx.Create(expense).Error; err != nil {
				return fmt.Errorf("error registrando egreso de devolución: %w", err)
			}
		}
		if err := tx.Model(&models.Sale{}).Where("\"saleId\" = ?", ret.SaleID).Updates(map[string]interface{}{
			"hasReturn": true,
			"returnRef": ret.ID,
		}).Error; err != nil {
			return fmt.Errorf("error vinculando devolución a venta: %w", err)
		}

		return nil
	})

	if err == nil {
		// Arreglo 2: una devolución sólo ajusta cantidades del kardex. No
		// invalidamos CacheKeyProducts para no dejar frío el catálogo.
		r.invalidateDashboardCache()
	}
	return err
}

func (r *GormReturnRepository) GetByID(id uint) (*models.Return, error) {
	var ret models.Return
	err := r.db.Preload("Details.Product").Preload("Sale").First(&ret, id).Error
	return &ret, err
}

// maxReturnsPerQuery es el techo absoluto de filas que esta consulta puede
// materializar, incluso si el llamador pide más o pasa un límite inválido.
// Cada Return arrastra Employee, Details y Details.Product por Preload, así que
// una tabla de miles de filas se traduce en un pico de memoria y varias
// consultas de precarga con IN gigantes.
const maxReturnsPerQuery = 200

// GetAll devuelve las devoluciones más recientes primero, acotadas a limit.
//
// Antes no tenía ni Limit ni filtro de fecha y estaba colgada de una ruta HTTP:
// la pantalla de devoluciones traía el histórico completo en cada carga.
// El orden es descendente por fecha (y por id como desempate estable, porque
// varias devoluciones del mismo día comparten timestamp cuando `date` viene del
// default now() truncado).
func (r *GormReturnRepository) GetAll(limit int) ([]models.Return, error) {
	if limit <= 0 || limit > maxReturnsPerQuery {
		limit = maxReturnsPerQuery
	}

	var returns []models.Return
	err := r.db.
		Preload("Employee").
		Preload("Details").
		Preload("Details.Product").
		Order("date desc").
		Order("id desc").
		Limit(limit).
		Find(&returns).Error
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
			SaleID:              req.InvoiceRef,
			Date:                time.Now(),
			TotalReturned:       req.RefundAmount,
			Reason:              "DEVOLUCION_AVANZADA",
			ReturnType:          req.Type,
			FinancialTraceReady: true,
			EmployeeDNI:         employeeDNI,
			Details:             details,
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
				ReturnRef:    &ret.ID,
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
				SaleDate:        time.Now(),
				EmployeeDNI:     employeeDNI,
				ClientDNI:       clientDni,
				TotalAmount:     req.ChargeAmount,
				PaymentMethod:   req.ChargeMethod,
				Status:          "PAID",
				ParentReturnRef: &ret.ID,
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
		// Arreglo 2: devolución avanzada — sólo ajusta cantidades y crea
		// registros financieros. Catálogo cacheado no cambia.
		r.invalidateDashboardCache()
	}
	return createdReturn, err
}

func (r *GormReturnRepository) DeleteWithTransaction(id uint, adminDNI string, adminName string) error {
	var ret models.Return
	err := r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Preload("Details.Product.BaseProduct").First(&ret, id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errors.New("devolución no encontrada o ya anulada")
			}
			return fmt.Errorf("error bloqueando devolución: %w", err)
		}

		if !ret.FinancialTraceReady {
			return errors.New("devolución histórica sin trazabilidad financiera; vincule su egreso/cobro antes de anularla")
		}

		adjustments := make(map[string]float64)
		movements := make([]models.StockMovement, 0, len(ret.Details))
		for _, detail := range ret.Details {
			targetBarcode := detail.Barcode
			effectiveQty := detail.Quantity
			if detail.Product.IsPack && detail.Product.BaseProductBarcode != nil && *detail.Product.BaseProductBarcode != "" {
				targetBarcode = *detail.Product.BaseProductBarcode
				effectiveQty = detail.Quantity * float64(detail.Product.PackMultiplier)
			}
			delta := -effectiveQty
			movementType := models.MovementTypeOut
			reason := models.MovementReasonReturnRevert
			if detail.IsExchange {
				delta = effectiveQty
				movementType = models.MovementTypeIn
				reason = models.MovementReasonExchangeRevert
			}
			adjustments[targetBarcode] += delta
			movements = append(movements, models.StockMovement{
				Date: time.Now(), Barcode: targetBarcode, Quantity: effectiveQty,
				Type: movementType, Reason: reason, ReferenceID: fmt.Sprintf("REV-RET-%d", ret.ID),
				EmployeeDNI: adminDNI, EmployeeName: adminName,
			})
		}
		for barcode, delta := range adjustments {
			if err := tx.Model(&models.Product{}).Where("barcode = ?", barcode).
				Update("quantity", gorm.Expr("ROUND((quantity + ?)::numeric, 3)", delta)).Error; err != nil {
				return fmt.Errorf("error revirtiendo stock de %s: %w", barcode, err)
			}
		}
		if len(movements) > 0 {
			if err := tx.Create(&movements).Error; err != nil {
				return fmt.Errorf("error registrando reverso en kárdex: %w", err)
			}
		}

		expenseDelete := tx.Where("return_ref = ?", ret.ID).Delete(&models.Expense{})
		if expenseDelete.Error != nil {
			return fmt.Errorf("error anulando egreso de devolución: %w", expenseDelete.Error)
		}
		if ret.ReturnType == "REFUND" && ret.TotalReturned > 0 && expenseDelete.RowsAffected == 0 {
			return errors.New("la devolución no tiene un egreso correlacionado; reverso cancelado para proteger la caja")
		}
		if err := tx.Model(&models.Sale{}).Where("parent_return_ref = ?", ret.ID).Updates(map[string]interface{}{
			"deletedReason": fmt.Sprintf("REVERSO DEVOLUCION #%d", ret.ID),
			"deletedByDni":  adminDNI,
		}).Error; err != nil {
			return fmt.Errorf("error marcando cobro de cambio: %w", err)
		}
		if err := tx.Where("parent_return_ref = ?", ret.ID).Delete(&models.Sale{}).Error; err != nil {
			return fmt.Errorf("error anulando cobro de cambio: %w", err)
		}

		if err := tx.Model(&models.ReturnDetail{}).Where("\"returnId\" = ?", ret.ID).Delete(&models.ReturnDetail{}).Error; err != nil {
			return fmt.Errorf("error anulando detalles de devolución: %w", err)
		}
		if err := tx.Model(&models.Return{}).Where("id = ?", ret.ID).Updates(map[string]interface{}{
			"deletedByDni":  adminDNI,
			"deletedByName": adminName,
			"deletedReason": "ANULACION_ADMINISTRATIVA",
		}).Error; err != nil {
			return fmt.Errorf("error registrando anulación: %w", err)
		}
		if err := tx.Delete(&ret).Error; err != nil {
			return fmt.Errorf("error anulando devolución: %w", err)
		}

		var lastReturn models.Return
		lastErr := tx.Where("\"saleId\" = ?", ret.SaleID).Order("id DESC").First(&lastReturn).Error
		updates := map[string]interface{}{"hasReturn": false, "returnRef": 0}
		if lastErr == nil {
			updates["hasReturn"] = true
			updates["returnRef"] = lastReturn.ID
		} else if !errors.Is(lastErr, gorm.ErrRecordNotFound) {
			return fmt.Errorf("error recalculando devoluciones vigentes: %w", lastErr)
		}
		if err := tx.Model(&models.Sale{}).Where("\"saleId\" = ?", ret.SaleID).Updates(updates).Error; err != nil {
			return fmt.Errorf("error actualizando venta original: %w", err)
		}

		snapshot, _ := json.Marshal(ret)
		audit := &models.AuditLog{
			EmployeeDNI: adminDNI, EmployeeName: adminName, Action: "REVERT_RETURN", Module: "SALES",
			Details:       fmt.Sprintf("Anulación de devolución #%d", ret.ID),
			HumanReadable: fmt.Sprintf("%s anuló la devolución #%d y se revirtieron stock y caja", adminName, ret.ID),
			Changes:       string(snapshot), IsCritical: true, CreatedAt: time.Now(),
		}
		if err := tx.Create(audit).Error; err != nil {
			return fmt.Errorf("error guardando auditoría del reverso: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	// Arreglo 2: reverso de devolución sólo mueve stock; no invalida el
	// catálogo cacheado.
	r.invalidateDashboardCache()
	return nil
}
