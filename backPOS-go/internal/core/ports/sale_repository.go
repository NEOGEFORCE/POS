package ports

import "backPOS-go/internal/core/domain/models"

type SaleFilter struct {
	Page        int
	PageSize    int
	From        string
	To          string
	ClientDNI   string
	EmployeeDNI string
	MinTotal    float64
	MaxTotal    float64
}

type SaleRepository interface {
	Create(sale *models.Sale) error
	CreateWithTx(tx interface{}, sale *models.Sale) error
	GetAll() ([]models.Sale, error)
	GetByDateRange(from, to string) ([]models.Sale, error)
	GetDeletedByDateRange(from, to string) ([]models.Sale, error)
	GetByID(id uint) (*models.Sale, error)
	Delete(id uint) error
	UpdatePayment(id uint, sale *models.Sale) error
	FindAll(filter SaleFilter) ([]models.Sale, int64, error)
	Count() (int64, error)
	GetTotalRevenue() (float64, error)
	GetMonthlyTotals() (map[string]float64, error)
	GetSoldQuantityByProduct(barcode string, from, to string) (float64, error)
}
