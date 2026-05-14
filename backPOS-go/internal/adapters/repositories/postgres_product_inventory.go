package repositories

import (
	"fmt"
	"math"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"
	"strings"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// UpdateQuantity actualiza el stock de un producto de forma atómica
func (r *PostgresProductRepository) UpdateQuantity(barcode string, newQuantity float64) error {
	err := r.db.Model(&models.Product{}).Where("barcode = ?", barcode).Update("quantity", newQuantity).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeyProducts)
		r.invalidateDashboardCache()
	}
	return err
}

// BatchUpdateQuantities realiza actualizaciones masivas de stock en una sola transacción
func (r *PostgresProductRepository) BatchUpdateQuantities(updates map[string]float64) error {
	if len(updates) == 0 {
		return nil
	}

	tx := r.db.Begin()
	if tx.Error != nil {
		return tx.Error
	}

	for barcode, newQty := range updates {
		if err := tx.Model(&models.Product{}).Where("barcode = ?", barcode).Update("quantity", newQty).Error; err != nil {
			tx.Rollback()
			return err
		}
	}

	err := tx.Commit().Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeyProducts)
		r.invalidateDashboardCache()
	}
	return err
}

// BatchAdjustQuantities realiza ajustes relativos de stock de forma atómica (quantity = quantity + delta)
func (r *PostgresProductRepository) BatchAdjustQuantities(adjustments map[string]float64) error {
	return r.BatchAdjustQuantitiesWithTx(r.db, adjustments)
}

func (r *PostgresProductRepository) BatchAdjustQuantitiesWithTx(tx interface{}, adjustments map[string]float64) error {
	if len(adjustments) == 0 {
		return nil
	}

	gormDB, ok := tx.(*gorm.DB)
	if !ok {
		gormDB = r.db.Begin()
		if gormDB.Error != nil {
			return gormDB.Error
		}
		defer func() {
			if r := recover(); r != nil {
				gormDB.Rollback()
			}
		}()
	}

	for barcode, delta := range adjustments {
		if err := gormDB.Model(&models.Product{}).Where("barcode = ?", barcode).
			Update("quantity", gorm.Expr("quantity - ?", delta)).Error; err != nil {
			if !ok {
				gormDB.Rollback()
			}
			return err
		}
	}

	if !ok {
		err := gormDB.Commit().Error
		if err == nil {
			cache.InvalidateCache(cache.CacheKeyProducts)
			r.invalidateDashboardCache()
		}
		return err
	}

	// Si es parte de una transacción externa, no invalidamos caché aquí para no hacerlo N veces
	// El llamador debe encargarse o podemos hacerlo al final
	return nil
}

// SyncSuppliers sincroniza la lista de proveedores autorizados para un producto
func (r *PostgresProductRepository) SyncSuppliers(barcode string, supplierIDs []uint) error {
	var suppliers []models.Supplier
	if len(supplierIDs) > 0 {
		if err := r.db.Where("id IN ?", supplierIDs).Find(&suppliers).Error; err != nil {
			return err
		}
	}

	return r.db.Model(&models.Product{Barcode: barcode}).Association("Suppliers").Replace(suppliers)
}

