package repositories

import (
	"fmt"
	"math"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// UpdateQuantity actualiza el stock de un producto de forma atómica
func (r *PostgresProductRepository) UpdateQuantity(barcode string, newQuantity float64) error {
	return r.db.Model(&models.Product{}).Where("barcode = ?", barcode).Update("quantity", newQuantity).Error
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

	return tx.Commit().Error
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

// BulkReceive procesa una recepción masiva de mercancía, gestionando costos, impuestos y productos tipo pack
func (r *PostgresProductRepository) BulkReceive(entries []ports.ReceiveEntry, orderID *uint) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
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

			// 2. Gestión de Costos y Proveedores
			totalEntryCost := entry.NewPurchasePrice + entry.Iva + entry.Icui + entry.Ibua - entry.Discount

			if totalEntryCost > 0 && entry.SupplierID != nil {
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

				var maxCost float64
				tx.Model(&models.ProductSupplier{}).
					Where("\"productBarcode\" = ?", entry.Barcode).
					Select("COALESCE(MAX(\"purchasePrice\"), 0)").
					Scan(&maxCost)

				product.PurchasePrice = maxCost
				product.Iva = entry.Iva
				product.Icui = entry.Icui
				product.Ibua = entry.Ibua
			}

			// 3. Actualización de Precios de Venta
			if entry.NewSalePrice > 0 {
				product.SalePrice = entry.NewSalePrice
				if product.PurchasePrice > 0 {
					product.MarginPercentage = ((product.SalePrice / product.PurchasePrice) - 1) * 100
				}
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
		}

		// 5. Cierre de Órdenes Relacionadas
		if orderID != nil && *orderID > 0 {
			tx.Model(&models.PurchaseOrder{}).Where("id = ?", *orderID).Update("status", models.PurchaseOrderReceived)
			tx.Model(&models.ExpectedOrder{}).Where("id = ?", *orderID).Update("status", "RECEIVED")
		}

		return nil
	})
}
