package ports

import (
	"backPOS-go/internal/core/domain/models"
	"time"
)

type ReturnRepository interface {
	Create(ret *models.Return) error
	CreateWithTransaction(ret *models.Return, employeeDNI string, employeeName string, adjustments map[string]float64, movements []*models.StockMovement) error
	GetByID(id uint) (*models.Return, error)
	GetAll() ([]models.Return, error)
	GetByDateRange(from, to time.Time) ([]models.Return, error)
	GetTotalReturnedByRange(from, to time.Time) (float64, error)
	ProcessAdvancedReturnTransaction(req ProcessReturnReq, originalSale *models.Sale, employeeDNI string, employeeName string, stockAdjustments map[string]float64, movements []*models.StockMovement) (*models.Return, error)
	DeleteWithTransaction(id uint, adminDNI string, adminName string) error
}

type ProcessReturnReq struct {
	InvoiceRef       uint   `json:"invoiceRef"`
	Type             string `json:"type"` // "REFUND" o "EXCHANGE"
	RefundAmount     float64 `json:"refundAmount"`
	ChargeAmount     float64 `json:"chargeAmount"`
	ReturnedItems    []ReturnItemReq `json:"returnedItems"`
	ReplacementItems []ReturnItemReq `json:"replacementItems"`
	ChargeMethod     string  `json:"chargeMethod"` // Para pagos adicionales
}

type ReturnItemReq struct {
	Barcode string  `json:"barcode"`
	Qty     float64 `json:"qty"`
}
