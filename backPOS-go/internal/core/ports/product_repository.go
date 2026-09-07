package ports

import (
	"backPOS-go/internal/core/domain/models"
	"time"
)

// SQLActiveProduct es la definición CANÓNICA de "producto activo" en SQL.
//
// El COALESCE no es decorativo: products."isActive" admite NULL para las filas
// legadas que se crearon antes de que la columna existiera. Un filtro
// `"isActive" = true` descarta esas filas EN SILENCIO, porque en SQL
// `NULL = true` es NULL, no false. El modelo declara `default:true`, así que
// "nunca se desactivó" significa activo.
//
// Ese desfase ya produjo un bug visible: la pantalla de productos usa el
// COALESCE y el reporte de inventario usaba el filtro pelado, de modo que el
// reporte mostraba menos productos que la pantalla y su valorización quedaba
// por debajo de la realidad.
//
// Cualquier consulta que responda "cuáles son mis productos" o "cuánto vale mi
// inventario" tiene que usar esta constante y no reescribir el predicado.
const SQLActiveProduct = `COALESCE("isActive", TRUE) = TRUE`

// SQLActiveProductAliased es SQLActiveProduct para consultas con alias de tabla
// (por ejemplo `products AS p`), donde la columna necesita calificarse.
func SQLActiveProductAliased(alias string) string {
	return `COALESCE(` + alias + `."isActive", TRUE) = TRUE`
}

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
	WorstPrice    float64 `json:"worstPrice"`
	WorstSupplier string  `json:"worstSupplier"`
	PotentialSave float64 `json:"potentialSave"`
	Stock         float64 `json:"stock"`
}

type ProductRestockInfo struct {
	models.Product
	BestSupplierID     uint    `json:"bestSupplierId"`
	BestSupplierName   string  `json:"bestSupplierName"`
	LowestPrice        float64 `json:"lowestPrice"`
	WorstPrice         float64 `json:"worstPrice"`
	WorstSupplierName  string  `json:"worstSupplierName"`
	VisitFrequencyDays int     `json:"visitFrequencyDays"`
}

type ReceiveEntry struct {
	Barcode             string   `json:"barcode"`
	AddedQuantity       float64  `json:"addedQuantity"`
	NewPurchasePrice    float64  `json:"newPurchasePrice"`
	NewSalePrice        float64  `json:"newSalePrice"`
	SupplierID          *uint    `json:"supplierId"`
	Iva                 float64  `json:"iva"`
	Icui                float64  `json:"icui"`
	Ibua                float64  `json:"ibua"`
	IvaPct              float64  `json:"ivaPct"`
	IcuiPct             float64  `json:"icuiPct"`
	IbuaPct             float64  `json:"ibuaPct"`
	DiscountPct         float64  `json:"discountPct"`
	Discount            float64  `json:"discount"`
	ActualPhysicalStock *float64 `json:"actualPhysicalStock"`
	LineType            string   `json:"lineType"`
}

type OrderRef struct {
	ID     interface{} `json:"id"`
	Source string      `json:"source"`
}

type ProductSupplierPriceUpdate struct {
	SupplierID uint
	Price      float64
}

type ProductUpdateOptions struct {
	ReplaceSuppliers bool
	SupplierIDs      []uint
	SupplierPrice    *ProductSupplierPriceUpdate
}

