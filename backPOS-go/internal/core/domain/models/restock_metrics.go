package models

import "time"

// DailyStockSnapshot is the closing stock captured for one product and date.
type DailyStockSnapshot struct {
	ID           uint      `json:"id" gorm:"primaryKey"`
	ProductID    string    `json:"productId" gorm:"column:product_id;size:50;uniqueIndex:uq_dss_product_date"`
	SnapshotDate string    `json:"snapshotDate" gorm:"column:snapshot_date;type:date;uniqueIndex:uq_dss_product_date"`
	ClosingStock float64   `json:"closingStock" gorm:"column:closing_stock"`
	WasZero      bool      `json:"wasZero" gorm:"column:was_zero"`
	CreatedAt    time.Time `json:"createdAt" gorm:"column:created_at"`
}

func (DailyStockSnapshot) TableName() string { return "daily_stock_snapshots" }

// ProductRestockMetric contains the result of the latest nightly batch.
type ProductRestockMetric struct {
	ID                uint      `json:"id" gorm:"primaryKey"`
	ProductID         string    `json:"productId" gorm:"column:product_id;uniqueIndex"`
	ProductName       string    `json:"productName" gorm:"column:product_name"`
	TotalSold30d      float64   `json:"totalSold30d" gorm:"column:total_sold_30d"`
	DaysWithStock     int       `json:"daysWithStock" gorm:"column:days_with_stock"`
	DaysZeroStock     int       `json:"daysZeroStock" gorm:"column:days_zero_stock"`
	AvgDailySales     float64   `json:"avgDailySales" gorm:"column:avg_daily_sales"`
	ABCCategory       string    `json:"abcCategory" gorm:"column:abc_category;size:1"`
	CurrentStock      float64   `json:"currentStock" gorm:"column:current_stock"`
	InTransitQty      float64   `json:"inTransitQty" gorm:"column:in_transit_qty"`
	IdealStock        float64   `json:"idealStock" gorm:"column:ideal_stock"`
	SuggestedOrderQty float64   `json:"suggestedOrderQty" gorm:"column:suggested_order_qty"`
	PrimarySupplierID *uint     `json:"primarySupplierId" gorm:"column:primary_supplier_id"`
	SupplierName      string    `json:"supplierName" gorm:"column:supplier_name"`
	SupplierLeadDays  int       `json:"supplierLeadDays" gorm:"column:supplier_lead_days"`
	UnitCost          float64   `json:"unitCost" gorm:"column:unit_cost"`
	CalculatedAt      time.Time `json:"calculatedAt" gorm:"column:calculated_at"`
}

func (ProductRestockMetric) TableName() string { return "product_restock_metrics" }

// RestockCalculationInput is loaded for every active product by one batch query.
type RestockCalculationInput struct {
	ProductID         string  `gorm:"column:product_id"`
	ProductName       string  `gorm:"column:product_name"`
	CurrentStock      float64 `gorm:"column:current_stock"`
	TotalSold30d      float64 `gorm:"column:total_sold_30d"`
	DaysZeroStock     int     `gorm:"column:days_zero_stock"`
	InTransitQty      float64 `gorm:"column:in_transit_qty"`
	PrimarySupplierID *uint   `gorm:"column:primary_supplier_id"`
	SupplierName      string  `gorm:"column:supplier_name"`
	SupplierLeadDays  int     `gorm:"column:supplier_lead_days"`
	UnitCost          float64 `gorm:"column:unit_cost"`
}

type CheaperSupplierAlert struct {
	SupplierID   uint    `json:"supplierId"`
	SupplierName string  `json:"supplierName"`
	UnitPrice    float64 `json:"unitPrice"`
	Savings      float64 `json:"savings"`
	TotalSavings float64 `json:"totalSavings"`
}

type RestockSuggestionResponse struct {
	ProductRestockMetric
	InTransit       bool                  `json:"inTransit"`
	CheaperSupplier *CheaperSupplierAlert `json:"cheaperSupplier,omitempty"`

	// Señales calculadas en el momento de la consulta, siempre frescas.
	LastReceptionAt     *time.Time `json:"lastReceptionAt,omitempty"`
	DaysSinceReception  *int       `json:"daysSinceReception,omitempty"`
	SoldSinceReception  float64    `json:"soldSinceReception"`
	Recommendation      string     `json:"recommendation"`
	RecommendationLevel string     `json:"recommendationLevel"`
}

// InTransitProduct identifies an item that cannot be ordered again while pending.
type InTransitProduct struct {
	ProductID   string  `json:"productId" gorm:"column:product_id"`
	ProductName string  `json:"productName" gorm:"column:product_name"`
	Quantity    float64 `json:"quantity" gorm:"column:quantity"`
}
