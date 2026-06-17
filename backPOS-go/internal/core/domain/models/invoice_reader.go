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

// Constantes de tipo de línea para el modo "3 zonas" del carrito de
// recepción. Una sola factura puede contener compras regulares,
// bonificaciones (productos regalados con costo $0) y devoluciones
// (productos que el proveedor recibe de vuelta, con cantidad negativa).
// El frontend renderiza una tarjeta por línea con icono distinto según
// el tipo, y el backend separa contabilidad y stock por línea.
const (
	LineTypeRegular = "REGULAR" // 🚚 compra normal
	LineTypeBonus   = "BONUS"   // 🎁 obsequio (cost=0, suma stock pero no cuenta por pagar)
	LineTypeReturn  = "RETURN"  // ↙️ devolución (resta stock y resta del total a pagar)
)

// ExtractedItem represents the raw item extracted by Gemini Vision
type ExtractedItem struct {
	Name           string  `json:"name"`
	Barcode        string  `json:"barcode,omitempty"`
	Quantity       float64 `json:"quantity"`
	// LineType: REGULAR | BONUS | RETURN. Si Claude no lo asigna, el
	// post-procesador (splitBonusItems) lo deriva: BonusQuantity > 0 lo
	// parte en REGULAR + BONUS; quantity < 0 se transforma en RETURN.
	LineType string `json:"lineType,omitempty"`
	// BonusQuantity son las unidades regaladas/bonificadas en una promoción
	// "Pague X, lleve Y". El splitter del backend convierte un único item
	// con bonus_quantity en DOS items separados (uno REGULAR, uno BONUS)
	// para que el carrito muestre dos tarjetas independientes.
	BonusQuantity      float64 `json:"bonus_quantity,omitempty"`
	UnitPrice          float64 `json:"unitPrice"`
	TotalPrice         float64 `json:"totalPrice"`
	// DiscountPercentage / DiscountValue: rebaja comercial aplicada por línea.
	// Tienen preferencia el porcentaje sobre el valor absoluto si vienen ambos.
	DiscountPercentage float64 `json:"discount_percentage,omitempty"`
	DiscountValue      float64 `json:"discount_value,omitempty"`
	IvaPercentage      float64 `json:"iva_percentage,omitempty"`
	IbuaPercentage     float64 `json:"ibua_percentage,omitempty"`
	IcuiPercentage     float64 `json:"icui_percentage,omitempty"`
}

// ExpectedTaxes are user-provided hints about which taxes the invoice contains.
// El frontend marca cuáles columnas esperar antes de procesar la factura,
// y el backend modifica el prompt de Claude para forzar la extracción.
type ExpectedTaxes struct {
	IVA  bool `json:"iva"`
	IBUA bool `json:"ibua"`
	ICUI bool `json:"icui"`
}

// ScannedItem represents a matched product from the invoice
type ScannedItem struct {
	ProductID    uint    `json:"productId"`
	Barcode      string  `json:"barcode"`
	ProductName  string  `json:"productName"`
	InvoiceName  string  `json:"invoiceName"`
	Quantity     float64 `json:"quantity"`
	LineType           string  `json:"lineType,omitempty"` // REGULAR | BONUS | RETURN
	BonusQuantity      float64 `json:"bonus_quantity,omitempty"`
	DiscountPercentage float64 `json:"discount_percentage,omitempty"`
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
	InvoiceName        string          `json:"invoiceName"`
	Quantity           float64         `json:"quantity"`
	LineType           string          `json:"lineType,omitempty"` // REGULAR | BONUS | RETURN
	BonusQuantity      float64         `json:"bonus_quantity,omitempty"`
	DiscountPercentage float64         `json:"discount_percentage,omitempty"`
	UnitPrice          float64         `json:"unitPrice"`
	IvaPercentage      float64         `json:"iva_percentage,omitempty"`
	IbuaPercentage     float64         `json:"ibua_percentage,omitempty"`
	IcuiPercentage     float64         `json:"icui_percentage,omitempty"`
	Suggestions        []ProductSearch `json:"suggestions"`
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