// BulkReceive procesa una recepción masiva de mercancía, gestionando costos, impuestos y productos tipo pack.
// Si bypassExpense es false, registra automáticamente un egreso contable.
func (r *PostgresProductRepository) BulkReceive(entries []ports.ReceiveEntry, orderID *uint, bypassExpense bool, paymentSource string, employeeDNI string) error {
	err := r.db.Transaction(func(tx *gorm.DB) error {
		totalAmount := 0.0
		var mainSupplierID *uint
		
		for _, entry := range entries {
			var product models.Product
			if err := tx.Where("barcode = ?", entry.Barcode).First(&product).Error; err != nil {
				return err
			}

			// === LÓGICA DE SINCRONIZACIÓN DE PACKS ===
			if product.IsPack && product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" && product.PackMultiplier > 0 {
				var baseProduct models.Product
				if err := tx.Where("barcode = ?", *product.BaseProductBarcode).First(&baseProduct).Error; err != nil {
					return fmt.Errorf("error obteniendo producto base (barcode=%s): %w", *product.BaseProductBarcode, err)
				}

				expandedQuantity := entry.AddedQuantity * float64(product.PackMultiplier)
				baseProduct.Quantity += expandedQuantity

				if err := tx.Save(&baseProduct).Error; err != nil {
					return fmt.Errorf("error actualizando stock del producto base: %w", err)
				}

				product.Quantity = math.Floor(baseProduct.Quantity / float64(product.PackMultiplier))

				baseMovement := models.StockMovement{
					Date:         time.Now(),
					Barcode:      baseProduct.Barcode,
					Quantity:     expandedQuantity,
					Type:         "IN",
					Reason:       "PACK_RECEPTION_BULK",
					ReferenceID:  fmt.Sprintf("PACKB-%d", time.Now().Unix()),
					EmployeeDNI:  product.UpdatedByDNI,
					EmployeeName: product.UpdatedByName,
				}
				if err := tx.Create(&baseMovement).Error; err != nil {
					return err
				}
			} else {
				product.Quantity += entry.AddedQuantity
			}

			// === LÓGICA DE COSTO PROMEDIO PONDERADO (WAC) ===
			currentStock := product.Quantity - entry.AddedQuantity
			if currentStock < 0 {
				currentStock = 0
			}

			totalEntryCost := entry.NewPurchasePrice + entry.Iva + entry.Icui + entry.Ibua - entry.Discount
			
			if totalEntryCost > 0 {
				// MODO PLAZA/DIRECTO: Si se especifica un costo nuevo, este manda sobre el promedio
				// para productos de alta volatilidad de precio.
				product.PurchasePrice = totalEntryCost

				product.Iva = entry.IvaPct
				product.Icui = entry.IcuiPct
				product.Ibua = entry.IbuaPct

				if entry.SupplierID != nil {
					ps := models.ProductSupplier{
						ProductID:     entry.Barcode,
						SupplierID:    *entry.SupplierID,
						PurchasePrice: totalEntryCost,
					}
					if err := tx.Clauses(clause.OnConflict{
						Columns:   []clause.Column{{Name: "product_barcode"}, {Name: "supplier_id"}},
						DoUpdates: clause.AssignmentColumns([]string{"purchasePrice"}),
					}).Create(&ps).Error; err != nil {
						return err
					}
				}
			}

			// 3. Actualización de Precios de Venta (PROTEGIDA)
			// 3. Actualización de Precios de Venta (CON REDONDEO POS)
			if entry.NewSalePrice > 0 {
				// Aplicar la misma lógica de redondeo que en el update individual
				base := float64(int64(entry.NewSalePrice) / 100 * 100)
				remainder := float64(int64(entry.NewSalePrice) % 100)
				if remainder >= 25 {
					product.SalePrice = base + 100
				} else {
					product.SalePrice = base
				}

				if product.PurchasePrice > 0 {
					product.MarginPercentage = ((product.SalePrice / product.PurchasePrice) - 1) * 100
				}
			} else if product.PurchasePrice > 0 {
				// No actualizamos el precio de venta, solo recalculamos el margen informativo
				product.MarginPercentage = ((product.SalePrice / product.PurchasePrice) - 1) * 100
			}

			if entry.SupplierID != nil {
				product.SupplierID = entry.SupplierID
			}

			if err := tx.Save(&product).Error; err != nil {
				return err
			}

			// 4. Registro de Movimiento en Kárdex
			movement := models.StockMovement{
				Date:         time.Now(),
				Barcode:      entry.Barcode,
				Quantity:     entry.AddedQuantity,
				Type:         "IN",
				Reason:       "RECEPTION",
				ReferenceID:  fmt.Sprintf("RECP-%d", time.Now().Unix()),
				EmployeeDNI:  product.UpdatedByDNI,
				EmployeeName: product.UpdatedByName,
			}
			if err := tx.Create(&movement).Error; err != nil {
				return err
			}

			// Acumular total para el egreso (solo compras, no regalos ni devoluciones)
			// Nota: devoluciones restan, pero aquí asumimos flujo de entrada positiva
			lineTotal := (entry.NewPurchasePrice + entry.Iva + entry.Icui + entry.Ibua - entry.Discount) * entry.AddedQuantity
			if lineTotal > 0 {
				totalAmount += lineTotal
			}
			if mainSupplierID == nil && entry.SupplierID != nil {
				mainSupplierID = entry.SupplierID
			}
		}

		// 4.5. Creación de Egreso Automático (si no hay bypass)
		if !bypassExpense && totalAmount > 0 {
			description := "RECEPCIÓN DE MERCANCÍA MASIVA"
			if mainSupplierID != nil {
				var supplier models.Supplier
				if err := tx.First(&supplier, *mainSupplierID).Error; err == nil {
					description = fmt.Sprintf("RECEPCIÓN DE MERCANCÍA - %s", supplier.Name)
				}
			}
			
			status := "PAID"
			if paymentSource == "PRESTAMO" || paymentSource == "PREST." {
				status = "PENDING"
			}
			
			expense := models.Expense{
				Description:   description,
				Amount:        totalAmount,
				Date:          time.Now(),
				PaymentSource: paymentSource,
				Status:        status,
				Category:      "Proveedores",
				SupplierID:    mainSupplierID,
				CreatedByDNI:  strings.ToUpper(strings.TrimSpace(employeeDNI)),
			}
			if err := tx.Create(&expense).Error; err != nil {
				return fmt.Errorf("error creando egreso: %w", err)
			}
		}

		// 5. Cierre de Órdenes Relacionadas
		if orderID != nil && *orderID > 0 {
			tx.Model(&models.PurchaseOrder{}).Where("id = ?", *orderID).Update("status", models.PurchaseOrderReceived)
			tx.Model(&models.ExpectedOrder{}).Where("id = ?", *orderID).Update("status", "RECEIVED")
		}

		return nil
	})

	if err == nil {
		cache.InvalidateCache(cache.CacheKeyProducts)
		cache.InvalidateCache(cache.CacheKeyProductCount + "_active")
		r.invalidateDashboardCache()
	}
	return err
}

func (r *PostgresProductRepository) GetGlobalInventoryValue() (float64, error) {
	var total float64
	err := r.db.Model(&models.Product{}).
		Where("\"isActive\" = ? AND COALESCE(\"isWeighted\", false) = ?", true, false).
		Select("COALESCE(SUM(quantity * \"purchasePrice\"), 0)").
		Scan(&total).Error
	return total, err
}

func (r *PostgresProductRepository) GetGlobalInventoryRetailValue() (float64, error) {
	var total float64
	err := r.db.Model(&models.Product{}).
		Where("\"isActive\" = ? AND COALESCE(\"isWeighted\", false) = ?", true, false).
		Select("COALESCE(SUM(quantity * \"salePrice\"), 0)").
		Scan(&total).Error
	return total, err
}
