package services

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"

	"golang.org/x/sync/errgroup"
)

// GetCriticalThreshold calcula el umbral crítico basado en minStock
// minStock >= 12 -> 3, minStock >= 4 -> 2, minStock <= 3 -> 1
// Esta es la ÚNICA fuente de verdad para el semáforo de stock en todo el sistema
func GetCriticalThreshold(minStock int) int {
	if minStock >= 12 {
		return 3
	}
	if minStock >= 4 {
		return 2
	}
	return 1
}

type DashboardService struct {
	saleRepo     ports.SaleRepository
	productRepo  ports.ProductRepository
	clientRepo   ports.ClientRepository
	expenseRepo  ports.ExpenseRepository
	returnRepo   ports.ReturnRepository
	closureRepo  ports.ClosureRepository
	shiftRepo    ports.ActiveShiftRepository
	creditRepo   ports.CreditPaymentRepository
	categoryRepo ports.CategoryRepository
	movementRepo ports.StockMovementRepository
	adminRepo    ports.AdminRepository
}

func NewDashboardService(
	s ports.SaleRepository,
	p ports.ProductRepository,
	c ports.ClientRepository,
	e ports.ExpenseRepository,
	r ports.ReturnRepository,
	cl ports.ClosureRepository,
	sh ports.ActiveShiftRepository,
	cr ports.CreditPaymentRepository,
	cat ports.CategoryRepository,
	mr ports.StockMovementRepository,
	ar ports.AdminRepository,
) *DashboardService {
	return &DashboardService{
		saleRepo:     s,
		productRepo:  p,
		clientRepo:   c,
		expenseRepo:  e,
		returnRepo:   r,
		closureRepo:  cl,
		shiftRepo:    sh,
		creditRepo:   cr,
		categoryRepo: cat,
		movementRepo: mr,
		adminRepo:    ar,
	}
}

// --- New structs for Dashboard V5 widgets ---

type StockStatus string

const (
	StockCritical StockStatus = "CRITICAL" // Rojo: quantity <= criticalThreshold
	StockWarning  StockStatus = "WARNING"  // Ámbar: quantity <= minStock && quantity > criticalThreshold
	StockOptimal  StockStatus = "OPTIMAL"  // Verde: quantity > minStock
)

type LowStockItem struct {
	Barcode   string      `json:"barcode"`
	Name      string      `json:"name"`
	Stock     float64     `json:"stock"`
	MinStock  float64     `json:"minStock"`
	Threshold int         `json:"threshold"` // Umbral crítico calculado dinámicamente
	Status    StockStatus `json:"status"`    // CRITICAL, WARNING, OPTIMAL
}

type DailyPoint struct {
	Date   string  `json:"date"`
	Amount float64 `json:"amount"`
}

type DashboardOverview struct {
	TotalSalesAmount    float64                  `json:"totalSalesAmount"`
	TotalExpensesAmount float64                  `json:"totalExpensesAmount"`
	Profit              float64                  `json:"profit"`
	TotalProductsSold   float64                  `json:"totalProductsSold"`
	TotalClients        int64                    `json:"totalClients"`
	SalesByDay          map[string]float64       `json:"salesByDay"`
	RecentSales         []map[string]interface{} `json:"recentSales"`
	Monthly             map[string]interface{}   `json:"monthly"`
	// V5 fields
	TodaySalesAmount      float64                    `json:"todaySalesAmount"`
	TodaySalesCount       int64                      `json:"todaySalesCount"`
	TodayCollectedDebts   float64                    `json:"todayCollectedDebts"`
	MonthlyCollectedDebts float64                    `json:"monthlyCollectedDebts"`
	ActiveProducts        int64                      `json:"activeProducts"`
	TotalProducts         int64                      `json:"totalProducts"`
	CategoriesCount       int64                      `json:"categoriesCount"`
	CriticalStockCount    int64                      `json:"criticalStockCount"` // Rojo
	WarningStockCount     int64                      `json:"warningStockCount"`  // Ámbar
	LowStockProducts      []LowStockItem             `json:"lowStockProducts"`
	SalesByPayment        map[string]float64         `json:"salesByPayment"`
	DailySalesLast7       []DailyPoint               `json:"dailySalesLast7"`
	TopProducts           []ports.ProductRankingItem `json:"topProducts"`
	MissingItems          []models.MissingItem       `json:"missingItems"`
	SavingsOpportunities  []ports.SavingsOpportunity `json:"savingsOpportunities"`
	// Financial Refactor V5.3 - Strict JSON Tags
	RealCashFlow  CashFlowSummary `json:"realCashFlow"`
	PendingDebts  DebtSummary     `json:"pendingDebts"`
	TodayExpenses ExpenseSummary  `json:"todayExpenses"`
	// Financial Reconciliation V5.5
	SystemBalance      float64 `json:"systemBalance"`
	ReportedBalance    float64 `json:"reportedBalance"`
	GlobalDifference   float64 `json:"globalDifference"`
	TotalExpensesPaid    float64 `json:"totalExpensesPaid"`
	EstimatedNetProfit   float64 `json:"estimatedNetProfit"`
	InventoryCostValue   float64 `json:"inventoryCostValue"`
	InventoryRetailValue float64 `json:"inventoryRetailValue"`
}

type CashFlowSummary struct {
	Cash      float64 `json:"cash"`
	Nequi     float64 `json:"nequi"`
	Daviplata float64 `json:"daviplata"`
}

