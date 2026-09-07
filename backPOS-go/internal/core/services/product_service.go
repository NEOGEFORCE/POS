package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type ProductService struct {
	repo         ports.ProductRepository
	movementRepo ports.StockMovementRepository
	expected     *ExpectedOrderService
	telegram     *TelegramService
}

func NewProductService(repo ports.ProductRepository, movementRepo ports.StockMovementRepository, expected *ExpectedOrderService, telegram *TelegramService) *ProductService {
	return &ProductService{repo: repo, movementRepo: movementRepo, expected: expected, telegram: telegram}
}

func applyRounding(val float64) float64 {
	base := float64(int64(val) / 100 * 100)
	remainder := float64(int64(val) % 100)
	// Nueva Regla: >= 25 -> 100, < 25 -> 000
	if remainder >= 25 {
		return base + 100
	}
	return base
}

func (s *ProductService) CreateProduct(product *models.Product) error {
	// Aplicar redondeo si ya viene con precio
	if product.SalePrice > 0 {
		product.SalePrice = normalizeManualSalePrice(product.SalePrice)
	}
	return s.repo.Save(product)
}

func (s *ProductService) RegisterShrinkage(shrinkage *models.Shrinkage) error {
	if strings.TrimSpace(shrinkage.ProductID) == "" {
		return fmt.Errorf("producto requerido")
	}
	if shrinkage.Quantity <= 0 {
		return fmt.Errorf("la cantidad de merma debe ser positiva")
	}
	switch shrinkage.Reason {
	case models.ShrinkageVencimiento, models.ShrinkageRotura, models.ShrinkageConsumoInt, models.ShrinkageHurto:
	default:
		return fmt.Errorf("motivo de merma inválido")
	}
	return s.repo.SaveShrinkage(shrinkage, nil)
}

func (s *ProductService) GetProduct(barcode string) (*models.Product, error) {
	return s.repo.GetByBarcode(barcode)
}

func (s *ProductService) GetProductByName(name string) (*models.Product, error) {
	return s.repo.GetByName(name)
}

func (s *ProductService) GetProductWithPreloads(barcode string, preloads ...string) (*models.Product, error) {
	return s.repo.GetByBarcodeWithPreloads(barcode, preloads...)
}

func (s *ProductService) GetAllProducts() ([]models.Product, error) {
	return s.repo.GetAll()
}

func (s *ProductService) GetPaginatedProducts(page, pageSize int, search string, supplierID int, stockFilter string) ([]models.Product, int64, error) {
	return s.repo.GetPaginated(page, pageSize, search, supplierID, stockFilter)
}

func (s *ProductService) GetProductsBySupplier(supplierID uint) ([]models.Product, error) {
	return s.repo.GetBySupplier(supplierID)
}

func (s *ProductService) SaveSupplierAlias(alias *models.SupplierProductAlias) error {
	return s.repo.SaveSupplierAlias(alias)
}

func (s *ProductService) LinkSupplier(barcode string, supplierID uint) error {
	return s.repo.LinkSupplier(barcode, supplierID)
}

func (s *ProductService) UnlinkSupplier(barcode string, supplierID uint) error {
	return s.repo.UnlinkSupplier(barcode, supplierID)
}

func (s *ProductService) GetOrphanedProducts() ([]models.Product, error) {
	return s.repo.GetOrphanedProducts()
}

