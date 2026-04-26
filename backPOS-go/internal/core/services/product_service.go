package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"fmt"
	"math"
	"time"
)

type ProductService struct {
	repo         ports.ProductRepository
	movementRepo ports.StockMovementRepository
}

func NewProductService(repo ports.ProductRepository, movementRepo ports.StockMovementRepository) *ProductService {
	return &ProductService{repo: repo, movementRepo: movementRepo}
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
		product.SalePrice = applyRounding(product.SalePrice)
	}
	return s.repo.Save(product)
}

func (s *ProductService) GetProduct(barcode string) (*models.Product, error) {
	return s.repo.GetByBarcode(barcode)
}

func (s *ProductService) GetProductWithPreloads(barcode string, preloads ...string) (*models.Product, error) {
	return s.repo.GetByBarcodeWithPreloads(barcode, preloads...)
}

func (s *ProductService) GetAllProducts() ([]models.Product, error) {
	return s.repo.GetAll()
}

func (s *ProductService) GetPaginatedProducts(page, pageSize int, search string) ([]models.Product, int64, error) {
	return s.repo.GetPaginated(page, pageSize, search)
}

func (s *ProductService) UpdateProduct(barcode string, updatedProduct *models.Product) error {
	existing, err := s.repo.GetByBarcode(barcode)
	if err != nil {
		return err
	}

	// 1. Obtener el costo máximo de sus proveedores para mantener integridad
	supplierPrices, err := s.repo.GetSupplierPrices(barcode)
	if err == nil && len(supplierPrices) > 0 {
		maxCost := 0.0
		for _, sp := range supplierPrices {
			if sp.PurchasePrice > maxCost {
				maxCost = sp.PurchasePrice
			}
		}
		// El precio de compra en el registro principal SIEMPRE es el máximo de proveedores
		existing.PurchasePrice = maxCost
	} else {
		// Si no hay proveedores vinculados, permitimos el precio manual del update
		existing.PurchasePrice = updatedProduct.PurchasePrice
	}

	// 2. Actualizar campos básicos
	existing.ProductName = updatedProduct.ProductName
	existing.IsWeighted = updatedProduct.IsWeighted
	existing.CategoryID = updatedProduct.CategoryID
	// Limpiar asociaciones para que GORM no sobreescriba foreign keys con objetos preloaded
	existing.Category = models.Category{}
	existing.Supplier = models.Supplier{}
	existing.UpdatedBy = models.Employee{}
	existing.CreatedBy = models.Employee{}
	existing.Iva = updatedProduct.Iva
	existing.Icui = updatedProduct.Icui
	existing.Ibua = updatedProduct.Ibua
	existing.MarginPercentage = updatedProduct.MarginPercentage
	existing.ImageUrl = updatedProduct.ImageUrl
	existing.MinStock = updatedProduct.MinStock
	existing.IsActive = updatedProduct.IsActive
	if updatedProduct.UpdatedByDNI != "" {
		existing.UpdatedByDNI = updatedProduct.UpdatedByDNI
		existing.UpdatedByName = updatedProduct.UpdatedByName
	}
	if updatedProduct.SupplierID != nil && *updatedProduct.SupplierID > 0 {
		existing.SupplierID = updatedProduct.SupplierID
	} else if updatedProduct.SupplierID != nil && *updatedProduct.SupplierID == 0 {
		existing.SupplierID = nil
	}

	if updatedProduct.CategoryID == 0 {
		existing.CategoryID = 0 // Wait, CategoryID is uint, not pointer?
	}

	// Lógica de Empaques (Sincronización con Producto Base)
	existing.IsPack = updatedProduct.IsPack
	existing.PackMultiplier = updatedProduct.PackMultiplier
	if updatedProduct.BaseProductBarcode != nil && *updatedProduct.BaseProductBarcode != "" {
		existing.BaseProductBarcode = updatedProduct.BaseProductBarcode

		// Si el stock ha cambiado en esta edición, debemos impactar al producto base
		if updatedProduct.Quantity != existing.Quantity && existing.PackMultiplier > 0 {
			baseProduct, err := s.repo.GetByBarcode(*existing.BaseProductBarcode)
			if err == nil {
				// Calcular nueva cantidad base: cantidad_pack * multiplicador
				baseProduct.Quantity = updatedProduct.Quantity * float64(existing.PackMultiplier)
				_ = s.repo.Update(baseProduct.Barcode, baseProduct)

				// Log del ajuste en el base
				baseMovement := &models.StockMovement{
					Date:         time.Now(),
					Barcode:      baseProduct.Barcode,
					Quantity:     0, // Es un ajuste absoluto en este caso
					Type:         "ADJUSTMENT_PACK",
					Reason:       "PACK_UPDATE_SYNC",
					ReferenceID:  fmt.Sprintf("SYNC-%d", time.Now().Unix()),
					EmployeeDNI:  existing.UpdatedByDNI,
					EmployeeName: existing.UpdatedByName,
				}
				_ = s.movementRepo.Save(baseMovement)
			}
		}
	} else {
		existing.BaseProductBarcode = nil // Aseguramos NULL en la DB
	}
	existing.Quantity = updatedProduct.Quantity
	// 3. Lógica de Precios:
	if existing.MarginPercentage > 0 && existing.PurchasePrice > 0 {
		suggested := existing.PurchasePrice * (1 + existing.MarginPercentage/100)
		existing.SalePrice = applyRounding(suggested)
	} else {
		// Si no hay margen definido, usamos el precio de venta manual o el previo
		if updatedProduct.SalePrice > 0 {
			existing.SalePrice = applyRounding(updatedProduct.SalePrice)
		}
	}

	// 4. Sincronizar Proveedores (Many-to-Many)
	if len(updatedProduct.Suppliers) > 0 {
		var ids []uint
		for _, s := range updatedProduct.Suppliers {
			if s.ID > 0 {
				ids = append(ids, s.ID)
			}
		}
		if len(ids) > 0 {
			_ = s.repo.SyncSuppliers(barcode, ids)
		}
	}

	// Usamos Save en lugar de Update para asegurar que GORM maneje correctamente el objeto completo
	return s.repo.Save(existing)
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

func (s *ProductService) ReceiveStock(barcode string, addedQuantity float64, newPurchasePrice float64, newSalePrice float64, supplierID *uint, iva, icui, ibua float64) error {
	product, err := s.repo.GetByBarcode(barcode)
	if err != nil {
		return err
	}

	// === LÓGICA DE SINCRONIZACIÓN DE PACKS ===
	// Si es un pack con producto base válido, el inventario real vive en el base
	if product.IsPack && product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" && product.PackMultiplier > 0 {
		baseProduct, err := s.repo.GetByBarcode(*product.BaseProductBarcode)
		if err != nil {
			return fmt.Errorf("error obteniendo producto base (barcode=%s): %w", *product.BaseProductBarcode, err)
		}

		// 1. Calcular cantidad expandida y sumar al base
		expandedQuantity := addedQuantity * float64(product.PackMultiplier)
		baseProduct.Quantity += expandedQuantity

		// 2. Guardar base product
		if err := s.repo.Update(baseProduct.Barcode, baseProduct); err != nil {
			return fmt.Errorf("error actualizando producto base: %w", err)
		}

		// 3. Sincronizar el stock del pack actual
		product.Quantity = math.Floor(baseProduct.Quantity / float64(product.PackMultiplier))

		// Log en el Kárdex del Base
		baseMovement := &models.StockMovement{
			Date:         time.Now(),
			Barcode:      baseProduct.Barcode,
			Quantity:     expandedQuantity,
			Type:         "IN",
			Reason:       "PACK_RECEPTION",
			ReferenceID:  fmt.Sprintf("PACK-%d", time.Now().Unix()),
			EmployeeDNI:  product.UpdatedByDNI,
			EmployeeName: product.UpdatedByName,
		}
		_ = s.movementRepo.Save(baseMovement)
	} else {
		// Comportamiento normal
		product.Quantity += addedQuantity
	}

	// El costo real de esta entrada es base + impuestos
	entryTotalCost := newPurchasePrice + iva + icui + ibua

	if entryTotalCost > 0 && supplierID != nil {
		// 1. Guardar/Actualizar el precio específico de este proveedor
		if err := s.repo.UpdateSupplierPrice(barcode, *supplierID, entryTotalCost); err != nil {
			return err
		}

		// 2. Obtener todos los precios de proveedores para este producto
		supplierPrices, err := s.repo.GetSupplierPrices(barcode)
		if err == nil && len(supplierPrices) > 0 {
			maxCost := 0.0
			for _, sp := range supplierPrices {
				if sp.PurchasePrice > maxCost {
					maxCost = sp.PurchasePrice
				}
			}
			// 3. El costo del producto siempre es el MÁXIMO histórico de sus proveedores
			product.PurchasePrice = maxCost
		} else {
			product.PurchasePrice = entryTotalCost
		}

		// Guardar los últimos impuestos aplicados como referencia
		product.Iva = iva
		product.Icui = icui
		product.Ibua = ibua
	}

	if newSalePrice > 0 {
		product.SalePrice = applyRounding(newSalePrice)
		// Update persistent margin based on newest sale price vs current max cost
		if product.PurchasePrice > 0 {
			margin := ((product.SalePrice / product.PurchasePrice) - 1) * 100
			product.MarginPercentage = margin
		}
	} else if product.PurchasePrice > 0 && product.MarginPercentage > 0 {
		// Re-calculate based on current (potentially updated) max cost and existing margin
		suggested := product.PurchasePrice * (1 + product.MarginPercentage/100)
		product.SalePrice = applyRounding(suggested)
	}

	if supplierID != nil {
		product.SupplierID = supplierID
	}

	if err := s.repo.Update(barcode, product); err != nil {
		return err
	}

	// 4. Log the movement for профессиональный Kárdex
	movement := &models.StockMovement{
		Date:         time.Now(),
		Barcode:      barcode,
		Quantity:     addedQuantity,
		Type:         "IN",
		Reason:       "RECEPTION",
		ReferenceID:  fmt.Sprintf("RECP-%d", time.Now().Unix()),
		EmployeeDNI:  product.UpdatedByDNI,
		EmployeeName: product.UpdatedByName,
	}
	_ = s.movementRepo.Save(movement)

	return nil
}