type DebtSummary struct {
	Amount float64          `json:"amount"`
	Count  int              `json:"count"`
	Items  []models.Expense `json:"items"`
}

type ExpenseSummary struct {
	Amount float64 `json:"amount"`
	Count  int     `json:"count"`
}


type CategoryReportItem struct {
	Category string  `json:"category"`
	Total    float64 `json:"total"`
	Quantity float64 `json:"quantity"`
}

type VIPClientItem struct {
	DNI   string  `json:"dni"`
	Name  string  `json:"name"`
	Total float64 `json:"total"`
	Count int     `json:"count"`
}

type VoidReportItem struct {
	SaleID   uint      `json:"saleId"`
	Date     time.Time `json:"date"`
	Total    float64   `json:"total"`
	Employee string    `json:"employee"`
	VoidedAt time.Time `json:"voidedAt"`
}

type PnLReport struct {
	From             string  `json:"from"`
	To               string  `json:"to"`
	TotalRevenue     float64 `json:"totalRevenue"`
	TotalCOGS        float64 `json:"totalCogs"`
	GrossProfit      float64 `json:"grossProfit"`
	TotalExpenses    float64 `json:"totalExpenses"`
	NetProfit        float64 `json:"netProfit"`
	MarginPercentage float64 `json:"marginPercentage"`
}

type StockMovementReportItem struct {
	Date     time.Time `json:"date"`
	Barcode  string    `json:"barcode"`
	Name     string    `json:"name"`
	Quantity float64   `json:"quantity"`
	Type     string    `json:"type"`
	Reason   string    `json:"reason"`
	Employee string    `json:"employee"`
	Ref      string    `json:"ref"`
}

