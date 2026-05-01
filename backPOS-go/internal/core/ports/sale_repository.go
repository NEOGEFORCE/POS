package ports

import "backPOS-go/internal/core/domain/models"

type ProductRankingItem struct {
	Barcode  string  `json:"barcode"`
	Name     string  `json:"name"`
	Quantity float64 `json:"quantity"`
	Total    float64 `json:"total"`
}

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

type MVMonthlyStats struct {
	MonthYear        string  `json:"monthYear"`
	TotalSales       float64 `json:"totalSales"`
	TransactionCount int64   `json:"transactionCount"`
	SalesCash        float64 `json:"salesCash"`
	SalesTransfer    float64 `json:"salesTransfer"`
	SalesCredit      float64 `json:"salesCredit"`
	ProductsSold     float64 `json:"productsSold"`
	TotalExpenses    float64 `json:"totalExpenses"`
	TotalAbonos      float64 `json:"totalAbonos"`
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
	FindPendingDebts() ([]models.Sale, error)
	UpdateDebt(id uint, newDebt float64) error
	GetDashboardStats(from, to string) (float64, int64, float64, error)
	GetMonthlyTotals() (map[string]float64, error)
	GetSoldQuantityByProduct(barcode string, from, to string) (float64, error)
	GetSoldQuantitiesByBarcodes(barcodes []string, from, to string) (map[string]float64, error)
	GetTopSellingProducts(from, to string, limit int) ([]ProductRankingItem, error)
	GetDailySalesByRange(from, to string) (map[string]float64, error)
	GetSalesByPaymentMethod(from, to string) (map[string]float64, error)
	GetMonthlyStatsFromMV(monthYear string) (*MVMonthlyStats, error)
	GetMonthlyStatsTrendFromMV() ([]MVMonthlyStats, error)
	GetGlobalTotalSales() (float64, error)
	GetGlobalSalesByMethod() (map[string]float64, error)
	GetGlobalCollectedDebtsByMethod() (map[string]float64, error)
	GetGlobalCOGS() (float64, error)
	GetCOGSByRange(from, to string) (float64, error)
}
