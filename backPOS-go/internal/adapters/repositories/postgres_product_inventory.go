package repositories

import (
	"encoding/json"
	"fmt"
	"math"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/core/utils"
	"backPOS-go/internal/infrastructure/cache"
	"strings"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// UpdateQuantity actualiza el stock de un producto de forma atómica (Protegiendo infinitos)
func (r *PostgresProductRepository) UpdateQuantity(barcode string, newQuantity float64) error {
	// MASTER SPRINT: Enforce 3 decimal precision
	roundedQty := math.Round(newQuantity*1000) / 1000
	err := r.db.Model(&models.Product{}).Where("barcode = ? AND quantity != -1", barcode).Update("quantity", roundedQty).Error
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
		// MASTER SPRINT: Enforce 3 decimal precision
		roundedQty := math.Round(newQty*1000) / 1000
		if err := tx.Model(&models.Product{}).Where("barcode = ? AND quantity != -1", barcode).Update("quantity", roundedQty).Error; err != nil {
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
		// MASTER SPRINT: Enforce 3 decimal precision in atomic adjustment
		if err := gormDB.Model(&models.Product{}).Where("barcode = ? AND quantity != -1", barcode).
			Update("quantity", gorm.Expr("ROUND((quantity - ?)::numeric, 3)", delta)).Error; err != nil {
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
func (r *PostgresProductRepository) BulkReceive(entries []ports.ReceiveEntry, orderID *uint, bypassExpense bool, paymentSource string, employeeDNI string, supplierID *uint, freightCost float64, totalWeight float64, isEgreso bool, editReceptionID string) ([]string, error) {
	var changedProducts []string
	err := r.db.Transaction(func(tx *gorm.DB) error {
		// Opción A: si estamos en modo edición, eliminar/dar de baja la recepción anterior y revertir stock antes de procesar el consolidado
		if editReceptionID != "" {
			var movements []models.StockMovement
			if err := tx.Where("reference_id = ? AND reason = ?", editReceptionID, "RECEPTION").Find(&movements).Error; err == nil {
				for _, m := range movements {
					if err := tx.Model(&models.Product{}).
						Where("barcode = ?", m.Barcode).
						UpdateColumn("quantity", gorm.Expr("ROUND((quantity - ?)::numeric, 3)", m.Quantity)).Error; err != nil {
						return err
					}
				}
			}
			if err := tx.Where("reference_id = ? AND reason = ?", editReceptionID, "RECEPTION").Delete(&models.StockMovement{}).Error; err != nil {
				return err
			}
			if err := tx.Where("reference_id = ?", editReceptionID).Delete(&models.Expense{}).Error; err != nil {
				return err
			}
		}

		totalAmount := 0.0
		var mainSupplierID *uint = supplierID
		
		employeeName := ""
		if employeeDNI != "" {
			var emp models.Employee
			if err := tx.Where("dni = ?", employeeDNI).First(&emp).Error; err == nil {
				employeeName = emp.Name
			}
		}
		
		receptionID := fmt.Sprintf("RECP-%d", time.Now().Unix())
		for _, entry := range entries {
			var product models.Product
			if err := tx.Where("barcode = ?", entry.Barcode).First(&product).Error; err != nil {
				return err
			}

			oldSalePrice := product.SalePrice

			// === TAREA 2 & 3: AJUSTE FÍSICO EN CALIENTE ===
			if entry.ActualPhysicalStock != nil && product.Quantity != -1 {
				theoreticalStock := product.Quantity
				physicalStock := *entry.ActualPhysicalStock
				diff := physicalStock - theoreticalStock

				if diff != 0 {
					moveType := "ADJUSTMENT_UP"
					reason := "Ajuste en Recepción"
					if diff < 0 {
						moveType = "ADJUSTMENT_DOWN"
						reason = "Ajuste por faltante en físico durante recepción (Auditoría)"
					}

					// Crear movimiento de ajuste físico en kárdex
					adjMovement := models.StockMovement{
						Date:         time.Now(),
						Barcode:      entry.Barcode,
						Quantity:     diff,
						Type:         moveType,
						Reason:       reason,
						ReferenceID:  receptionID,
						EmployeeDNI:  employeeDNI,
						EmployeeName: employeeName,
					}
					if err := tx.Create(&adjMovement).Error; err != nil {
						return err
					}

					// Despachar alerta de auditoría por Telegram de forma asíncrona
					var diffMsg string
					if diff < 0 {
						diffMsg = fmt.Sprintf("Faltan %.2f", math.Abs(diff))
					} else {
						diffMsg = fmt.Sprintf("Sobran %.2f", diff)
					}

					userDisplay := employeeName
					if userDisplay == "" {
						userDisplay = employeeDNI
						if userDisplay == "" {
							userDisplay = "Desconocido"
						}
					}

					alertMsg := fmt.Sprintf(
						"🚨 ALERTA DE AUDITORÍA - POS Pro\nUsuario: %s\nProducto: %s\nTeórico: %.2f | Físico digitado: %.2f\n%s unidades.",
						userDisplay,
						product.ProductName,
						theoreticalStock,
						physicalStock,
						diffMsg,
					)

					go utils.SendAuditAlert(alertMsg)
				}

				// El stock base antes de sumar la compra pasa a ser el stock físico real
				if isEgreso {
					product.Quantity = physicalStock
				}
				
				// Si es pack, también debemos ajustar el stock del producto base proporcionalmente
				if product.IsPack && product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" && product.PackMultiplier > 0 && diff != 0 {
					var baseProduct models.Product
					if err := tx.Where("barcode = ?", *product.BaseProductBarcode).First(&baseProduct).Error; err == nil {
						if baseProduct.Quantity != -1 && isEgreso {
							baseProduct.Quantity += diff * float64(product.PackMultiplier)
							if err := tx.Save(&baseProduct).Error; err != nil {
								return fmt.Errorf("error actualizando stock del producto base en ajuste: %w", err)
							}
						}
					}
				}
			}

			// === TAREA 3: APRENDIZAJE LOGÍSTICO (Auto-Frecuencia en Bulk) ===
			if entry.AddedQuantity > 0 {
				var lastMove models.StockMovement
				if err := tx.Where("barcode = ? AND reason = ?", entry.Barcode, "RECEPTION").Order("date DESC").First(&lastMove).Error; err == nil {
					days := int(time.Since(lastMove.Date).Hours() / 24)
					if days > 1 && days < 100 && entry.SupplierID != nil {
						tx.Model(&models.Supplier{}).Where("id = ?", *entry.SupplierID).Update("visit_frequency_days", days)
					}
				}
			}

			// === TAREA 3: INTELIGENCIA DE PACAS (Bulk) ===
			commonMultiples := []int{12, 24, 30, 50, 100}
			if product.OrderMultiple <= 1 {
				for _, m := range commonMultiples {
					if int(entry.AddedQuantity) == m {
						product.OrderMultiple = m
						break
					}
				}
			}

			if product.IsPack && product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" && product.PackMultiplier > 0 {
				var baseProduct models.Product
				if err := tx.Where("barcode = ?", *product.BaseProductBarcode).First(&baseProduct).Error; err != nil {
					return fmt.Errorf("error obteniendo producto base (barcode=%s): %w", *product.BaseProductBarcode, err)
				}

				expandedQuantity := entry.AddedQuantity * float64(product.PackMultiplier)
				
				if baseProduct.Quantity != -1 && isEgreso {
					baseProduct.Quantity += expandedQuantity
					if err := tx.Save(&baseProduct).Error; err != nil {
						return fmt.Errorf("error actualizando stock del producto base: %w", err)
					}
				}

				if product.Quantity != -1 && isEgreso {
					product.Quantity = math.Floor(baseProduct.Quantity / float64(product.PackMultiplier))
				}

				baseMovement := models.StockMovement{
					Date:         time.Now(),
					Barcode:      baseProduct.Barcode,
					Quantity:     expandedQuantity,
					Type:         "IN",
					Reason:       "PACK_RECEPTION_BULK",
					ReferenceID:  fmt.Sprintf("PACKB-%d", time.Now().Unix()),
					EmployeeDNI:  employeeDNI,
					EmployeeName: employeeName,
				}
				if !isEgreso {
					baseMovement.Reason = "PRICE_UPDATE_NO_STOCK"
					baseMovement.Quantity = 0
				}
				if err := tx.Create(&baseMovement).Error; err != nil {
					return err
				}
			} else {
				if product.Quantity != -1 && isEgreso {
					product.Quantity += entry.AddedQuantity
				}
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

			// Detectar cambio de precio para alerta de Telegram y LOG histórico
			if oldSalePrice > 0 && product.SalePrice > 0 && oldSalePrice != product.SalePrice {
				emoji := "📈"
				if product.SalePrice < oldSalePrice {
					emoji = "📉"
				}
				changeMsg := fmt.Sprintf("%s %s: Antes $%s ➡️ Ahora $%s", 
					emoji, product.ProductName, 
					formatMoney(oldSalePrice), 
					formatMoney(product.SalePrice))
				changedProducts = append(changedProducts, changeMsg)

				// REGISTRO HISTÓRICO EN DB
				if err := r.RecordPriceChange(tx, product.Barcode, oldSalePrice, product.SalePrice); err != nil {
					return fmt.Errorf("error registrando cambio de precio para %s: %w", product.ProductName, err)
				}
			}

			if entry.SupplierID != nil {
				product.SupplierID = entry.SupplierID
			}

			if err := tx.Save(&product).Error; err != nil {
				return err
			}

			// Guardar snapshot de los valores (IVA, DTO, Precios) para reconstrucción/edición futura
			metaBytes, _ := json.Marshal(entry)

			// 4. Registro de Movimiento en Kárdex
			movementQty := entry.AddedQuantity
			movementReason := "RECEPTION"
			if !isEgreso {
				movementQty = 0
				movementReason = "PRICE_UPDATE_NO_STOCK"
			}
			
			movement := models.StockMovement{
				Date:         time.Now(),
				Barcode:      entry.Barcode,
				Quantity:     movementQty,
				Type:         "IN",
				Reason:       movementReason,
				ReferenceID:  receptionID,
				EmployeeDNI:  employeeDNI,
				EmployeeName: employeeName,
				Metadata:     string(metaBytes),
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

		// Determinar si paymentSource es un JSON de pagos mixtos para egresos
		type mixedPayment struct {
			Method string  `json:"method"`
			Amount float64 `json:"amount"`
		}
		var mixed []mixedPayment
		isMixed := false

		if strings.HasPrefix(paymentSource, "[") {
			if err := json.Unmarshal([]byte(paymentSource), &mixed); err == nil && len(mixed) > 0 {
				isMixed = true
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
			
			if isMixed {
				// Crear un egreso por cada método de pago
				for _, mp := range mixed {
					if mp.Amount <= 0 {
						continue
					}
					status := "PAID"
					if mp.Method == "PRESTAMO" || mp.Method == "PREST." {
						status = "PENDING"
					}

					expense := models.Expense{
						Description:   fmt.Sprintf("%s (%s)", description, mp.Method),
						Amount:        mp.Amount,
						Date:          time.Now(),
						PaymentSource: mp.Method,
						Status:        status,
						Category:      "Proveedores",
						SupplierID:    mainSupplierID,
						CreatedByDNI:  strings.ToUpper(strings.TrimSpace(employeeDNI)),
						ReferenceID:   receptionID,
					}
					if err := tx.Create(&expense).Error; err != nil {
						return fmt.Errorf("error creando egreso mixto: %w", err)
					}
				}
			} else {
				// Flujo normal (un solo método de pago)
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
					ReferenceID:   receptionID,
				}
				if err := tx.Create(&expense).Error; err != nil {
					return fmt.Errorf("error creando egreso: %w", err)
				}
			}
		}

		// 4.6. Creación de Egreso por Flete (si aplica y no hay bypass)
		if !bypassExpense && freightCost > 0 {
			description := "FLETE / TRANSPORTE - MERCANCÍA"
			if mainSupplierID != nil {
				var supplier models.Supplier
				if err := tx.First(&supplier, *mainSupplierID).Error; err == nil {
					description = fmt.Sprintf("FLETE / TRANSPORTE - %s", supplier.Name)
				}
			}

			freightPaymentSource := paymentSource
			if isMixed && len(mixed) > 0 {
				freightPaymentSource = mixed[0].Method
			} else if paymentSource == "" {
				freightPaymentSource = "EFECTIVO"
			}

			expenseFreight := models.Expense{
				Description:   description,
				Amount:        freightCost,
				Date:          time.Now(),
				PaymentSource: freightPaymentSource,
				Status:        "PAID",
				Category:      "Logística",
				SupplierID:    mainSupplierID,
				CreatedByDNI:  strings.ToUpper(strings.TrimSpace(employeeDNI)),
			}
			if err := tx.Create(&expenseFreight).Error; err != nil {
				return fmt.Errorf("error creando egreso de flete: %w", err)
			}
		}

		// 5. Cierre de Órdenes Relacionadas
		if orderID != nil && *orderID > 0 {
			tx.Model(&models.PurchaseOrder{}).Where("id = ?", *orderID).Update("status", models.PurchaseOrderReceived)
			tx.Model(&models.ExpectedOrder{}).Where("id = ?", *orderID).Update("status", "RECEIVED")
		}
		if mainSupplierID != nil && *mainSupplierID > 0 {
			tx.Model(&models.ConfirmedOrder{}).Where("supplier_id = ? AND status != 'received' AND status != 'dismissed'", *mainSupplierID).Update("status", "received")
		}

		return nil
	})

	if err == nil {
		cache.InvalidateCache(cache.CacheKeyProducts)
		cache.InvalidateCache(cache.CacheKeyProductCount + "_active")
		r.invalidateDashboardCache()
	}
	return changedProducts, err
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
func (r *PostgresProductRepository) DeleteReception(receptionID string) error {
	err := r.db.Transaction(func(tx *gorm.DB) error {
		// 1. Obtener todos los movimientos de esta recepción
		var movements []models.StockMovement
		if err := tx.Where("reference_id = ? AND reason = ?", receptionID, "RECEPTION").Find(&movements).Error; err != nil {
			return err
		}

		if len(movements) == 0 {
			return fmt.Errorf("no se encontraron movimientos para la recepción %s", receptionID)
		}

		// 2. Revertir stock para cada producto
		for _, m := range movements {
			// MASTER SPRINT: Enforce 3 decimal precision in reversal
			if err := tx.Model(&models.Product{}).
				Where("barcode = ?", m.Barcode).
				UpdateColumn("quantity", gorm.Expr("ROUND((quantity - ?)::numeric, 3)", m.Quantity)).Error; err != nil {
				return err
			}
		}

		// 3. Eliminar los movimientos
		if err := tx.Where("reference_id = ? AND reason = ?", receptionID, "RECEPTION").Delete(&models.StockMovement{}).Error; err != nil {
			return err
		}

		// 4. Eliminar el egreso vinculado
		if err := tx.Where("reference_id = ?", receptionID).Delete(&models.Expense{}).Error; err != nil {
			return err
		}

		return nil
	})

	if err == nil {
		cache.InvalidateCache(cache.CacheKeyProducts)
		r.invalidateDashboardCache()
	}
	return err
}

func formatMoney(amount float64) string {
	return fmt.Sprintf("%.0f", amount)
}
// SanitizeAllNames recorre todos los productos y elimina tildes/normaliza nombres
func (r *PostgresProductRepository) SanitizeAllNames() (int64, error) {
	var products []models.Product
	if err := r.db.Find(&products).Error; err != nil {
		return 0, err
	}

	count := int64(0)
	for _, p := range products {
		cleanName := utils.NormalizeString(p.ProductName)
		if cleanName != p.ProductName {
			// Usar un query directo para evitar hooks de GORM si fuera necesario, 
			// pero aquí queremos que se actualice el campo correctamente.
			if err := r.db.Model(&models.Product{}).Where("barcode = ?", p.Barcode).Update("productName", cleanName).Error; err == nil {
				count++
			}
		}
	}
	return count, nil
}

func (r *PostgresProductRepository) GetReception(receptionID string) ([]models.StockMovement, error) {
	var movements []models.StockMovement
	err := r.db.Preload("Product").Where("reference_id = ? AND reason = ?", receptionID, "RECEPTION").Find(&movements).Error
	return movements, err
}