func (s *DashboardService) GetOverview() (*DashboardOverview, error) {
	// CACHÉ L1: Retorno instantáneo si existe en RAM (Barrera HFT)
	if cached, found := cache.CacheManager.Get(cache.CacheKeyDashboardOverview); found {
		if overview, ok := cached.(*DashboardOverview); ok {
			log.Println("🚀 HFT: Dashboard HIT (L1 Cache Intercepted)")
			return overview, nil
		}
	}

	log.Println("⚡ HFT: Dashboard MISS (Ejecutando Goroutines de Alta Intensidad...)")
	now := time.Now()
	todayStr := now.Format("2006-01-02")
	tomorrowStr := now.AddDate(0, 0, 1).Format("2006-01-02")
	sevenDaysAgoStr := now.AddDate(0, 0, -7).Format("2006-01-02")
	currentMonthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	nextMonthStart := currentMonthStart.AddDate(0, 1, 0)
	currentMonthStr := currentMonthStart.Format("2006-01-02")
	nextMonthStr := nextMonthStart.Format("2006-01-02")

	g, _ := errgroup.WithContext(context.Background())

	var totalSalesAmount, totalProductsSold, totalExpensesAmount, monthlyCollectedDebts float64
	var mvStats *ports.MVMonthlyStats
	var mvTrend []ports.MVMonthlyStats
	currentMonthKey := now.Format("2006-01")

	var todayExpensesRaw []models.Expense
	var todayPaymentsRaw []models.CreditPayment
	var todaySalesAmount float64
	var todaySalesCount int64
	var clientCount int64
	var categories []models.Category
	var totalProducts, activeProducts int64
	var lowStockRaw []models.Product
	var recentSalesRaw []models.Sale
	var salesByMonth, expensesByMonth, profitByMonth map[string]float64
	var dailySalesMap map[string]float64
	var dailyCollectedMap map[string]float64
	var salesByPayment map[string]float64
	var topProducts []ports.ProductRankingItem
	var missingItems []models.MissingItem
	var savingsOpportunities []ports.SavingsOpportunity
	var todaySalesByPayment map[string]float64
	var pendingDebtsAmount float64
	var pendingDebtsCount int64
	var pendingDebtsList []models.Expense
	var globalSales, globalExpenses, globalReported float64
	var inventoryCostValue, inventoryRetailValue float64
	var monthlyCOGS, monthlyExpensesAmount float64
	var globalSalesByMethod, globalCollectedByMethod, globalPaidByMethod map[string]float64

	// 1. Get Materialized View Stats (Instant)
	g.Go(func() error {
		var err error
		mvStats, err = s.saleRepo.GetMonthlyStatsFromMV(currentMonthKey)
		return err
	})
	g.Go(func() error {
		amount, count, err := s.expenseRepo.GetPendingDebtsSummary()
		if err == nil {
			pendingDebtsAmount = amount
			pendingDebtsCount = count
		}
		// Fetch the actual list of pending debts for the dashboard
		pendingDebtsList, _ = s.expenseRepo.GetExpensesByStatus("PENDING")
		return nil
	})
	g.Go(func() error {
		var err error
		mvTrend, err = s.saleRepo.GetMonthlyStatsTrendFromMV()
		return err
	})

	// 2. Optimized Real-time Queries (Only Today or small sets)
	g.Go(func() error {
		var err error
		// Only get expenses for TODAY to keep it fast
		todayExpensesRaw, err = s.expenseRepo.GetByDateRange(todayStr, tomorrowStr)
		return err
	})
	g.Go(func() error {
		var err error
		// Only get payments for TODAY
		todayPaymentsRaw, err = s.creditRepo.GetByDateRange(now, now) // Note: might need adjustment for full day
		return err
	})
	g.Go(func() error {
		var err error
		todaySalesAmount, todaySalesCount, _, err = s.saleRepo.GetDashboardStats(todayStr, tomorrowStr)
		return err
	})
	g.Go(func() error {
		var err error
		clientCount, err = s.clientRepo.Count()
		return err
	})
	g.Go(func() error {
		var err error
		categories, err = s.categoryRepo.GetAll()
		return err
	})
	g.Go(func() error {
		var err error
		totalProducts, err = s.productRepo.Count()
		return err
	})
	g.Go(func() error {
		var err error
		activeProducts, err = s.productRepo.GetActiveCount()
		return err
	})
	g.Go(func() error {
		var err error
		lowStockRaw, err = s.productRepo.GetAllWithLowStock()
		return err
	})
	g.Go(func() error {
		var err error
		// Recent sales is already small (limit 5)
		salesFilter := ports.SaleFilter{Page: 1, PageSize: 20, From: currentMonthStr, To: nextMonthStr}
		recentSalesRaw, _, err = s.saleRepo.FindAll(salesFilter)
		return err
	})
	g.Go(func() error {
		var err error
		dailySalesMap, err = s.saleRepo.GetDailySalesByRange(sevenDaysAgoStr, tomorrowStr)
		return err
	})
	g.Go(func() error {
		var err error
		dailyCollectedMap, err = s.creditRepo.GetDailyCollectedByRange(sevenDaysAgoStr, tomorrowStr)
		return err
	})
	g.Go(func() error {
		var err error
		topProducts, err = s.saleRepo.GetTopSellingProducts(currentMonthStr, nextMonthStr, 7)
		return err
	})
	g.Go(func() error {
		var err error
		missingItems, err = s.adminRepo.GetRecentPendingMissingItems(7)
		return err
	})
	g.Go(func() error {
		var err error
		savingsOpportunities, err = s.getSavingsOpportunitiesCached()
		return err
	})
	g.Go(func() error {
		var err error
		todaySalesByPayment, err = s.saleRepo.GetSalesByPaymentMethod(todayStr, tomorrowStr)
		return err
	})
	g.Go(func() error {
		var err error
		pendingDebtsAmount, pendingDebtsCount, err = s.expenseRepo.GetPendingDebtsSummary()
		return err
	})
	// Global Reconciliation Queries
	g.Go(func() error {
		var err error
		globalSales, err = s.saleRepo.GetGlobalTotalSales()
		return err
	})
	g.Go(func() error {
		var err error
		globalExpenses, err = s.expenseRepo.GetGlobalTotalPaidExpenses()
		return err
	})
	g.Go(func() error {
		var err error
		globalReported, err = s.closureRepo.GetGlobalReportedBalance()
		return err
	})
	// Financial Stats V5.5
	g.Go(func() error {
		var err error
		inventoryCostValue, err = s.productRepo.GetGlobalInventoryValue()
		return err
	})
	g.Go(func() error {
		var err error
		inventoryRetailValue, err = s.productRepo.GetGlobalInventoryRetailValue()
		return err
	})
	// Breakdown Reconciliation Queries
	g.Go(func() error {
		var err error
		globalSalesByMethod, err = s.saleRepo.GetGlobalSalesByMethod()
		return err
	})
	g.Go(func() error {
		var err error
		globalCollectedByMethod, err = s.saleRepo.GetGlobalCollectedDebtsByMethod()
		return err
	})
	g.Go(func() error {
		var err error
		globalPaidByMethod, err = s.expenseRepo.GetGlobalPaidExpensesByMethod()
		return err
	})
	// Monthly Profit Components
	g.Go(func() error {
		var err error
		monthlyCOGS, err = s.saleRepo.GetCOGSByRange(currentMonthStr, nextMonthStr)
		return err
	})
	g.Go(func() error {
		var err error
		monthlyExpensesAmount, err = s.expenseRepo.GetPaidAmountByRange(currentMonthStr, nextMonthStr)
		return err
	})

	if err := g.Wait(); err != nil {
		return nil, err
	}

	// Consolidación de Datos usando MVStats
	totalSalesAmount = mvStats.TotalSales
	totalProductsSold = mvStats.ProductsSold
	totalExpensesAmount = mvStats.TotalExpenses
	monthlyCollectedDebts = mvStats.TotalAbonos

	todayExpenses := 0.0
	todayExpensesCount := int64(0)
	expensesByMethod := make(map[string]float64)

	for _, e := range todayExpensesRaw {
		status := strings.ToUpper(e.Status)
		source := strings.ToUpper(e.PaymentSource)
		isPending := status == "PENDING" || source == "PRESTAMO" || source == "PREST."

		if !isPending && status == "PAID" {
			todayExpenses += e.Amount
			todayExpensesCount++
			method := strings.ToUpper(e.PaymentSource)
			expensesByMethod[method] += e.Amount
		}
	}

	// Categorize Abonos (Collected Debts) by Payment Method
	paymentsByMethod := make(map[string]float64)
	todayCollectedDebts := 0.0
	for _, p := range todayPaymentsRaw {
		todayCollectedDebts += p.TotalPaid
		// Direct Cash portion
		if p.AmountCash > 0 {
			paymentsByMethod["EFECTIVO"] += p.AmountCash
		}
		// Transfer portion
		if p.AmountTransfer > 0 {
			method := strings.ToUpper(p.TransferSource)
			if method == "" {
				method = "NEQUI" // Default if empty, common in this system
			}
			paymentsByMethod[method] += p.AmountTransfer
		}
	}

	// Normalize Sales by Payment Method keys to Uppercase
	normalizedSales := make(map[string]float64)
	for k, v := range todaySalesByPayment {
		normalizedSales[strings.ToUpper(k)] = v
	}

	// Reconstruir mapas históricos desde MV Trend
	salesByMonth = make(map[string]float64)
	expensesByMonth = make(map[string]float64)
	profitByMonth = make(map[string]float64)

	for _, trend := range mvTrend {
		salesByMonth[trend.MonthYear] = trend.TotalSales
		expensesByMonth[trend.MonthYear] = trend.TotalExpenses
		profitByMonth[trend.MonthYear] = trend.TotalSales - trend.TotalExpenses
	}

	// Reconstruir salesByPayment desde MVStats (Mes Actual)
	salesByPayment = map[string]float64{
		"EFECTIVO":      mvStats.SalesCash,
		"TRANSFERENCIA": mvStats.SalesTransfer,
		"FIADO":         mvStats.SalesCredit,
	}

	criticalCount := 0
	warningCount := 0
	lowStockProducts := []LowStockItem{}
	for _, p := range lowStockRaw {
		if p.IsWeighted { continue }
		minStock := int(p.MinStock)
		if minStock <= 0 { minStock = 5 }
		threshold := GetCriticalThreshold(minStock)
		if int(p.Quantity) <= threshold {
			criticalCount++
			lowStockProducts = append(lowStockProducts, LowStockItem{
				Barcode: p.Barcode, Name: p.ProductName, Stock: p.Quantity, MinStock: float64(minStock), Threshold: threshold, Status: StockCritical,
			})
		} else if int(p.Quantity) <= minStock {
			warningCount++
			lowStockProducts = append(lowStockProducts, LowStockItem{
				Barcode: p.Barcode, Name: p.ProductName, Stock: p.Quantity, MinStock: float64(minStock), Threshold: threshold, Status: StockWarning,
			})
		}
	}
	if len(lowStockProducts) > 18 {
		lowStockProducts = lowStockProducts[:18]
	}

	recentSales := []map[string]interface{}{}
	for _, sale := range recentSalesRaw {
		clientName := "Consumidor Final"
		if sale.Client.Name != "" { clientName = sale.Client.Name }
		recentSales = append(recentSales, map[string]interface{}{
			"id": sale.SaleID, "total": sale.TotalAmount, "date": sale.SaleDate.Format(time.RFC3339), "client": clientName, "payment_method": sale.PaymentMethod,
		})
	}
	if len(recentSales) > 18 {
		recentSales = recentSales[:18]
	}

	dailySalesLast7 := []DailyPoint{}
	for i := 6; i >= 0; i-- {
		d := now.AddDate(0, 0, -i)
		dStr := d.Format("2006-01-02")
		dailySalesLast7 = append(dailySalesLast7, DailyPoint{Date: dStr, Amount: dailySalesMap[dStr] + dailyCollectedMap[dStr]})
	}

	result := &DashboardOverview{
		TotalSalesAmount:    totalSalesAmount,
		TotalExpensesAmount: totalExpensesAmount,
		Profit:              totalSalesAmount - totalExpensesAmount,
		TotalProductsSold:   totalProductsSold,
		TotalClients:        clientCount,
		RecentSales:         recentSales,
		Monthly: map[string]interface{}{
			"salesByMonth": salesByMonth, "expensesByMonth": expensesByMonth, "profitByMonth": profitByMonth,
		},
		TodaySalesAmount:      todaySalesAmount,
		TodaySalesCount:       todaySalesCount,
		TodayCollectedDebts:   todayCollectedDebts,
		MonthlyCollectedDebts: monthlyCollectedDebts,
		ActiveProducts:        activeProducts,
		TotalProducts:         totalProducts,
		CategoriesCount:       int64(len(categories)),
		CriticalStockCount:    int64(criticalCount),
		WarningStockCount:     int64(warningCount),
		LowStockProducts:      lowStockProducts,
		SalesByPayment:        salesByPayment,
		DailySalesLast7:       dailySalesLast7,
		TopProducts:           topProducts,
		MissingItems:          missingItems,
		SavingsOpportunities:  savingsOpportunities,
		RealCashFlow: CashFlowSummary{
			Cash:      globalSalesByMethod["EFECTIVO"] + globalCollectedByMethod["EFECTIVO"] - globalPaidByMethod["EFECTIVO"],
			Nequi:     globalSalesByMethod["NEQUI"] + globalCollectedByMethod["NEQUI"] - globalPaidByMethod["NEQUI"],
			Daviplata: globalSalesByMethod["DAVIPLATA"] + globalCollectedByMethod["DAVIPLATA"] - globalPaidByMethod["DAVIPLATA"],
		},
		PendingDebts: DebtSummary{
			Amount: pendingDebtsAmount,
			Count:  int(pendingDebtsCount),
			Items:  pendingDebtsList,
		},
		TodayExpenses: ExpenseSummary{
			Amount: todayExpenses,
			Count:  int(todayExpensesCount),
		},
		SystemBalance:    globalSales - globalExpenses,
		ReportedBalance:  globalReported,
		GlobalDifference: globalReported - (func() float64 {
			sb := globalSales - globalExpenses
			if sb < 0 { return 0 }
			return sb
		})(),
		TotalExpensesPaid:    globalExpenses,
		EstimatedNetProfit:   (mvStats.TotalSales - monthlyCOGS) - monthlyExpensesAmount,
		InventoryCostValue:   inventoryCostValue,
		InventoryRetailValue: inventoryRetailValue,
	}

	// PERSISTENCIA EN RAM: TTL de 60s para datos frescos pero sin I/O repetitivo
	cache.CacheManager.Set(cache.CacheKeyDashboardOverview, result, 60*time.Second)

	return result, nil
}

