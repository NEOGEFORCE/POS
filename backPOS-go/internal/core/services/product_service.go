package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"fmt"
	"math"
	"strings"
	"time"
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
		product.SalePrice = applyRounding(product.SalePrice)
	}
	return s.repo.Save(product)
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

func (s *ProductService) GetPaginatedProducts(page, pageSize int, search string) ([]models.Product, int64, error) {
	return s.repo.GetPaginated(page, pageSize, search, 0)
}

func (s *ProductService) UpdateProduct(barcode string, updatedProduct *models.Product) error {
	existing, err := s.repo.GetByBarcode(barcode)
	if err != nil {
		return err
	}

	// Si el código de barras ha cambiado, verificar que el nuevo no esté ocupado por OTRO producto
	// IMPORTANTE: Solo verificar el barcode principal, NO códigos alternos
	if updatedProduct.Barcode != "" && updatedProduct.Barcode != barcode {
		collision, err := s.repo.GetByBarcode(updatedProduct.Barcode)
		if err == nil && collision != nil && collision.Barcode == updatedProduct.Barcode {
			// Solo es colisión si otro producto tiene ese barcode como código PRINCIPAL
			return fmt.Errorf("el código de barras '%s' ya está en uso por el producto: %s", updatedProduct.Barcode, collision.ProductName)
		}
	}

	// 1. Lógica de Costo: Priorizar el precio manual del update para flexibilidad total
	if updatedProduct.PurchasePrice > 0 {
		existing.PurchasePrice = updatedProduct.PurchasePrice
		
		// Si tiene un proveedor principal, sincronizar ese costo también
		if existing.SupplierID != nil && *existing.SupplierID > 0 {
			_ = s.repo.UpdateSupplierPrice(barcode, *existing.SupplierID, existing.PurchasePrice)
		}
	} else {
		// Si no se envía precio nuevo, intentar mantener el máximo de proveedores (histórico)
		supplierPrices, err := s.repo.GetSupplierPrices(barcode)
		if err == nil && len(supplierPrices) > 0 {
			maxCost := 0.0
			for _, sp := range supplierPrices {
				if sp.PurchasePrice > maxCost {
					maxCost = sp.PurchasePrice
				}
			}
			existing.PurchasePrice = maxCost
		}
	}

	// 2. Actualizar campos básicos
	existing.Barcode = updatedProduct.Barcode // Permitir cambio de código principal
	existing.ProductName = updatedProduct.ProductName
	existing.IsWeighted = updatedProduct.IsWeighted
	existing.CategoryID = updatedProduct.CategoryID
	existing.AlternateCodes = updatedProduct.AlternateCodes // Nuevos códigos alternos
	// Limpiar asociaciones para que GORM no sobreescriba foreign keys con objetos preloaded
	existing.Category = models.Category{}
	existing.Supplier = models.Supplier{}
	existing.UpdatedBy = models.Employee{}
	existing.CreatedBy = models.Employee{}
	existing.BaseProduct = nil
	existing.Suppliers = []models.Supplier{}
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
		existing.CategoryID = 0
	}

	// Lógica de Empaques (Sincronización con Producto Base)
	existing.IsPack = updatedProduct.IsPack
	existing.PackMultiplier = updatedProduct.PackMultiplier
	if updatedProduct.BaseProductBarcode != nil && *updatedProduct.BaseProductBarcode != "" {
		existing.BaseProductBarcode = updatedProduct.BaseProductBarcode

		// BLINDAJE MODO PACK: Solo actualizar el base si hay un cambio real en la cantidad del pack
		// solicitado por el usuario, evitando sobreescrituras accidentales por re-cálculos.
		if existing.PackMultiplier > 0 {
			baseProduct, err := s.repo.GetByBarcode(*existing.BaseProductBarcode)
			if err == nil {
				// Calcular cuántas unidades de empaque REPRESENTA el stock actual del base
				currentCalculatedPackQty := math.Floor(baseProduct.Quantity / float64(existing.PackMultiplier))

				// Si la cantidad que envía el usuario es diferente a la calculada, significa que el usuario
				// quiere forzar un nuevo stock para el pack (y por ende para el base)
				if updatedProduct.Quantity != currentCalculatedPackQty {
					// Calcular nueva cantidad base: cantidad_pack * multiplicador
					baseProduct.Quantity = updatedProduct.Quantity * float64(existing.PackMultiplier)
					
					// Usar UpdateQuantity para asegurar atomicidad e invalidación de caché
					_ = s.repo.UpdateQuantity(baseProduct.Barcode, baseProduct.Quantity)

					// Log del ajuste en el base
					baseMovement := &models.StockMovement{
						Date:         time.Now(),
						Barcode:      baseProduct.Barcode,
						Quantity:     baseProduct.Quantity,
						Type:         "IN",
						Reason:       "PACK_UPDATE_SYNC",
						ReferenceID:  fmt.Sprintf("PSYNC-%d", time.Now().Unix()),
						EmployeeDNI:  updatedProduct.UpdatedByDNI,
						EmployeeName: updatedProduct.UpdatedByName,
					}
					_ = s.movementRepo.Save(baseMovement)
				}
			}
		}
	} else {
		existing.BaseProductBarcode = nil // Aseguramos NULL en la DB si viene vacío o nulo
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

	// 4. (Verificación de duplicados ya se hizo arriba, no repetir)

	// 5. Ejecutar Update principal (incluye cambio de barcode si aplica)
	if err := s.repo.Update(barcode, existing); err != nil {
		errStr := err.Error()
		if strings.Contains(errStr, "23505") || strings.Contains(errStr, "duplicate key") {
			return fmt.Errorf("error: el código de barras %s ya está en uso por otro producto", existing.Barcode)
		}
		return fmt.Errorf("error al persistir producto: %w", err)
	}

	// 5. Sincronizar Proveedores (Many-to-Many) - DESPUÉS del update para usar el nuevo barcode si cambió
	if len(updatedProduct.Suppliers) > 0 {
		var ids []uint
		for _, s := range updatedProduct.Suppliers {
			if s.ID > 0 {
				ids = append(ids, s.ID)
			}
		}
		if len(ids) > 0 {
			// Usamos existing.Barcode porque ya fue actualizado en la DB
			_ = s.repo.SyncSuppliers(existing.Barcode, ids)
		}
	}

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

	// === LÓGICA DE COSTO PROMEDIO PONDERADO (WAC) ===
	currentStock := product.Quantity - addedQuantity
	if currentStock < 0 {
		currentStock = 0
	}

	// El costo real de esta entrada es base + impuestos
	entryTotalCost := newPurchasePrice + iva + icui + ibua

	if entryTotalCost > 0 {
		if currentStock+addedQuantity > 0 {
			// Fórmula: (StockAnterior * CostoAnterior + StockNuevo * CostoNuevo) / StockTotal
			product.PurchasePrice = ((currentStock * product.PurchasePrice) + (addedQuantity * entryTotalCost)) / (currentStock + addedQuantity)
		} else {
			product.PurchasePrice = entryTotalCost
		}

		// Guardar los últimos impuestos aplicados como referencia
		product.Iva = iva
		product.Icui = icui
		product.Ibua = ibua

		// Actualizar el precio específico del proveedor (como referencia histórica)
		if supplierID != nil {
			_ = s.repo.UpdateSupplierPrice(barcode, *supplierID, entryTotalCost)
		}
	}

	if newSalePrice > 0 {
		product.SalePrice = applyRounding(newSalePrice)
		// Update persistent margin based on newest sale price vs current WAC cost
		if product.PurchasePrice > 0 {
			margin := ((product.SalePrice / product.PurchasePrice) - 1) * 100
			product.MarginPercentage = margin
		}
	} else if product.PurchasePrice > 0 {
		// El precio de venta NO SE TOCA automáticamente.
		// Solo recalculamos el margen informativo.
		product.MarginPercentage = ((product.SalePrice / product.PurchasePrice) - 1) * 100
	}

	if supplierID != nil {
		product.SupplierID = supplierID
	}

	if err := s.repo.Update(barcode, product); err != nil {
		return err
	}
	
	// Automatización: Marcar pedido esperado como recibido
	if supplierID != nil {
		_ = s.expected.MarkAsReceivedBySupplier(*supplierID)
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

func (s *ProductService) BulkReceiveStock(entries []ports.ReceiveEntry, orderID *uint, bypassExpense bool, paymentSource string, employeeDNI string, supplierID *uint, freightCost float64, totalWeight float64, isEgreso bool) error {
	_, err := s.repo.BulkReceive(entries, orderID, bypassExpense, paymentSource, employeeDNI, supplierID, freightCost, totalWeight, isEgreso)
	if err == nil {
		// Automatización: Intentar identificar el proveedor principal para marcar preventa como recibida
		var mainSupplierID uint
		for _, e := range entries {
			if e.SupplierID != nil && *e.SupplierID > 0 {
				mainSupplierID = *e.SupplierID
				break
			}
		}
		if mainSupplierID > 0 {
			_ = s.expected.MarkAsReceivedBySupplier(mainSupplierID)
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
	product, err := s.repo.GetByBarcode(barcode)
	if err != nil {
		return err
	}

	if product.Quantity < 1 {
		return fmt.Errorf("no hay stock suficiente de %s para abrir", product.ProductName)
	}

	// 1. Restar 1 al stock
	product.Quantity -= 1
	if err := s.repo.UpdateQuantity(barcode, product.Quantity); err != nil {
		return err
	}

	// 2. Registrar Movimiento de Kárdex Justificado
	movement := &models.StockMovement{
		Date:         time.Now(),
		Barcode:      barcode,
		Quantity:     1,
		Type:         "OUT",
		Reason:       "OPEN_BULK",
		ReferenceID:  fmt.Sprintf("OPEN-%d", time.Now().Unix()),
		EmployeeDNI:  employeeDNI,
		EmployeeName: employeeName,
	}
	_ = s.movementRepo.Save(movement)

	return nil
}
func (s *ProductService) UpsertProduct(product *models.Product) error {
	existing, err := s.repo.GetByBarcode(product.Barcode)
	if err != nil || existing == nil {
		// Crear nuevo
		return s.CreateProduct(product)
	}

	// Actualizar existente (solo campos básicos del CSV)
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
	// Dummy implementation for now
	return nil
}

func (s *ProductService) EditReception(ref string, qty float64, price float64, dniStr string, reason string) error {
	// Dummy implementation for now
	return nil
}