type ProductRepository interface {
	GetDB() interface{}
	Save(product *models.Product) error
	GetByBarcode(barcode string) (*models.Product, error)
	GetByBarcodes(barcodes []string) ([]models.Product, error)
	GetByName(name string) (*models.Product, error)
	GetByBarcodeWithPreloads(barcode string, preloads ...string) (*models.Product, error)
	GetAll() ([]models.Product, error)
	GetAllWithLimit(limit int) ([]models.Product, error)
	GetPaginated(page, pageSize int, search string, supplierID int, stockFilter string) ([]models.Product, int64, error)
	Update(barcode string, product *models.Product) error
	UpdateWithTx(tx interface{}, barcode string, product *models.Product, options ProductUpdateOptions) error
	AfterCommitUpdate(barcodes ...string)
	Delete(barcode string) error
	UpdateQuantity(barcode string, newQuantity float64) error
	BatchUpdateQuantities(updates map[string]float64) error
	BatchAdjustQuantities(adjustments map[string]float64) error
	BatchAdjustQuantitiesWithTx(tx interface{}, adjustments map[string]float64) error
	Count() (int64, error)
	GetActiveCount() (int64, error)
	GetInventoryStats(from, to time.Time) ([]InventoryStat, error)
	// GetProductStatsAggregate devuelve el resumen del catálogo activo en una
	// sola consulta agregada (costo, precio de venta, total y contadores por
	// severidad). Retorna: totalCost, totalRetail, totalItems, criticalStock,
	// warningStock. Reemplaza el recorrido en Go de GetAll() para stats.
	GetProductStatsAggregate() (float64, float64, int64, int64, int64, error)
	// MergeHistoricalMarker fusiona un producto marcador '[HISTORICO] B' con
	// un producto real cuyo código actual es realBarcode, dejando al producto
	// real con el código markerBarcode y liberando así el código para el
	// catálogo. Ver postgres_product_merge.go para el algoritmo detallado.
	MergeHistoricalMarker(realBarcode, markerBarcode, authorDNI, authorName string) error
	// InvalidateCatalogAfterMerge purga los cachés de catálogo tras una
	// fusión exitosa (la fusión sí cambia la forma del catálogo).
	InvalidateCatalogAfterMerge(barcodes ...string)
	UpdateSupplierPrice(productBarcode string, supplierID uint, price float64) error
	GetSupplierPrices(productBarcode string) ([]models.ProductSupplier, error)
	GetBySupplier(supplierID uint) ([]models.Product, error)
	GetOrphanedProducts() ([]models.Product, error)

	SyncSuppliers(productBarcode string, supplierIDs []uint) error
	UnlinkSupplier(productBarcode string, supplierID uint) error
	LinkSupplier(barcode string, supplierID uint) error
	BulkReceive(entries []ReceiveEntry, orderID *uint, orderIDs []interface{}, orderRefs []OrderRef, bypassExpense bool, paymentSource string, employeeDNI string, supplierID *uint, freightCost float64, totalWeight float64, isEgreso bool, editReceptionID string) ([]string, error)
	GetSavingsOpportunities() ([]SavingsOpportunity, error)
	GetAllWithLowStock() ([]models.Product, error)
	GetProductsWithBestSupplier(supplierID *uint) ([]ProductRestockInfo, error)
	GetPendingTransitQuantities() (map[string]float64, map[string]string, error)
	GetGlobalInventoryValue() (float64, error)
	GetGlobalInventoryRetailValue() (float64, error)
	UpdateSupplierFrequency(supplierID uint, days int) error
	GetDailySalesAverage(barcode string, days int) (float64, error)
	GetPriceChangesToday() ([]models.PriceLog, error)
	RecordPriceChange(tx interface{}, barcode string, oldPrice, newPrice float64) error
	DeleteReception(receptionID string) error
	EditReception(ref string, dniStr string, reason string, products []models.EditReceiveItem) ([]string, error)
	GetReception(receptionID string) ([]models.StockMovement, error)
	SanitizeAllNames() (int64, error)
	SaveShrinkage(shrinkage *models.Shrinkage, shiftID *uint) error

	// Invoice Reader Methods
	GetSupplierAliases(supplierID uint) (map[string]models.SupplierProductAlias, error)
	GetSupplierInvoiceParams(supplierID uint) (*models.SupplierInvoiceParams, error)
	SaveSupplierAlias(alias *models.SupplierProductAlias) error
	FindProductBySimilarName(name string, supplierID uint) (*models.Product, float64)
	SearchSimilarProducts(name string, limit int) []models.ProductSearch
}

type SupplierOrderMethodRepository interface {
	Create(method *models.SupplierOrderMethod) error
	GetByID(id uint) (*models.SupplierOrderMethod, error)
	GetBySupplierID(supplierID uint) ([]models.SupplierOrderMethod, error)
	Update(method *models.SupplierOrderMethod) error
	Delete(id uint) error
	GetAllActive() ([]models.SupplierOrderMethod, error)
}
