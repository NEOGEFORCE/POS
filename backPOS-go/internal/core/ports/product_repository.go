package ports

import "backPOS-go/internal/core/domain/models"

type InventoryStat struct {
	Barcode       string  `json:"barcode"`
	ProductName   string  `json:"productName"`
	CategoryID    uint    `json:"categoryId"`
	CategoryName  string  `json:"categoryName"`
	SalePrice     float64 `json:"salePrice"`
	PurchasePrice float64 `json:"purchasePrice"`
	Stock         float64 `json:"stock"`
	UnitsSold     float64 `json:"unitsSold"`
	TotalRevenue  float64 `json:"totalRevenue"`
	TotalCost     float64 `json:"totalCost"`
	GrossMargin   float64 `json:"grossMargin"`
	AvgSoldPerDay float64 `json:"avgSoldPerDay"`
}

type ProductRepository interface {
	Save(product *models.Product) error
	GetByBarcode(barcode string) (*models.Product, error)
	GetAll() ([]models.Product, error)
	GetAllWithLimit(limit int) ([]models.Product, error)
	GetPaginated(page, pageSize int) ([]models.Product, int64, error)
	Update(barcode string, product *models.Product) error
	Delete(barcode string) error
	UpdateQuantity(barcode string, newQuantity float64) error
	BatchUpdateQuantities(updates map[string]float64) error
	Count() (int64, error)
	GetInventoryStats(from, to string) ([]InventoryStat, error)
	UpdateSupplierPrice(productBarcode string, supplierID uint, price float64) error
	GetSupplierPrices(productBarcode string) ([]models.ProductSupplier, error)
}
