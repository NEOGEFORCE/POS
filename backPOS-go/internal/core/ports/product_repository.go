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

type SavingsOpportunity struct {
	Barcode       string  `json:"barcode"`
	ProductName   string  `json:"productName"`
	CurrentPrice  float64 `json:"currentPrice"`
	BestPrice     float64 `json:"bestPrice"`
	BestSupplier  string  `json:"bestSupplier"`
	PotentialSave float64 `json:"potentialSave"`
	Stock         float64 `json:"stock"`
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
	Discount         float64 `json:"discount"`
}

type ProductRepository interface {
	Save(product *models.Product) error
	GetByBarcode(barcode string) (*models.Product, error)
	GetByBarcodeWithPreloads(barcode string, preloads ...string) (*models.Product, error)
	GetAll() ([]models.Product, error)
	GetAllWithLimit(limit int) ([]models.Product, error)
	GetPaginated(page, pageSize int, search string) ([]models.Product, int64, error)
	Update(barcode string, product *models.Product) error
	Delete(barcode string) error
	UpdateQuantity(barcode string, newQuantity float64) error
	BatchUpdateQuantities(updates map[string]float64) error
	Count() (int64, error)
	GetActiveCount() (int64, error)
	GetInventoryStats(from, to string) ([]InventoryStat, error)
	UpdateSupplierPrice(productBarcode string, supplierID uint, price float64) error
	GetSupplierPrices(productBarcode string) ([]models.ProductSupplier, error)
	GetBySupplier(supplierID uint) ([]models.Product, error)
	SyncSuppliers(productBarcode string, supplierIDs []uint) error
	BulkReceive(entries []ReceiveEntry, orderID *uint) error
	GetSavingsOpportunities() ([]SavingsOpportunity, error)
	GetAllWithLowStock() ([]models.Product, error) // Nuevo: para Radar Global
}

type SupplierOrderMethodRepository interface {
	Create(method *models.SupplierOrderMethod) error
	GetByID(id uint) (*models.SupplierOrderMethod, error)
	GetBySupplierID(supplierID uint) ([]models.SupplierOrderMethod, error)
	Update(method *models.SupplierOrderMethod) error
	Delete(id uint) error
	GetAllActive() ([]models.SupplierOrderMethod, error)
}