func (s *ProductService) UpdateProduct(barcode string, updatedProduct *models.Product) error {
	if updatedProduct == nil {
		return fmt.Errorf("producto requerido")
	}
	rawDB, ok := s.repo.GetDB().(*gorm.DB)
	if !ok || rawDB == nil {
		return fmt.Errorf("error de sistema: base de datos de productos inválida")
	}

	supplierIDs := make([]uint, 0, len(updatedProduct.Suppliers))
	for _, supplier := range updatedProduct.Suppliers {
		if supplier.ID > 0 {
			supplierIDs = append(supplierIDs, supplier.ID)
		}
	}
	options := ports.ProductUpdateOptions{
		ReplaceSuppliers: updatedProduct.Suppliers != nil,
		SupplierIDs:      supplierIDs,
	}

	targetBarcode := strings.TrimSpace(updatedProduct.Barcode)
	if targetBarcode == "" {
		targetBarcode = barcode
	}

	err := rawDB.Transaction(func(tx *gorm.DB) error {
		var existing models.Product
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Unscoped().
			Where("barcode = ?", barcode).First(&existing).Error; err != nil {
			return fmt.Errorf("producto %s no encontrado: %w", barcode, err)
		}
		if !updatedProduct.UpdatedAt.IsZero() && !existing.UpdatedAt.Equal(updatedProduct.UpdatedAt) {
			return fmt.Errorf("el producto cambió mientras estaba abierto; recargue antes de guardar")
		}

		if updatedProduct.PurchasePrice > 0 {
			existing.PurchasePrice = updatedProduct.PurchasePrice
		} else {
			var supplierPrices []models.ProductSupplier
			if err := tx.Where("product_barcode = ?", barcode).Find(&supplierPrices).Error; err != nil {
				return fmt.Errorf("error consultando costos de proveedores: %w", err)
			}
			for _, supplierPrice := range supplierPrices {
				if supplierPrice.PurchasePrice > existing.PurchasePrice {
					existing.PurchasePrice = supplierPrice.PurchasePrice
				}
			}
		}

		existing.Barcode = targetBarcode
		existing.ProductName = updatedProduct.ProductName
		existing.IsWeighted = updatedProduct.IsWeighted
		existing.CategoryID = updatedProduct.CategoryID
		existing.AlternateCodes = updatedProduct.AlternateCodes
		existing.Iva = updatedProduct.Iva
		existing.Icui = updatedProduct.Icui
		existing.Ibua = updatedProduct.Ibua
		existing.Discount = updatedProduct.Discount
		existing.MarginPercentage = updatedProduct.MarginPercentage
		existing.ImageUrl = updatedProduct.ImageUrl
		existing.MinStock = updatedProduct.MinStock
		existing.IsActive = updatedProduct.IsActive
		if updatedProduct.OrderMultiple > 0 {
			existing.OrderMultiple = updatedProduct.OrderMultiple
		}
		if updatedProduct.UpdatedByDNI != "" {
			existing.UpdatedByDNI = updatedProduct.UpdatedByDNI
			existing.UpdatedByName = updatedProduct.UpdatedByName
		}
		if updatedProduct.SupplierID != nil {
			if *updatedProduct.SupplierID > 0 {
				supplierID := *updatedProduct.SupplierID
				existing.SupplierID = &supplierID
			} else {
				existing.SupplierID = nil
			}
		}

		existing.IsPack = updatedProduct.IsPack
		existing.PackMultiplier = updatedProduct.PackMultiplier
		existing.Quantity = updatedProduct.Quantity
		if existing.IsPack {
			if existing.PackMultiplier <= 0 {
				return fmt.Errorf("un pack debe tener un multiplicador mayor que cero")
			}
			if updatedProduct.BaseProductBarcode == nil || strings.TrimSpace(*updatedProduct.BaseProductBarcode) == "" {
				return fmt.Errorf("un pack debe indicar su producto base")
			}
			baseBarcode := strings.TrimSpace(*updatedProduct.BaseProductBarcode)
			if baseBarcode == barcode || baseBarcode == targetBarcode {
				return fmt.Errorf("un producto no puede ser su propio producto base")
			}
			existing.BaseProductBarcode = &baseBarcode

			var baseProduct models.Product
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("barcode = ?", baseBarcode).First(&baseProduct).Error; err != nil {
				return fmt.Errorf("producto base %s no encontrado: %w", baseBarcode, err)
			}
			calculatedPackQuantity := math.Floor(baseProduct.Quantity / float64(existing.PackMultiplier))
			if updatedProduct.Quantity != calculatedPackQuantity {
				newBaseQuantity := updatedProduct.Quantity * float64(existing.PackMultiplier)
				delta := newBaseQuantity - baseProduct.Quantity
				now := time.Now()
				if err := tx.Model(&models.Product{}).Where("barcode = ?", baseBarcode).
					Updates(map[string]interface{}{"quantity": newBaseQuantity, "updated_at": now}).Error; err != nil {
					return fmt.Errorf("error sincronizando stock del producto base: %w", err)
				}
				movementType := models.MovementTypeIn
				if delta < 0 {
					movementType = models.MovementTypeOut
				}
				movement := &models.StockMovement{
					Date:         now,
					Barcode:      baseBarcode,
					Quantity:     math.Abs(delta),
					Type:         movementType,
					Reason:       models.MovementReasonPackUpdateSync,
					ReferenceID:  fmt.Sprintf("PSYNC-%d", now.UnixNano()),
					EmployeeDNI:  updatedProduct.UpdatedByDNI,
					EmployeeName: updatedProduct.UpdatedByName,
				}
				if err := s.movementRepo.SaveWithTx(tx, movement); err != nil {
					return fmt.Errorf("error registrando ajuste del pack en kárdex: %w", err)
				}
			}
		} else {
			existing.BaseProductBarcode = nil
			if existing.PackMultiplier <= 0 {
				existing.PackMultiplier = 1
			}
		}

		if updatedProduct.SalePrice > 0 && isHalfHundredPrice(updatedProduct.SalePrice) {
			// Precio fijado a propósito en terminación 50: no se recalcula por margen.
			existing.SalePrice = normalizeManualSalePrice(updatedProduct.SalePrice)
		} else if existing.MarginPercentage > 0 && existing.PurchasePrice > 0 {
			existing.SalePrice = applyRounding(existing.PurchasePrice * (1 + existing.MarginPercentage/100))
		} else if updatedProduct.SalePrice > 0 {
			existing.SalePrice = normalizeManualSalePrice(updatedProduct.SalePrice)
		}

		if existing.PurchasePrice > 0 && existing.SupplierID != nil && *existing.SupplierID > 0 {
			options.SupplierPrice = &ports.ProductSupplierPriceUpdate{
				SupplierID: *existing.SupplierID,
				Price:      existing.PurchasePrice,
			}
		}

		existing.Category = models.Category{}
		existing.Supplier = models.Supplier{}
		existing.UpdatedBy = models.Employee{}
		existing.CreatedBy = models.Employee{}
		existing.BaseProduct = nil
		existing.Suppliers = nil
		existing.ProductSuppliers = nil

		if err := s.repo.UpdateWithTx(tx, barcode, &existing, options); err != nil {
			return err
		}
		targetBarcode = existing.Barcode
		return nil
	})
	if err != nil {
		errString := strings.ToLower(err.Error())
		if strings.Contains(errString, "23505") || strings.Contains(errString, "duplicate key") || strings.Contains(errString, "ya pertenece") || strings.Contains(errString, "ya está asociado") {
			return fmt.Errorf("el código de barras ya está en uso: %w", err)
		}
		return fmt.Errorf("error al persistir producto: %w", err)
	}

	s.repo.AfterCommitUpdate(barcode, targetBarcode)
	return nil
}

