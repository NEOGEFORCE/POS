package repositories

import (
	"encoding/json"
	"errors"
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
	err := r.db.Model(&models.Product{}).Where("barcode = ?", barcode).Update("quantity", roundedQty).Error
	if err == nil {
		// Arreglo 2: cambio sólo de cantidad — no invalidamos CacheKeyProducts.
		// El dashboard sí depende de saldos agregados, así que lo refrescamos.
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
		if err := tx.Model(&models.Product{}).Where("barcode = ?", barcode).Update("quantity", roundedQty).Error; err != nil {
			tx.Rollback()
			return err
		}
	}

	err := tx.Commit().Error
	if err == nil {
		// Arreglo 2: sólo se movieron cantidades, no la forma del catálogo.
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

	// Construir query masiva con CASE
	query := "UPDATE products SET quantity = ROUND((quantity - CASE barcode "
	var args []interface{}
	var barcodes []string

	for barcode, delta := range adjustments {
		query += "WHEN ? THEN ?::numeric "
		args = append(args, barcode, delta)
		barcodes = append(barcodes, barcode)
	}

	query += "ELSE 0 END)::numeric, 3), updated_at = NOW() WHERE barcode IN ?"
	args = append(args, barcodes)

	if err := gormDB.Exec(query, args...).Error; err != nil {
		if !ok {
			gormDB.Rollback()
		}
		return err
	}

	// Sincronizar automáticamente los packs que dependan de los productos base ajustados
	packUpdateQuery := `
		UPDATE products p
		SET quantity = FLOOR(b.quantity / p."packMultiplier"),
		    updated_at = NOW()
		FROM products b
		WHERE p."isPack" = true 
		  AND p."baseProductBarcode" = b.barcode 
		  AND p."packMultiplier" > 0 
		  AND b.barcode IN ?
	`
	if err := gormDB.Exec(packUpdateQuery, barcodes).Error; err != nil {
		if !ok {
			gormDB.Rollback()
		}
		return err
	}

	if !ok {
		err := gormDB.Commit().Error
		if err == nil {
			// Arreglo 2: BatchAdjust sólo mueve cantidades — no purgamos
			// CacheKeyProducts (ver comentario general en cache.go).
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
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var product models.Product
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("barcode = ?", barcode).First(&product).Error; err != nil {
			return fmt.Errorf("producto %s no encontrado: %w", barcode, err)
		}

		uniqueIDs := make([]uint, 0, len(supplierIDs))
		seen := make(map[uint]struct{})
		for _, id := range supplierIDs {
			if id == 0 {
				continue
			}
			if _, exists := seen[id]; exists {
				continue
			}
			seen[id] = struct{}{}
			uniqueIDs = append(uniqueIDs, id)
		}
		if len(uniqueIDs) > 0 {
			var count int64
			if err := tx.Model(&models.Supplier{}).Where("id IN ?", uniqueIDs).Count(&count).Error; err != nil {
				return err
			}
			if count != int64(len(uniqueIDs)) {
				return fmt.Errorf("uno o más proveedores seleccionados no existen")
			}
		}

		var previous []models.ProductSupplier
		if err := tx.Where("product_barcode = ?", barcode).Find(&previous).Error; err != nil {
			return err
		}
		prices := make(map[uint]float64, len(previous))
		for _, link := range previous {
			prices[link.SupplierID] = link.PurchasePrice
		}
		if err := tx.Where("product_barcode = ?", barcode).Delete(&models.ProductSupplier{}).Error; err != nil {
			return err
		}
		links := make([]models.ProductSupplier, 0, len(uniqueIDs))
		for _, id := range uniqueIDs {
			links = append(links, models.ProductSupplier{ProductID: barcode, SupplierID: id, PurchasePrice: prices[id]})
		}
		if len(links) > 0 {
			if err := tx.Create(&links).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	r.AfterCommitUpdate(barcode)
	return nil
}

// BulkReceive procesa una recepción masiva de mercancía, gestionando costos, impuestos y productos tipo pack.
// Si bypassExpense es false, registra automáticamente un egreso contable.
func (r *PostgresProductRepository) BulkReceive(entries []ports.ReceiveEntry, orderID *uint, orderIDs []interface{}, orderRefs []ports.OrderRef, bypassExpense bool, paymentSource string, employeeDNI string, supplierID *uint, freightCost float64, totalWeight float64, isEgreso bool, editReceptionID string) ([]string, error) {
	var changedProducts []string
	err := r.db.Transaction(func(tx *gorm.DB) error {
		// Opción A: si estamos en modo edición, eliminar/dar de baja la recepción anterior y revertir stock antes de procesar el consolidado
		//
		// FIX (Sprint arreglos): el filtro histórico era
		//   Where("reference_id = ? AND reason = ?", editReceptionID, "RECEPTION")
		// y sólo atrapaba movimientos con reason="RECEPTION". Dejaba
		// afuera:
		//   - RECEPTION_BONUS (bonificaciones del proveedor).
		//   - PACK_RECEPTION_BULK (el efecto sobre el producto BASE
		//     cuando se recibió una paca; antes usaba un reference_id
		//     distinto "PACKB-<ts>" — ahora comparte receptionID).
		//   - PRICE_UPDATE_NO_STOCK (movimientos qty=0 de las recepciones
		//     de sólo precio).
		//   - ADJUSTMENT_UP/DOWN (ajustes físicos del entry y del base).
		// La consecuencia real reportada por el dueño: editar una
		// recepción de pacas duplicaba el stock del producto base.
		//
		// El allowlist vive en reception_reasons.go (con tests) para
		// que si BulkReceive gana un reason nuevo, se sepa dónde
		// actualizarlo.
		if editReceptionID != "" {
			var movements []models.StockMovement
			if err := tx.Where(
				"reference_id = ? AND (reason IN ? OR type IN ?)",
				editReceptionID,
				ReceptionMovementReasons,
				ReceptionAdjustmentTypes,
			).Find(&movements).Error; err == nil {
				for _, m := range movements {
					if m.Quantity == 0 {
						// PRICE_UPDATE_NO_STOCK: nada que revertir en stock,
						// pero el movimiento se borra abajo para no dejar
						// huellas fantasma.
						continue
					}
					if err := tx.Model(&models.Product{}).
						Where("barcode = ?", m.Barcode).
						Updates(map[string]interface{}{
							"quantity":   gorm.Expr("ROUND((quantity - ?)::numeric, 3)", m.Quantity),
							"updated_at": time.Now(),
						}).Error; err != nil {
						return err
					}
				}
			}
			if err := tx.Where(
				"reference_id = ? AND (reason IN ? OR type IN ?)",
				editReceptionID,
				ReceptionMovementReasons,
				ReceptionAdjustmentTypes,
			).Delete(&models.StockMovement{}).Error; err != nil {
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
			if employeeName == "" {
				employeeName = employeeDNI
			}
		}

		// Lookup del nombre del proveedor global para el historial
		supplierName := ""
		if supplierID != nil {
			var sup models.Supplier
			if err := tx.First(&sup, *supplierID).Error; err == nil {
				supplierName = sup.Name
			}
		}

		receptionID := fmt.Sprintf("RECP-%d", time.Now().Unix())
		for _, entry := range entries {
			var product models.Product
			if err := tx.Where("barcode = ?", entry.Barcode).First(&product).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) && strings.HasPrefix(entry.Barcode, "FREE-ITEM-") {
					// Crear el "Item Libre" sobre la marcha para que pueda ser recibido e inventariado
					var defaultCat models.Category
					tx.Order("id asc").First(&defaultCat)

					product = models.Product{
						Barcode:       entry.Barcode,
						ProductName:   "Item Libre",
						Quantity:      0,
						PurchasePrice: entry.NewPurchasePrice,
						SalePrice:     entry.NewSalePrice,
						Iva:           entry.IvaPct,
						Icui:          entry.IcuiPct,
						Ibua:          entry.IbuaPct,
						CategoryID:    defaultCat.ID,
						IsActive:      true,
					}
					// Si fallara por defaultCat.ID = 0, se asume que CategoryID = 0 es válido o la BD no tiene constraint duro.
					if errCreate := tx.Create(&product).Error; errCreate != nil {
						return fmt.Errorf("fallo al crear item libre %s: %v", entry.Barcode, errCreate)
					}
				} else {
					return err
				}
			}

			oldSalePrice := product.SalePrice

			// === TAREA 2 & 3: AJUSTE FÍSICO EN CALIENTE ===
			if entry.ActualPhysicalStock != nil {
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
						if isEgreso {
							baseDiff := diff * float64(product.PackMultiplier)
							baseProduct.Quantity += baseDiff
							if err := tx.Save(&baseProduct).Error; err != nil {
								return fmt.Errorf("error actualizando stock del producto base en ajuste: %w", err)
							}

							// FIX: Antes ESTE ajuste sobre el producto BASE NO
							// se registraba como movimiento. Al editar/eliminar
							// la recepción no se revertía, y el base quedaba
							// descuadrado. Ahora emitimos un movimiento
							// gemelo sobre el base con el mismo receptionID
							// para que la reversión sea completa.
							baseMoveType := "ADJUSTMENT_UP"
							if baseDiff < 0 {
								baseMoveType = "ADJUSTMENT_DOWN"
							}
							baseAdjMovement := models.StockMovement{
								Date:         time.Now(),
								Barcode:      baseProduct.Barcode,
								Quantity:     baseDiff,
								Type:         baseMoveType,
								Reason:       "Ajuste en Recepción (base de paca)",
								ReferenceID:  receptionID,
								EmployeeDNI:  employeeDNI,
								EmployeeName: employeeName,
							}
							if err := tx.Create(&baseAdjMovement).Error; err != nil {
								return err
							}
						}
					}
				}
			}

			// === TAREA 3: APRENDIZAJE LOGÍSTICO (Auto-Frecuencia en Bulk) ===
			//
			// Este bloque venia sobreescribiendo visit_frequency_days
			// automaticamente con la separacion entre recepciones. Ese
			// mecanismo inflaba las fechas y quemaba al dueno: si pasaban
			// dos semanas sin recepcion, "aprendia" 14 dias y las sugerencias
			// se corrian a un mes.
			//
			// A partir del Sprint 9 (migracion 014) el aprendizaje real vive
			// en el batch nocturno y escribe en columnas learned_* separadas.
			// Esta linea sigue vigente SOLO como fallback: si el proveedor
			// NUNCA fue configurado a mano (visit_days y delivery_days vacios)
			// y ademas nadie puso un lead_time_days explicito, seguimos
			// aportando alguna senal.
			//
			// Si el dueno YA configuro visit_days O delivery_days, NO se
			// toca visit_frequency_days: la agenda manual es sagrada.
			if entry.AddedQuantity > 0 {
				var lastMove models.StockMovement
				if err := tx.Where("barcode = ? AND reason = ?", entry.Barcode, "RECEPTION").Order("date DESC").First(&lastMove).Error; err == nil {
					days := int(time.Since(lastMove.Date).Hours() / 24)
					if days > 1 && days < 100 && entry.SupplierID != nil {
						// Solo aprender si el proveedor NO tiene agenda
						// manual configurada. El chequeo lo hace la BD con
						// un WHERE que exige ambas columnas vacias — asi
						// evitamos una lectura extra en Go.
						tx.Model(&models.Supplier{}).
							Where("id = ?", *entry.SupplierID).
							Where("(visit_days IS NULL OR visit_days::text = '[]') AND (delivery_days IS NULL OR delivery_days::text = '[]')").
							Update("visit_frequency_days", days)
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

				if isEgreso {
					baseProduct.Quantity += expandedQuantity
					if err := tx.Save(&baseProduct).Error; err != nil {
						return fmt.Errorf("error actualizando stock del producto base: %w", err)
					}
				}

				if isEgreso {
					product.Quantity = math.Floor(baseProduct.Quantity / float64(product.PackMultiplier))
				}

				baseMovement := models.StockMovement{
					Date:     time.Now(),
					Barcode:  baseProduct.Barcode,
					Quantity: expandedQuantity,
					Type:     "IN",
					Reason:   "PACK_RECEPTION_BULK",
					// FIX: antes usaba fmt.Sprintf("PACKB-%d", time.Now().Unix())
					// como reference_id, distinto al receptionID de la
					// recepción padre. Como consecuencia, la reversión al
					// editar/eliminar NO encontraba este movimiento y el
					// stock del BASE se duplicaba al reprocesar la pack.
					// Ahora comparte el mismo receptionID para que la
					// reversión sea completa. El allowlist de reasons vive
					// en reception_reasons.go.
					ReferenceID:  receptionID,
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
				if isEgreso {
					product.Quantity += entry.AddedQuantity
				}
			}

			// === LÓGICA DE COSTO PROMEDIO PONDERADO (WAC) ===
			currentStock := product.Quantity - entry.AddedQuantity
			if currentStock < 0 {
				currentStock = 0
			}

			// REGLA DEL NEGOCIO: el DTO % del proveedor NO se le resta al costo.
			// El descuento es un beneficio que se traslada al PVP (sube el
			// margen), no una rebaja del costo registrado.
			// Ver reception_discount_test.go.
			//
			// Los impuestos SÍ suman. El costo con impuestos se calcula con
			// models.GrossFromNet (fuente única, aditiva) en vez de sumar los
			// montos a mano: así esta cuenta no puede volver a divergir de la
			// que muestra la pantalla ni de la de EditReception.
			entryRates := models.TaxRates{
				IvaPct:  entry.IvaPct,
				IcuiPct: entry.IcuiPct,
				IbuaPct: entry.IbuaPct,
			}
			totalEntryCost := models.GrossFromNet(entry.NewPurchasePrice, entryRates)

			oldPurchasePrice := product.PurchasePrice

			if entry.NewPurchasePrice > 0 {
				// WAC (Promedio Ponderado) para suavizar cambios bruscos ("precio moderado")
				//
				// Se pondera sobre totalEntryCost (CON impuestos), no sobre la
				// base. Antes se usaba entry.NewPurchasePrice pelado: la
				// pantalla mostraba al operador "COSTO $1.190" para una base de
				// $1.000 con IVA 19%, y en la base de datos quedaba $1.000. El
				// costo del producto salía 19% por debajo de lo realmente
				// pagado, lo que inflaba el margen y subvaloraba el inventario.
				// EditReception y ReceiveStock ya guardaban el costo con
				// impuestos, así que esta ruta era además la única distinta de
				// las tres.
				if currentStock > 0 && entry.AddedQuantity > 0 {
					totalOldValue := currentStock * oldPurchasePrice
					totalNewValue := entry.AddedQuantity * totalEntryCost
					newWAC := (totalOldValue + totalNewValue) / (currentStock + entry.AddedQuantity)

					// Redondear a 2 decimales
					product.PurchasePrice = math.Round(newWAC*100) / 100
				} else {
					// Si no había stock, el costo asume el nuevo completo
					product.PurchasePrice = math.Round(totalEntryCost*100) / 100
				}

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

			// 3. Actualización de Precios de Venta (CON REDONDEO POS Y AUTO-MARGEN)
			if entry.NewSalePrice > 0 {
				product.SalePrice = entry.NewSalePrice
			} else if oldSalePrice > 0 {
				product.SalePrice = oldSalePrice
			} else if product.PurchasePrice > 0 {
				product.SalePrice = product.PurchasePrice * 1.20
			}

			if product.PurchasePrice > 0 && product.SalePrice > 0 {
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
			// Añadimos supplierName y employeeName para el historial de recepciones
			type receptionMetadata struct {
				Entry        interface{} `json:"entry"`
				SupplierName string      `json:"supplierName"`
				EmployeeName string      `json:"employeeName"`
			}
			meta := receptionMetadata{
				Entry:        entry,
				SupplierName: supplierName,
				EmployeeName: employeeName,
			}
			metaBytes, _ := json.Marshal(meta)

			// 4. Registro de Movimiento en Kárdex
			movementQty := entry.AddedQuantity
			movementReason := "RECEPTION"
			if strings.EqualFold(entry.LineType, "BONUS") {
				movementReason = "RECEPTION_BONUS"
			}
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

			// Acumular total para el egreso. La separación 3 zonas garantiza:
			//   - REGULAR: AddedQuantity > 0 y NewPurchasePrice > 0  → lineTotal > 0 (suma)
			//   - BONUS:   AddedQuantity > 0 pero NewPurchasePrice 0 → lineTotal = 0 (no afecta)
			//   - RETURN:  AddedQuantity < 0 con precio > 0          → lineTotal < 0 (resta)
			// Sin el filtro `> 0` anterior, las devoluciones reducen el monto
			// real a pagar al proveedor al cerrar el egreso de recepción.
			// Mismo cálculo que el costo del producto (models.GrossFromNet):
			// lo que se le debe al proveedor es la base con impuestos.
			lineTotal := models.GrossFromNet(entry.NewPurchasePrice, models.TaxRates{
				IvaPct:  entry.IvaPct,
				IcuiPct: entry.IcuiPct,
				IbuaPct: entry.IbuaPct,
			}) * entry.AddedQuantity
			totalAmount += lineTotal
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
		} else if strings.HasPrefix(paymentSource, "{") {
			var objMap map[string]float64
			if err := json.Unmarshal([]byte(paymentSource), &objMap); err == nil {
				for k, v := range objMap {
					if v > 0 {
						mixed = append(mixed, mixedPayment{Method: k, Amount: v})
					}
				}
				if len(mixed) > 0 {
					isMixed = true
				}
			}
		}

		// VALIDACIÓN ESTRICTA DE PAGOS MIXTOS: si el operador dividió el pago
		// en varios canales, la suma debe cuadrar con el total del egreso
		// (mercancía + flete). Tolerancia ±5 pesos por redondeos del frontend.
		// Si no cuadra abortamos antes de tocar la BD; el operador corrige.
		if isMixed && !bypassExpense {
			var sumMixed float64
			for _, mp := range mixed {
				sumMixed += mp.Amount
			}
			expectedSum := totalAmount + freightCost
			if math.Abs(sumMixed-expectedSum) > 5.0 {
				return fmt.Errorf(
					"pagos mixtos no cuadran: suma de canales $%.2f vs total esperado $%.2f (mercancía $%.2f + flete $%.2f)",
					sumMixed, expectedSum, totalAmount, freightCost,
				)
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
				// Pagos mixtos: una sola fila contable con desglose en las nuevas columnas
				// y el campo paymentSource concatenado
				freightLabel := ""
				if freightCost > 0 {
					freightLabel = " (incluye flete)"
				}

				var parts []string
				var actualSum float64
				for _, mp := range mixed {
					if mp.Amount > 0 {
						actualSum += mp.Amount
					}
				}

				expense := models.Expense{
					Description:  fmt.Sprintf("%s%s", description, freightLabel),
					Amount:       actualSum,
					Date:         time.Now(),
					Status:       "PAID",
					Category:     "Proveedores",
					SupplierID:   mainSupplierID,
					CreatedByDNI: strings.ToUpper(strings.TrimSpace(employeeDNI)),
					ReferenceID:  receptionID,
				}

				for _, mp := range mixed {
					if mp.Amount <= 0 {
						continue
					}
					methodUpper := strings.ToUpper(mp.Method)
					parts = append(parts, fmt.Sprintf("%s: $%s", methodUpper, formatMoney(mp.Amount)))

					switch methodUpper {
					case "EFECTIVO", "CAJA", "CASH":
						expense.CashAmount += mp.Amount
					case "NEQUI":
						expense.NequiAmount += mp.Amount
						expense.TaxAmount += math.Ceil(mp.Amount * 0.004)
					case "DAVIPLATA":
						expense.DaviplataAmount += mp.Amount
					case "FONDO":
						expense.FondoAmount += mp.Amount
					case "PRESTAMO", "PREST.":
						expense.Status = "PENDING"
					}
				}

				expense.PaymentSource = strings.Join(parts, " / ")
				if expense.PaymentSource == "" {
					expense.PaymentSource = "MIXTO"
				}

				if err := tx.Create(&expense).Error; err != nil {
					return fmt.Errorf("error creando egreso mixto consolidado: %w", err)
				}
			} else {
				// Flujo normal (un solo método de pago)
				status := "PAID"
				if paymentSource == "PRESTAMO" || paymentSource == "PREST." || paymentSource == "DEUDA" {
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

				srcUpper := strings.ToUpper(strings.TrimSpace(paymentSource))
				if strings.Contains(srcUpper, "NEQUI") || strings.Contains(srcUpper, "BANCOLOMBIA") || strings.Contains(srcUpper, "TRANSFERENCIA") || strings.Contains(srcUpper, "BANCO") || strings.Contains(srcUpper, "DIGITAL") {
					expense.NequiAmount = totalAmount
					if strings.Contains(srcUpper, "NEQUI") {
						expense.TaxAmount = math.Ceil(totalAmount * 0.004)
					}
				} else if strings.Contains(srcUpper, "DAVIPLATA") {
					expense.DaviplataAmount = totalAmount
				} else if strings.Contains(srcUpper, "FONDO") || strings.Contains(srcUpper, "BOVEDA") {
					expense.FondoAmount = totalAmount
				} else if srcUpper != "PRESTAMO" && srcUpper != "PREST." && srcUpper != "DEUDA" {
					expense.CashAmount = totalAmount
				}

				if err := tx.Create(&expense).Error; err != nil {
					return fmt.Errorf("error creando egreso: %w", err)
				}
			}
		}

		// 4.6. Creación de Egreso por Flete — SOLO si NO hay pagos mixtos.
		// En modo mixed, el flete ya está distribuido entre los canales que
		// el operador eligió (validación de suma garantiza que cubre todo).
		if !bypassExpense && freightCost > 0 && !isMixed {
			description := "FLETE / TRANSPORTE - MERCANCÍA"
			if mainSupplierID != nil {
				var supplier models.Supplier
				if err := tx.First(&supplier, *mainSupplierID).Error; err == nil {
					description = fmt.Sprintf("FLETE / TRANSPORTE - %s", supplier.Name)
				}
			}

			freightPaymentSource := paymentSource
			if paymentSource == "" {
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

			if freightPaymentSource == "NEQUI" {
				expenseFreight.NequiAmount = freightCost
				expenseFreight.TaxAmount = math.Ceil(freightCost * 0.004)
			} else if freightPaymentSource == "DAVIPLATA" {
				expenseFreight.DaviplataAmount = freightCost
			} else if freightPaymentSource == "EFECTIVO" || freightPaymentSource == "CAJA" {
				expenseFreight.CashAmount = freightCost
			} else if freightPaymentSource == "FONDO" {
				expenseFreight.FondoAmount = freightCost
			}

			if err := tx.Create(&expenseFreight).Error; err != nil {
				return fmt.Errorf("error creando egreso de flete: %w", err)
			}
		}

		// 5. Cierre de Órdenes Relacionadas
		if len(orderRefs) > 0 {
			for _, ref := range orderRefs {
				switch ref.Source {
				case "purchase_order":
					tx.Model(&models.PurchaseOrder{}).Where("id = ?", ref.ID).Update("status", models.PurchaseOrderReceived)
				case "expected":
					tx.Model(&models.ExpectedOrder{}).Where("id = ?", ref.ID).Update("status", "RECEIVED")
				case "confirmed":
					tx.Model(&models.ConfirmedOrder{}).Where("id = ?", ref.ID).Update("status", "received")
				}
			}
		} else {
			// Fallback para clientes antiguos
			var idsToClose []uint
			if orderID != nil && *orderID > 0 {
				idsToClose = append(idsToClose, *orderID)
			}
			for _, rawID := range orderIDs {
				switch v := rawID.(type) {
				case float64:
					if uint(v) > 0 {
						idsToClose = append(idsToClose, uint(v))
					}
				case int:
					if uint(v) > 0 {
						idsToClose = append(idsToClose, uint(v))
					}
				}
			}

			for _, id := range idsToClose {
				// Cuidado: ConfirmedOrder no usa uint, evitar error de BD ignorando ConfirmedOrder aquí si es int
				tx.Model(&models.PurchaseOrder{}).Where("id = ?", id).Update("status", models.PurchaseOrderReceived)
				tx.Model(&models.ExpectedOrder{}).Where("id = ?", id).Update("status", "RECEIVED")
			}
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

// GetGlobalInventoryValue devuelve el valor del inventario A COSTO:
// SUM(stock × precio de compra) sobre los productos activos.
//
// Es la cifra que alimenta el KPI "Valor del inventario" del dashboard y la
// misma que totaliza el reporte de inventario. El predicado sale de
// ports.SQLActiveProduct para que las dos no puedan divergir: antes esta
// consulta usaba `"isActive" = true` pelado y descartaba en silencio las filas
// legadas con isActive NULL, subvalorando el inventario.
func (r *PostgresProductRepository) GetGlobalInventoryValue() (float64, error) {
	var total float64
	err := r.db.Model(&models.Product{}).
		Where(ports.SQLActiveProduct).
		Select("COALESCE(SUM(quantity * \"purchasePrice\"), 0)").
		Scan(&total).Error
	return total, err
}

// GetGlobalInventoryRetailValue devuelve el valor del inventario A PRECIO DE
// VENTA: SUM(stock × precio de venta) sobre los productos activos.
func (r *PostgresProductRepository) GetGlobalInventoryRetailValue() (float64, error) {
	var total float64
	err := r.db.Model(&models.Product{}).
		Where(ports.SQLActiveProduct).
		Select("COALESCE(SUM(quantity * \"salePrice\"), 0)").
		Scan(&total).Error
	return total, err
}
func (r *PostgresProductRepository) DeleteReception(receptionID string) error {
	err := r.db.Transaction(func(tx *gorm.DB) error {
		// 1. Obtener todos los movimientos de esta recepción.
		//
		// FIX: El filtro histórico era
		//   Where("reference_id = ? AND reason = ?", receptionID, "RECEPTION")
		// e ignoraba bonificaciones, el efecto sobre el producto base
		// de las pacas y los ajustes físicos. Al borrar una recepción
		// con pacas, el stock del base no se revertía. Ahora se usa el
		// allowlist definido en reception_reasons.go (con tests).
		var movements []models.StockMovement
		if err := tx.Where(
			"reference_id = ? AND (reason IN ? OR type IN ?)",
			receptionID,
			ReceptionMovementReasons,
			ReceptionAdjustmentTypes,
		).Find(&movements).Error; err != nil {
			return err
		}

		if len(movements) == 0 {
			return fmt.Errorf("no se encontraron movimientos para la recepción %s", receptionID)
		}

		// 2. Revertir stock para cada producto. Los PRICE_UPDATE_NO_STOCK
		//    tienen Quantity=0, así que restar es un no-op de stock,
		//    pero el movimiento sí se borra para no dejar huella
		//    fantasma en el kárdex.
		for _, m := range movements {
			if m.Quantity == 0 {
				continue
			}
			// MASTER SPRINT: Enforce 3 decimal precision in reversal
			if err := tx.Model(&models.Product{}).
				Where("barcode = ?", m.Barcode).
				Updates(map[string]interface{}{
					"quantity":   gorm.Expr("ROUND((quantity - ?)::numeric, 3)", m.Quantity),
					"updated_at": time.Now(),
				}).Error; err != nil {
				return err
			}
		}

		// 3. Eliminar los movimientos con el mismo criterio del find.
		if err := tx.Where(
			"reference_id = ? AND (reason IN ? OR type IN ?)",
			receptionID,
			ReceptionMovementReasons,
			ReceptionAdjustmentTypes,
		).Delete(&models.StockMovement{}).Error; err != nil {
			return err
		}

		// 4. Eliminar el egreso vinculado
		if err := tx.Where("reference_id = ?", receptionID).Delete(&models.Expense{}).Error; err != nil {
			return err
		}

		return nil
	})

	if err == nil {
		// Arreglo 2: eliminar una recepción sólo revierte cantidades del kardex
		// (no recalcula precios). No invalidamos CacheKeyProducts.
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
