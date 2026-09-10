package models

import (
	"time"

	"gorm.io/gorm"
)

type StockMovement struct {
	ID             uint       `gorm:"primaryKey;autoIncrement" json:"id"`
	Date           time.Time  `gorm:"default:now();index" json:"date"`
	Barcode        string     `gorm:"not null;index" json:"barcode"`
	Quantity       float64    `gorm:"not null" json:"quantity"`
	Type           string     `gorm:"not null;index" json:"type"`   // "IN" or "OUT"
	Reason         string     `gorm:"not null;index" json:"reason"` // "SALE", "RECEPTION", "RETURN", "ADJUSTMENT", "DELETE"
	EmployeeDNI    string     `gorm:"index" json:"employeeDni"`
	EmployeeName   string     `json:"employeeName"`
	ReferenceID    string     `gorm:"index" json:"referenceId"`  // e.g., SaleID or ReceptionID
	Metadata       string     `gorm:"type:text" json:"metadata"` // Snapshot of prices/taxes in JSON

	// Porcentajes de la LÍNEA DE COMPRA, tal como se aprobaron en la recepción.
	//
	// Son una foto histórica: products.iva/icui/ibua se sobrescriben en cada
	// recepción, así que sin estas columnas no había forma de responder "qué
	// descuento me dio este proveedor en la compra de marzo".
	//
	// DiscountPct es el caso que más se echaba de menos: el DTO se escribía en
	// la pantalla, se usaba para calcular el PVP y se perdía al guardar.
	//
	// Punteros para distinguir "no aplica / movimiento que no es de compra" de
	// un 0% real. Los movimientos de venta, merma o ajuste los dejan en NULL.
	// Creadas por la migración 015 como NUMERIC(6,3).
	DiscountPct *float64 `gorm:"column:discount_pct;type:numeric(6,3)" json:"discountPct,omitempty"`
	IvaPct      *float64 `gorm:"column:iva_pct;type:numeric(6,3)" json:"ivaPct,omitempty"`
	IcuiPct     *float64 `gorm:"column:icui_pct;type:numeric(6,3)" json:"icuiPct,omitempty"`
	IbuaPct     *float64 `gorm:"column:ibua_pct;type:numeric(6,3)" json:"ibuaPct,omitempty"`

	EditedBy       string     `gorm:"index;column:edited_by" json:"editedBy"`
	EditedAt       *time.Time `gorm:"column:edited_at" json:"editedAt"`
	OriginalValues string     `gorm:"type:jsonb;column:original_values" json:"originalValues"`
	AnnulledBy     string     `gorm:"index;column:annulled_by" json:"annulledBy"`
	AnnulledAt     *time.Time `gorm:"column:annulled_at" json:"annulledAt"`
	AnnulledReason string     `gorm:"type:text;column:annulled_reason" json:"annulledReason"`
	Product        Product    `gorm:"foreignKey:Barcode;references:Barcode;constraint:false;" json:"product,omitempty"`
}

func (StockMovement) TableName() string {
	return "stock_movements"
}

func (m *StockMovement) BeforeCreate(tx *gorm.DB) (err error) {
	if m.OriginalValues == "" {
		m.OriginalValues = "{}"
	}
	return
}

func (m *StockMovement) BeforeUpdate(tx *gorm.DB) (err error) {
	if m.OriginalValues == "" {
		m.OriginalValues = "{}"
	}
	return
}

const (
	MovementTypeIn  = "IN"
	MovementTypeOut = "OUT"

	MovementReasonSale           = "SALE"
	MovementReasonReturn         = "RETURN"
	MovementReasonExchangeOut    = "EXCHANGE_OUT"
	MovementReasonVoidSale       = "VOID_SALE"
	MovementReasonEditRevert     = "EDIT_REVERT"
	MovementReasonEditApply      = "EDIT_APPLY"
	MovementReasonReturnRevert   = "RETURN_REVERT"
	MovementReasonExchangeRevert = "EXCHANGE_REVERT"
	MovementReasonPackUpdateSync = "PACK_UPDATE_SYNC"
)
