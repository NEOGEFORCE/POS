package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"
	"fmt"
	"log"
	"strings"

	"backPOS-go/internal/infrastructure/sse"
	"gorm.io/gorm"
	"sync"
	"time"
)

type PostgresSaleRepository struct {
	db           *gorm.DB
	isRefreshing bool
	mu           sync.Mutex
}

func NewPostgresSaleRepository(db *gorm.DB) *PostgresSaleRepository {
	return &PostgresSaleRepository{db: db}
}

func (r *PostgresSaleRepository) GetDB() interface{} {
	return r.db
}

func (r *PostgresSaleRepository) invalidateDashboardCache() {
	// Borrado de cache local es trivial (in-memory map), lo dejamos síncrono.
	cache.CacheManager.Delete(cache.CacheKeyDashboardOverview)

	// MV refresh y SSE broadcast se mueven a goroutine de fondo: no son
	// requeridos para responder al cliente HTTP. El broadcast SSE sobre
	// muchas conexiones puede ser pesado, y el RequestRefresh dispara
	// REFRESH MATERIALIZED VIEW en Postgres (segundos en datasets grandes).
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("⚠️ [invalidateDashboardCache] recovered: %v", rec)
			}
		}()
		sse.GetSSEService().BroadcastNewSale(nil)
	}()
}

func (r *PostgresSaleRepository) Create(sale *models.Sale) error {
	err := r.db.Create(sale).Error
	if err == nil {
		r.invalidateDashboardCache()
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
		r.invalidateDashboardCache()
	}
	return err
}

func (r *PostgresSaleRepository) GetAll() ([]models.Sale, error) {
	var sales []models.Sale
	err := r.db.Preload("Client").Preload("SaleDetails.Product.Category").Order("\"saleDate\" DESC").Find(&sales).Error
	return sales, err
}

func (r *PostgresSaleRepository) GetByDateRange(from, to time.Time) ([]models.Sale, error) {
	var sales []models.Sale
	query := r.db.Preload("Client").Preload("SaleDetails.Product.Category")
	if !from.IsZero() {
		query = query.Where("\"saleDate\" >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("\"saleDate\" <= ?", to)
	}
	err := query.Order("\"saleDate\" DESC").Find(&sales).Error
	return sales, err
}

func (r *PostgresSaleRepository) GetByDateRangeWithoutDetails(from, to time.Time) ([]models.Sale, error) {
	var sales []models.Sale
	query := r.db.Preload("Client")
	if !from.IsZero() {
		query = query.Where("\"saleDate\" >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("\"saleDate\" <= ?", to)
	}
	err := query.Order("\"saleDate\" DESC").Find(&sales).Error
	return sales, err
}

