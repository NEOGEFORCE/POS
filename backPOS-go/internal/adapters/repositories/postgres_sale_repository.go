package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"fmt"

	"gorm.io/gorm"
)

type PostgresSaleRepository struct {
	db *gorm.DB
}

func NewPostgresSaleRepository(db *gorm.DB) *PostgresSaleRepository {
	return &PostgresSaleRepository{db: db}
}

func (r *PostgresSaleRepository) Create(sale *models.Sale) error {
	err := r.db.Create(sale).Error
	if err == nil {
		// HFT FIX: Se elimina la invalidación agresiva y el REFRESH síncrono/background
		// para evitar Deadlocks y asegurar que el Dashboard use la RAM L1 (60s TTL).
	}
	return err
}

func (r *PostgresSaleRepository) CreateWithTx(tx interface{}, sale *models.Sale) error {
	gormDB, ok := tx.(*gorm.DB)
	if !ok {
		return r.db.Create(sale).Error
	}
	err := gormDB.Create(sale).Error
	if err == nil {
		// HFT FIX: Sin invalidación agresiva
	}
	return err
}

func (r *PostgresSaleRepository) GetAll() ([]models.Sale, error) {
	var sales []models.Sale
	err := r.db.Preload("Client").Preload("SaleDetails.Product.Category").Limit(100).Order("\"saleDate\" DESC").Find(&sales).Error
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
	err := query.Limit(100).Order("\"saleDate\" DESC").Find(&sales).Error
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
	err := query.Limit(100).Order("\"saleDate\" DESC").Find(&sales).Error
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
	err := r.db.Delete(&models.Sale{}, id).Error
	if err == nil {
		// HFT FIX: Sin invalidación agresiva
	}
	return err
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

	if err == nil && len(sales) > 0 {
		// Optimization: Single query to get all returned quantities for the sales list
		saleIDs := make([]uint, len(sales))
		for i, s := range sales {
			saleIDs[i] = s.SaleID
		}

		type result struct {
			SaleID   uint
			Barcode  string
			TotalQty float64
		}
		var results []result
		r.db.Table("return_details").
			Joins("JOIN returns ON returns.id = return_details.\"returnId\"").
			Where("returns.\"saleId\" IN ? AND return_details.\"isExchange\" = ?", saleIDs, false).
			Select("returns.\"saleId\", return_details.barcode, SUM(return_details.quantity) as total_qty").
			Group("returns.\"saleId\", return_details.barcode").
			Scan(&results)

		// Map results for quick lookup
		returnMap := make(map[string]float64)
		for _, res := range results {
			key := fmt.Sprintf("%d-%s", res.SaleID, res.Barcode)
			returnMap[key] = res.TotalQty
		}

		// Assign returned quantities
		for sIdx := range sales {
			for dIdx := range sales[sIdx].SaleDetails {
				key := fmt.Sprintf("%d-%s", sales[sIdx].SaleID, sales[sIdx].SaleDetails[dIdx].Barcode)
				sales[sIdx].SaleDetails[dIdx].ReturnedQty = returnMap[key]
			}
		}
	}

	return sales, total, err
}