func (s *DashboardService) getSavingsOpportunitiesCached() ([]ports.SavingsOpportunity, error) {
	if cached, found := cache.CacheManager.Get(cache.CacheKeySavingsOpportunities); found {
		return cached.([]ports.SavingsOpportunity), nil
	}
	savings, err := s.productRepo.GetSavingsOpportunities()
	if err == nil {
		cache.CacheManager.Set(cache.CacheKeySavingsOpportunities, savings, 1*time.Hour)
	}
	return savings, err
}

func (s *DashboardService) getSavingsOpportunities() []ports.SavingsOpportunity {
	savings, err := s.productRepo.GetSavingsOpportunities()
	if err != nil {
		return []ports.SavingsOpportunity{}
	}
	return savings
}

func (s *DashboardService) fetchRecentMissingItems() []models.MissingItem {
	items, err := s.adminRepo.GetMissingItems()
	if err != nil {
		return []models.MissingItem{}
	}
	// Only return the 5 most recent pending items
	filtered := []models.MissingItem{}
	for _, item := range items {
		if strings.ToUpper(item.Status) == "PENDIENTE" {
			filtered = append(filtered, item)
		}
		if len(filtered) >= 5 {
			break
		}
	}
	return filtered
}

func (s *DashboardService) calculateTopProductsFromSales(sales []models.Sale) []ports.ProductRankingItem {
	rankingMap := make(map[string]*ports.ProductRankingItem)
	for _, sale := range sales {
		for _, detail := range sale.SaleDetails {
			if _, ok := rankingMap[detail.Barcode]; !ok {
				name := detail.Barcode
				if detail.Product.ProductName != "" {
					name = detail.Product.ProductName
				}
				rankingMap[detail.Barcode] = &ports.ProductRankingItem{
					Barcode: detail.Barcode,
					Name:    name,
				}
			}
			rankingMap[detail.Barcode].Quantity += detail.Quantity
			rankingMap[detail.Barcode].Total += detail.Subtotal
		}
	}

	ranking := []ports.ProductRankingItem{}
	for _, item := range rankingMap {
		ranking = append(ranking, *item)
	}

	sort.Slice(ranking, func(i, j int) bool {
		return ranking[i].Quantity > ranking[j].Quantity
	})

	if len(ranking) > 5 {
		ranking = ranking[:5]
	}
	return ranking
}

