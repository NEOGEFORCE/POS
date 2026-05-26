package models

import "time"

// SupplierProductAlias maps a supplier's invoice product name to an internal ProductID
type SupplierProductAlias struct {
	ID             uint      `gorm:"primaryKey" json:"id"`
	SupplierID     uint      `gorm:"index;not null" json:"supplierId"`
	InvoiceName    string    `gorm:"not null" json:"invoiceName"`
	ProductBarcode string    `gorm:"not null" json:"productBarcode"`
	UsesCount      int       `gorm:"default:1" json:"usesCount"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`

	Supplier *Supplier `gorm:"foreignKey:SupplierID" json:"supplier,omitempty"`
}

func (SupplierProductAlias) TableName() string {
	return "supplier_product_aliases"
}

// SupplierInvoiceParams holds parameters for parsing invoices from a specific supplier
type SupplierInvoiceParams struct {
	ID                uint      `gorm:"primaryKey" json:"id"`
	SupplierID        uint      `gorm:"uniqueIndex;not null" json:"supplierId"`
	PriceIncludesIVA  bool      `gorm:"default:false" json:"priceIncludesIva"`
	PriceIncludesICUI bool      `gorm:"default:false" json:"priceIncludesIcui"`
	PriceIncludesIBUA bool      `gorm:"default:false" json:"priceIncludesIbua"`
	Notes             string    `gorm:"type:text" json:"notes"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`

	Supplier *Supplier `gorm:"foreignKey:SupplierID" json:"supplier,omitempty"`
}

func (SupplierInvoiceParams) TableName() string {
	return "supplier_invoice_params"
}

// ExtractedItem represents the raw item extracted by Gemini Vision
type ExtractedItem struct {
	Name       string  `json:"name"`
	Quantity   float64 `json:"quantity"`
	UnitPrice  float64 `json:"unitPrice"`
	TotalPrice float64 `json:"totalPrice"`
}

// ScannedItem represents a matched product from the invoice
type ScannedItem struct {
	ProductID    uint    `json:"productId"`
	Barcode      string  `json:"barcode"`
	ProductName  string  `json:"productName"`
	InvoiceName  string  `json:"invoiceName"`
	Quantity     float64 `json:"quantity"`
	CostUnit     float64 `json:"costUnit"`
	CostoReal    float64 `json:"costoReal"`
	PVPActual    float64 `json:"pvpActual"`
	PVPSugerido  float64 `json:"pvpSugerido"`
	MarginUsed   float64 `json:"marginUsed"`
	MarginSource string  `json:"marginSource"`
	IVA          float64 `json:"iva"`
	ICUI         float64 `json:"icui"`
	IBUA         float64 `json:"ibua"`
	CurrentStock float64 `json:"currentStock"`
	CurrentWAC   float64 `json:"currentWac"`
	Confidence   float64 `json:"confidence"`
	MatchType    string  `json:"matchType"` // "alias" | "similarity"
}

// UnmatchedItem represents a product from the invoice that could not be matched automatically
type UnmatchedItem struct {
	InvoiceName string          `json:"invoiceName"`
	Quantity    float64         `json:"quantity"`
	UnitPrice   float64         `json:"unitPrice"`
	Suggestions []ProductSearch `json:"suggestions"`
}

// ProductSearch is a lightweight struct for returning suggestions
type ProductSearch struct {
	ID          uint    `json:"id"`
	Barcode     string  `json:"barcode"`
	ProductName string  `json:"productName"`
	Confidence  float64 `json:"confidence,omitempty"`
}

// ScanInvoiceResult is the final result sent to the frontend
type ScanInvoiceResult struct {
	TotalDetected int             `json:"totalDetected"`
	TotalMatched  int             `json:"totalMatched"`
	ScannedItems  []ScannedItem   `json:"scannedItems"`
	Unmatched     []UnmatchedItem `json:"unmatched"`
}