func (s *ProductService) UpdateProductSuppliers(barcode string, suppliers []models.Supplier) error {
	var ids []uint
	for _, sup := range suppliers {
		if sup.ID > 0 {
			ids = append(ids, sup.ID)
		}
	}
	return s.repo.SyncSuppliers(barcode, ids)
}

func (s *ProductService) DeleteProduct(barcode string) error {
	return s.repo.Delete(barcode)
}

// MergeHistoricalMarker (arreglo 5) delega la fusión al repositorio y limpia
// los cachés de catálogo (esta operación SÍ cambia la forma del catálogo:
// desaparece el marcador y el producto real cambia de barcode).
func (s *ProductService) MergeHistoricalMarker(realBarcode, markerBarcode, authorDNI, authorName string) error {
	if err := s.repo.MergeHistoricalMarker(realBarcode, markerBarcode, authorDNI, authorName); err != nil {
		return err
	}
	s.repo.InvalidateCatalogAfterMerge(realBarcode, markerBarcode)
	return nil
}

// ReceiveStock registra la entrada de UN producto.
//
// Los parámetros ivaAmount/icuiAmount/ibuaAmount son MONTOS absolutos por
// unidad, igual que el campo `iva` de bulk-receive. Los porcentajes que se
// guardan en el producto se derivan de ellos.
//
// Antes esta función recibía tres valores y los usaba de las DOS formas a la
// vez: los sumaba al costo (tratándolos como monto) y los escribía en
// product.Iva (que todo el sistema lee como porcentaje, dividiendo por 100).
// Una de las dos lecturas estaba mal por definición: con $190 de IVA el
// producto quedaba con "190%" y la facturación electrónica declaraba esa tasa.
func (s *ProductService) ReceiveStock(barcode string, addedQuantity float64, newPurchasePrice float64, newSalePrice float64, supplierID *uint, ivaAmount, icuiAmount, ibuaAmount float64) error {
	if addedQuantity <= 0 {
		return fmt.Errorf("la cantidad recibida debe ser positiva")
	}
	db, ok := s.repo.GetDB().(*gorm.DB)
	if !ok || db == nil {
		return fmt.Errorf("repositorio de productos sin transacciones")
	}
	now := time.Now()
	referenceID := fmt.Sprintf("RECP-%d", now.UnixNano())
	affected := []string{barcode}
	err := db.Transaction(func(tx *gorm.DB) error {
		var product models.Product
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("barcode = ?", barcode).First(&product).Error; err != nil {
			return err
		}
		previousStock := product.Quantity

		if product.IsPack && product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" && product.PackMultiplier > 0 {
			var base models.Product
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("barcode = ?", *product.BaseProductBarcode).First(&base).Error; err != nil {
				return fmt.Errorf("obteniendo producto base: %w", err)
			}
			expanded := addedQuantity * float64(product.PackMultiplier)
			base.Quantity += expanded
			if err := tx.Save(&base).Error; err != nil {
				return fmt.Errorf("actualizando producto base: %w", err)
			}
			baseMovement := &models.StockMovement{
				Date: now, Barcode: base.Barcode, Quantity: expanded, Type: models.MovementTypeIn,
				Reason: "PACK_RECEPTION", ReferenceID: referenceID,
				EmployeeDNI: product.UpdatedByDNI, EmployeeName: product.UpdatedByName,
			}
			if err := s.movementRepo.SaveWithTx(tx, baseMovement); err != nil {
				return fmt.Errorf("registrando movimiento del producto base: %w", err)
			}
			product.Quantity = math.Floor(base.Quantity / float64(product.PackMultiplier))
			affected = append(affected, base.Barcode)
		} else {
			product.Quantity += addedQuantity
		}

		// Los montos recibidos se convierten a porcentajes UNA vez, y de ahí
		// sale tanto el costo con impuestos como lo que se guarda en el
		// producto. Así el monto y el porcentaje no pueden contradecirse.
		rates := models.RatesFromAmounts(newPurchasePrice, ivaAmount, icuiAmount, ibuaAmount)
		entryTotalCost := models.GrossFromNet(newPurchasePrice, rates)
		if entryTotalCost > 0 {
			totalLogicalStock := previousStock + addedQuantity
			if totalLogicalStock > 0 {
				product.PurchasePrice = ((previousStock * product.PurchasePrice) + (addedQuantity * entryTotalCost)) / totalLogicalStock
			} else {
				product.PurchasePrice = entryTotalCost
			}
			product.Iva, product.Icui, product.Ibua = rates.IvaPct, rates.IcuiPct, rates.IbuaPct
			if supplierID != nil {
				link := models.ProductSupplier{ProductID: barcode, SupplierID: *supplierID, PurchasePrice: entryTotalCost}
				if err := tx.Clauses(clause.OnConflict{
					Columns:   []clause.Column{{Name: "product_barcode"}, {Name: "supplier_id"}},
					DoUpdates: clause.AssignmentColumns([]string{"purchasePrice", "updated_at"}),
				}).Create(&link).Error; err != nil {
					return fmt.Errorf("actualizando precio del proveedor: %w", err)
				}
			}
		}
		if newSalePrice > 0 {
			product.SalePrice = normalizeManualSalePrice(newSalePrice)
		}
		if product.PurchasePrice > 0 {
			product.MarginPercentage = ((product.SalePrice / product.PurchasePrice) - 1) * 100
		}
		if supplierID != nil {
			product.SupplierID = supplierID
		}
		if err := tx.Save(&product).Error; err != nil {
			return fmt.Errorf("actualizando producto: %w", err)
		}
		movement := &models.StockMovement{
			Date: now, Barcode: barcode, Quantity: addedQuantity, Type: models.MovementTypeIn,
			Reason: "RECEPTION", ReferenceID: referenceID,
			EmployeeDNI: product.UpdatedByDNI, EmployeeName: product.UpdatedByName,
		}
		if err := s.movementRepo.SaveWithTx(tx, movement); err != nil {
			return fmt.Errorf("registrando movimiento de recepción: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.repo.AfterCommitUpdate(affected...)
	if supplierID != nil && s.expected != nil {
		if err := s.expected.MarkAsReceivedBySupplier(*supplierID); err != nil {
			log.Printf("[RECEIVE-STOCK] no se pudo actualizar pedido esperado del proveedor %d: %v", *supplierID, err)
		}
	}
	return nil
}

// validateStockAdjustment devuelve un error si el ajuste dejaría el stock
// físicamente imposible.
//
// La guarda SÓLO aplica cuando el ajuste es hacia abajo (delta < 0). Un ajuste
// positivo siempre pasa: el operador debe poder recuperar existencias en
// productos que hoy están en negativo (bug del botón "+" reportado por caja).
// La política de permitir stock negativo en ventas ya está aceptada por el
// negocio (ver sale_service.go:168 "Validación eliminada a petición del
// usuario"); esta función preserva esa política sin bloquear las correcciones.
func validateStockAdjustment(currentQuantity, delta float64) error {
	if delta >= 0 {
		return nil
	}
	if currentQuantity+delta < 0 {
		return fmt.Errorf("stock insuficiente: disponible %.3f", currentQuantity)
	}
	return nil
}

func (s *ProductService) AdjustStock(barcode string, amount float64, employeeDNI string, employeeName string) error {
	if amount == 0 {
		return fmt.Errorf("el ajuste no puede ser cero")
	}
	db, ok := s.repo.GetDB().(*gorm.DB)
	if !ok || db == nil {
		return fmt.Errorf("repositorio de productos sin transacciones")
	}
	now := time.Now()
	referenceID := fmt.Sprintf("ADJ-%d", now.UnixNano())
	movementType := "ADJUSTMENT_UP"
	if amount < 0 {
		movementType = "ADJUSTMENT_DOWN"
	}
	affected := []string{barcode}
	err := db.Transaction(func(tx *gorm.DB) error {
		var product models.Product
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("barcode = ?", barcode).First(&product).Error; err != nil {
			return err
		}
		movements := make([]models.StockMovement, 0, 2)
		if product.IsPack && product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" && product.PackMultiplier > 0 {
			var base models.Product
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("barcode = ?", *product.BaseProductBarcode).First(&base).Error; err != nil {
				return fmt.Errorf("obteniendo producto base: %w", err)
			}
			baseAdjustment := amount * float64(product.PackMultiplier)
			if err := validateStockAdjustment(base.Quantity, baseAdjustment); err != nil {
				return err
			}
			base.Quantity += baseAdjustment
			if err := tx.Save(&base).Error; err != nil {
				return err
			}
			product.Quantity = math.Floor(base.Quantity / float64(product.PackMultiplier))
			if err := tx.Save(&product).Error; err != nil {
				return err
			}
			movements = append(movements, models.StockMovement{
				Date: now, Barcode: base.Barcode, Quantity: baseAdjustment, Type: movementType,
				Reason: "PACK_ADJUSTMENT_SYNC", ReferenceID: referenceID,
				EmployeeDNI: employeeDNI, EmployeeName: employeeName,
			})
			affected = append(affected, base.Barcode)
		} else {
			if err := validateStockAdjustment(product.Quantity, amount); err != nil {
				return err
			}
			product.Quantity += amount
			if err := tx.Save(&product).Error; err != nil {
				return err
			}
		}
		movements = append(movements, models.StockMovement{
			Date: now, Barcode: barcode, Quantity: amount, Type: movementType,
			Reason: "MANUAL_ADJUSTMENT", ReferenceID: referenceID,
			EmployeeDNI: employeeDNI, EmployeeName: employeeName,
		})
		if err := s.movementRepo.BatchSaveWithTx(tx, movements); err != nil {
			return fmt.Errorf("registrando movimientos de ajuste: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.repo.AfterCommitUpdate(affected...)
	return nil
}

func (s *ProductService) FixAllProductPrices() error {
	products, err := s.repo.GetAll()
	if err != nil {
		return err
	}

	for _, p := range products {
		if p.PurchasePrice > 0 && p.MarginPercentage > 0 {
			suggested := p.PurchasePrice * (1 + p.MarginPercentage/100)
			newPrice := applyRounding(suggested)
			if newPrice != p.SalePrice {
				p.SalePrice = newPrice
				if err := s.repo.Update(p.Barcode, &p); err != nil {
					// Continuar con los demÃ¡s aunque uno falle
					fmt.Printf("Error actualizando %s: %v\n", p.Barcode, err)
				}
			}
		}
	}
	return nil
}

func (s *ProductService) BulkReceiveStock(entries []ports.ReceiveEntry, orderID *uint, orderIDs []interface{}, orderRefs []ports.OrderRef, bypassExpense bool, paymentSource string, employeeDNI string, mainSupplierID *uint, freightCost float64, totalWeight float64, isEgreso bool, editReceptionID string) error {
	_, err := s.repo.BulkReceive(entries, orderID, orderIDs, orderRefs, bypassExpense, paymentSource, employeeDNI, mainSupplierID, freightCost, totalWeight, isEgreso, editReceptionID)
	if err == nil {
		// AutomatizaciÃ³n: Intentar identificar el proveedor principal para marcar preventa como recibida
		var mainSupplierID uint
		for _, e := range entries {
			if e.SupplierID != nil && *e.SupplierID > 0 {
				mainSupplierID = *e.SupplierID
				break
			}
		}
		if mainSupplierID > 0 && s.expected != nil {
			if markErr := s.expected.MarkAsReceivedBySupplier(mainSupplierID); markErr != nil {
				log.Printf("[BULK-RECEIVE] no se pudo marcar pedido esperado del proveedor %d: %v", mainSupplierID, markErr)
			}
		}
	}
	return err
}

func (s *ProductService) GetSavingsOpportunities() ([]ports.SavingsOpportunity, error) {
	return s.repo.GetSavingsOpportunities()
}

func (s *ProductService) GetPriceChangesToday() ([]models.PriceLog, error) {
	return s.repo.GetPriceChangesToday()
}

func (s *ProductService) GetProductPriceComparison(barcode string) ([]models.ProductSupplier, error) {
	return s.repo.GetSupplierPrices(barcode)
}
func (s *ProductService) OpenBulk(barcode string, employeeDNI string, employeeName string) error {
	db, ok := s.repo.GetDB().(*gorm.DB)
	if !ok || db == nil {
		return fmt.Errorf("repositorio de productos sin transacciones")
	}
	err := db.Transaction(func(tx *gorm.DB) error {
		var product models.Product
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("barcode = ?", barcode).First(&product).Error; err != nil {
			return fmt.Errorf("obteniendo producto: %w", err)
		}
		if product.Quantity < 1 {
			return fmt.Errorf("no hay stock suficiente de %s para abrir", product.ProductName)
		}
		product.Quantity--
		if err := tx.Save(&product).Error; err != nil {
			return fmt.Errorf("actualizando stock del bulto: %w", err)
		}
		movement := &models.StockMovement{
			Date:         time.Now(),
			Barcode:      barcode,
			Quantity:     1,
			Type:         models.MovementTypeOut,
			Reason:       "OPEN_BULK",
			ReferenceID:  fmt.Sprintf("OPEN-%d", time.Now().UnixNano()),
			EmployeeDNI:  employeeDNI,
			EmployeeName: employeeName,
		}
		if err := s.movementRepo.SaveWithTx(tx, movement); err != nil {
			return fmt.Errorf("registrando movimiento de apertura: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.repo.AfterCommitUpdate(barcode)
	return nil
}
func (s *ProductService) UpsertProduct(product *models.Product) error {
	existing, err := s.repo.GetByBarcode(product.Barcode)
	if err != nil || existing == nil {
		// Crear nuevo
		return s.CreateProduct(product)
	}

	// Actualizar existente (solo campos bÃ¡sicos del CSV)
	existing.ProductName = product.ProductName
	existing.Quantity = product.Quantity
	existing.PurchasePrice = product.PurchasePrice
	existing.SalePrice = product.SalePrice
	existing.IsWeighted = product.IsWeighted
	existing.UpdatedByDNI = product.UpdatedByDNI
	existing.IsActive = true

	return s.UpdateProduct(existing.Barcode, existing)
}

func (s *ProductService) SanitizeAllNames() (int, error) {
	return 0, nil
}

func (s *ProductService) DeleteReception(ref string, dniStr string, reason string) error {
	return s.repo.DeleteReception(ref)
}

func (s *ProductService) GetReception(receptionID string) ([]models.StockMovement, error) {
	return s.repo.GetReception(receptionID)
}

func (s *ProductService) EditReception(ref string, dniStr string, reason string, products []models.EditReceiveItem) error {
	priceChanges, err := s.repo.EditReception(ref, dniStr, reason, products)
	if err != nil {
		return err
	}

	if len(priceChanges) > 0 {
		msg := "âš ï¸ PRECIOS MODIFICADOS EN EDICIÃ“N DE RECEPCIÃ“N:\n\n"
		for _, change := range priceChanges {
			msg += "Â· " + change + "\n"
		}
		s.telegram.SendAlert(msg)
	}

	return nil
}

// --- AI Invoice Reader Logic ---

func (s *ProductService) ScanInvoice(imageBase64, mimeType, supplierName string, supplierID uint, expectedTaxes *models.ExpectedTaxes) (*models.ScanInvoiceResult, error) {
	aliases, err := s.repo.GetSupplierAliases(supplierID)
	if err != nil {
		aliases = make(map[string]models.SupplierProductAlias)
	}

	params, _ := s.repo.GetSupplierInvoiceParams(supplierID)

	extractedItems, err := s.callClaudeVision(imageBase64, mimeType, supplierName, params)
	if err != nil {
		return nil, err
	}

	result := &models.ScanInvoiceResult{}

	for _, extracted := range extractedItems {
		if extracted.Quantity <= 0 {
			continue
		}

		if alias, ok := aliases[strings.ToUpper(extracted.Name)]; ok {
			product, _ := s.repo.GetByBarcode(alias.ProductBarcode)
			if product != nil {
				item := s.calculateItemDetails(product, extracted, params, "alias", 1.0)
				result.ScannedItems = append(result.ScannedItems, item)
				continue
			}
		}

		result.Unmatched = append(result.Unmatched, models.UnmatchedItem{
			InvoiceName: extracted.Name,
			Quantity:    extracted.Quantity,
			UnitPrice:   extracted.UnitPrice,
			Suggestions: s.repo.SearchSimilarProducts(extracted.Name, 5),
		})
	}

	return result, nil
}

func (s *ProductService) calculateItemDetails(product *models.Product, extracted models.ExtractedItem, params *models.SupplierInvoiceParams, matchType string, confidence float64) models.ScannedItem {
	unitPrice := extracted.UnitPrice
	if unitPrice == 0 && extracted.Quantity > 0 && extracted.TotalPrice > 0 {
		unitPrice = extracted.TotalPrice / extracted.Quantity
	}

	// Los porcentajes del producto son la tasa de cada impuesto.
	productRates := models.TaxRates{
		IvaPct:  product.Iva,
		IcuiPct: product.Icui,
		IbuaPct: product.Ibua,
	}

	// Si la factura del proveedor ya trae los impuestos incluidos, se quitan
	// para llegar a la base. Sólo se descuentan los que el proveedor realmente
	// incluye, por eso se arma un TaxRates parcial en vez de usar productRates.
	//
	// Antes esto se hacía dividiendo impuesto por impuesto —multiplicativo—
	// mientras la recepción sumaba los porcentajes —aditivo—. Con dos impuestos
	// las dos cuentas se separaban y el costo del lector nunca cuadraba con el
	// de la recepción. Ahora ambas salen de models.NetFromGross/GrossFromNet.
	if params != nil {
		included := models.TaxRates{}
		if params.PriceIncludesIVA {
			included.IvaPct = product.Iva
		}
		if params.PriceIncludesICUI {
			included.IcuiPct = product.Icui
		}
		if params.PriceIncludesIBUA {
			included.IbuaPct = product.Ibua
		}
		if !included.IsZero() {
			unitPrice = models.NetFromGross(unitPrice, included)
		}
	}

	costoReal := models.GrossFromNet(unitPrice, productRates)

	var margin float64
	var marginSource string

	if product.MarginPercentage > 0 {
		margin = product.MarginPercentage
		marginSource = "producto"
	} else if product.CategoryID > 0 && product.Category.MarginPercentage > 0 {
		margin = product.Category.MarginPercentage
		marginSource = "categoria"
	} else {
		margin = 20.0
		marginSource = "global"
	}

	pvpSugerido := costoReal * (1 + margin/100)
	pvpSugerido = applyRounding(pvpSugerido)

	return models.ScannedItem{
		Barcode:      product.Barcode,
		ProductName:  product.ProductName,
		InvoiceName:  extracted.Name,
		Quantity:     extracted.Quantity,
		CostUnit:     math.Round(unitPrice*100) / 100,
		CostoReal:    math.Round(costoReal*100) / 100,
		PVPActual:    product.SalePrice,
		PVPSugerido:  pvpSugerido,
		MarginUsed:   margin,
		MarginSource: marginSource,
		IVA:          product.Iva,
		ICUI:         product.Icui,
		IBUA:         product.Ibua,
		CurrentStock: product.Quantity,
		CurrentWAC:   product.PurchasePrice,
		Confidence:   confidence,
		MatchType:    matchType,
	}
}

func buildInvoicePrompt(supplierName string, params *models.SupplierInvoiceParams) string {
	prompt := fmt.Sprintf("\x60Analiza esta factura del proveedor \"%s\".\n"+
		"Extrae TODOS los productos con sus cantidades y precios.\n"+
		"Responde ÚNICAMENTE con JSON válido, sin texto adicional en el siguiente formato:\n"+
		"[\n"+
		"  {\n"+
		"    \"name\": \"nombre exacto del producto como aparece en la factura\",\n"+
		"    \"quantity\": número,\n"+
		"    \"unitPrice\": número,\n"+
		"    \"totalPrice\": número\n"+
		"  }\n"+
		"]\n"+
		"Reglas estrictas:\n"+
		"- Si solo aparece precio total de línea, divide entre cantidad para obtener unitario\n"+
		"- Ignora filas de subtotal, total, descuentos globales, encabezados y pie de página\n"+
		"- Si una cantidad dice \"1 PAC x 6 UND\", pon quantity: 6\n"+
		"- Precios como números puros sin símbolos ni puntos de miles\n"+
		"- Si un valor no es legible, pon 0\n"+
		"- NO incluyas productos con cantidad 0\x60", supplierName)

	if params != nil && params.Notes != "" {
		prompt += "\nInstrucción especial para este proveedor: " + params.Notes
	}
	return prompt
}

func (s *ProductService) callClaudeVision(imageBase64, mimeType, supplierName string, params *models.SupplierInvoiceParams) ([]models.ExtractedItem, error) {
	apiKey := os.Getenv("ANTHROPIC_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("ANTHROPIC_API_KEY no configurado en .env")
	}

	prompt := buildInvoicePrompt(supplierName, params)

	// Limpiar cabecera data:image/... del base64 si existe
	cleanBase64 := imageBase64
	if idx := strings.Index(imageBase64, ","); idx != -1 {
		cleanBase64 = imageBase64[idx+1:]
	}

	// Determinar media_type limpio
	cleanMime := mimeType
	if cleanMime == "" {
		cleanMime = "image/jpeg"
	}

	// Construir payload multimodal exacto para Claude
	reqBody := map[string]interface{}{
		"model":      VisionModel(),
		"max_tokens": 4000,
		"messages": []map[string]interface{}{
			{
				"role": "user",
				"content": []map[string]interface{}{
					{
						"type": "image",
						"source": map[string]interface{}{
							"type":       "base64",
							"media_type": cleanMime,
							"data":       cleanBase64,
						},
					},
					{
						"type": "text",
						"text": prompt,
					},
				},
			},
		},
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("x-api-key", apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")
	httpReq.Header.Set("content-type", "application/json")

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("claude API error %d: %s", resp.StatusCode, string(body))
	}

	var claudeResp struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(body, &claudeResp); err != nil {
		return nil, fmt.Errorf("error parseando respuesta de Claude: %v", err)
	}

	if len(claudeResp.Content) == 0 {
		return nil, fmt.Errorf("Claude devolvió respuesta vacía")
	}

	text := claudeResp.Content[0].Text
	text = strings.TrimPrefix(text, "```json")
	text = strings.TrimPrefix(text, "```")
	text = strings.TrimSuffix(text, "```")
	text = strings.TrimSpace(text)

	var items []models.ExtractedItem
	if err := json.Unmarshal([]byte(text), &items); err != nil {
		return nil, fmt.Errorf("error parseando JSON de Claude: %v. Raw: %s", err, text)
	}

	return items, nil
}