func (s *DashboardService) AdjustInitialBalance(realBalance float64, employeeName string, employeeDNI string) error {
	// 1. Obtener totales actuales
	globalSales, _ := s.saleRepo.GetGlobalTotalSales()
	globalExpenses, _ := s.expenseRepo.GetGlobalTotalPaidExpenses()
	globalReported, _ := s.closureRepo.GetGlobalReportedBalance()

	currentSystemBalance := globalSales - globalExpenses
	// Si el balance teórico es negativo, lo tratamos como 0 para la base
	if currentSystemBalance < 0 {
		currentSystemBalance = 0
	}

	// 2. Calcular ajustes necesarios para que ambos totales sean igual a realBalance
	saleAdjustment := realBalance - currentSystemBalance
	closureAdjustment := realBalance - globalReported

	// 3. Aplicar Ajuste de Ventas (para normalizar el Saldo Esperado)
	if saleAdjustment != 0 {
		adjSale := &models.Sale{
			TotalAmount:   saleAdjustment,
			CashAmount:    saleAdjustment,
			PaymentMethod: "EFECTIVO",
			SaleDate:      time.Now(),
			EmployeeDNI:   "SYSTEM",
			ClientDNI:     "S.N.",
		}
		_ = s.saleRepo.Create(adjSale)
	}

	// 4. Aplicar Ajuste de Cierres (para normalizar el Saldo Real)
	if closureAdjustment != 0 {
		adjClosure := &models.CashierClosure{
			Date:          time.Now(),
			StartDate:     time.Now(),
			EndDate:       time.Now(),
			TotalCashReal: closureAdjustment,
			ClosedByDNI:   employeeDNI,
			ClosedByName:  employeeName,
			Difference:    0,
			AuthorizedBy:  "SYSTEM_RESET",
			ExpensesDetail: "AJUSTE MANUAL DE SALDO INICIAL",
		}
		_ = s.closureRepo.Save(adjClosure)
	}

	// Invalidar caché para que el frontend vea los cambios
	cache.CacheManager.Delete(cache.CacheKeyDashboardOverview)

	log.Printf("📊 [AdjustInitialBalance] Reseteo completado. Nuevo Saldo Base: $%f", realBalance)
	return nil
}

