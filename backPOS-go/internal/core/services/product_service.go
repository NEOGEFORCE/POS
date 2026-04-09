package services

import (
	"fmt"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

type ProductService struct {
	repo ports.ProductRepository
}

func NewProductService(repo ports.ProductRepository) *ProductService {
	return &ProductService{repo: repo}
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

func (s *ProductService) GetPaginatedProducts(page, pageSize int) ([]models.Product, int64, error) {
	return s.repo.GetPaginated(page, pageSize)
}

func (s *ProductService) UpdateProduct(barcode string, product *models.Product) error {
	return s.repo.Update(barcode, product)
}

func (s *ProductService) DeleteProduct(barcode string) error {
	return s.repo.Delete(barcode)
}

func (s *ProductService) ReceiveStock(barcode string, addedQuantity float64, newPurchasePrice float64, newSalePrice float64, supplierID *uint) error {
	product, err := s.repo.GetByBarcode(barcode)
	if err != nil {
		return err
	}

	product.Quantity += addedQuantity

	if newPurchasePrice > 0 {
		product.PurchasePrice = newPurchasePrice
		// If we only updated purchase price, update sale price based on existing margin
		if newSalePrice <= 0 && product.MarginPercentage > 0 {
			product.SalePrice = product.PurchasePrice * (1 + product.MarginPercentage/100)
		}
	}

	if newSalePrice > 0 {
		product.SalePrice = applyRounding(newSalePrice)
		// Update persistent margin based on newest sale price
		if product.PurchasePrice > 0 {
			margin := ((product.SalePrice / product.PurchasePrice) - 1) * 100
			product.MarginPercentage = margin
		}
	} else if newPurchasePrice > 0 && product.MarginPercentage > 0 {
		// Re-calculate based on new cost and existing margin
		suggested := product.PurchasePrice * (1 + product.MarginPercentage/100)
		product.SalePrice = applyRounding(suggested)
	}

	if supplierID != nil {
		product.SupplierID = supplierID
	}

	return s.repo.Update(barcode, product)
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
}

func (s *ProductService) BulkReceiveStock(entries []ReceiveEntry) error {
	for _, entry := range entries {
		if err := s.ReceiveStock(entry.Barcode, entry.AddedQuantity, entry.NewPurchasePrice, entry.NewSalePrice, entry.SupplierID); err != nil {
			return err
		}
	}
	return nil
}
