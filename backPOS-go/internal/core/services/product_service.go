package services

import (
	"fmt"
	"time"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
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
	existing.Quantity = updatedProduct.Quantity
	existing.IsWeighted = updatedProduct.IsWeighted
	existing.CategoryID = updatedProduct.CategoryID
	existing.Iva = updatedProduct.Iva
	existing.Icui = updatedProduct.Icui
	existing.Ibua = updatedProduct.Ibua
	existing.MarginPercentage = updatedProduct.MarginPercentage
	existing.ImageUrl = updatedProduct.ImageUrl
	if updatedProduct.SupplierID != nil {
		existing.SupplierID = updatedProduct.SupplierID
	}

	// 3. Lógica de Precios: PVP se calcula siempre sobre el PurchasePrice (maxCost) + Margen
	if existing.MarginPercentage > 0 && existing.PurchasePrice > 0 {
		suggested := existing.PurchasePrice * (1 + existing.MarginPercentage/100)
		existing.SalePrice = applyRounding(suggested)
	} else {
		// Si no hay margen definido, usamos el precio de venta manual o el previo
		if updatedProduct.SalePrice > 0 {
			existing.SalePrice = applyRounding(updatedProduct.SalePrice)
		}
	}

	// Usamos Save en lugar de Update para asegurar que GORM maneje correctamente el objeto completo
	return s.repo.Save(existing)
}

func (s *ProductService) DeleteProduct(barcode string) error {
	return s.repo.Delete(barcode)
}

func (s *ProductService) ReceiveStock(barcode string, addedQuantity float64, newPurchasePrice float64, newSalePrice float64, supplierID *uint, iva, icui, ibua float64) error {
	product, err := s.repo.GetByBarcode(barcode)
	if err != nil {
		return err
	}

	product.Quantity += addedQuantity

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

func (s *ProductService) AdjustStock(barcode string, amount float64) error {
	product, err := s.repo.GetByBarcode(barcode)
	if err != nil {
		return err
	}
	newQuantity := product.Quantity + amount
	if newQuantity < 0 {
		newQuantity = 0
	}
	return s.repo.UpdateQuantity(barcode, newQuantity)
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

type ReceiveEntry struct {
	Barcode          string  `json:"barcode"`
	AddedQuantity    float64 `json:"addedQuantity"`
	NewPurchasePrice float64 `json:"newPurchasePrice"`
	NewSalePrice     float64 `json:"newSalePrice"`
	SupplierID       *uint   `json:"supplierId"`
	Iva              float64 `json:"iva"`
	Icui             float64 `json:"icui"`
	Ibua             float64 `json:"ibua"`
}

func (s *ProductService) BulkReceiveStock(entries []ReceiveEntry) error {
	for _, entry := range entries {
		if err := s.ReceiveStock(entry.Barcode, entry.AddedQuantity, entry.NewPurchasePrice, entry.NewSalePrice, entry.SupplierID, entry.Iva, entry.Icui, entry.Ibua); err != nil {
			return err
		}
	}
	return nil
}