type CashierClosure struct {
	Date                 time.Time              `json:"date"`
	StartDate            time.Time              `json:"startDate"`
	EndDate              time.Time              `json:"endDate"`
	SalesCount           int                    `json:"salesCount"`
	TotalSales           float64                `json:"totalSales"`
	TotalCash            float64                `json:"totalCash"`
	TotalTransfer        float64                `json:"totalTransfer"`
	TotalCard            float64                `json:"totalCard"` // NUEVO: Pagos con tarjeta
	TotalNequi           float64                `json:"totalNequi"`
	TotalDaviplata       float64                `json:"totalDaviplata"`
	TotalBancolombia     float64                `json:"totalBancolombia"`
	TotalOtherTransfer   float64                `json:"totalOtherTransfer"`
	TotalExpenses        float64                `json:"totalExpenses"`
	TotalReturns         float64                `json:"totalReturns"`
	ReturnsCount         float64                `json:"returnsCount"`
	TotalCreditIssued    float64                `json:"totalCreditIssued"`
	TotalCreditCollected float64                `json:"totalCreditCollected"`
	OpeningCash          float64                `json:"openingCash"`
	NetBalance           float64                `json:"netBalance"`
	CashBills            float64                `json:"cashBills"`
	Coins200             float64                `json:"coins200"`
	Coins100             float64                `json:"coins100"`
	Coins500_1000        float64                `json:"coins500_1000"`
	ClosedByDNI          string                 `json:"closedByDni"`
	ClosedByName         string                 `json:"closedByName"`
	PhysicalCash         float64                `json:"physicalCash"`
	Difference           float64                `json:"difference"`
	AuthorizedBy         string                 `json:"authorizedBy"`
	Expenses             []models.Expense       `json:"expenses"`
	CreditPayments       []models.CreditPayment `json:"creditPayments"`
	CreditsIssued        []models.Sale          `json:"creditsIssued"` // NUEVO: Listado de fiados
	ExpensesDetail       string                 `json:"expensesDetail"`
}

func (s *DashboardService) GetCashierClosure() (*CashierClosure, error) {
	activeShift, _ := s.shiftRepo.GetActive()
	var startDate time.Time

	if activeShift != nil {
		startDate = activeShift.StartTime
	} else {
		lastClosure, _ := s.closureRepo.GetLast()
		startDate = time.Date(time.Now().Year(), time.Now().Month(), time.Now().Day(), 0, 0, 0, 0, time.UTC)
		if lastClosure != nil {
			startDate = lastClosure.EndDate
		}
	}

	startStr := startDate.Format("2006-01-02 15:04:05")
	endStr := time.Now().AddDate(0, 0, 1).Format("2006-01-02 15:04:05")

	g, _ := errgroup.WithContext(context.Background())

	var sales []models.Sale
	var expenses []models.Expense
	var returns []models.Return
	var payments []models.CreditPayment

	g.Go(func() error {
		var err error
		sales, err = s.saleRepo.GetByDateRange(startStr, endStr)
		return err
	})
	g.Go(func() error {
		var err error
		expenses, err = s.expenseRepo.GetByDateRange(startStr, endStr)
		return err
	})
	g.Go(func() error {
		var err error
		returns, err = s.returnRepo.GetByDateRange(startStr, endStr)
		return err
	})
	g.Go(func() error {
		var err error
		payments, err = s.creditRepo.GetByDateRange(startDate, time.Now())
		return err
	})

	if err := g.Wait(); err != nil {
		return nil, err
	}

	var closure CashierClosure
	closure.Date = time.Now()
	closure.StartDate = startDate
	closure.EndDate = time.Now()
	closure.CreditsIssued = []models.Sale{}

	// Agrupar fiados por cliente para el resumen
	creditsIssuedMap := make(map[string]models.Sale)
	for _, sale := range sales {
		if !sale.SaleDate.Before(startDate) {
			closure.SalesCount++
			netCashInSale := sale.CashAmount - sale.Change
			if netCashInSale < 0 { netCashInSale = 0 }
			cleanTransfer := sale.TransferAmount
			if cleanTransfer < 0 { cleanTransfer = 0 }
			cleanCredit := sale.CreditAmount
			if cleanCredit < 0 { cleanCredit = 0 }

			closure.TotalSales += (netCashInSale + cleanTransfer + cleanCredit)
			closure.TotalCash += netCashInSale
			closure.TotalTransfer += cleanTransfer
			closure.TotalCreditIssued += cleanCredit

			if sale.CreditAmount > 0 {
				if existing, ok := creditsIssuedMap[sale.ClientDNI]; ok {
					existing.CreditAmount += sale.CreditAmount
					existing.TotalAmount += sale.TotalAmount
					creditsIssuedMap[sale.ClientDNI] = existing
				} else {
					creditsIssuedMap[sale.ClientDNI] = sale
				}
			}

			if sale.TransferAmount > 0 {
				switch strings.ToUpper(sale.TransferSource) {
				case "NEQUI": closure.TotalNequi += sale.TransferAmount
				case "DAVIPLATA": closure.TotalDaviplata += sale.TransferAmount
				case "BANCOLOMBIA": closure.TotalBancolombia += sale.TransferAmount
				case "TARJETA": closure.TotalCard += sale.TransferAmount
				default: closure.TotalOtherTransfer += sale.TransferAmount
				}
			}
		}
	}

	for _, s := range creditsIssuedMap {
		closure.CreditsIssued = append(closure.CreditsIssued, s)
	}

	clientPaymentsMap := make(map[string]models.CreditPayment)
	for _, p := range payments {
		closure.TotalCash += p.AmountCash
		closure.TotalTransfer += p.AmountTransfer
		closure.TotalCreditCollected += p.TotalPaid

		if existing, ok := clientPaymentsMap[p.ClientDNI]; ok {
			existing.TotalPaid += p.TotalPaid
			existing.AmountCash += p.AmountCash
			existing.AmountTransfer += p.AmountTransfer
			clientPaymentsMap[p.ClientDNI] = existing
		} else {
			clientPaymentsMap[p.ClientDNI] = p
		}

		if p.AmountTransfer > 0 {
			switch strings.ToUpper(p.TransferSource) {
			case "NEQUI": closure.TotalNequi += p.AmountTransfer
			case "DAVIPLATA": closure.TotalDaviplata += p.AmountTransfer
			case "BANCOLOMBIA": closure.TotalBancolombia += p.AmountTransfer
			case "TARJETA": closure.TotalCard += p.AmountTransfer
			default: closure.TotalOtherTransfer += p.AmountTransfer
			}
		}
	}

	closure.CreditPayments = []models.CreditPayment{}
	for _, cp := range clientPaymentsMap {
		closure.CreditPayments = append(closure.CreditPayments, cp)
	}

	for _, ret := range returns {
		if !ret.Date.Before(startDate) {
			closure.TotalReturns += ret.TotalReturned
			for _, detail := range ret.Details {
				closure.ReturnsCount += detail.Quantity
			}
		}
	}

	for _, expense := range expenses {
		if !expense.Date.Before(startDate) {
			if strings.ToUpper(expense.Status) != "PENDING" {
				closure.TotalExpenses += expense.Amount
			}
			closure.Expenses = append(closure.Expenses, expense)
		}
	}

	closure.NetBalance = (closure.TotalSales - closure.TotalCreditIssued) + closure.TotalCreditCollected - closure.TotalReturns - closure.TotalExpenses
	return &closure, nil
}

