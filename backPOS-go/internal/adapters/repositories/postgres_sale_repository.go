package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"gorm.io/gorm"
)

type PostgresSaleRepository struct {
	db *gorm.DB
}

func NewPostgresSaleRepository(db *gorm.DB) *PostgresSaleRepository {
	return &PostgresSaleRepository{db: db}
}

func (r *PostgresSaleRepository) Create(sale *models.Sale) error {
	return r.db.Create(sale).Error
}

func (r *PostgresSaleRepository) CreateWithTx(tx interface{}, sale *models.Sale) error {
	gormDB, ok := tx.(*gorm.DB)
	if !ok {
		return r.db.Create(sale).Error
	}
	return gormDB.Create(sale).Error
}

func (r *PostgresSaleRepository) GetAll() ([]models.Sale, error) {
	var sales []models.Sale
	err := r.db.Preload("Client").Preload("SaleDetails.Product.Category").Find(&sales).Error
	return sales, err
}

func (r *PostgresSaleRepository) GetByDateRange(from, to string) ([]models.Sale, error) {
	var sales []models.Sale
	query := r.db.Preload("Client").Preload("SaleDetails.Product.Category")
	if from != "" {
		query = query.Where("\"saleDate\" >= ?", from)
	}
	if to != "" {
		query = query.Where("\"saleDate\" <= ?", to)
	}
	err := query.Find(&sales).Error
	return sales, err
}

func (r *PostgresSaleRepository) GetDeletedByDateRange(from, to string) ([]models.Sale, error) {
	var sales []models.Sale
	query := r.db.Unscoped().Where("\"deletedAt\" IS NOT NULL").Preload("Client").Preload("SaleDetails.Product.Category")
	if from != "" {
		query = query.Where("\"saleDate\" >= ?", from)
	}
	if to != "" {
		query = query.Where("\"saleDate\" <= ?", to)
	}
	err := query.Find(&sales).Error
	return sales, err
}

func (r *PostgresSaleRepository) GetByID(id uint) (*models.Sale, error) {
	var sale models.Sale
	err := r.db.Preload("Client").Preload("SaleDetails.Product.Category").First(&sale, id).Error
	if err != nil {
		return nil, err
	}

	// Calcular cantidades ya devueltas para cada item
	for i := range sale.SaleDetails {
		var returned float64
		// Sumamos la cantidad de return_details donde isExchange = false (es una devolución de entrada)
		r.db.Table("return_details").
			Joins("JOIN returns ON returns.id = return_details.\"returnId\"").
			Where("returns.\"saleId\" = ? AND return_details.barcode = ? AND return_details.\"isExchange\" = ?", 
				sale.SaleID, sale.SaleDetails[i].Barcode, false).
			Select("COALESCE(SUM(return_details.quantity), 0)").
			Scan(&returned)
		
		sale.SaleDetails[i].ReturnedQty = returned
	}
	
	return &sale, nil
}

func (r *PostgresSaleRepository) Delete(id uint) error {
	return r.db.Delete(&models.Sale{}, id).Error
}

func (r *PostgresSaleRepository) FindAll(filter ports.SaleFilter) ([]models.Sale, int64, error) {
	var sales []models.Sale
	var total int64

	// Base query matching JS logic
	query := r.db.Model(&models.Sale{})

	// Aplicar filtros (Mismo comportamiento que JS)
	if filter.From != "" {
		query = query.Where("\"saleDate\" >= ?", filter.From)
	}
	if filter.To != "" {
		query = query.Where("\"saleDate\" <= ?", filter.To)
	}
	if filter.ClientDNI != "" {
		query = query.Where("\"clientDni\" = ?", filter.ClientDNI)
	}
	if filter.EmployeeDNI != "" {
		query = query.Where("\"employeeDni\" = ?", filter.EmployeeDNI)
	}
	if filter.MinTotal > 0 {
		query = query.Where("\"totalAmount\" >= ?", filter.MinTotal)
	}
	if filter.MaxTotal > 0 {
		query = query.Where("\"totalAmount\" <= ?", filter.MaxTotal)
	}

	// Conteo total (Paso 1: Usar una sesión limpia)
	if err := query.Session(&gorm.Session{}).Count(&total).Error; err != nil {
		return nil, 0, err
	}

	// Búsqueda con Paginación (Paso 2: Preload y Limit)
	offset := (filter.Page - 1) * filter.PageSize
	err := query.Preload("Client").Preload("SaleDetails.Product.Category").
		Order("\"saleDate\" DESC").
		Limit(filter.PageSize).
		Offset(offset).
		Find(&sales).Error

	if err == nil {
		// Calcular cantidades devueltas para cada venta en la lista (historial)
		for sIdx := range sales {
			for dIdx := range sales[sIdx].SaleDetails {
				var returned float64
				r.db.Table("return_details").
					Joins("JOIN returns ON returns.id = return_details.\"returnId\"").
					Where("returns.\"saleId\" = ? AND return_details.barcode = ? AND return_details.\"isExchange\" = ?", 
						sales[sIdx].SaleID, sales[sIdx].SaleDetails[dIdx].Barcode, false).
					Select("COALESCE(SUM(return_details.quantity), 0)").
					Scan(&returned)
				sales[sIdx].SaleDetails[dIdx].ReturnedQty = returned
			}
		}
	}

	return sales, total, err
}

func (r *PostgresSaleRepository) Count() (int64, error) {
	var count int64
	err := r.db.Model(&models.Sale{}).Count(&count).Error
	return count, err
}

func (r *PostgresSaleRepository) GetTotalRevenue() (float64, error) {
	var total float64
	err := r.db.Model(&models.Sale{}).Select("SUM(\"totalAmount\")").Scan(&total).Error
	return total, err
}

func (r *PostgresSaleRepository) UpdatePayment(id uint, sale *models.Sale) error {
	return r.db.Model(&models.Sale{}).Where("\"saleId\" = ?", id).Updates(map[string]interface{}{
		"clientDni":      sale.ClientDNI,
		"paymentMethod":  sale.PaymentMethod,
		"cashAmount":     sale.CashAmount,
		"transferAmount": sale.TransferAmount,
		"transferSource": sale.TransferSource,
		"creditAmount":   sale.CreditAmount,
		"amountPaid":     sale.AmountPaid,
		"change":         sale.Change,
	}).Error
}
func (r *PostgresSaleRepository) GetMonthlyTotals() (map[string]float64, error) {
	results := make(map[string]float64)
	rows, err := r.db.Table("sales").
		Select("TO_CHAR(\"saleDate\", 'YYYY-MM') as month, SUM(\"totalAmount\") as total").
		Group("month").
		Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var month string
		var total float64
		if err := rows.Scan(&month, &total); err != nil {
			return nil, err
		}
		results[month] = total
	}
	return results, nil
}

func (r *PostgresSaleRepository) GetSoldQuantityByProduct(barcode string, from, to string) (float64, error) {
	var total float64
	query := r.db.Table("sale_details").
		Joins("JOIN sales ON sales.\"saleId\" = sale_details.\"saleId\"").
		Where("sale_details.barcode = ?", barcode)
	
	if from != "" {
		query = query.Where("sales.\"saleDate\" >= ?", from)
	}
	if to != "" {
		query = query.Where("sales.\"saleDate\" <= ?", to)
	}
	
	err := query.Select("COALESCE(SUM(sale_details.quantity), 0)").Scan(&total).Error
	return total, err
}