func (r *PostgresSaleRepository) GetDeletedByDateRange(from, to time.Time) ([]models.Sale, error) {
	var sales []models.Sale
	query := r.db.Unscoped().Where("deleted_at IS NOT NULL").Preload("Client").Preload("SaleDetails.Product.Category")
	if !from.IsZero() {
		query = query.Where("\"saleDate\" >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("\"saleDate\" <= ?", to)
	}
	err := query.Order("\"saleDate\" DESC").Find(&sales).Error
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

func (r *PostgresSaleRepository) Delete(id uint, reason string, employeeDNI string) error {
	// 1. Guardar motivo y quién anula antes del soft delete
	r.db.Model(&models.Sale{}).Where("\"saleId\" = ?", id).Updates(map[string]interface{}{
		"deletedReason": reason,
		"deletedByDni":  employeeDNI,
	})

	// 2. Ejecutar soft delete
	err := r.db.Delete(&models.Sale{}, id).Error
	if err == nil {
		r.invalidateDashboardCache()
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
	if filter.Search != "" {
		searchTerm := "%" + strings.ToLower(filter.Search) + "%"
		sLower := strings.ToLower(strings.TrimSpace(filter.Search))

		subQuery := "(LOWER(COALESCE(clients.name, '')) LIKE ? OR LOWER(COALESCE(sales.\"clientDni\", '')) LIKE ? OR CAST(sales.\"saleId\" AS TEXT) LIKE ? OR LOWER(COALESCE(sales.\"paymentMethod\", '')) LIKE ? OR LOWER(COALESCE(sales.\"transferSource\", '')) LIKE ?"
		args := []interface{}{searchTerm, searchTerm, searchTerm, searchTerm, searchTerm}

		if strings.Contains(sLower, "nequi") {
			subQuery += " OR sales.\"transferNequi\" > 0"
		}
		if strings.Contains(sLower, "daviplata") {
			subQuery += " OR sales.\"transferDaviplata\" > 0"
		}
		if strings.Contains(sLower, "efectivo") {
			subQuery += " OR sales.\"cashAmount\" > 0"
		}
		if strings.Contains(sLower, "fiado") || strings.Contains(sLower, "credito") {
			subQuery += " OR sales.\"creditAmount\" > 0"
		}
		subQuery += ")"

		query = query.Joins("LEFT JOIN clients ON clients.dni = sales.\"clientDni\"").
			Where(subQuery, args...)
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

func (r *PostgresSaleRepository) GetDashboardStats(from, to time.Time) (float64, int64, float64, error) {
	var stats struct {
		TotalAmount  float64
		TotalCount   int64
	}

	// 1. Efectivo Contado + Digitales (Ventas PAGADAS)
	query := r.db.Model(&models.Sale{}).Where("status = 'PAID' AND deleted_at IS NULL")
	if !from.IsZero() {
		query = query.Where("\"saleDate\" >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("\"saleDate\" <= ?", to)
	}

	err := query.Select("COALESCE(SUM(\"totalAmount\"), 0) as total_amount, COUNT(*) as total_count").
		Scan(&stats).Error

	if err != nil {
		log.Printf("❌ [GetDashboardStats] Error en consulta base: %v", err)
		return 0, 0, 0, nil // Fallback a 0 para no romper dashboard
	}

	// 2. Sumar Abonos Recibidos (Ingresos Reales por cobro de cartera)
	var totalPayments float64
	paymentQuery := r.db.Table("credit_payments").Where("deleted_at IS NULL")
	if !from.IsZero() {
		paymentQuery = paymentQuery.Where("\"paymentDate\" >= ?", from)
	}
	if !to.IsZero() {
		paymentQuery = paymentQuery.Where("\"paymentDate\" <= ?", to)
	}
	paymentQuery.Select("COALESCE(SUM(\"totalPaid\"), 0)").Scan(&totalPayments)

	stats.TotalAmount += totalPayments

	// 3. Productos Vendidos (Causación de inventario: Incluye Fiados)
	var productsSold float64
	err = r.db.Table("sale_details").
		Joins("JOIN sales ON sales.\"saleId\" = sale_details.\"saleId\"").
		Where("sales.\"saleDate\" >= ? AND sales.\"saleDate\" <= ? AND sales.status IN ('PAID', 'CREDIT') AND sales.deleted_at IS NULL", from, to).
		Select("COALESCE(SUM(quantity), 0)").
		Scan(&productsSold).Error

	if err != nil {
		log.Printf("❌ [GetDashboardStats] Error en consulta productsSold: %v", err)
		// No retornamos error aquí, solo logueamos y devolvemos lo que tengamos
	}

	return stats.TotalAmount, stats.TotalCount, productsSold, nil
}


func (r *PostgresSaleRepository) UpdatePayment(id uint, sale *models.Sale) error {
	err := r.db.Model(&models.Sale{}).Where("\"saleId\" = ?", id).Updates(map[string]interface{}{
		"clientDni":      sale.ClientDNI,
		"paymentMethod":  sale.PaymentMethod,
		"cashAmount":     sale.CashAmount,
		"transferAmount": sale.TransferAmount,
		"transferSource": sale.TransferSource,
		"creditAmount":   sale.CreditAmount,
		"amountPaid":     sale.AmountPaid,
		"change":         sale.Change,
		"debtPending":    sale.DebtPending,
	}).Error
	if err == nil {
		r.invalidateDashboardCache()
	}
	return err
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
		Select("TO_CHAR(\"saleDate\" AT TIME ZONE 'America/Bogota', 'YYYY-MM') as month, COALESCE(SUM(\"totalAmount\"), 0) as total").
		Where("status = ?", "PAID").
		Group("month").
		Rows()
	if err != nil {
		log.Printf("❌ [GetMonthlyTotals] Error: %v", err)
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

func (r *PostgresSaleRepository) GetSoldQuantityByProduct(barcode string, from, to time.Time) (float64, error) {
	var total float64
	query := r.db.Table("sale_details").
		Joins("JOIN sales ON sales.\"saleId\" = sale_details.\"saleId\"").
		Where("sale_details.barcode = ?", barcode)
	
	if !from.IsZero() {
		query = query.Where("sales.\"saleDate\" >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("sales.\"saleDate\" <= ?", to)
	}
	
	err := query.Select("COALESCE(SUM(sale_details.quantity), 0)").Scan(&total).Error
	return total, err
}

func (r *PostgresSaleRepository) GetSoldQuantitiesByBarcodes(barcodes []string, from, to time.Time) (map[string]float64, error) {
	results := make(map[string]float64)
	if len(barcodes) == 0 {
		return results, nil
	}

	query := r.db.Table("sale_details").
		Joins("JOIN sales ON sales.\"saleId\" = sale_details.\"saleId\"").
		Select("sale_details.barcode, SUM(sale_details.quantity) as total").
		Where("sale_details.barcode IN ?", barcodes)

	if !from.IsZero() {
		query = query.Where("sales.\"saleDate\" >= ?", from)
	}
	if !to.IsZero() {
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

func (r *PostgresSaleRepository) GetTopSellingProducts(from, to time.Time, limit int) ([]ports.ProductRankingItem, error) {
	var ranking []ports.ProductRankingItem
	query := `
		SELECT 
			agg.barcode, 
			COALESCE(p."productName", 'VENTA RÁPIDA / VARIOS') as name, 
			agg.quantity, 
			agg.total
		FROM (
			SELECT 
				sd.barcode, 
				SUM(sd.quantity) as quantity, 
				SUM(sd.subtotal) as total
			FROM sale_details sd
			JOIN sales s ON s."saleId" = sd."saleId"
			WHERE s."saleDate" >= ? AND s."saleDate" <= ? AND s.status IN ('PAID', 'CREDIT') AND s.deleted_at IS NULL
			GROUP BY sd.barcode
			ORDER BY quantity DESC
			LIMIT ?
		) agg
		LEFT JOIN products p ON p.barcode = agg.barcode
	`
	err := r.db.Raw(query, from, to, limit).Scan(&ranking).Error
	if err != nil {
		log.Printf("❌ [GetTopSellingProducts] Error: %v", err)
	}
	return ranking, err
}
func (r *PostgresSaleRepository) GetMajorityDayForRange(from, to time.Time) (string, error) {
	var result string
	err := r.db.Table("sales").
		Select("TO_CHAR(\"saleDate\" AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') as day").
		Where("\"saleDate\" >= ? AND \"saleDate\" <= ? AND status IN ('PAID', 'CREDIT') AND deleted_at IS NULL", from, to).
		Group("day").
		Order("COUNT(1) DESC").
		Limit(1).
		Scan(&result).Error
	return result, err
}

func (r *PostgresSaleRepository) GetDailySalesByRange(from, to time.Time) (map[string]float64, error) {
	results := make(map[string]float64)
	rows, err := r.db.Table("sales").
		Select("TO_CHAR(\"saleDate\" AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') as day, COALESCE(SUM(\"totalAmount\"), 0) as total").
		Where("\"saleDate\" >= ? AND \"saleDate\" <= ? AND status IN ('PAID', 'CREDIT') AND deleted_at IS NULL", from, to).
		Group("day").
		Rows()

	if err != nil {
		log.Printf("❌ [GetDailySalesByRange] Error: %v", err)
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

	// Agregar Diferencia Física (Sobrantes/Faltantes) para igualar a Venta Real Reconstruida
	diffRows, err := r.db.Table("cashier_closures").
		Select("TO_CHAR(end_date AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') as day, COALESCE(SUM(difference), 0) as diff").
		Where("end_date >= ? AND end_date <= ? AND deleted_at IS NULL", from, to).
		Group("day").
		Rows()

	if err == nil {
		defer diffRows.Close()
		for diffRows.Next() {
			var day string
			var diff float64
			if err := diffRows.Scan(&day, &diff); err == nil {
				results[day] += diff
			}
		}
	}

	// Restar devoluciones
	returnRows, err := r.db.Table("returns").
		Select("TO_CHAR(date AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') as day, COALESCE(SUM(\"totalReturned\"), 0) as total").
		Where("date >= ? AND date <= ? AND deleted_at IS NULL", from, to).
		Group("day").
		Rows()

	if err == nil {
		defer returnRows.Close()
		for returnRows.Next() {
			var day string
			var ret float64
			if err := returnRows.Scan(&day, &ret); err == nil {
				results[day] -= ret
			}
		}
	}

	return results, nil
}

func (r *PostgresSaleRepository) GetSalesByPaymentMethod(from, to time.Time) (map[string]float64, error) {
	// Usamos la versión V2 que separa correctamente efectivo, transferencias y fiados
	// especialmente para ventas a crédito con abonos iniciales.
	return r.GetSalesByPaymentMethodV2(from, to)
}

func (r *PostgresSaleRepository) GetSalesByPaymentMethodV2(from, to time.Time) (map[string]float64, error) {
	results := make(map[string]float64)
	
	// 1. Sumar efectivo directo de todas las ventas (PAID y CREDIT)
	var totalCash float64
	r.db.Raw(`
		SELECT COALESCE(SUM("cashAmount"), 0)
		FROM sales
		WHERE "saleDate" >= ? AND "saleDate" <= ? AND status IN ('PAID', 'CREDIT') AND deleted_at IS NULL
	`, from, to).Scan(&totalCash)
	results["EFECTIVO"] = totalCash
	
	// 2. Sumar transferencias agrupadas por su origen (NEQUI, DAVIPLATA, etc.)
	rows, err := r.db.Raw(`
		SELECT COALESCE("transferSource", 'TRANSFERENCIA') as source, SUM("transferAmount") as total
		FROM sales
		WHERE "saleDate" >= ? AND "saleDate" <= ? AND status IN ('PAID', 'CREDIT') AND deleted_at IS NULL AND "transferAmount" > 0
		GROUP BY 1
	`, from, to).Rows()
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var m string
			var a float64
			rows.Scan(&m, &a)
			results[m] += a
		}
	}
	
	// 3. Sumar el monto que quedó debiéndose (FIADO)
	var totalFiado float64
	r.db.Raw(`
		SELECT COALESCE(SUM("creditAmount"), 0)
		FROM sales
		WHERE "saleDate" >= ? AND "saleDate" <= ? AND status IN ('PAID', 'CREDIT') AND deleted_at IS NULL
	`, from, to).Scan(&totalFiado)
	results["FIADO"] = totalFiado
	
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
		// Fallback: No romper el Dashboard si la MV no existe o falla
		log.Printf("⚠️ [GetMonthlyStatsFromMV] Fallo (posible MV no creada): %v", err)
		return &ports.MVMonthlyStats{MonthYear: monthYear}, nil
	}
	return &stats, nil
}

func (r *PostgresSaleRepository) GetMonthlyStatsTrendFromMV() ([]ports.MVMonthlyStats, error) {
	var stats []ports.MVMonthlyStats
	err := r.db.Table("mv_dashboard_stats_monthly").
		Order("month_year ASC").
		Find(&stats).Error
	if err != nil {
		log.Printf("⚠️ [GetMonthlyStatsTrendFromMV] Fallo: %v", err)
		return []ports.MVMonthlyStats{}, nil
	}
	return stats, nil
}
func (r *PostgresSaleRepository) GetGlobalTotalSales() (float64, error) {
	var total float64
	err := r.db.Model(&models.Sale{}).Where("status = 'PAID' AND deleted_at IS NULL").Select("COALESCE(SUM(\"totalAmount\"), 0)").Scan(&total).Error
	if err != nil {
		log.Printf("❌ [GetGlobalTotalSales] Error en sales: %v", err)
		return 0, nil
	}
	
	var totalPayments float64
	err = r.db.Table("credit_payments").Where("deleted_at IS NULL").Select("COALESCE(SUM(\"totalPaid\"), 0)").Scan(&totalPayments).Error
	if err != nil {
		log.Printf("❌ [GetGlobalTotalSales] Error en payments: %v", err)
	}

	return total + totalPayments, nil
}

func (r *PostgresSaleRepository) GetTotalSalesByRange(from, to time.Time) (float64, error) {
	var total float64
	query := r.db.Model(&models.Sale{}).Where("status = 'PAID' AND deleted_at IS NULL")
	if !from.IsZero() {
		query = query.Where("\"saleDate\" >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("\"saleDate\" < ?", to)
	}
	err := query.Select("COALESCE(SUM(\"totalAmount\"), 0)").Scan(&total).Error
	if err != nil {
		log.Printf("❌ [GetTotalSalesByRange] Error en sales: %v", err)
		return 0, nil
	}

	var totalPayments float64
	paymentQuery := r.db.Table("credit_payments").Where("deleted_at IS NULL")
	if !from.IsZero() {
		paymentQuery = paymentQuery.Where("\"paymentDate\" >= ?", from)
	}
	if !to.IsZero() {
		paymentQuery = paymentQuery.Where("\"paymentDate\" < ?", to)
	}
	err = paymentQuery.Select("COALESCE(SUM(\"totalPaid\"), 0)").Scan(&totalPayments).Error
	if err != nil {
		log.Printf("❌ [GetTotalSalesByRange] Error en payments: %v", err)
	}

	return total + totalPayments, nil
}

func (r *PostgresSaleRepository) GetGlobalCOGS() (float64, error) {
	var total float64
	err := r.db.Table("sale_details").
		Joins("JOIN sales ON sales.\"saleId\" = sale_details.\"saleId\"").
		Joins("JOIN products ON products.barcode = sale_details.barcode").
		Where("sales.status IN ('PAID', 'CREDIT')").
		Select("COALESCE(SUM(sale_details.quantity * COALESCE(NULLIF(sale_details.\"costPrice\", 0), products.\"purchasePrice\", 0)), 0)").
		Scan(&total).Error
	if err != nil {
		log.Printf("❌ [GetGlobalCOGS] Error: %v", err)
		return 0, nil
	}
	return total, nil
}

func (r *PostgresSaleRepository) GetCOGSByRange(from, to time.Time) (float64, error) {
	var total float64
	err := r.db.Table("sale_details").
		Joins("JOIN sales ON sales.\"saleId\" = sale_details.\"saleId\"").
		Joins("JOIN products ON products.barcode = sale_details.barcode").
		Where("sales.\"saleDate\" >= ? AND sales.\"saleDate\" <= ? AND sales.status IN ('PAID', 'CREDIT') AND sales.deleted_at IS NULL", from, to).
		Select("COALESCE(SUM(sale_details.quantity * COALESCE(NULLIF(sale_details.\"costPrice\", 0), products.\"purchasePrice\", 0)), 0)").
		Scan(&total).Error
	if err != nil {
		log.Printf("❌ [GetCOGSByRange] Error: %v", err)
		return 0, nil
	}
	return total, nil
}

func (r *PostgresSaleRepository) GetGlobalSalesByMethod() (map[string]float64, error) {
	results := make(map[string]float64)
	
	var totalCash, totalTransfer, totalCredit float64

	// EFECTIVO: Todos los ingresos en efectivo netos (restando el cambio)
	r.db.Model(&models.Sale{}).
		Where("deleted_at IS NULL AND status IN ('PAID', 'CREDIT', 'FIADO')").
		Select("COALESCE(SUM(GREATEST(0, \"cashAmount\" - \"change\")), 0)").
		Scan(&totalCash)

	// TRANSFERENCIA: Todos los ingresos por transferencia
	r.db.Model(&models.Sale{}).
		Where("deleted_at IS NULL AND status IN ('PAID', 'CREDIT', 'FIADO')").
		Select("COALESCE(SUM(\"transferAmount\"), 0)").
		Scan(&totalTransfer)

	// FIADOS: Total de deuda pendiente (creditAmount)
	r.db.Model(&models.Sale{}).
		Where("deleted_at IS NULL AND status IN ('PAID', 'CREDIT', 'FIADO')").
		Select("COALESCE(SUM(\"creditAmount\"), 0)").
		Scan(&totalCredit)
	
	results["EFECTIVO"] = totalCash
	results["TRANSFERENCIA"] = totalTransfer
	results["FIADO"] = totalCredit

	// Breakdown for TransferSource
	rows, err := r.db.Table("sales").
		Select("\"transferSource\", SUM(\"transferAmount\") as total").
		Where("status IN ('PAID', 'CREDIT', 'FIADO') AND \"transferAmount\" > 0 AND \"deleted_at\" IS NULL").
		Group("\"transferSource\"").
		Rows()
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var source string
			var total float64
			if err := rows.Scan(&source, &total); err == nil {
				if source == "" { source = "NEQUI" }
				results[strings.ToUpper(source)] = total
			}
		}
	}

	return results, nil
}

func (r *PostgresSaleRepository) GetGlobalCollectedDebtsByMethod() (map[string]float64, error) {
	results := make(map[string]float64)
	
	var stats struct {
		TotalCash     float64
		TotalTransfer float64
	}

	err := r.db.Table("credit_payments").
		Select("COALESCE(SUM(\"amountCash\"), 0) as total_cash, COALESCE(SUM(\"amountTransfer\"), 0) as total_transfer").
		Scan(&stats).Error
	
	if err != nil {
		return nil, err
	}

	results["EFECTIVO"] = stats.TotalCash
	results["TRANSFERENCIA"] = stats.TotalTransfer

	// Breakdown for TransferSource
	rows, err := r.db.Table("credit_payments").
		Select("\"transferSource\", SUM(\"amountTransfer\") as total").
		Where("\"amountTransfer\" > 0").
		Group("\"transferSource\"").
		Rows()
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var source string
			var total float64
			if err := rows.Scan(&source, &total); err == nil {
				if source == "" { source = "NEQUI" }
				results[strings.ToUpper(source)] = total
			}
		}
	}

	return results, nil
}
func (r *PostgresSaleRepository) GetSalesBreakdownByRange(from, to time.Time) (map[string]float64, error) {
	results := make(map[string]float64)
	
	// Usamos una consulta unificada para evitar duplicidades y asegurar que cada movimiento se cuente una vez
	// 1. Efectivo de Ventas y Abonos
	var totalCash float64
	cashQuery := `
		SELECT COALESCE(SUM(amount), 0) FROM (
			SELECT ("cashAmount" - "change") as amount FROM sales 
			WHERE status IN ('PAID', 'CREDIT') AND deleted_at IS NULL AND "saleDate" >= ? AND "saleDate" <= ?
			UNION ALL
			SELECT "amountCash" as amount FROM credit_payments 
			WHERE "paymentDate" >= ? AND "paymentDate" <= ?
		) as combined_cash
	`
 r.db.Raw(cashQuery, from, to, from, to).Scan(&totalCash)
	results["EFECTIVO"] = totalCash

	// 2. Fiados (Monto de deuda emitido)
	var totalFiados float64
	r.db.Model(&models.Sale{}).
		Where("status IN ('PAID', 'CREDIT') AND deleted_at IS NULL AND \"saleDate\" >= ? AND \"saleDate\" <= ?", from, to).
		Select("COALESCE(SUM(\"creditAmount\"), 0)").Scan(&totalFiados)
	results["FIADO"] = totalFiados

	// 3. Transferencias (Nequi, Daviplata, etc.) agrupadas
	type TransferResult struct {
		Source string
		Total  float64
	}
	var transferResults []TransferResult
	transferQuery := `
		SELECT UPPER(COALESCE(source, 'TRANSFERENCIA')) as source, SUM(amount) as total FROM (
			SELECT "transferSource" as source, "transferAmount" as amount FROM sales 
			WHERE status IN ('PAID', 'CREDIT') AND "transferAmount" > 0 AND deleted_at IS NULL AND "saleDate" >= ? AND "saleDate" <= ?
			UNION ALL
			SELECT "transferSource" as source, "amountTransfer" as amount FROM credit_payments 
			WHERE "amountTransfer" > 0 AND "paymentDate" >= ? AND "paymentDate" <= ?
		) as combined_transfers
		GROUP BY 1
	`
	r.db.Raw(transferQuery, from, to, from, to).Scan(&transferResults)
	
	totalTransferSum := 0.0
	for _, tr := range transferResults {
		if tr.Source == "" { tr.Source = "TRANSFERENCIA" }
		results[tr.Source] = tr.Total
		totalTransferSum += tr.Total
	}
	results["TRANSFERENCIA"] = totalTransferSum

	return results, nil
}

func (r *PostgresSaleRepository) GetPendingByClient(clientDNI string) ([]models.Sale, error) {
	var sales []models.Sale
	err := r.db.Preload("SaleDetails").Preload("SaleDetails.Product").
		Where("status = ? AND \"clientDni\" = ? AND \"debtPending\" > 0", "CREDIT", clientDNI).
		Order("\"saleDate\" ASC").
		Find(&sales).Error
	return sales, err
}

func (r *PostgresSaleRepository) GetCreditHistoryByClient(clientDNI string) ([]models.Sale, error) {
	var sales []models.Sale
	// Traer todas las ventas donde creditAmount > 0 (sin importar el estado de debtPending)
	err := r.db.Preload("SaleDetails").Preload("SaleDetails.Product").
		Where("\"clientDni\" = ? AND \"creditAmount\" > 0", clientDNI).
		Order("\"saleDate\" ASC").
		Find(&sales).Error
	return sales, err
}