func (s *DashboardService) SaveClosure(closureDTO *models.CashierClosure) error {
	// 0. Serializar gastos detallados si existen
	if len(closureDTO.Expenses) > 0 {
		expensesJSON, _ := json.Marshal(closureDTO.Expenses)
		closureDTO.ExpensesDetail = string(expensesJSON)
	}

	// 1. Save the history closure
	err := s.closureRepo.Save(closureDTO)
	if err != nil {
		return err
	}

	// 2. Close the active shift
	_ = s.shiftRepo.CloseActive()

	// 3. Automatically open a new shift
	newShift := &models.ActiveShift{
		StartTime:   time.Now(),
		OpeningCash: 0,
		CashierDNI:  closureDTO.ClosedByDNI,
		CashierName: closureDTO.ClosedByName,
		Status:      "OPEN",
	}
	return s.shiftRepo.Save(newShift)
}

func (s *DashboardService) GetClosuresHistory() ([]models.CashierClosure, error) {
	return s.closureRepo.GetAll()
}

func (s *DashboardService) GetRankingReport(from, to string) ([]ports.ProductRankingItem, error) {
	sales, err := s.saleRepo.GetByDateRange(from, to)
	if err != nil {
		return nil, err
	}

	rankingMap := make(map[string]*ports.ProductRankingItem)
	for _, sale := range sales {
		for _, detail := range sale.SaleDetails {
			if _, ok := rankingMap[detail.Barcode]; !ok {
				name := detail.Barcode
				if detail.Product.ProductName != "" {
					name = detail.Product.ProductName
				}
				rankingMap[detail.Barcode] = &ports.ProductRankingItem{
					Barcode: detail.Barcode,
					Name:    name,
				}
			}
			rankingMap[detail.Barcode].Quantity += detail.Quantity
			rankingMap[detail.Barcode].Total += detail.Subtotal
		}
	}

	ranking := []ports.ProductRankingItem{}
	for _, item := range rankingMap {
		ranking = append(ranking, *item)
	}

	sort.Slice(ranking, func(i, j int) bool {
		return ranking[i].Quantity > ranking[j].Quantity
	})

	return ranking, nil
}

func (s *DashboardService) GetCategoryReport(from, to string) ([]CategoryReportItem, error) {
	sales, err := s.saleRepo.GetByDateRange(from, to)
	if err != nil {
		return nil, err
	}

	categoryMap := make(map[string]*CategoryReportItem)
	for _, sale := range sales {
		for _, detail := range sale.SaleDetails {
			catName := detail.Product.Category.Name
			if catName == "" {
				catName = "SIN CATEGORÍA"
			}
			if _, ok := categoryMap[catName]; !ok {
				categoryMap[catName] = &CategoryReportItem{
					Category: catName,
				}
			}
			categoryMap[catName].Quantity += detail.Quantity
			categoryMap[catName].Total += detail.Subtotal
		}
	}

	report := []CategoryReportItem{}
	for _, item := range categoryMap {
		report = append(report, *item)
	}

	return report, nil
}

func (s *DashboardService) GetVIPClientsReport(from, to string) ([]VIPClientItem, error) {
	sales, err := s.saleRepo.GetByDateRange(from, to)
	if err != nil {
		return nil, err
	}

	clientMap := make(map[string]*VIPClientItem)
	for _, sale := range sales {
		if sale.ClientDNI == "" {
			continue
		}
		if _, ok := clientMap[sale.ClientDNI]; !ok {
			name := "Cliente " + sale.ClientDNI
			if sale.Client.Name != "" {
				name = sale.Client.Name
			}
			clientMap[sale.ClientDNI] = &VIPClientItem{
				DNI:  sale.ClientDNI,
				Name: name,
			}
		}
		clientMap[sale.ClientDNI].Total += sale.TotalAmount
		clientMap[sale.ClientDNI].Count++
	}

	report := []VIPClientItem{}
	for _, item := range clientMap {
		report = append(report, *item)
	}

	sort.Slice(report, func(i, j int) bool {
		return report[i].Total > report[j].Total
	})

	return report, nil
}