func (s *ProductService) AdjustStock(barcode string, amount float64, employeeDNI string, employeeName string) error {
	product, err := s.repo.GetByBarcode(barcode)
	if err != nil {
		return err
	}
	movementType := "ADJUSTMENT_UP"
	if amount < 0 {
		movementType = "ADJUSTMENT_DOWN"
	}

	// Lógica de Packs (Ajuste Manual)
	if product.IsPack && product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" && product.PackMultiplier > 0 {
		baseProduct, err := s.repo.GetByBarcode(*product.BaseProductBarcode)
		if err == nil {
			// 1. Ajustar el producto base (multiplicando el ajuste)
			baseAdjustment := amount * float64(product.PackMultiplier)
			baseProduct.Quantity += baseAdjustment
			if baseProduct.Quantity < 0 {
				baseProduct.Quantity = 0
			}
			_ = s.repo.Update(baseProduct.Barcode, baseProduct)

			// 2. Recalcular el stock del pack
			product.Quantity = math.Floor(baseProduct.Quantity / float64(product.PackMultiplier))
			_ = s.repo.UpdateQuantity(barcode, product.Quantity)

			// Log en el base
			baseMovement := &models.StockMovement{
				Date:         time.Now(),
				Barcode:      baseProduct.Barcode,
				Quantity:     baseAdjustment,
				Type:         movementType,
				Reason:       "PACK_ADJUSTMENT_SYNC",
				ReferenceID:  fmt.Sprintf("PADJ-%d", time.Now().Unix()),
				EmployeeDNI:  employeeDNI,
				EmployeeName: employeeName,
			}
			_ = s.movementRepo.Save(baseMovement)
		}
	} else {
		// Comportamiento normal
		product.Quantity += amount
		if product.Quantity < 0 {
			product.Quantity = 0
		}
		if err := s.repo.UpdateQuantity(barcode, product.Quantity); err != nil {
			return err
		}
	}


	movement := &models.StockMovement{
		Date:         time.Now(),
		Barcode:      barcode,
		Quantity:     amount,
		Type:         movementType,
		Reason:       "MANUAL_ADJUSTMENT",
		ReferenceID:  fmt.Sprintf("ADJ-%d", time.Now().Unix()),
		EmployeeDNI:  employeeDNI,
		EmployeeName: employeeName,
	}
	_ = s.movementRepo.Save(movement)

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
					// Continuar con los demás aunque uno falle
					fmt.Printf("Error actualizando %s: %v\n", p.Barcode, err)
				}
			}
		}
	}
	return nil
}

func (s *ProductService) BulkReceiveStock(entries []ports.ReceiveEntry, orderID *uint) error {
	return s.repo.BulkReceive(entries, orderID)
}

func (s *ProductService) GetSavingsOpportunities() ([]ports.SavingsOpportunity, error) {
	return s.repo.GetSavingsOpportunities()
}

func (s *ProductService) GetProductPriceComparison(barcode string) ([]models.ProductSupplier, error) {
	return s.repo.GetSupplierPrices(barcode)
}
