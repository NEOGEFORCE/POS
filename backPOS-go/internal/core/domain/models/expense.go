package models

import (
	"time"

	"gorm.io/gorm"
)

type Expense struct {
	ID            uint      `gorm:"primaryKey;autoIncrement;column:id" json:"id"`
	Description   string    `gorm:"not null;column:description" json:"description"`
	Amount        float64   `gorm:"type:decimal(10,2);not null;column:amount" json:"amount"`
	Date          time.Time `gorm:"default:now();not null;column:date" json:"date"`
	PaymentSource string    `gorm:"not null;column:paymentSource;default:'EFECTIVO'" json:"paymentSource"`
	Category      string    `gorm:"not null;type:varchar(100);column:category;default:'Otros'" json:"category"`
	SupplierID    *uint     `gorm:"column:supplier_id" json:"supplierId"`
	Supplier      *Supplier `gorm:"foreignKey:SupplierID" json:"supplier,omitempty"`
	Status        string    `gorm:"type:varchar(20);default:'PAID';column:status" json:"status"`     // PAID, PENDING
	LenderName    string    `gorm:"column:lenderName" json:"lenderName"`                             // Socio que presta el dinero
	TaxAmount     float64   `gorm:"type:decimal(10,2);default:0;column:tax_amount" json:"taxAmount"` // GMF 4x1000
	ReferenceID   string    `gorm:"index;column:reference_id" json:"referenceId"`                    // e.g., RECP-123456
	ReturnRef     *uint     `gorm:"index;column:return_ref" json:"returnRef,omitempty"`

	PaidAmount      float64 `gorm:"type:decimal(10,2);default:0;column:paid_amount" json:"paidAmount"`
	RemainingAmount float64 `gorm:"type:decimal(10,2);default:0;column:remaining_amount" json:"remainingAmount"`

	CashAmount      float64 `gorm:"type:decimal(10,2);default:0;column:cash_amount" json:"cashAmount"`
	NequiAmount     float64 `gorm:"type:decimal(10,2);default:0;column:nequi_amount" json:"nequiAmount"`
	DaviplataAmount float64 `gorm:"type:decimal(10,2);default:0;column:daviplata_amount" json:"daviplataAmount"`
	FondoAmount     float64 `gorm:"type:decimal(10,2);default:0;column:fondo_amount" json:"fondoAmount"`
	CoinsAmount     float64 `gorm:"type:decimal(10,2);default:0;column:coins_amount" json:"coinsAmount"`

	// BoldQrAmount es la parte del egreso pagada por el canal Bold QR /
	// Bre-B. Antes de la migración 028 era un valor CALCULADO EN RUNTIME
	// (gorm:"-") porque no existía columna física; ahora es la sexta
	// columna del "bolsillo" al mismo nivel que cash_amount, nequi_amount,
	// daviplata_amount, fondo_amount y coins_amount. La migración 028
	// agregó la columna con `DECIMAL(10,2) NOT NULL DEFAULT 0` y
	// backfilleó los egresos BOLD_QR puros `status='PAID'` existentes.
	//
	// Esto permite EGRESOS MIXTOS (p. ej. $200.000 BOLD_QR + $100.000
	// CAJA en el mismo pago) con cada parte descontándose del canal
	// correcto. parseExpenseChannelsFull sigue siendo la fuente única de
	// decisión canal↔monto; esta columna le ahorra el fallback por texto
	// cuando el frontend ya envía el desglose explícito.
	BoldQrAmount float64 `gorm:"type:decimal(10,2);default:0;column:bold_qr_amount" json:"boldQrAmount"`

	IsRestocked bool `gorm:"default:false;column:is_restocked" json:"isRestocked"`

	CreatedByDNI    string         `gorm:"not null;index;column:createdByDni" json:"createdByDni"`
	Creator         Employee       `gorm:"foreignKey:CreatedByDNI;references:DNI" json:"creator,omitempty"`
	DeletedAt       gorm.DeletedAt `gorm:"index" json:"-"`
	NewSupplierName string         `gorm:"-" json:"newSupplierName,omitempty"` // For quick creation
}

func (Expense) TableName() string {
	return "expenses"
}
