package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
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

	// Si el cÃ³digo de barras ha cambiado, verificar que el nuevo no estÃ© ocupado por OTRO producto
	// IMPORTANTE: Solo verificar el barcode principal, NO cÃ³digos alternos
	if updatedProduct.Barcode != "" && updatedProduct.Barcode != barcode {
		collision, err := s.repo.GetByBarcode(updatedProduct.Barcode)
		if err == nil && collision != nil && collision.Barcode == updatedProduct.Barcode {
			// Solo es colisiÃ³n si otro producto tiene ese barcode como cÃ³digo PRINCIPAL
			return fmt.Errorf("el cÃ³digo de barras '%s' ya estÃ¡ en uso por el producto: %s", updatedProduct.Barcode, collision.ProductName)
		}
	}

	// 1. LÃ³gica de Costo: Priorizar el precio manual del update para flexibilidad total
	if updatedProduct.PurchasePrice > 0 {
		existing.PurchasePrice = updatedProduct.PurchasePrice
		
		// Si tiene un proveedor principal, sincronizar ese costo tambiÃ©n
		if existing.SupplierID != nil && *existing.SupplierID > 0 {
			_ = s.repo.UpdateSupplierPrice(barcode, *existing.SupplierID, existing.PurchasePrice)
		}
	} else {
		// Si no se envÃ­a precio nuevo, intentar mantener el mÃ¡ximo de proveedores (histÃ³rico)
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

	// 2. Actualizar campos bÃ¡sicos
	existing.Barcode = updatedProduct.Barcode // Permitir cambio de cÃ³digo principal
	existing.ProductName = updatedProduct.ProductName
	existing.IsWeighted = updatedProduct.IsWeighted
	existing.CategoryID = updatedProduct.CategoryID
	existing.AlternateCodes = updatedProduct.AlternateCodes // Nuevos cÃ³digos alternos
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

	// LÃ³gica de Empaques (SincronizaciÃ³n con Producto Base)
	existing.IsPack = updatedProduct.IsPack
	existing.PackMultiplier = updatedProduct.PackMultiplier
	if updatedProduct.BaseProductBarcode != nil && *updatedProduct.BaseProductBarcode != "" {
		existing.BaseProductBarcode = updatedProduct.BaseProductBarcode

		// BLINDAJE MODO PACK: Solo actualizar el base si hay un cambio real en la cantidad del pack
		// solicitado por el usuario, evitando sobreescrituras accidentales por re-cÃ¡lculos.
		if existing.PackMultiplier > 0 {
			baseProduct, err := s.repo.GetByBarcode(*existing.BaseProductBarcode)
			if err == nil {
				// Calcular cuÃ¡ntas unidades de empaque REPRESENTA el stock actual del base
				currentCalculatedPackQty := math.Floor(baseProduct.Quantity / float64(existing.PackMultiplier))

				// Si la cantidad que envÃ­a el usuario es diferente a la calculada, significa que el usuario
				// quiere forzar un nuevo stock para el pack (y por ende para el base)
				if updatedProduct.Quantity != currentCalculatedPackQty {
					// Calcular nueva cantidad base: cantidad_pack * multiplicador
					baseProduct.Quantity = updatedProduct.Quantity * float64(existing.PackMultiplier)
					
					// Usar UpdateQuantity para asegurar atomicidad e invalidaciÃ³n de cachÃ©
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
		existing.BaseProductBarcode = nil // Aseguramos NULL en la DB si viene vacÃ­o o nulo
	}
	existing.Quantity = updatedProduct.Quantity
	// 3. LÃ³gica de Precios:
	if existing.MarginPercentage > 0 && existing.PurchasePrice > 0 {
		suggested := existing.PurchasePrice * (1 + existing.MarginPercentage/100)
		existing.SalePrice = applyRounding(suggested)
	} else {
		// Si no hay margen definido, usamos el precio de venta manual o el previo
		if updatedProduct.SalePrice > 0 {
			existing.SalePrice = applyRounding(updatedProduct.SalePrice)
		}
	}

	// 4. (VerificaciÃ³n de duplicados ya se hizo arriba, no repetir)

	// 5. Ejecutar Update principal (incluye cambio de barcode si aplica)
	if err := s.repo.Update(barcode, existing); err != nil {
		errStr := err.Error()
		if strings.Contains(errStr, "23505") || strings.Contains(errStr, "duplicate key") {
			return fmt.Errorf("error: el cÃ³digo de barras %s ya estÃ¡ en uso por otro producto", existing.Barcode)
		}
		return fmt.Errorf("error al persistir producto: %w", err)
	}

	// 5. Sincronizar Proveedores (Many-to-Many) - DESPUÃ‰S del update para usar el nuevo barcode si cambiÃ³
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

	// === LÃ“GICA DE SINCRONIZACIÃ“N DE PACKS ===
	// Si es un pack con producto base vÃ¡lido, el inventario real vive en el base
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

		// Log en el KÃ¡rdex del Base
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

	// === LÃ“GICA DE COSTO PROMEDIO PONDERADO (WAC) ===
	currentStock := product.Quantity - addedQuantity
	if currentStock < 0 {
		currentStock = 0
	}

	// El costo real de esta entrada es base + impuestos
	entryTotalCost := newPurchasePrice + iva + icui + ibua

	if entryTotalCost > 0 {
		if currentStock+addedQuantity > 0 {
			// FÃ³rmula: (StockAnterior * CostoAnterior + StockNuevo * CostoNuevo) / StockTotal
			product.PurchasePrice = ((currentStock * product.PurchasePrice) + (addedQuantity * entryTotalCost)) / (currentStock + addedQuantity)
		} else {
			product.PurchasePrice = entryTotalCost
		}

		// Guardar los Ãºltimos impuestos aplicados como referencia
		product.Iva = iva
		product.Icui = icui
		product.Ibua = ibua

		// Actualizar el precio especÃ­fico del proveedor (como referencia histÃ³rica)
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
		// El precio de venta NO SE TOCA automÃ¡ticamente.
		// Solo recalculamos el margen informativo.
		product.MarginPercentage = ((product.SalePrice / product.PurchasePrice) - 1) * 100
	}

	if supplierID != nil {
		product.SupplierID = supplierID
	}

	if err := s.repo.Update(barcode, product); err != nil {
		return err
	}
	
	// AutomatizaciÃ³n: Marcar pedido esperado como recibido
	if supplierID != nil {
		_ = s.expected.MarkAsReceivedBySupplier(*supplierID)
	}

	// 4. Log the movement for Ð¿Ñ€Ð¾Ñ„ÐµÑÑÐ¸Ð¾Ð½Ð°Ð»ÑŒÐ½Ñ‹Ð¹ KÃ¡rdex
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

	// LÃ³gica de Packs (Ajuste Manual)
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
					// Continuar con los demÃ¡s aunque uno falle
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
		// AutomatizaciÃ³n: Intentar identificar el proveedor principal para marcar preventa como recibida
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

	// 2. Registrar Movimiento de KÃ¡rdex Justificado
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
	// Dummy implementation for now
	return nil
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

func (s *ProductService) ScanInvoice(imageBase64, mimeType, supplierName string, supplierID uint) (*models.ScanInvoiceResult, error) {
	aliases, err := s.repo.GetSupplierAliases(supplierID)
	if err != nil {
		aliases = make(map[string]models.SupplierProductAlias)
	}

	params, _ := s.repo.GetSupplierInvoiceParams(supplierID)

	extractedItems, err := s.callGeminiVision(imageBase64, mimeType, supplierName, params)
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
		})
	}

	return result, nil
}

func (s *ProductService) calculateItemDetails(product *models.Product, extracted models.ExtractedItem, params *models.SupplierInvoiceParams, matchType string, confidence float64) models.ScannedItem {
	unitPrice := extracted.UnitPrice
	if unitPrice == 0 && extracted.Quantity > 0 && extracted.TotalPrice > 0 {
		unitPrice = extracted.TotalPrice / extracted.Quantity
	}

	if params != nil && params.PriceIncludesIVA && product.Iva > 0 {
		unitPrice = unitPrice / (1 + product.Iva/100)
	}
	if params != nil && params.PriceIncludesICUI && product.Icui > 0 {
		unitPrice = unitPrice / (1 + product.Icui/100)
	}
	if params != nil && params.PriceIncludesIBUA && product.Ibua > 0 {
		unitPrice = unitPrice / (1 + product.Ibua/100)
	}

	costoReal := unitPrice
	costoReal *= (1 + product.Iva/100)
	costoReal *= (1 + product.Icui/100)
	costoReal *= (1 + product.Ibua/100)

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
	prompt := fmt.Sprintf("\x60Analiza esta factura del proveedor \"%s\".\n" +
		"Extrae TODOS los productos con sus cantidades y precios.\n" +
		"Responde ÚNICAMENTE con JSON válido, sin texto adicional en el siguiente formato:\n" +
		"[\n" +
		"  {\n" +
		"    \"name\": \"nombre exacto del producto como aparece en la factura\",\n" +
		"    \"quantity\": número,\n" +
		"    \"unitPrice\": número,\n" +
		"    \"totalPrice\": número\n" +
		"  }\n" +
		"]\n" +
		"Reglas estrictas:\n" +
		"- Si solo aparece precio total de línea, divide entre cantidad para obtener unitario\n" +
		"- Ignora filas de subtotal, total, descuentos globales, encabezados y pie de página\n" +
		"- Si una cantidad dice \"1 PAC x 6 UND\", pon quantity: 6\n" +
		"- Precios como números puros sin símbolos ni puntos de miles\n" +
		"- Si un valor no es legible, pon 0\n" +
		"- NO incluyas productos con cantidad 0\x60", supplierName)

	if params != nil && params.Notes != "" {
		prompt += "\nInstrucción especial para este proveedor: " + params.Notes
	}
	return prompt
}

func (s *ProductService) callGeminiVision(imageBase64, mimeType, supplierName string, params *models.SupplierInvoiceParams) ([]models.ExtractedItem, error) {
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("GEMINI_API_KEY no configurado")
	}

	url := "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + apiKey

	prompt := buildInvoicePrompt(supplierName, params)

	if idx := strings.Index(imageBase64, ","); idx != -1 {
		imageBase64 = imageBase64[idx+1:]
	}

	reqBody := map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"parts": []map[string]interface{}{
					{
						"text": prompt,
					},
					{
						"inline_data": map[string]interface{}{
							"mime_type": mimeType,
							"data":      imageBase64,
						},
					},
				},
			},
		},
		"generationConfig": map[string]interface{}{
			"temperature": 0.0,
			"response_mime_type": "application/json",
		},
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	resp, err := http.Post(url, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&errResp)
		return nil, fmt.Errorf("gemini API error (%%d): %%v", resp.StatusCode, errResp)
	}

	var geminiResp struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&geminiResp); err != nil {
		return nil, err
	}

	if len(geminiResp.Candidates) == 0 || len(geminiResp.Candidates[0].Content.Parts) == 0 {
		return nil, fmt.Errorf("gemini devolvió respuesta vacía")
	}

	text := geminiResp.Candidates[0].Content.Parts[0].Text

	text = strings.TrimPrefix(text, "```json")
	text = strings.TrimPrefix(text, "```")
	text = strings.TrimSuffix(text, "```")
	text = strings.TrimSpace(text)

	var items []models.ExtractedItem
	if err := json.Unmarshal([]byte(text), &items); err != nil {
		return nil, fmt.Errorf("error parseando JSON de Gemini: %v. Raw Text: %s", err, text)
	}

	return items, nil
}
