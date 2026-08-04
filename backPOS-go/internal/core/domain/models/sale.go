package models

import (
	"time"

	"gorm.io/gorm"
)

type PaymentMethodBreakdown struct {
	Method string  `json:"method"`
	Amount float64 `json:"amount"`
}

type Sale struct {
	SaleID         uint           `gorm:"primaryKey;autoIncrement;column:saleId" json:"id"`
	ClientTxId     string         `gorm:"type:varchar(64);index;column:clientTxId" json:"clientTxId,omitempty"`
	SaleDate       time.Time      `gorm:"default:now();not null;index;column:saleDate" json:"date"`
	ClientDNI      string         `gorm:"index;column:clientDni" json:"clientDni"`
	EmployeeDNI    string         `gorm:"not null;index;column:employeeDni" json:"employeeDni"`
	TotalAmount    float64        `gorm:"type:decimal(10,2);not null;column:totalAmount" json:"total"`
	PaymentMethod  string         `gorm:"index;column:paymentMethod" json:"paymentMethod"`
	AmountPaid     float64        `gorm:"type:decimal(10,2);column:amountPaid" json:"amountPaid"`
	CashAmount     float64        `gorm:"type:decimal(10,2);column:cashAmount" json:"cashAmount"`
	TransferAmount float64        `gorm:"type:decimal(10,2);column:transferAmount" json:"transferAmount"`
	TransferNequi  float64        `gorm:"type:decimal(10,2);default:0;column:transferNequi" json:"transferNequi"`
	TransferDaviplata float64     `gorm:"type:decimal(10,2);default:0;column:transferDaviplata" json:"transferDaviplata"`
	TransferSource string         `gorm:"index;column:transferSource" json:"transferSource"`
	CreditAmount   float64        `gorm:"type:decimal(10,2);column:creditAmount" json:"creditAmount"`
	DebtPending    float64        `gorm:"type:decimal(10,2);column:debtPending" json:"debtPending"`
	Change         float64        `gorm:"type:decimal(10,2);column:change" json:"change"`
	MultiplePayments []PaymentMethodBreakdown `gorm:"-" json:"multiplePayments,omitempty"`
	Status         string         `gorm:"type:varchar(20);default:'PAID';column:status" json:"status"`
	DeletedReason  string         `gorm:"column:deletedReason" json:"deletedReason,omitempty"`
	DeletedByDNI   string         `gorm:"column:deletedByDni" json:"deletedByDni,omitempty"`
	DianReady      bool           `gorm:"default:false;column:dian_ready" json:"dianReady"`
	HasReturn      bool           `gorm:"default:false;column:hasReturn" json:"hasReturn"`
	ReturnRef      uint           `gorm:"column:returnRef" json:"returnRef,omitempty"`
	Client         Client         `gorm:"foreignKey:ClientDNI;references:DNI" json:"client,omitempty"`
	Employee       Employee       `gorm:"foreignKey:EmployeeDNI;references:DNI" json:"employee,omitempty"`
	SaleDetails    []SaleDetail   `gorm:"foreignKey:SaleID" json:"details,omitempty"`
	DeletedAt      gorm.DeletedAt `gorm:"index" json:"-"`
}

func (Sale) TableName() string {
	return "sales"
}

type SaleDetail struct {
	ID        uint           `gorm:"primaryKey;autoIncrement;column:id" json:"id"`
	SaleID    uint           `gorm:"not null;index;column:saleId" json:"saleId"`
	Barcode   string         `gorm:"not null;index;column:barcode" json:"barcode"`
	Quantity  float64        `gorm:"not null;column:quantity" json:"quantity"`
	UnitPrice float64        `gorm:"type:decimal(10,2);not null;column:price" json:"unitPrice"`
	CostPrice float64        `gorm:"type:decimal(10,2);default:0;not null;column:costPrice" json:"costPrice"`
	Subtotal    float64        `gorm:"type:decimal(10,2);not null;column:subtotal" json:"subtotal"`
	ReturnedQty float64        `gorm:"-" json:"returnedQty"`
	Product     Product        `gorm:"foreignKey:Barcode;references:Barcode;constraint:false;" json:"product,omitempty"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"`
}

func (SaleDetail) TableName() string {
	return "sale_details"
}