func (r *PostgresSaleRepository) GetDashboardStats(from, to string) (float64, int64, float64, error) {
	var stats struct {
		TotalAmount float64
		TotalCount  int64
		ProductsSold float64
	}

	query := r.db.Model(&models.Sale{})
	if from != "" {
		query = query.Where("\"saleDate\" >= ?", from)
	}
	if to != "" {
		query = query.Where("\"saleDate\" < ?", to)
	}

	err := query.Select("COALESCE(SUM(\"totalAmount\"), 0) as total_amount, COUNT(*) as total_count").
		Scan(&stats).Error

	if err != nil {
		return 0, 0, 0, err
	}

	// Calculate total products sold separately to avoid complex joins if not needed
	// But we can do it in one if we join sale_details
	var productsSold float64
	err = r.db.Table("sale_details").
		Joins("JOIN sales ON sales.\"saleId\" = sale_details.\"saleId\"").
		Where("sales.\"saleDate\" >= ? AND sales.\"saleDate\" < ?", from, to).
		Select("COALESCE(SUM(quantity), 0)").
		Scan(&productsSold).Error

	return stats.TotalAmount, stats.TotalCount, productsSold, err
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

func (r *PostgresSaleRepository) FindPendingDebts() ([]models.Sale, error) {
	var sales []models.Sale
	err := r.db.Preload("Client").Where("\"debtPending\" > 0").Order("\"saleDate\" DESC").Limit(100).Find(&sales).Error
	return sales, err
}

func (r *PostgresSaleRepository) UpdateDebt(id uint, newDebt float64) error {
	return r.db.Model(&models.Sale{}).Where("\"saleId\" = ?", id).Update("debtPending", newDebt).Error
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

func (r *PostgresSaleRepository) GetSoldQuantitiesByBarcodes(barcodes []string, from, to string) (map[string]float64, error) {
	results := make(map[string]float64)
	if len(barcodes) == 0 {
		return results, nil
	}

	query := r.db.Table("sale_details").
		Joins("JOIN sales ON sales.\"saleId\" = sale_details.\"saleId\"").
		Select("sale_details.barcode, SUM(sale_details.quantity) as total").
		Where("sale_details.barcode IN ?", barcodes)

	if from != "" {
		query = query.Where("sales.\"saleDate\" >= ?", from)
	}
	if to != "" {
		query = query.Where("sales.\"saleDate\" <= ?", to)
	}

	rows, err := query.Group("sale_details.barcode").Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var barcode string
		var total float64
		if err := rows.Scan(&barcode, &total); err != nil {
			return nil, err
		}
		results[barcode] = total
	}

	return results, nil
}

func (r *PostgresSaleRepository) GetTopSellingProducts(from, to string, limit int) ([]ports.ProductRankingItem, error) {
	var ranking []ports.ProductRankingItem
	query := `
		SELECT 
			agg.barcode, 
			p."productName" as name, 
			agg.quantity, 
			agg.total
		FROM (
			SELECT 
				sd.barcode, 
				SUM(sd.quantity) as quantity, 
				SUM(sd.subtotal) as total
			FROM sale_details sd
			JOIN sales s ON s."saleId" = sd."saleId"
			WHERE s."saleDate" >= ? AND s."saleDate" < ? AND s.deleted_at IS NULL
			GROUP BY sd.barcode
			ORDER BY quantity DESC
			LIMIT ?
		) agg
		JOIN products p ON p.barcode = agg.barcode
	`
	err := r.db.Raw(query, from, to, limit).Scan(&ranking).Error
	return ranking, err
}
func (r *PostgresSaleRepository) GetDailySalesByRange(from, to string) (map[string]float64, error) {
	results := make(map[string]float64)
	rows, err := r.db.Table("sales").
		Select("TO_CHAR(\"saleDate\", 'YYYY-MM-DD') as day, SUM(\"totalAmount\") as total").
		Where("\"saleDate\" >= ? AND \"saleDate\" < ?", from, to).
		Group("day").
		Rows()

	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var day string
		var total float64
		if err := rows.Scan(&day, &total); err != nil {
			return nil, err
		}
		results[day] = total
	}
	return results, nil
}

func (r *PostgresSaleRepository) GetSalesByPaymentMethod(from, to string) (map[string]float64, error) {
	results := make(map[string]float64)
	rows, err := r.db.Table("sales").
		Select("\"paymentMethod\", SUM(\"totalAmount\") as total").
		Where("\"saleDate\" >= ? AND \"saleDate\" < ?", from, to).
		Group("\"paymentMethod\"").
		Rows()

	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var method string
		var total float64
		if err := rows.Scan(&method, &total); err != nil {
			return nil, err
		}
		results[method] = total
	}
	return results, nil
}

func (r *PostgresSaleRepository) GetMonthlyStatsFromMV(monthYear string) (*ports.MVMonthlyStats, error) {
	var stats ports.MVMonthlyStats
	err := r.db.Table("mv_dashboard_stats_monthly").
		Where("month_year = ?", monthYear).
		First(&stats).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return &ports.MVMonthlyStats{MonthYear: monthYear}, nil
		}
		return nil, err
	}
	return &stats, nil
}

func (r *PostgresSaleRepository) GetMonthlyStatsTrendFromMV() ([]ports.MVMonthlyStats, error) {
	var stats []ports.MVMonthlyStats
	err := r.db.Table("mv_dashboard_stats_monthly").
		Order("month_year ASC").
		Find(&stats).Error
	return stats, err
}