func (s *DashboardService) GetVoidsReport(from, to string) ([]VoidReportItem, error) {
	returns, err := s.returnRepo.GetByDateRange(from, to)
	if err != nil {
		return nil, err
	}

	deletedSales, err := s.saleRepo.GetDeletedByDateRange(from, to)
	if err != nil {
		return nil, err
	}

	report := []VoidReportItem{}

	// Add returns
	for _, r := range returns {
		report = append(report, VoidReportItem{
			SaleID:   r.SaleID,
			Date:     r.Date, // Effective return date
			Total:    r.TotalReturned,
			Employee: r.EmployeeDNI,
			VoidedAt: r.Date,
		})
	}

	// Add deleted sales
	for _, ds := range deletedSales {
		report = append(report, VoidReportItem{
			SaleID:   ds.SaleID,
			Date:     ds.SaleDate,
			Total:    ds.TotalAmount,
			Employee: ds.EmployeeDNI,
			VoidedAt: ds.DeletedAt.Time,
		})
	}

	// Sort by voidedAt descending
	sort.Slice(report, func(i, j int) bool {
		return report[i].VoidedAt.After(report[j].VoidedAt)
	})

	return report, nil
}

func (s *DashboardService) GetPnLReport(from, to string) (*PnLReport, error) {
	start, _ := time.Parse("2006-01-02", from)
	end, _ := time.Parse("2006-01-02", to)
	endQuery := end.AddDate(0, 0, 1)

	g, _ := errgroup.WithContext(context.Background())

	var sales []models.Sale
	var expenses []models.Expense
	var payments []models.CreditPayment

	g.Go(func() error {
		var err error
		sales, err = s.saleRepo.GetByDateRange(from, to)
		return err
	})
	g.Go(func() error {
		var err error
		expenses, err = s.expenseRepo.GetByDateRange(from, to)
		return err
	})
	g.Go(func() error {
		var err error
		payments, err = s.creditRepo.GetByDateRange(start, endQuery)
		return err
	})

	if err := g.Wait(); err != nil {
		return nil, err
	}

	var revenue float64
	var cogs float64
	for _, sale := range sales {
		revenue += sale.TotalAmount
		for _, detail := range sale.SaleDetails {
			cost := detail.CostPrice
			if cost == 0 { cost = detail.Product.PurchasePrice }
			cogs += detail.Quantity * cost
		}
	}

	var totalExpenses float64
	for _, e := range expenses {
		totalExpenses += e.Amount
	}

	for _, p := range payments {
		revenue += p.TotalPaid
	}

	grossProfit := revenue - cogs
	netProfit := grossProfit - totalExpenses
	margin := 0.0
	if revenue > 0 { margin = (netProfit / revenue) * 100 }

	return &PnLReport{
		From: from, To: to, TotalRevenue: revenue, TotalCOGS: cogs,
		GrossProfit: grossProfit, TotalExpenses: totalExpenses,
		NetProfit: netProfit, MarginPercentage: margin,
	}, nil
}

type VaultAuditReport struct {
	Date          time.Time `json:"date"`
	SystemCash    float64   `json:"systemCash"`
	ReportedCash  float64   `json:"reportedCash"`
	Difference    float64   `json:"difference"`
	VaultFund     float64   `json:"vaultFund"`
	TotalPhysical float64   `json:"totalPhysical"`
}

func (s *DashboardService) GetVaultAudit() (*VaultAuditReport, error) {
	// 1. Obtener datos de cajas en piso
	// Priorizamos el turno activo para auditoría en tiempo real
	activeShift, _ := s.shiftRepo.GetActive()
	var systemCash, reportedCash float64

	if activeShift != nil {
		closure, _ := s.GetCashierClosure()
		systemCash = closure.TotalCash - closure.TotalExpenses
		reportedCash = 0 // Aún no reportado físicamente
	} else {
		// Si no hay turno, usamos el último cierre histórico
		lastClosure, _ := s.closureRepo.GetLast()
		if lastClosure != nil {
			systemCash = lastClosure.TotalCash - lastClosure.TotalExpenses
			reportedCash = lastClosure.PhysicalCash
		}
	}

	// 2. Fondo de Bóveda (Fijo por ahora, o configurable en el futuro)
	// Valor base de la caja fuerte según requerimiento
	vaultFund := 2500000.0

	return &VaultAuditReport{
		Date:          time.Now(),
		SystemCash:    systemCash,
		ReportedCash:  reportedCash,
		Difference:    reportedCash - systemCash,
		VaultFund:     vaultFund,
		TotalPhysical: reportedCash + vaultFund,
	}, nil
}

func (s *DashboardService) GetGlobalDebt() (float64, error) {
	clients, err := s.clientRepo.GetAll()
	if err != nil {
		return 0, err
	}
	totalDebt := 0.0
	for _, c := range clients {
		totalDebt += c.CurrentCredit
	}
	return totalDebt, nil
}

func (s *DashboardService) GetInventoryMovementsReport(from, to string) ([]StockMovementReportItem, error) {
	movements, err := s.movementRepo.GetByDateRange(from, to)
	if err != nil {
		return nil, err
	}

	report := []StockMovementReportItem{}
	for _, m := range movements {
		name := m.Product.ProductName
		if name == "" {
			name = m.Barcode
		}
		report = append(report, StockMovementReportItem{
			Date:     m.Date,
			Barcode:  m.Barcode,
			Name:     name,
			Quantity: m.Quantity,
			Type:     m.Type,
			Reason:   m.Reason,
			Employee: m.EmployeeName,
			Ref:      m.ReferenceID,
		})
	}

	return report, nil
}
