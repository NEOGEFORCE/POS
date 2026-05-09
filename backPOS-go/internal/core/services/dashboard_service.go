package services

import (
	"context"
	"encoding/json"
	"fmt"
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
	reportRepo   ports.ReportRepository
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
	rr ports.ReportRepository,
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
		reportRepo:   rr,
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
	TotalReports        int64                    `json:"totalReports"`
	// V5 fields
	TodaySalesAmount      float64                    `json:"todaySalesAmount"`
	TodaySalesByMethod    map[string]float64         `json:"todaySalesByMethod"`
	TodaySalesCount       int64                      `json:"todaySalesCount"`
	ShiftSalesAmount      float64                    `json:"shiftSalesAmount"`
	ShiftSalesCount       int64                      `json:"shiftSalesCount"`
	ShiftSalesByMethod    map[string]float64         `json:"shiftSalesByMethod"`
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
	TodayCashFlow CashFlowSummary `json:"todayCashFlow"`
	// Financial Reconciliation V5.5
	SystemBalance      float64 `json:"systemBalance"`
	ReportedBalance    float64 `json:"reportedBalance"`
	GlobalDifference   float64 `json:"globalDifference"`
	TotalExpensesPaid    float64 `json:"totalExpensesPaid"`
	TotalCashExpensesPaid float64 `json:"totalCashExpensesPaid"`
	EstimatedNetProfit   float64 `json:"estimatedNetProfit"`
	InventoryCostValue   float64 `json:"inventoryCostValue"`
	InventoryRetailValue float64 `json:"inventoryRetailValue"`
	TodayNetProfit       float64 `json:"todayNetProfit"`
	// Vault/Fondo V9.5
	VaultBalance         float64 `json:"vaultBalance"`
	VaultExpenses        float64 `json:"vaultExpenses"`
	Coins100             float64 `json:"coins100"`
	Coins200             float64 `json:"coins200"`
	Coins500             float64 `json:"coins500"`
	Coins1000            float64 `json:"coins1000"`
	GlobalHistoricalExpected float64 `json:"globalHistoricalExpected"`
	GlobalHistoricalReal     float64 `json:"globalHistoricalReal"`
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
	now := time.Now().UTC()
	// 0. Determinar Rango del Turno Actual (Para Cierre y Caja)
	activeShift, _ := s.shiftRepo.GetActive()
	var shiftStartDate time.Time
	var lastClosure *models.CashierClosure
	var globalReportedByMethod map[string]float64
	var globalHistoricalExpected, globalHistoricalReal float64

	// Usar la zona horaria local (Colombia) para determinar los límites del día
	loc := time.FixedZone("America/Bogota", -5*60*60)
	nowLocal := time.Now().In(loc)

	if activeShift != nil {
		shiftStartDate = activeShift.StartTime
	} else {
		lastClosure, _ = s.closureRepo.GetLast()
		if lastClosure != nil {
			shiftStartDate = lastClosure.EndDate
		} else {
			// Si no hay cierre previo, empezar desde la medianoche LOCAL
			shiftStartDate = time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 0, 0, 0, 0, loc)
		}
	}

	// Si shiftStartDate es Nil (por error en GetLast), fallback a hoy medianoche local
	if shiftStartDate.IsZero() {
		shiftStartDate = time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 0, 0, 0, 0, loc)
	}
	shiftStartStr := shiftStartDate.Format("2006-01-02 15:04:05")

	// Si no había activeShift, intentar obtener el lastClosure de nuevo si falló antes para los cálculos de bóveda
	if lastClosure == nil && activeShift == nil {
		lastClosure, _ = s.closureRepo.GetLast()
	}

	// 0.1 Determinar Inicio del Día Calendario (Medianoche Local)
	dayStart := time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 0, 0, 0, 0, loc)
	dayStartStr := dayStart.Format("2006-01-02 15:04:05")

	nowStr := time.Now().Format("2006-01-02 15:04:05")
	tomorrowStr := now.AddDate(0, 0, 1).Format("2006-01-02")

	sevenDaysAgoStr := now.AddDate(0, 0, -7).Format("2006-01-02")
	// CORRECCIÓN: calcular dinámicamente el inicio del mes actual
	currentMonthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	nextMonthStart := currentMonthStart.AddDate(0, 1, 0)
	currentMonthStr := currentMonthStart.Format("2006-01-02")
	nextMonthStr := nextMonthStart.Format("2006-01-02")

	g, _ := errgroup.WithContext(context.Background())

	g.Go(func() error {
		lastClosure, _ = s.closureRepo.GetLast()
		return nil
	})
	g.Go(func() error {
		globalReportedByMethod, _ = s.closureRepo.GetGlobalReportedBalanceByMethod()
		return nil
	})
	g.Go(func() error {
		globalHistoricalExpected, globalHistoricalReal, _ = s.closureRepo.GetGlobalHistoricalSum()
		return nil
	})

	var totalSalesAmount, totalProductsSold, totalExpensesAmount, monthlyCollectedDebts float64
	var mvStats *ports.MVMonthlyStats
	var mvTrend []ports.MVMonthlyStats
	currentMonthKey := now.Format("2006-01")

	var todayExpensesRaw []models.Expense
	var todayPaymentsRaw []models.CreditPayment
	var todaySalesAmount, shiftSalesAmount float64
	var todaySalesCount, shiftSalesCount int64
	var todayExpensesCount int64
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
	var globalExpenses float64
	var shiftClosure *CashierClosure
	var inventoryCostValue, inventoryRetailValue float64
	var shiftExpensesCount int64
	var shiftExpensesAmount float64
	var todayExpenses float64
	var todayReturns, globalReturns float64
	var globalSalesByMethod, globalCollectedByMethod, globalPaidByMethod map[string]float64
	var dayExpensesRaw []models.Expense
	var dayPaymentsRaw []models.CreditPayment
	var globalCoins map[string]float64

	// 1. Get Materialized View Stats (Instant)
	g.Go(func() error {
		var err error
		log.Printf("📊 [Dashboard] Iniciando GetMonthlyStatsFromMV (%s)", currentMonthKey)
		mvStats, err = s.saleRepo.GetMonthlyStatsFromMV(currentMonthKey)
		if err != nil {
			log.Printf("❌ [Dashboard] Error en GetMonthlyStatsFromMV: %v", err)
		}
		return nil // No romper dashboard por la MV
	})
	g.Go(func() error {
		log.Printf("📊 [Dashboard] Iniciando GetPendingDebtsSummary")
		amount, count, err := s.expenseRepo.GetPendingDebtsSummary()
		if err != nil {
			log.Printf("❌ [Dashboard] Error en GetPendingDebtsSummary: %v", err)
		} else {
			pendingDebtsAmount = amount
			pendingDebtsCount = count
		}
		pendingDebtsList, _ = s.expenseRepo.GetExpensesByStatus("PENDING")
		return nil
	})
	g.Go(func() error {
		log.Printf("📊 [Dashboard] Iniciando GetMonthlyStatsTrendFromMV")
		var err error
		mvTrend, err = s.saleRepo.GetMonthlyStatsTrendFromMV()
		if err != nil {
			log.Printf("❌ [Dashboard] Error en GetMonthlyStatsTrendFromMV: %v", err)
		}
		return nil
	})

	// 2. Optimized Real-time Queries (Only Today or small sets)
	g.Go(func() error {
		log.Printf("📊 [Dashboard] Iniciando GetByDateRange (Expenses Shift) desde %s", shiftStartStr)
		var err error
		todayExpensesRaw, err = s.expenseRepo.GetByDateRange(shiftStartStr, nowStr)
		if err != nil { log.Printf("❌ [Dashboard] Error Expenses Shift: %v", err) }
		return nil
	})
	g.Go(func() error {
		log.Printf("📊 [Dashboard] Iniciando GetByDateRange (Expenses Day) desde %s", dayStartStr)
		var err error
		dayExpensesRaw, err = s.expenseRepo.GetByDateRange(dayStartStr, nowStr)
		if err != nil { log.Printf("❌ [Dashboard] Error Expenses Day: %v", err) }
		return nil
	})
	g.Go(func() error {
		log.Printf("📊 [Dashboard] Iniciando GetByDateRange (Payments Shift) desde %v", shiftStartDate)
		var err error
		todayPaymentsRaw, err = s.creditRepo.GetByDateRange(shiftStartDate, now)
		if err != nil { log.Printf("❌ [Dashboard] Error Payments Shift: %v", err) }
		return nil
	})
	g.Go(func() error {
		log.Printf("📊 [Dashboard] Iniciando GetByDateRange (Payments Day) desde %v", dayStart)
		var err error
		dayPaymentsRaw, err = s.creditRepo.GetByDateRange(dayStart, now)
		if err != nil { log.Printf("❌ [Dashboard] Error Payments Day: %v", err) }
		return nil
	})
	g.Go(func() error {
		log.Printf("📊 [Dashboard] Iniciando GetDashboardStats (Day) desde %s", dayStartStr)
		var err error
		todaySalesAmount, todaySalesCount, _, err = s.saleRepo.GetDashboardStats(dayStartStr, nowStr)
		if err != nil { log.Printf("❌ [Dashboard] Error Stats (Day): %v", err) }
		return nil
	})
	g.Go(func() error {
		log.Printf("📊 [Dashboard] Iniciando GetDashboardStats (Shift) desde %s", shiftStartStr)
		var err error
		shiftSalesAmount, shiftSalesCount, _, err = s.saleRepo.GetDashboardStats(shiftStartStr, nowStr)
		if err != nil { log.Printf("❌ [Dashboard] Error Stats (Shift): %v", err) }
		return nil
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
		if err != nil { log.Printf("❌ [Dashboard] Error LowStock: %v", err) }
		return nil
	})
	g.Go(func() error {
		var err error
		salesFilter := ports.SaleFilter{Page: 1, PageSize: 20, From: currentMonthStr, To: nextMonthStr}
		recentSalesRaw, _, err = s.saleRepo.FindAll(salesFilter)
		if err != nil { log.Printf("❌ [Dashboard] Error RecentSales: %v", err) }
		return nil
	})
	g.Go(func() error {
		var err error
		dailySalesMap, err = s.saleRepo.GetDailySalesByRange(sevenDaysAgoStr, tomorrowStr)
		return err
	})
	g.Go(func() error {
		var err error
		dailyCollectedMap, err = s.creditRepo.GetDailyCollectedByRange(sevenDaysAgoStr, tomorrowStr)
		if err != nil { log.Printf("❌ [Dashboard] Error DailyCollected: %v", err) }
		return nil
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
		log.Printf("📊 [Dashboard] Iniciando GetSalesBreakdown (Day) desde %s", dayStartStr)
		todaySalesByPayment, err = s.saleRepo.GetSalesBreakdownByRange(dayStartStr, nowStr)
		if err != nil { log.Printf("❌ [Dashboard] Error SalesByPayment (Day): %v", err) }
		return nil
	})
	g.Go(func() error {
		var err error
		log.Printf("📊 [Dashboard] Sincronizando Shift desde GetCashierClosure")
		shiftClosure, err = s.GetCashierClosure()
		if err != nil { log.Printf("❌ [Dashboard] Error GetCashierClosure: %v", err) }
		return nil
	})
	g.Go(func() error {
		var err error
		pendingDebtsAmount, pendingDebtsCount, err = s.expenseRepo.GetPendingDebtsSummary()
		if err != nil { log.Printf("❌ [Dashboard] Error PendingDebts: %v", err) }
		return nil
	})
	// Global Reconciliation Queries
	g.Go(func() error {
		log.Printf("📊 [Dashboard] Iniciando GetGlobalTotalPaidExpenses")
		var err error
		globalExpenses, err = s.expenseRepo.GetGlobalTotalPaidExpenses()
		if err != nil { log.Printf("❌ [Dashboard] Error GlobalExpenses: %v", err) }
		return nil
	})
	g.Go(func() error {
		log.Printf("📊 [Dashboard] Iniciando GetGlobalCoins")
		var err error
		globalCoins, err = s.closureRepo.GetGlobalCoins()
		if err != nil { log.Printf("❌ [Dashboard] Error GlobalCoins: %v", err) }
		return nil
	})
	// Financial Stats V5.5
	g.Go(func() error {
		var err error
		inventoryCostValue, err = s.productRepo.GetGlobalInventoryValue()
		if err != nil { log.Printf("❌ [Dashboard] Error InventoryCost: %v", err) }
		return nil
	})
	g.Go(func() error {
		var err error
		inventoryRetailValue, err = s.productRepo.GetGlobalInventoryRetailValue()
		if err != nil { log.Printf("❌ [Dashboard] Error InventoryRetail: %v", err) }
		return nil
	})
	// Breakdown Reconciliation Queries
	g.Go(func() error {
		var err error
		globalSalesByMethod, err = s.saleRepo.GetGlobalSalesByMethod()
		if err != nil { log.Printf("❌ [Dashboard] Error GlobalSalesByMethod: %v", err) }
		return nil
	})
	g.Go(func() error {
		var err error
		globalCollectedByMethod, err = s.saleRepo.GetGlobalCollectedDebtsByMethod()
		if err != nil { log.Printf("❌ [Dashboard] Error GlobalCollectedByMethod: %v", err) }
		return nil
	})
	g.Go(func() error {
		var err error
		globalPaidByMethod, err = s.expenseRepo.GetGlobalPaidExpensesByMethod()
		if err != nil { log.Printf("❌ [Dashboard] Error GlobalPaidByMethod: %v", err) }
		return nil
	})
	// Today Profit Components
	g.Go(func() error {
		var err error
		todayExpenses, err = s.expenseRepo.GetPaidAmountByRange(shiftStartStr, nowStr)
		if err != nil { log.Printf("❌ [Dashboard] Error TodayExpenses (Shift): %v", err) }
		return nil
	})
	g.Go(func() error {
		var err error
		todayReturns, err = s.returnRepo.GetTotalReturnedByRange(shiftStartStr, nowStr)
		if err != nil { log.Printf("❌ [Dashboard] Error TodayReturns (Shift): %v", err) }
		return nil
	})
	g.Go(func() error {
		var err error
		globalReturns, err = s.returnRepo.GetTotalReturnedByRange("", "")
		if err != nil { log.Printf("❌ [Dashboard] Error GlobalReturns: %v", err) }
		return nil
	})
	var shiftFundExpenses float64
	g.Go(func() error {
		expenses, err := s.expenseRepo.GetGlobalPaidExpensesByMethodInRange(shiftStartStr, nowStr)
		if err == nil {
			shiftFundExpenses = expenses["FONDO"]
		}
		return nil
	})
	// Financial Stats V5.5

	// Wait for all to finish, ignoring errors since we handle them inside
	_ = g.Wait()

	// 2. UTILIDAD Y COGS (COSTE DE VENTAS) - V8.7 Lógica Estricta de Transacciones
	var totalCOGS, monthlyExpenses float64
	if mvStats != nil {
		totalSalesAmount = mvStats.TotalSales
		totalCOGS = mvStats.TotalCOGS
		monthlyExpenses = mvStats.TotalExpenses
		totalProductsSold = mvStats.ProductsSold
		monthlyCollectedDebts = mvStats.TotalAbonos
	} else {
		// Fallback si la MV no está lista
		totalSalesAmount, _ = s.saleRepo.GetGlobalTotalSales() // Solo status='PAID'
		totalCOGS, _ = s.saleRepo.GetGlobalCOGS()
		monthlyExpenses, _ = s.expenseRepo.GetGlobalTotalPaidExpenses() // Mejor que nada
		totalProductsSold = 0 // Simplificado si no hay MV
	}

	estimatedNetProfit := (totalSalesAmount - totalCOGS) - monthlyExpenses
	todayExpensesByMethod := make(map[string]float64)
	for _, e := range todayExpensesRaw {
		status := strings.ToUpper(e.Status)
		source := strings.ToUpper(e.PaymentSource)
		isPending := status == "PENDING" || source == "PRESTAMO" || source == "PREST."

		if !isPending && status == "PAID" {
			// todayExpenses ya viene de la query anterior, aquí solo contamos y desglosamos
			todayExpensesCount++
			method := strings.ToUpper(e.PaymentSource)
			todayExpensesByMethod[method] += (e.Amount + e.TaxAmount)
		}
	}

	dayExpensesByMethod := make(map[string]float64)
	for _, e := range dayExpensesRaw {
		status := strings.ToUpper(e.Status)
		source := strings.ToUpper(e.PaymentSource)
		isPending := status == "PENDING" || source == "PRESTAMO" || source == "PREST."
		if !isPending && status == "PAID" {
			method := strings.ToUpper(e.PaymentSource)
			dayExpensesByMethod[method] += (e.Amount + e.TaxAmount)
		}
	}

	// Categorize Abonos (Collected Debts) by Payment Method
	todayCollectedByMethod := make(map[string]float64)
	todayCollectedDebts := 0.0
	for _, p := range todayPaymentsRaw {
		todayCollectedDebts += p.TotalPaid
		if p.AmountCash > 0 {
			todayCollectedByMethod["EFECTIVO"] += p.AmountCash
		}
		if p.AmountTransfer > 0 {
			method := strings.ToUpper(p.TransferSource)
			if method == "" { method = "NEQUI" }
			todayCollectedByMethod[method] += p.AmountTransfer
		}
	}

	dayCollectedByMethod := make(map[string]float64)
	for _, p := range dayPaymentsRaw {
		if p.AmountCash > 0 {
			dayCollectedByMethod["EFECTIVO"] += p.AmountCash
		}
		if p.AmountTransfer > 0 {
			method := strings.ToUpper(p.TransferSource)
			if method == "" { method = "NEQUI" }
			dayCollectedByMethod[method] += p.AmountTransfer
		}
	}

	// Normalize Sales by Payment Method keys
	normalizedSales := make(map[string]float64)
	for k, v := range todaySalesByPayment {
		normalizedSales[strings.ToUpper(k)] = v
	}

	normalizedShiftSales := make(map[string]float64)
	if shiftClosure != nil {
		normalizedShiftSales["EFECTIVO"] = shiftClosure.TotalCash
		normalizedShiftSales["NEQUI"] = shiftClosure.TotalNequi
		normalizedShiftSales["DAVIPLATA"] = shiftClosure.TotalDaviplata
		normalizedShiftSales["FIADO"] = shiftClosure.TotalCreditIssued
		normalizedShiftSales["TRANSFERENCIA"] = shiftClosure.TotalTransfer
		normalizedShiftSales["MIXTO"] = shiftClosure.TotalMixed
		
		shiftSalesAmount = shiftClosure.TotalSales
		shiftExpensesCount = int64(len(shiftClosure.Expenses))
		shiftExpensesAmount = shiftClosure.TotalExpenses
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
	// Reconciliación Global
	var globalSalesTotal, globalCollected float64
	for _, v := range globalSalesByMethod { globalSalesTotal += v }
	for _, v := range globalCollectedByMethod { globalCollected += v }

	// Reconstruir salesByPayment desde MVStats (Mes Actual)
	salesByPayment = make(map[string]float64)
	if mvStats != nil {
		salesByPayment["EFECTIVO"] = mvStats.SalesCash
		salesByPayment["TRANSFERENCIA"] = mvStats.SalesTransfer
		salesByPayment["FIADO"] = mvStats.SalesCredit
	} else {
		salesByPayment["EFECTIVO"] = 0
		salesByPayment["TRANSFERENCIA"] = 0
		salesByPayment["FIADO"] = 0
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
			"id": sale.SaleID, 
			"total": sale.TotalAmount, 
			"date": sale.SaleDate.Format(time.RFC3339), 
			"client": clientName, 
			"payment_method": sale.PaymentMethod,
			"transfer_source": sale.TransferSource,
			"cash_amount": sale.CashAmount,
			"transfer_amount": sale.TransferAmount,
			"credit_amount": sale.CreditAmount,
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

	totalReports, _ := s.reportRepo.Count()

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
		TotalReports:          totalReports,
		TodaySalesAmount:      todaySalesAmount,
		TodaySalesByMethod:    normalizedSales,
		TodaySalesCount:       todaySalesCount,
		ShiftSalesAmount:      shiftSalesAmount,
		ShiftSalesCount:       shiftSalesCount,
		ShiftSalesByMethod:    normalizedShiftSales,
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
			Cash:      globalSalesByMethod["EFECTIVO"] + globalCollectedByMethod["EFECTIVO"] - globalPaidByMethod["EFECTIVO"] - globalReturns,
			Nequi:     globalSalesByMethod["NEQUI"] + globalCollectedByMethod["NEQUI"] - globalPaidByMethod["NEQUI"],
			Daviplata: globalSalesByMethod["DAVIPLATA"] + globalCollectedByMethod["DAVIPLATA"] - globalPaidByMethod["DAVIPLATA"],
		},
		PendingDebts: DebtSummary{
			Amount: pendingDebtsAmount,
			Count:  int(pendingDebtsCount),
			Items:  pendingDebtsList,
		},
		TodayExpenses: ExpenseSummary{
			Amount: shiftExpensesAmount,
			Count:  int(shiftExpensesCount),
		},
		TodayCashFlow: CashFlowSummary{
			Cash:      normalizedSales["EFECTIVO"] + dayCollectedByMethod["EFECTIVO"] - dayExpensesByMethod["EFECTIVO"] - todayReturns,
			Nequi:     normalizedSales["NEQUI"] + dayCollectedByMethod["NEQUI"] - dayExpensesByMethod["NEQUI"],
			Daviplata: normalizedSales["DAVIPLATA"] + dayCollectedByMethod["DAVIPLATA"] - dayExpensesByMethod["DAVIPLATA"],
		},
		// CÁLCULO DE SALDOS V6.5 (Reconciliación Histórica Absoluta)
		// VaultBalance (Dinero Real): Suma de reportes de cierre - Gastos de Fondo
		VaultBalance:     globalReportedByMethod["EFECTIVO"] - globalPaidByMethod["FONDO"],
		
		// SystemBalance (Dinero Teórico): Ventas Totales + Abonos Totales - Gastos Totales (Caja + Fondo)
		SystemBalance:    (globalSalesByMethod["EFECTIVO"] + globalCollectedByMethod["EFECTIVO"]) - (globalPaidByMethod["EFECTIVO"] + globalPaidByMethod["FONDO"]),
		
		// Diferencia Global: Efectivo Real Acumulado - Saldo Esperado Total
		GlobalDifference: (globalHistoricalReal - globalPaidByMethod["FONDO"]) - (globalHistoricalExpected - globalPaidByMethod["FONDO"]),
		
		ReportedBalance:  globalReportedByMethod["EFECTIVO"] - globalPaidByMethod["FONDO"],
		
		VaultExpenses:    shiftFundExpenses,
		TotalExpensesPaid:    globalExpenses,
		TotalCashExpensesPaid: globalPaidByMethod["EFECTIVO"],
		GlobalHistoricalExpected: globalHistoricalExpected - globalPaidByMethod["FONDO"],
		GlobalHistoricalReal:     globalHistoricalReal - globalPaidByMethod["FONDO"],
		
		EstimatedNetProfit:   estimatedNetProfit,
		InventoryCostValue:   inventoryCostValue,
		InventoryRetailValue: inventoryRetailValue,
		TodayNetProfit:       (todaySalesAmount - (func() float64 { if totalSalesAmount > 0 { return (totalCOGS / totalSalesAmount) * todaySalesAmount }; return 0 }())) - (todayExpenses - todayExpensesByMethod["FONDO"]),
		Coins100:             globalCoins["100"],
		Coins200:             globalCoins["200"],
		Coins500:             globalCoins["500"],
		Coins1000:            globalCoins["1000"],
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

func (s *DashboardService) AdjustInitialBalance(cash, nequi, daviplata float64, employeeName string, employeeDNI string) error {
	// 1. Obtener totales actuales por método
	globalSalesByMethod, _ := s.saleRepo.GetGlobalSalesByMethod()
	globalCollectedByMethod, _ := s.saleRepo.GetGlobalCollectedDebtsByMethod()
	globalPaidByMethod, _ := s.expenseRepo.GetGlobalPaidExpensesByMethod()
	globalReportedByMethod, _ := s.closureRepo.GetGlobalReportedBalanceByMethod()

	adjustMethod := func(method string, target float64) {
		currentSystem := globalSalesByMethod[method] + globalCollectedByMethod[method] - globalPaidByMethod[method]
		if currentSystem < 0 { currentSystem = 0 }
		
		saleAdjustment := target - currentSystem
		if saleAdjustment != 0 {
			adjSale := &models.Sale{
				TotalAmount:   saleAdjustment,
				CashAmount:    0,
				PaymentMethod: method,
				SaleDate:      time.Now(),
				EmployeeDNI:   "SYSTEM",
				ClientDNI:     "S.N.", // Marcar como ajuste de sistema
			}
			if method == "EFECTIVO" { adjSale.CashAmount = saleAdjustment }
			_ = s.saleRepo.Create(adjSale)
		}

		currentReported := globalReportedByMethod[method]
		closureAdjustment := target - currentReported
		if closureAdjustment != 0 {
			adjClosure := &models.CashierClosure{
				Date:          time.Now(),
				StartDate:     time.Now(),
				EndDate:       time.Now(),
				ClosedByDNI:   employeeDNI,
				ClosedByName:  employeeName,
				AuthorizedBy:  "SYSTEM_RESET",
				ExpensesDetail: fmt.Sprintf("AJUSTE MANUAL %s", method),
			}
			if method == "EFECTIVO" { adjClosure.TotalCashReal = closureAdjustment }
			if method == "NEQUI" { adjClosure.TotalNequiReal = closureAdjustment }
			if method == "DAVIPLATA" { adjClosure.TotalDaviplataReal = closureAdjustment }
			_ = s.closureRepo.Save(adjClosure)
		}
	}

	adjustMethod("EFECTIVO", cash)
	adjustMethod("NEQUI", nequi)
	adjustMethod("DAVIPLATA", daviplata)

	// Invalidar caché
	cache.CacheManager.Delete(cache.CacheKeyDashboardOverview)

	log.Printf("📊 [AdjustInitialBalance] Reseteo multi-método completado. Cash: %f, Nequi: %f, Davi: %f", cash, nequi, daviplata)
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
	TotalMixed           float64                `json:"totalMixed"` // NUEVO: Ventas con múltiples medios
	OpeningCash          float64                `json:"openingCash"`
	NetBalance           float64                `json:"netBalance"`
	ExpectedCash         float64                `json:"expectedCash"` // NUEVO: Saldo esperado en caja
	CashBills            float64                `json:"cashBills"`
	Coins200             float64                `json:"coins200"`
	Coins100             float64                `json:"coins100"`
	Coins500             float64                `json:"coins500"`
	Coins1000            float64                `json:"coins1000"`
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
	
	loc := time.FixedZone("America/Bogota", -5*60*60)
	nowLocal := time.Now().In(loc)
	
	var startDate time.Time
	var lastClosure *models.CashierClosure

	// 1. SIEMPRE buscar el último cierre como base de tiempo
	lastClosure, _ = s.closureRepo.GetLast()
	
	if lastClosure != nil {
		// La continuidad es sagrada: empezamos donde terminó el anterior
		startDate = lastClosure.EndDate
	} else if activeShift != nil {
		// Si no hay cierres pero hay un turno abierto
		startDate = activeShift.StartTime
	} else {
		// Fallback: 24 horas atrás
		startDate = nowLocal.Add(-24 * time.Hour)
	}

	// 2. Determinar el Saldo Inicial
	openingCash := 0.0
	if activeShift != nil {
		// Si el cajero abrió turno manualmente, respetamos el fondo que declaró
		openingCash = activeShift.OpeningCash
	} else if lastClosure != nil {
		// Si no hay turno abierto, asumimos que el fondo es lo que quedó en el último cierre
		openingCash = lastClosure.TotalCashReal
	}

	// 3. Preparar rangos para la base de datos (Usamos el timezone local de la BD)
	startStr := startDate.Format("2006-01-02 15:04:05")
	endStr := time.Now().In(loc).Format("2006-01-02 15:04:05")

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
	loc = time.FixedZone("America/Bogota", -5*60*60)
	closure.Date = time.Now().In(loc)
	closure.StartDate = startDate
	closure.EndDate = time.Now()
	closure.OpeningCash = openingCash
	closure.CreditsIssued = []models.Sale{}

	// Agrupar fiados por cliente para el resumen
	creditsIssuedMap := make(map[string]models.Sale)
	for _, sale := range sales {
		status := strings.ToUpper(sale.Status)
		if (status == "PAID" || status == "CREDIT") {
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

			// Si la venta tiene más de un medio de pago, es MIXTA
			methodsCount := 0
			if netCashInSale > 0 { methodsCount++ }
			if cleanTransfer > 0 { methodsCount++ }
			if cleanCredit > 0 { methodsCount++ }
			if methodsCount > 1 {
				closure.TotalMixed += (netCashInSale + cleanTransfer + cleanCredit)
			}

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
		closure.TotalReturns += ret.TotalReturned
		for _, detail := range ret.Details {
			closure.ReturnsCount += detail.Quantity
		}
	}

	for _, expense := range expenses {
		if strings.ToUpper(expense.Status) != "PENDING" {
			closure.TotalExpenses += (expense.Amount + expense.TaxAmount)
		}
		closure.Expenses = append(closure.Expenses, expense)
	}

	closure.NetBalance = (closure.TotalSales - closure.TotalCreditIssued) + closure.TotalCreditCollected - closure.TotalReturns - closure.TotalExpenses
	
	var cashExpenses float64
	for _, e := range expenses {
		if strings.ToUpper(e.PaymentSource) == "EFECTIVO" && strings.ToUpper(e.Status) != "PENDING" {
			cashExpenses += (e.Amount + e.TaxAmount)
		}
	}

	var cashReturns float64
	for _, ret := range returns {
		if strings.ToUpper(ret.ReturnType) == "REFUND" {
			cashReturns += ret.TotalReturned
		}
	}

	closure.ExpectedCash = closure.OpeningCash + closure.TotalCash - cashExpenses - cashReturns

	return &closure, nil
}

func (s *DashboardService) SaveClosure(closureDTO *models.CashierClosure) error {
	// 0. Persistir egresos nuevos (manuales) en la base de datos
	for i := range closureDTO.Expenses {
		if closureDTO.Expenses[i].ID == 0 {
			// Es un egreso manual del cierre, lo guardamos permanentemente
			if closureDTO.Expenses[i].Date.IsZero() {
				closureDTO.Expenses[i].Date = time.Now()
			}
			closureDTO.Expenses[i].CreatedByDNI = closureDTO.ClosedByDNI
			_ = s.expenseRepo.Save(&closureDTO.Expenses[i])
		}
	}

	// 0.1 Serializar gastos detallados si existen
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

func (s *DashboardService) DeleteClosure(id uint) error {
	// Validar que el cierre existe
	_, err := s.closureRepo.GetByID(id)
	if err != nil {
		return fmt.Errorf("cierre con ID %d no encontrado", id)
	}

	// Eliminar permanentemente
	err = s.closureRepo.Delete(id)
	if err != nil {
		return fmt.Errorf("error al eliminar cierre ID %d: %v", id, err)
	}

	// Invalidar caché del dashboard para que los totales se recalculen
	cache.CacheManager.Delete(cache.CacheKeyDashboardOverview)

	log.Printf("🗑️ [DeleteClosure] Cierre ID #%d eliminado permanentemente del sistema", id)
	return nil
}

func (s *DashboardService) GetRankingReport(from, to string) ([]ports.ProductRankingItem, error) {
	sales, err := s.saleRepo.GetByDateRange(from, to)
	if err != nil {
		return nil, err
	}

	rankingMap := make(map[string]*ports.ProductRankingItem)
	for _, sale := range sales {
		st := strings.ToUpper(sale.Status)
		if st != "PAID" && st != "CREDIT" { continue }
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
		st := strings.ToUpper(sale.Status)
		if st != "PAID" && st != "CREDIT" { continue }
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
		st := strings.ToUpper(sale.Status)
		if st != "PAID" && st != "CREDIT" { continue }
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
		status := strings.ToUpper(sale.Status)
		if status != "PAID" && status != "CREDIT" { continue }
		revenue += sale.TotalAmount
		for _, detail := range sale.SaleDetails {
			cost := detail.CostPrice
			if cost == 0 { cost = detail.Product.PurchasePrice }
			cogs += detail.Quantity * cost
		}
	}

	var totalExpenses float64
	for _, e := range expenses {
		totalExpenses += (e.Amount + e.TaxAmount)
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

type MovementDetail struct {
	Time        time.Time `json:"time"`
	Type        string    `json:"type"` // VENTA, GASTO, ABONO
	Amount      float64   `json:"amount"`
	Method      string    `json:"method"`
	Status      string    `json:"status"`
	Description string    `json:"description"`
}

type DetailedShiftReport struct {
	StartTime time.Time        `json:"startTime"`
	EndTime   time.Time        `json:"endTime"`
	Employee  string           `json:"employee"`
	Movements []MovementDetail `json:"movements"`
	Totals    map[string]float64 `json:"totals"`
}

func (s *DashboardService) GetDetailedShiftReport(employeeDni string) (*DetailedShiftReport, error) {
	activeShift, err := s.shiftRepo.GetActive()
	if err != nil || activeShift == nil {
		return nil, fmt.Errorf("no hay turno activo")
	}

	start := activeShift.StartTime
	now := time.Now()
	startStr := start.Format("2006-01-02 15:04:05")
	nowStr := now.Format("2006-01-02 15:04:05")

	var movements []MovementDetail
	totals := make(map[string]float64)

	// 1. Obtener Ventas
	sales, err := s.saleRepo.GetByDateRange(startStr, nowStr)
	if err == nil {
		for _, sale := range sales {
			method := strings.ToUpper(sale.PaymentMethod)
			movements = append(movements, MovementDetail{
				Time:        sale.SaleDate,
				Type:        "VENTA",
				Amount:      sale.TotalAmount,
				Method:      method,
				Status:      sale.Status,
				Description: fmt.Sprintf("Venta #%d", sale.SaleID),
			})
			if strings.ToUpper(sale.Status) == "PAID" {
				if sale.CashAmount > 0 {
					totals["EFECTIVO"] += sale.CashAmount - sale.Change
				}
				if sale.TransferAmount > 0 {
					source := strings.ToUpper(sale.TransferSource)
					if source == "" {
						source = "TRANSFERENCIA"
					}
					totals[source] += sale.TransferAmount
				}
				if sale.CreditAmount > 0 {
					totals["FIADO"] += sale.CreditAmount
				}
			}
		}
	}

	// 2. Obtener Gastos
	expenses, err := s.expenseRepo.GetByDateRange(startStr, nowStr)
	if err == nil {
		for _, exp := range expenses {
			method := strings.ToUpper(exp.PaymentSource)
			movements = append(movements, MovementDetail{
				Time:        exp.Date,
				Type:        "GASTO",
				Amount:      exp.Amount + exp.TaxAmount,
				Method:      method,
				Status:      exp.Status,
				Description: exp.Description,
			})
			if strings.ToUpper(exp.Status) == "PAID" {
				totals[method] -= (exp.Amount + exp.TaxAmount)
			}
		}
	}

	// 3. Obtener Abonos (Pagos de Crédito)
	payments, err := s.creditRepo.GetByDateRange(start, now)
	if err == nil {
		for _, p := range payments {
			var method string
			if p.AmountCash > 0 && p.AmountTransfer > 0 {
				method = "MIXTO"
			} else if p.AmountCash > 0 {
				method = "EFECTIVO"
			} else {
				method = strings.ToUpper(p.TransferSource)
				if method == "" { method = "TRANSFERENCIA" }
			}

			movements = append(movements, MovementDetail{
				Time:        p.PaymentDate,
				Type:        "ABONO",
				Amount:      p.TotalPaid,
				Method:      method,
				Status:      "PAID",
				Description: "Abono de cliente",
			})
			if p.AmountCash > 0 {
				totals["EFECTIVO"] += p.AmountCash
			}
			if p.AmountTransfer > 0 {
				source := strings.ToUpper(p.TransferSource)
				if source == "" {
					source = "TRANSFERENCIA"
				}
				totals[source] += p.AmountTransfer
			}
		}
	}

	// Ordenar cronológicamente
	sort.Slice(movements, func(i, j int) bool {
		return movements[i].Time.Before(movements[j].Time)
	})

	return &DetailedShiftReport{
		StartTime: start,
		EndTime:   now,
		Employee:  activeShift.CashierName,
		Movements: movements,
		Totals:    totals,
	}, nil
}
