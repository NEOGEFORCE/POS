package services

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"

	"golang.org/x/sync/errgroup"
	"golang.org/x/sync/singleflight"
)

// GetCriticalThreshold calcula el umbral crÃ­tico basado en minStock
// minStock >= 12 -> 3, minStock >= 4 -> 2, minStock <= 3 -> 1
// Esta es la ÃšNICA fuente de verdad para el semÃ¡foro de stock en todo el sistema
func GetCriticalThreshold(minStock int) int {
	if minStock <= 0 {
		return 0 // Changed from 1: if minStock is 0, threshold is 0 (so quantity <= 0 is critical)
	}
	return int(math.Ceil(float64(minStock) * 0.20))
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
	sg           singleflight.Group
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
	StockWarning  StockStatus = "WARNING"  // Ã mbar: quantity <= minStock && quantity > criticalThreshold
	StockOptimal  StockStatus = "OPTIMAL"  // Verde: quantity > minStock
)

type LowStockItem struct {
	Barcode   string      `json:"barcode"`
	Name      string      `json:"name"`
	Stock     float64     `json:"stock"`
	MinStock  float64     `json:"minStock"`
	Threshold int         `json:"threshold"` // Umbral crÃ­tico calculado dinÃ¡micamente
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
	WarningStockCount     int64                      `json:"warningStockCount"`  // Ã mbar
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

	GlobalHistoricalExpected float64 `json:"globalHistoricalExpected"`
	GlobalHistoricalReal     float64 `json:"globalHistoricalReal"`
	ShiftEfectivoFisico      float64 `json:"shiftEfectivoFisico"`
	ShiftIngresosDigitales   float64 `json:"shiftIngresosDigitales"`
	ShiftEgresosEfectivo     float64 `json:"shiftEgresosEfectivo"`
	ShiftVentaReal           float64 `json:"shiftVentaReal"`
	TotalLiquidity           float64 `json:"totalLiquidity"`
	Coins100             float64 `json:"coins100"`
	Coins200             float64 `json:"coins200"`
	Coins500             float64 `json:"coins500"`
	Coins1000            float64 `json:"coins1000"`
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
	From             time.Time `json:"from"`
	To               time.Time `json:"to"`
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

func (s *DashboardService) GetOverview(ctx context.Context, startDateStr string, endDateStr string) (*DashboardOverview, error) {
	// CACHÃ‰ L1: Retorno instantÃ¡neo si existe en RAM (Barrera HFT)
	if cached, found := cache.CacheManager.Get(cache.CacheKeyDashboardOverview); found {
		if overview, ok := cached.(*DashboardOverview); ok {
			log.Println("ðŸš€ HFT: Dashboard HIT (L1 Cache Intercepted)")
			return overview, nil
		}
	}

	key := fmt.Sprintf("overview_%s_%s", startDateStr, endDateStr)
	val, err, _ := s.sg.Do(key, func() (interface{}, error) {
		log.Println("âš¡ HFT: Dashboard MISS (Ejecutando Goroutines de Alta Intensidad...)")
	
		// Usar el contexto de la peticiÃ³n para permitir cancelaciÃ³n
		g, _ := errgroup.WithContext(ctx)

		now := time.Now().UTC()
		// 0. Determinar Rango del Turno Actual (Para Cierre y Caja)
		activeShift, _ := s.shiftRepo.GetActive()
		var shiftStartDate time.Time
		var lastClosure *models.CashierClosure
		var globalReportedByMethod map[string]float64
		var globalHistoricalExpected, globalHistoricalReal float64

		// Usar la zona horaria local (Colombia) para determinar los lÃ­mites del dÃ­a
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

		// 0.1 Determinar Inicio del DÃ­a Calendario (Medianoche Local)
		dayStart := time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 0, 0, 0, 0, loc)
	
		// Para reportes mensuales y semanales (usamos UTC para la DB)
		nowUTC := time.Now()
		currentMonthStart := time.Date(nowUTC.Year(), nowUTC.Month(), 1, 0, 0, 0, 0, time.UTC)
		nextMonthStart := currentMonthStart.AddDate(0, 1, 0)

		// Inyectar filtro por fechas si fue provisto
		if startDateStr != "" {
			if t, err := time.Parse(time.RFC3339, startDateStr); err == nil {
				dayStart = t
				shiftStartDate = t
			} else if t, err := time.Parse("2006-01-02", startDateStr); err == nil {
				dayStart = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
				shiftStartDate = dayStart
			}
		}
	
		if endDateStr != "" {
			if t, err := time.Parse(time.RFC3339, endDateStr); err == nil {
				nowUTC = t
			} else if t, err := time.Parse("2006-01-02", endDateStr); err == nil {
				nowUTC = time.Date(t.Year(), t.Month(), t.Day(), 23, 59, 59, 999999999, loc)
			}
		}

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
		var todayReturns float64
		var globalSalesByMethod, globalCollectedByMethod, globalPaidByMethod map[string]float64
		var dayExpensesRaw []models.Expense
		var dayPaymentsRaw []models.CreditPayment
		var globalCoins map[string]float64

		// 1. Get Materialized View Stats (Instant)
		g.Go(func() error {
			var err error
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetMonthlyStatsFromMV (%s)", currentMonthKey)
			mvStats, err = s.saleRepo.GetMonthlyStatsFromMV(currentMonthKey)
			if err != nil {
				log.Printf("â Œ [Dashboard] Error en GetMonthlyStatsFromMV: %v", err)
			}
			return nil // No romper dashboard por la MV
		})
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetPendingDebtsSummary")
			amount, count, err := s.expenseRepo.GetPendingDebtsSummary()
			if err != nil {
				log.Printf("â Œ [Dashboard] Error en GetPendingDebtsSummary: %v", err)
			} else {
				pendingDebtsAmount = amount
				pendingDebtsCount = count
			}
			pendingDebtsList, _ = s.expenseRepo.GetExpensesByStatus("PENDING")
			return nil
		})
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetMonthlyStatsTrendFromMV")
			var err error
			mvTrend, err = s.saleRepo.GetMonthlyStatsTrendFromMV()
			if err != nil {
				log.Printf("â Œ [Dashboard] Error en GetMonthlyStatsTrendFromMV: %v", err)
			}
			return nil
		})

		// 2. Optimized Real-time Queries (Only Today or small sets)
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetByDateRange (Expenses Shift) desde %v", shiftStartDate)
			var err error
			todayExpensesRaw, err = s.expenseRepo.GetByDateRange(shiftStartDate, nowUTC)
			if err != nil { log.Printf("â Œ [Dashboard] Error Expenses Shift: %v", err) }
			return nil
		})
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetByDateRange (Expenses Day) desde %v", dayStart)
			var err error
			dayExpensesRaw, err = s.expenseRepo.GetByDateRange(dayStart, nowUTC)
			if err != nil { log.Printf("â Œ [Dashboard] Error Expenses Day: %v", err) }
			return nil
		})
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetByDateRange (Payments Shift) desde %v", shiftStartDate)
			var err error
			todayPaymentsRaw, err = s.creditRepo.GetByDateRange(shiftStartDate, nowUTC)
			if err != nil { log.Printf("â Œ [Dashboard] Error Payments Shift: %v", err) }
			return nil
		})
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetByDateRange (Payments Day) desde %v", dayStart)
			var err error
			dayPaymentsRaw, err = s.creditRepo.GetByDateRange(dayStart, nowUTC)
			if err != nil { log.Printf("â Œ [Dashboard] Error Payments Day: %v", err) }
			return nil
		})
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetDashboardStats (Day) desde %v", dayStart)
			var err error
			todaySalesAmount, todaySalesCount, _, err = s.saleRepo.GetDashboardStats(dayStart, nowUTC)
			if err != nil { log.Printf("â Œ [Dashboard] Error Stats (Day): %v", err) }
			return nil
		})
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetDashboardStats (Shift) desde %v", shiftStartDate)
			var err error
			shiftSalesAmount, shiftSalesCount, _, err = s.saleRepo.GetDashboardStats(shiftStartDate, nowUTC)
			if err != nil { log.Printf("â Œ [Dashboard] Error Stats (Shift): %v", err) }
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
			if err != nil { log.Printf("â Œ [Dashboard] Error LowStock: %v", err) }
			return nil
		})
		g.Go(func() error {
			var err error
			salesFilter := ports.SaleFilter{Page: 1, PageSize: 20, From: currentMonthStart.Format("2006-01-02"), To: nextMonthStart.Format("2006-01-02")}
			recentSalesRaw, _, err = s.saleRepo.FindAll(salesFilter)
			if err != nil { log.Printf("â Œ [Dashboard] Error RecentSales: %v", err) }
			return nil
		})

		g.Go(func() error {
			var err error
			topProducts, err = s.saleRepo.GetTopSellingProducts(currentMonthStart, nextMonthStart, 7)
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
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetSalesBreakdown (Day) desde %v", dayStart)
			todaySalesByPayment, err = s.saleRepo.GetSalesBreakdownByRange(dayStart, nowUTC)
			if err != nil { log.Printf("â Œ [Dashboard] Error SalesByPayment (Day): %v", err) }
			return nil
		})
		g.Go(func() error {
			var err error
			log.Printf("ðŸ“Š [Dashboard] Sincronizando Shift desde GetCashierClosure")
			shiftClosure, err = s.GetCashierClosure()
			if err != nil { log.Printf("â Œ [Dashboard] Error GetCashierClosure: %v", err) }
			return nil
		})
		// Global Reconciliation Queries
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetGlobalTotalPaidExpenses")
			var err error
			globalExpenses, err = s.expenseRepo.GetGlobalTotalPaidExpenses()
			if err != nil { log.Printf("â Œ [Dashboard] Error GlobalExpenses: %v", err) }
			return nil
		})
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetGlobalCoins")
			var err error
			globalCoins, err = s.closureRepo.GetGlobalCoins()
			if err != nil { log.Printf("â Œ [Dashboard] Error GlobalCoins: %v", err) }
			return nil
		})
		// Financial Stats V5.5
		g.Go(func() error {
			var err error
			inventoryCostValue, err = s.productRepo.GetGlobalInventoryValue()
			if err != nil { log.Printf("â Œ [Dashboard] Error InventoryCost: %v", err) }
			return nil
		})
		g.Go(func() error {
			var err error
			inventoryRetailValue, err = s.productRepo.GetGlobalInventoryRetailValue()
			if err != nil { log.Printf("â Œ [Dashboard] Error InventoryRetail: %v", err) }
			return nil
		})
		// Breakdown Reconciliation Queries
		g.Go(func() error {
			var err error
			globalSalesByMethod, err = s.saleRepo.GetGlobalSalesByMethod()
			if err != nil { log.Printf("â Œ [Dashboard] Error GlobalSalesByMethod: %v", err) }
			return nil
		})
		g.Go(func() error {
			var err error
			globalCollectedByMethod, err = s.saleRepo.GetGlobalCollectedDebtsByMethod()
			if err != nil { log.Printf("â Œ [Dashboard] Error GlobalCollectedByMethod: %v", err) }
			return nil
		})
		g.Go(func() error {
			var err error
			globalPaidByMethodRaw, err := s.expenseRepo.GetGlobalPaidExpensesByMethod()
  			if err != nil { log.Printf("â Œ [Dashboard] Error GlobalPaidByMethod: %v", err) }
		
			globalPaidByMethod = make(map[string]float64)
			if globalPaidByMethodRaw != nil {
				for method, amount := range globalPaidByMethodRaw {
					if strings.Contains(method, ":") && strings.Contains(method, "$") {
						parts := strings.Split(method, " / ")
						for _, part := range parts {
							subParts := strings.Split(part, ":")
							if len(subParts) >= 2 {
								subMethod := strings.TrimSpace(subParts[0])
								subAmountStr := strings.TrimSpace(strings.ReplaceAll(subParts[1], "$", ""))
								var subAmount float64
								if strings.Contains(subAmountStr, ",") {
									subAmountStr = strings.ReplaceAll(subAmountStr, ".", "")
									subAmountStr = strings.ReplaceAll(subAmountStr, ",", ".")
									subAmount, _ = strconv.ParseFloat(subAmountStr, 64)
								} else if strings.Contains(subAmountStr, ".") {
									dotParts := strings.Split(subAmountStr, ".")
									if len(dotParts) == 2 && len(dotParts[1]) <= 2 {
										subAmount, _ = strconv.ParseFloat(subAmountStr, 64)
									} else {
										subAmountStr = strings.ReplaceAll(subAmountStr, ".", "")
										subAmount, _ = strconv.ParseFloat(subAmountStr, 64)
									}
								} else {
									subAmount, _ = strconv.ParseFloat(subAmountStr, 64)
								}
								globalPaidByMethod[subMethod] += subAmount
							}
						}
					} else {
						globalPaidByMethod[method] += amount
					}
				}
			}
  			return nil
		})
		// Today Profit Components
		g.Go(func() error {
			var err error
			todayExpenses, err = s.expenseRepo.GetPaidAmountByRange(shiftStartDate, nowUTC)
			if err != nil { log.Printf("â Œ [Dashboard] Error TodayExpenses (Shift): %v", err) }
			return nil
		})
		g.Go(func() error {
			var err error
			todayReturns, err = s.returnRepo.GetTotalReturnedByRange(shiftStartDate, nowUTC)
			if err != nil { log.Printf("â Œ [Dashboard] Error TodayReturns (Shift): %v", err) }
			return nil
		})

		var shiftFundExpenses float64
		g.Go(func() error {
			expenses, err := s.expenseRepo.GetGlobalPaidExpensesByMethodInRange(shiftStartDate, nowUTC)
			if err == nil {
				shiftFundExpenses = expenses["FONDO"]
			}
			return nil
		})
		// Financial Stats V5.5

		// Wait for all to finish, ignoring errors since we handle them inside
		_ = g.Wait()

		// 2. UTILIDAD Y COGS (COSTE DE VENTAS)
		var totalCOGS, monthlyExpenses float64
		if startDateStr == "" && endDateStr == "" && mvStats != nil {
			// Si no hay filtro de fechas, la vista general asume el mes actual
			totalSalesAmount = mvStats.TotalSales
			totalCOGS = mvStats.TotalCOGS
			monthlyExpenses = mvStats.TotalExpenses
			totalProductsSold = mvStats.ProductsSold
			monthlyCollectedDebts = mvStats.TotalAbonos
		} else {
			// Si el usuario filtró por fechas, respetamos la fecha consultada (todaySalesAmount que viene de dayStart y nowUTC)
			totalSalesAmount = todaySalesAmount
			// Recalculamos COGS y Gastos dinámicamente para el rango consultado
			totalCOGS, _ = s.saleRepo.GetCOGSByRange(dayStart, nowUTC)
			monthlyExpenses, _ = s.expenseRepo.GetPaidAmountByRange(dayStart, nowUTC)
			// Products Sold viene de todaySalesCount (o podemos dejar totalProductsSold en 0 temporalmente)
			totalProductsSold = 0
		}

		estimatedNetProfit := totalSalesAmount - totalCOGS - monthlyExpenses
		todayExpensesByMethod := make(map[string]float64)
		for _, e := range todayExpensesRaw {
			status := strings.ToUpper(e.Status)
			source := strings.ToUpper(e.PaymentSource)
			isPending := status == "PENDING" || source == "PRESTAMO" || source == "PREST."

			if !isPending && status == "PAID" {
				todayExpensesCount++
				if e.CashAmount > 0 || e.NequiAmount > 0 || e.DaviplataAmount > 0 || e.FondoAmount > 0 {
					todayExpensesByMethod["EFECTIVO"] += e.CashAmount
					todayExpensesByMethod["NEQUI"] += e.NequiAmount
					todayExpensesByMethod["DAVIPLATA"] += e.DaviplataAmount
					todayExpensesByMethod["FONDO"] += e.FondoAmount
					if e.TaxAmount > 0 && e.NequiAmount > 0 {
						todayExpensesByMethod["NEQUI"] += e.TaxAmount
					}
				} else {
					method := strings.ToUpper(e.PaymentSource)
					if method == "CAJA" { method = "EFECTIVO" }
					todayExpensesByMethod[method] += (e.Amount + e.TaxAmount)
				}
			}
		}

		dayExpensesByMethod := make(map[string]float64)
		for _, e := range dayExpensesRaw {
			status := strings.ToUpper(e.Status)
			source := strings.ToUpper(e.PaymentSource)
			isPending := status == "PENDING" || source == "PRESTAMO" || source == "PREST."
			if !isPending && status == "PAID" {
				if e.CashAmount > 0 || e.NequiAmount > 0 || e.DaviplataAmount > 0 || e.FondoAmount > 0 {
					dayExpensesByMethod["EFECTIVO"] += e.CashAmount
					dayExpensesByMethod["NEQUI"] += e.NequiAmount
					dayExpensesByMethod["DAVIPLATA"] += e.DaviplataAmount
					dayExpensesByMethod["FONDO"] += e.FondoAmount
					if e.TaxAmount > 0 && e.NequiAmount > 0 {
						dayExpensesByMethod["NEQUI"] += e.TaxAmount
					}
				} else {
					method := strings.ToUpper(e.PaymentSource)
					if method == "CAJA" { method = "EFECTIVO" }
					dayExpensesByMethod[method] += (e.Amount + e.TaxAmount)
				}
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
	
		// Reconstruir mapas históricos iterando los cierres reales para la Venta Real
		salesByMonth = make(map[string]float64)
		dailySalesMap = make(map[string]float64)
		allClosures, _ := s.GetClosuresHistory()
		for _, c := range allClosures {
			if !c.EndDate.IsZero() {
				monthStr := c.EndDate.In(loc).Format("2006-01")
				cDigital := c.TotalNequi + c.TotalDaviplata + c.TotalCard + c.TotalBancolombia + c.TotalOtherTransfer
				cExp := c.Expenses
				if len(cExp) == 0 && c.ExpensesDetail != "" {
					_ = json.Unmarshal([]byte(c.ExpensesDetail), &cExp)
				}
				cEgCaja := 0.0
				for _, e := range cExp {
					cash, _, _, _ := parseExpenseChannels(&e)
					cEgCaja += cash
				}
				cVentasCajero := c.PhysicalCash + cDigital + cEgCaja + c.TotalReturns
				if cVentasCajero == 0 {
					cVentasCajero = c.TotalSales
				}
				salesByMonth[monthStr] += cVentasCajero
				
				dayStr := c.EndDate.In(loc).Format("2006-01-02")
				dailySalesMap[dayStr] += cVentasCajero
			}
		}

		expensesByMonth = make(map[string]float64)
		profitByMonth = make(map[string]float64)

		// Agregar la venta del turno en curso al mes y día actual para ver DATOS EN TIEMPO REAL
		currentMonthStr := nowLocal.Format("2006-01")
		todayStr := nowLocal.Format("2006-01-02")
		if shiftClosure != nil {
			shiftVentaRealValue := shiftClosure.TotalSales
			if shiftVentaRealValue == 0 {
				shiftVentaRealValue = shiftSalesAmount
			}
			salesByMonth[currentMonthStr] += shiftVentaRealValue
			dailySalesMap[todayStr] += shiftVentaRealValue
		} else if shiftSalesAmount > 0 {
			salesByMonth[currentMonthStr] += shiftSalesAmount
			dailySalesMap[todayStr] += shiftSalesAmount
		}

		if startDateStr == "" && endDateStr == "" && salesByMonth[currentMonthStr] > 0 {
			totalSalesAmount = salesByMonth[currentMonthStr]
		}

		for _, trend := range mvTrend {
			expensesByMonth[trend.MonthYear] = trend.TotalExpenses
			profitByMonth[trend.MonthYear] = salesByMonth[trend.MonthYear] - trend.TotalExpenses
		}
		// ReconciliaciÃ³n Global
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
			minStock := int(p.MinStock)
			threshold := GetCriticalThreshold(minStock)
			warningThreshold := int(math.Ceil(float64(minStock) * 0.50))
			
			if int(p.Quantity) == -1 {
			    continue
			}
			if int(p.Quantity) <= threshold {
				criticalCount++
				lowStockProducts = append(lowStockProducts, LowStockItem{
					Barcode: p.Barcode, Name: p.ProductName, Stock: p.Quantity, MinStock: float64(minStock), Threshold: threshold, Status: StockCritical,
				})
			} else if int(p.Quantity) <= warningThreshold {
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
			dailySalesLast7 = append(dailySalesLast7, DailyPoint{Date: dStr, Amount: dailySalesMap[dStr]})
		}

		totalReports, _ := s.reportRepo.Count()

		// CALCULOS HOTFIX DE PUNTO CERO
		baseEfectivo := 0.0

		if lastClosure != nil {
			baseEfectivo = lastClosure.PhysicalCash
		}

		saldoNequiReal := globalSalesByMethod["NEQUI"] + globalCollectedByMethod["NEQUI"] - globalPaidByMethod["NEQUI"]
		saldoDaviplataReal := globalSalesByMethod["DAVIPLATA"] + globalCollectedByMethod["DAVIPLATA"] - globalPaidByMethod["DAVIPLATA"]
		bovedaFisicaAcumulada := globalReportedByMethod["EFECTIVO"] - globalPaidByMethod["FONDO"]

		result := DashboardOverview{
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
				Cash:      baseEfectivo, // Efectivo Operativo de Caja (Aislado de la sumatoria global)
				Nequi:     saldoNequiReal,
				Daviplata: saldoDaviplataReal,
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
			// CÃ LCULO DE SALDOS (BÃ³veda Estricta y RestauraciÃ³n Digital)
			VaultBalance:     bovedaFisicaAcumulada,
		
			SystemBalance:    baseEfectivo + bovedaFisicaAcumulada,
		
			GlobalDifference: (globalHistoricalReal - globalPaidByMethod["FONDO"]) - (globalHistoricalExpected - globalPaidByMethod["FONDO"]),
		
			ReportedBalance:  bovedaFisicaAcumulada,
		
			VaultExpenses:    shiftFundExpenses,
			TotalExpensesPaid:    globalExpenses,
			TotalCashExpensesPaid: globalPaidByMethod["EFECTIVO"],
			GlobalHistoricalExpected: globalHistoricalExpected - globalPaidByMethod["FONDO"],
			GlobalHistoricalReal:     globalHistoricalReal - globalPaidByMethod["FONDO"],
		
			ShiftEfectivoFisico:      (func() float64 { if shiftClosure != nil { return shiftClosure.ExpectedCash }; return 0 })(),
			ShiftIngresosDigitales:   (func() float64 { if shiftClosure != nil { return shiftClosure.TotalNequi + shiftClosure.TotalDaviplata + shiftClosure.TotalBancolombia + shiftClosure.TotalCard + shiftClosure.TotalOtherTransfer }; return 0 })(),
			ShiftEgresosEfectivo:     (func() float64 {
				total := 0.0
				if shiftClosure != nil {
					for _, e := range shiftClosure.Expenses {
						src := strings.ToUpper(e.PaymentSource)
						if src == "" || src == "EFECTIVO" || src == "CAJA" {
							total += e.Amount
						}
					}
				}
				return total
			})(),
			ShiftVentaReal: (func() float64 {
				if shiftClosure != nil {
					return shiftClosure.TotalSales
				}
				return 0
			})(),
			TotalLiquidity: bovedaFisicaAcumulada + saldoNequiReal + saldoDaviplataReal,
		
			EstimatedNetProfit:   estimatedNetProfit,
			InventoryCostValue:   inventoryCostValue,
			InventoryRetailValue: inventoryRetailValue,
			TodayNetProfit:       (todaySalesAmount - (func() float64 { if totalSalesAmount > 0 { return (totalCOGS / totalSalesAmount) * todaySalesAmount }; return 0 }())) - (todayExpenses - todayExpensesByMethod["FONDO"]),
			Coins100:             globalCoins["100"],
			Coins200:             globalCoins["200"],
			Coins500:             globalCoins["500"],
			Coins1000:            globalCoins["1000"],
		}

		// Actualizar CachÃ© L1 con 1 hora de TTL
		cache.CacheManager.Set(cache.CacheKeyDashboardOverview, &result, 1*time.Hour)

		return &result, nil
	})

	if err != nil {
		return nil, err
	}

	return val.(*DashboardOverview), nil
}

func (s *DashboardService) UpdateClosure(id uint, updates map[string]interface{}) error {
	closure, err := s.closureRepo.GetByID(id)
	if err == nil {
		if forgotten, ok := updates["forgotten_expenses"]; ok {
			var newExpenses []models.Expense
			b, _ := json.Marshal(forgotten)
			json.Unmarshal(b, &newExpenses)
			
			// Load existing expenses from the closure
			var existingExpenses []models.Expense
			if closure.ExpensesDetail != "" {
				json.Unmarshal([]byte(closure.ExpensesDetail), &existingExpenses)
			}
			
			for _, exp := range newExpenses {
				if exp.Amount > 0 {
					exp.Date = closure.Date
					exp.CreatedByDNI = closure.ClosedByDNI
					exp.Status = "PAID"
					s.expenseRepo.Save(&exp)
					existingExpenses = append(existingExpenses, exp)
				}
			}
			delete(updates, "forgotten_expenses")
			
		}

		// ALWAYS refresh expenses detail to capture any out-of-band expense creations
		expenses, _ := s.expenseRepo.GetByDateRange(closure.StartDate, closure.EndDate)
		// Normalizar montos por canal antes de serializar (egresos viejos solo tienen PaymentSource)
		for i := range expenses {
			e := &expenses[i]
			if e.Status == "PENDING" {
				e.CashAmount = 0; e.NequiAmount = 0; e.DaviplataAmount = 0; e.FondoAmount = 0
				continue
			}
			sum := e.CashAmount + e.NequiAmount + e.DaviplataAmount + e.FondoAmount
			src := strings.ToUpper(strings.TrimSpace(e.PaymentSource))
			if src == "FONDO" || src == "BOVEDA" || src == "BÓVEDA" || strings.Contains(src, "FOND") {
				e.FondoAmount = e.Amount + e.TaxAmount
				e.CashAmount = 0
				e.NequiAmount = 0
				e.DaviplataAmount = 0
				e.PaymentSource = "FONDO"
			} else if sum == 0 {
				switch {
				case strings.Contains(src, "NEQUI") || strings.Contains(src, "BANCOLOMBIA") || strings.Contains(src, "TRANSFERENCIA") || strings.Contains(src, "BANCO") || strings.Contains(src, "DIGITAL"):
					e.NequiAmount = e.Amount + e.TaxAmount
				case strings.Contains(src, "DAVIPLATA"):
					e.DaviplataAmount = e.Amount + e.TaxAmount
				case strings.Contains(src, "PREST") || strings.Contains(src, "DEUDA") || strings.Contains(src, "PENDING"):
					// Deudas no afectan caja
				default:
					e.CashAmount = e.Amount + e.TaxAmount
				}
			}
		}
		if len(expenses) > 0 {
			eb, _ := json.Marshal(expenses)
			updates["expenses_detail"] = string(eb)
		} else {
			updates["expenses_detail"] = "[]"
		}

		// Recalcular montos consolidados (total_sales, expected_cash, difference) para mantener consistencia
		egresosEfectivo := 0.0
		egresosGlobales := 0.0
		for _, e := range expenses {
			if e.Status != "PENDING" && strings.ToUpper(e.Category) != "DEVOLUCIONES" {
				egresosEfectivo += e.CashAmount
				egresosGlobales += e.CashAmount + e.NequiAmount + e.DaviplataAmount + e.FondoAmount
			}
		}

		physicalCash := closure.PhysicalCash
		if pc, ok := updates["physical_cash"]; ok {
			switch v := pc.(type) {
			case float64:
				physicalCash = v
			case int:
				physicalCash = float64(v)
			}
		}

		// Recalcular ventas reales del turno desde las ventas grabadas en BD
		salesInPeriod, _ := s.saleRepo.GetByDateRangeWithoutDetails(closure.StartDate, closure.EndDate)
		realTotalSales := 0.0
		for _, sale := range salesInPeriod {
			status := strings.ToUpper(sale.Status)
			if status == "PAID" || status == "CREDIT" {
				netCash := sale.CashAmount - sale.Change
				if netCash < 0 { netCash = 0 }
				cleanTransfer := sale.TransferAmount
				if cleanTransfer < 0 { cleanTransfer = 0 }
				realTotalSales += (netCash + cleanTransfer)
			}
		}
		paymentsInPeriod, _ := s.creditRepo.GetByDateRange(closure.StartDate, closure.EndDate)
		for _, p := range paymentsInPeriod {
			realTotalSales += p.TotalPaid
		}

		expectedCash := closure.OpeningCash + closure.TotalCash - egresosEfectivo - closure.TotalReturns
		if expectedCash <= 0 && closure.ExpectedCash > 0 {
			expectedCash = closure.ExpectedCash
		}
		diferencia := physicalCash - expectedCash

		if realTotalSales > 0 {
			updates["total_sales"] = realTotalSales
		} else if closure.TotalSales > 0 {
			updates["total_sales"] = closure.TotalSales
		}
		updates["expected_cash"] = expectedCash
		updates["difference"] = diferencia
		updates["total_expenses"] = egresosGlobales
	}
	err = s.closureRepo.Update(id, updates)
	if err == nil {
		cache.CacheManager.Delete(cache.CacheKeyDashboardOverview)
	}
	return err
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
	// Round down to avoid "monedas" (if they input decimals or exact coins, we assume they only care about bills/thousands)
	// Actually, just save the exact float they pass, the UI can handle rounding, but we will ensure it's clean.
	
	activeShift, err := s.shiftRepo.GetActive()
	if err != nil || activeShift == nil {
		activeShift = &models.ActiveShift{
			StartTime:        time.Now(),
			OpeningCash:      cash,
			OpeningNequi:     nequi,
			OpeningDaviplata: daviplata,
			CashierDNI:       employeeDNI,
			CashierName:      employeeName,
			Status:           "OPEN",
		}
	} else {
		activeShift.OpeningCash = cash
		activeShift.OpeningNequi = nequi
		activeShift.OpeningDaviplata = daviplata
	}

	err = s.shiftRepo.Save(activeShift)
	if err != nil {
		log.Printf("❌ [AdjustInitialBalance] Error guardando turno activo: %v", err)
		return err
	}

	// Invalidar caché
	cache.CacheManager.Delete(cache.CacheKeyDashboardOverview)

	log.Printf("📊 [AdjustInitialBalance] Fondo inicial ajustado en Turno Activo. Cash: %f, Nequi: %f, Davi: %f", cash, nequi, daviplata)
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
	TotalMixed           float64                `json:"totalMixed"` // NUEVO: Ventas con mÃºltiples medios
	OpeningCash          float64                `json:"openingCash"`
	OpeningNequi         float64                `json:"openingNequi"`
	OpeningDaviplata     float64                `json:"openingDaviplata"`
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
	ActiveShiftName      string                 `json:"activeShiftName"`
	ActiveShiftDNI       string                 `json:"activeShiftDni"`
}

func (s *DashboardService) GetCashierClosure() (*CashierClosure, error) {
	activeShift, _ := s.shiftRepo.GetActive()
	
	loc := time.FixedZone("America/Bogota", -5*60*60)
	nowLocal := time.Now().In(loc)
	
	var startDate time.Time
	var lastClosure *models.CashierClosure

	lastClosure, _ = s.closureRepo.GetLast()
	openingCash := 0.0
	openingNequi := 0.0
	openingDaviplata := 0.0
	
	if activeShift != nil {
		// Si hay un turno abierto manualmente, la fecha de inicio y el saldo son los de ese turno
		startDate = activeShift.StartTime
		openingCash = activeShift.OpeningCash
		openingNequi = activeShift.OpeningNequi
		openingDaviplata = activeShift.OpeningDaviplata
	} else if lastClosure != nil {
		// Si no hay turno abierto pero hay un cierre anterior, continuamos desde ahí
		startDate = lastClosure.EndDate
		openingCash = lastClosure.TotalCashReal
		openingNequi = lastClosure.TotalNequiReal
		openingDaviplata = lastClosure.TotalDaviplataReal
	} else {
		// Fallback: 24 horas atrás
		startDate = nowLocal.Add(-24 * time.Hour)
	}

	// 3. Preparar rangos para la base de datos (Usamos objetos time.Time directamente)
	// Aseguramos que endDate sea el momento exacto actual (UTC) para capturar todo
	endDate := time.Now()

	g, _ := errgroup.WithContext(context.Background())

	var sales []models.Sale
	var expenses []models.Expense
	var returns []models.Return
	var payments []models.CreditPayment

	g.Go(func() error {
		var err error
		sales, err = s.saleRepo.GetByDateRangeWithoutDetails(startDate, endDate)
		return err
	})
	g.Go(func() error {
		var err error
		expenses, err = s.expenseRepo.GetByDateRange(startDate, endDate)
		return err
	})
	g.Go(func() error {
		var err error
		returns, err = s.returnRepo.GetByDateRange(startDate, endDate)
		return err
	})
	g.Go(func() error {
		var err error
		payments, err = s.creditRepo.GetByDateRange(startDate, endDate)
		return err
	})

	if err := g.Wait(); err != nil {
		return nil, err
	}

	var closure CashierClosure
	loc = time.FixedZone("America/Bogota", -5*60*60)
	
	// Determinar el día mayoritario de las transacciones (Ventas + Egresos)
	dateCounts := make(map[string]int)
	for _, sale := range sales {
		dStr := sale.SaleDate.In(loc).Format("2006-01-02")
		dateCounts[dStr]++
	}
	for _, exp := range expenses {
		dStr := exp.Date.In(loc).Format("2006-01-02")
		dateCounts[dStr]++
	}

	maxCount := -1
	bestDateStr := time.Now().In(loc).Format("2006-01-02")
	for dStr, count := range dateCounts {
		if count > maxCount {
			maxCount = count
			bestDateStr = dStr
		}
	}

	if bestDate, err := time.ParseInLocation("2006-01-02", bestDateStr, loc); err == nil {
		closure.Date = bestDate.Add(12 * time.Hour) // Set to noon to avoid timezone shifts pushing to previous day
	} else {
		closure.Date = time.Now().In(loc)
	}

	closure.StartDate = startDate
	closure.EndDate = time.Now()
	closure.OpeningCash = openingCash
	closure.OpeningNequi = openingNequi
	closure.OpeningDaviplata = openingDaviplata
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

			// TotalSales se calculará al final según las reglas del usuario
			closure.TotalCash += netCashInSale
			closure.TotalTransfer += cleanTransfer
			closure.TotalCreditIssued += cleanCredit

			// Si la venta tiene mÃ¡s de un medio de pago, es MIXTA
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

	// Regla del usuario: Ventas Totales = Efectivo (Caja) + Transferencias (Los abonos ya están sumados en TotalCash y TotalTransfer)
	closure.TotalSales = closure.TotalCash + closure.TotalTransfer

	closure.NetBalance = closure.TotalSales - closure.TotalReturns - closure.TotalExpenses

	
  	var cashExpenses float64
  	for _, e := range expenses {
  		if strings.ToUpper(e.Status) != "PENDING" {
			// Preferir la columna CashAmount (precisa) sobre el parseo de PaymentSource (propenso a errores)
			if e.CashAmount > 0 {
				cashExpenses += e.CashAmount
			} else if e.CashAmount == 0 && e.NequiAmount == 0 && e.DaviplataAmount == 0 && e.FondoAmount == 0 {
				// Legacy: no tiene montos por canal, revisar PaymentSource
				src := strings.ToUpper(e.PaymentSource)
				if src == "EFECTIVO" || src == "CAJA" || src == "" {
					cashExpenses += (e.Amount + e.TaxAmount)
				}
			}
  		}
  	}

	var cashReturns float64
	for _, ret := range returns {
		if strings.ToUpper(ret.ReturnType) == "REFUND" {
			cashReturns += ret.TotalReturned
		}
	}

	closure.ExpectedCash = closure.OpeningCash + closure.TotalCash - cashExpenses - cashReturns

	if activeShift != nil {
		closure.ActiveShiftName = activeShift.CashierName
		closure.ActiveShiftDNI = activeShift.CashierDNI
	}

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
		// Normalizar montos por canal antes de serializar
		for i := range closureDTO.Expenses {
			e := &closureDTO.Expenses[i]
			if e.Status == "PENDING" { continue }
			src := strings.ToUpper(e.PaymentSource)
			sum := e.CashAmount + e.NequiAmount + e.DaviplataAmount + e.FondoAmount
			if sum == 0 {
				tot := e.Amount + e.TaxAmount
				if strings.Contains(src, "/") || strings.Contains(src, ":") {
					parts := strings.Split(src, "/")
					for _, part := range parts {
						p := strings.TrimSpace(part)
						var val float64
						if idx := strings.Index(p, "$"); idx != -1 {
							cleanStr := strings.ReplaceAll(p[idx+1:], ".", "")
							cleanStr = strings.ReplaceAll(cleanStr, ",", ".")
							cleanStr = strings.TrimSpace(cleanStr)
							var num float64
							if _, err := fmt.Sscanf(cleanStr, "%f", &num); err == nil {
								val = num
							}
						}
						if val == 0 {
							val = tot
						}

						if strings.Contains(p, "NEQUI") {
							e.NequiAmount += val
						} else if strings.Contains(p, "DAVIPLATA") || strings.Contains(p, "DAVI") {
							e.DaviplataAmount += val
						} else if strings.Contains(p, "FONDO") || strings.Contains(p, "BOVEDA") || strings.Contains(p, "BÓVEDA") || strings.Contains(p, "FOND") {
							e.FondoAmount += val
						} else if strings.Contains(p, "CAJA") || strings.Contains(p, "EFECTIVO") || strings.Contains(p, "CASH") {
							e.CashAmount += val
						}
					}
				} else if strings.Contains(src, "NEQUI") {
					e.NequiAmount = tot
				} else if strings.Contains(src, "DAVIPLATA") || strings.Contains(src, "DAVI") {
					e.DaviplataAmount = tot
				} else if strings.Contains(src, "FONDO") || strings.Contains(src, "BOVEDA") || strings.Contains(src, "BÓVEDA") || strings.Contains(src, "FOND") {
					e.FondoAmount = tot
				} else if strings.Contains(src, "PREST") || strings.Contains(src, "DEUDA") {
					// Debt - 0 cash/digital
				} else {
					e.CashAmount = tot
				}
			}
		}
		expensesJSON, _ := json.Marshal(closureDTO.Expenses)
		closureDTO.ExpensesDetail = string(expensesJSON)
	}

	// 1. Save the history closure
	err := s.closureRepo.Save(closureDTO)
	if err != nil {
		return err
	}

	// INVALIDAR CACHÉ DEL DASHBOARD PARA ACTUALIZAR BOVEDA INMEDIATAMENTE
	cache.CacheManager.Delete(cache.CacheKeyDashboardOverview)

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
	closures, err := s.closureRepo.GetAll()
	if err != nil {
		return nil, err
	}

	for i := range closures {
		c := &closures[i]
		if c.ExpensesDetail != "" {
			var expenses []models.Expense
			json.Unmarshal([]byte(c.ExpensesDetail), &expenses)

			egresosEfectivoTurno := 0.0
			for j := range expenses {
				e := &expenses[j]
				if e.Status == "PENDING" {
					continue
				}
				
				src := strings.ToUpper(e.PaymentSource)
				if !strings.Contains(src, ": $") && !strings.Contains(src, " / ") {
					totalExp := e.Amount + e.TaxAmount
					e.CashAmount = 0
					e.NequiAmount = 0
					e.DaviplataAmount = 0
					e.FondoAmount = 0
					
					if src == "" || src == "CAJA" || src == "EFECTIVO" {
						e.CashAmount = totalExp
					} else if src == "NEQUI" {
						e.NequiAmount = totalExp
					} else if src == "DAVIPLATA" {
						e.DaviplataAmount = totalExp
					} else if src == "FONDO" {
						e.FondoAmount = totalExp
					} else if src != "PREST." && src != "DEUDA" && src != "PRESTAMO" {
						e.CashAmount = totalExp
					}
				} else {
					sum := e.CashAmount + e.NequiAmount + e.DaviplataAmount + e.FondoAmount
					if sum > 0 && e.TaxAmount > 0 && sum == e.Amount {
						if e.NequiAmount > 0 {
							e.NequiAmount += e.TaxAmount
						} else if e.DaviplataAmount > 0 {
							e.DaviplataAmount += e.TaxAmount
						} else if e.FondoAmount > 0 {
							e.FondoAmount += e.TaxAmount
						} else {
							e.CashAmount += e.TaxAmount
						}
					}
				}
				
				egresosEfectivoTurno += e.CashAmount
			}

			// ingresosDigitales := c.TotalNequi + c.TotalDaviplata + c.TotalCard + c.TotalBancolombia + c.TotalOtherTransfer
			// ventaReal := c.PhysicalCash + ingresosDigitales + egresosEfectivoTurno
			// c.TotalSales = ventaReal
		}
	}

	return closures, nil
}

func (s *DashboardService) GetClosureByID(id uint) (*models.CashierClosure, error) {
	closure, err := s.closureRepo.GetByID(id)
	if err != nil {
		return nil, err
	}
	if closure.ExpensesDetail != "" {
		json.Unmarshal([]byte(closure.ExpensesDetail), &closure.Expenses)
	}

	// Fetch Credits Issued
	sales, _ := s.saleRepo.GetByDateRange(closure.StartDate, closure.EndDate)
	var creditsIssued []models.Sale
	for _, sale := range sales {
		if strings.ToUpper(sale.Status) == "CREDIT" {
			creditsIssued = append(creditsIssued, sale)
		}
	}
	closure.CreditsIssued = creditsIssued

	// Fetch Credit Payments
	payments, _ := s.creditRepo.GetByDateRange(closure.StartDate, closure.EndDate)
	closure.CreditPayments = payments

	return closure, nil
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

	// Invalidar cachÃ© del dashboard para que los totales se recalculen
	cache.CacheManager.Delete(cache.CacheKeyDashboardOverview)

	log.Printf("ðŸ—‘ï¸ [DeleteClosure] Cierre ID #%d eliminado permanentemente del sistema", id)
	return nil
}

func (s *DashboardService) GetRankingReport(from, to time.Time) ([]ports.ProductRankingItem, error) {
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

func (s *DashboardService) GetCategoryReport(from, to time.Time) ([]CategoryReportItem, error) {
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
				catName = "SIN CATEGORÃA"
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

func (s *DashboardService) GetVIPClientsReport(from, to time.Time) ([]VIPClientItem, error) {
	sales, err := s.saleRepo.GetByDateRangeWithoutDetails(from, to)
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

func (s *DashboardService) GetVoidsReport(from, to time.Time) ([]VoidReportItem, error) {
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

func (s *DashboardService) GetPnLReport(from, to time.Time) (*PnLReport, error) {
	// Ajustamos el rango: end debe ser el final del dÃ­a si solo viene la fecha
	// Pero como ya viene como time.Time, lo usamos directamente.
	// Si el llamador mandÃ³ "2023-01-01 00:00:00", queremos hasta "2023-01-01 23:59:59"
	// pero eso lo debe manejar el llamador o lo ajustamos aquÃ­ si detectamos que es medianoche.
	
	endDate := to
	if to.Hour() == 0 && to.Minute() == 0 {
		endDate = to.Add(24*time.Hour - time.Second)
	}

	g, _ := errgroup.WithContext(context.Background())

	var sales []models.Sale
	var expenses []models.Expense
	var payments []models.CreditPayment

	g.Go(func() error {
		var err error
		sales, err = s.saleRepo.GetByDateRangeWithoutDetails(from, endDate)
		return err
	})
	g.Go(func() error {
		var err error
		expenses, err = s.expenseRepo.GetByDateRange(from, endDate)
		return err
	})
	g.Go(func() error {
		var err error
		payments, err = s.creditRepo.GetByDateRange(from, endDate)
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
	// Priorizamos el turno activo para auditorÃ­a en tiempo real
	activeShift, _ := s.shiftRepo.GetActive()
	var systemCash, reportedCash float64

	if activeShift != nil {
		closure, _ := s.GetCashierClosure()
		systemCash = closure.TotalCash - closure.TotalExpenses
		reportedCash = 0 // AÃºn no reportado fÃ­sicamente
	} else {
		// Si no hay turno, usamos el Ãºltimo cierre histÃ³rico
		lastClosure, _ := s.closureRepo.GetLast()
		if lastClosure != nil {
			systemCash = lastClosure.TotalCash - lastClosure.TotalExpenses
			reportedCash = lastClosure.PhysicalCash
		}
	}

	// 2. Fondo de BÃ³veda (Fijo por ahora, o configurable en el futuro)
	// Valor base de la caja fuerte segÃºn requerimiento
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

func (s *DashboardService) GetInventoryMovementsReport(from, to time.Time) ([]StockMovementReportItem, error) {
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

	var movements []MovementDetail
	totals := make(map[string]float64)

	// 1. Obtener Ventas
	sales, err := s.saleRepo.GetByDateRangeWithoutDetails(start, now)
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
	expenses, err := s.expenseRepo.GetByDateRange(start, now)
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
				if strings.Contains(method, ":") && strings.Contains(method, "$") {
					parts := strings.Split(method, " / ")
					for _, part := range parts {
						subParts := strings.Split(part, ":")
						if len(subParts) >= 2 {
							subMethod := strings.TrimSpace(subParts[0])
							subAmountStr := strings.TrimSpace(strings.ReplaceAll(subParts[1], "$", ""))
							var subAmount float64
							if strings.Contains(subAmountStr, ",") {
								subAmountStr = strings.ReplaceAll(subAmountStr, ".", "")
								subAmountStr = strings.ReplaceAll(subAmountStr, ",", ".")
								subAmount, _ = strconv.ParseFloat(subAmountStr, 64)
							} else if strings.Contains(subAmountStr, ".") {
								dotParts := strings.Split(subAmountStr, ".")
								if len(dotParts) == 2 && len(dotParts[1]) <= 2 {
									subAmount, _ = strconv.ParseFloat(subAmountStr, 64)
								} else {
									subAmountStr = strings.ReplaceAll(subAmountStr, ".", "")
									subAmount, _ = strconv.ParseFloat(subAmountStr, 64)
								}
							} else {
								subAmount, _ = strconv.ParseFloat(subAmountStr, 64)
							}
							totals[subMethod] -= subAmount
						}
					}
				} else {
					totals[method] -= (exp.Amount + exp.TaxAmount)
				}
			}
		}
	}

	// 3. Obtener Abonos (Pagos de CrÃ©dito)
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

	// Ordenar cronolÃ³gicamente
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
type CashFlowDailyDetail struct {
	Date     string  `json:"date"`
	Income   float64 `json:"income"`
	Expense  float64 `json:"expense"`
	Balance  float64 `json:"balance"`
}

type CashFlowReport struct {
	From         time.Time             `json:"from"`
	To           time.Time             `json:"to"`
	TotalIncome  float64               `json:"totalIncome"`
	TotalExpense float64               `json:"totalExpense"`
	TotalBalance float64               `json:"totalBalance"`
	DailyDetails []CashFlowDailyDetail `json:"dailyDetails"`
}

func (s *DashboardService) GetCashFlowReport(from, to time.Time) (*CashFlowReport, error) {
	endDate := to
	if to.Hour() == 0 && to.Minute() == 0 {
		endDate = to.Add(24*time.Hour - time.Second)
	}

	closures, err := s.closureRepo.GetByDateRange(from, endDate)
	if err != nil {
		return nil, err
	}

	dailyMap := make(map[string]*CashFlowDailyDetail)
	var totalIncome, totalExpense float64

	for _, c := range closures {
		dayStr := c.Date.Format("2006-01-02")
		income := c.TotalCash + c.TotalTransfer
		expense := c.TotalExpenses

		if d, exists := dailyMap[dayStr]; exists {
			d.Income += income
			d.Expense += expense
		} else {
			dailyMap[dayStr] = &CashFlowDailyDetail{
				Date:    dayStr,
				Income:  income,
				Expense: expense,
			}
		}
		totalIncome += income
		totalExpense += expense
	}

	var dailyList []CashFlowDailyDetail
	for _, d := range dailyMap {
		d.Balance = d.Income - d.Expense
		dailyList = append(dailyList, *d)
	}

	sort.Slice(dailyList, func(i, j int) bool {
		return dailyList[i].Date < dailyList[j].Date
	})

	return &CashFlowReport{
		From:         from,
		To:           to,
		TotalIncome:  totalIncome,
		TotalExpense: totalExpense,
		TotalBalance: totalIncome - totalExpense,
		DailyDetails: dailyList,
	}, nil
}

type CashFlowDetailedReport struct {
	From         time.Time             `json:"from"`
	To           time.Time             `json:"to"`
	TotalIncome  float64               `json:"totalIncome"`
	TotalExpense float64               `json:"totalExpense"`
	TotalBalance float64               `json:"totalBalance"`
	Days         []CashFlowDetailedDay `json:"days"`
}

type CashFlowDetailedDay struct {
	Date         string                  `json:"date"`
	TotalIncome  float64                 `json:"totalIncome"`
	TotalExpense float64                 `json:"totalExpense"`
	Events       []CashFlowDetailedEvent `json:"events"`
}

type CashFlowDetailedEvent struct {
	Type          string  `json:"type"`
	Concept       string  `json:"concept"`
	IncomeCash    float64 `json:"incomeCash"`
	IncomeNequi   float64 `json:"incomeNequi"`
	IncomeDavi    float64 `json:"incomeDavi"`
	IncomeOther   float64 `json:"incomeOther"`
	ExpenseTotal  float64 `json:"expenseTotal"`
	PaymentMethod string  `json:"paymentMethod"`
}

func (s *DashboardService) GetCashFlowDetailedRaw(from, to time.Time) ([]models.CashierClosure, []models.Expense, []models.CreditPayment, error) {
	endDate := to
	if to.Hour() == 0 && to.Minute() == 0 {
		endDate = to.Add(24*time.Hour - time.Second)
	}

	g, _ := errgroup.WithContext(context.Background())

	var closures []models.CashierClosure
	var expenses []models.Expense
	var payments []models.CreditPayment

	g.Go(func() error {
		var err error
		closures, err = s.closureRepo.GetByDateRange(from, endDate)
		return err
	})
	g.Go(func() error {
		var err error
		expenses, err = s.expenseRepo.GetByDateRange(from, endDate)
		return err
	})
	g.Go(func() error {
		var err error
		payments, err = s.creditRepo.GetByDateRange(from, endDate)
		return err
	})

	if err := g.Wait(); err != nil {
		return nil, nil, nil, err
	}
	return closures, expenses, payments, nil
}

func (s *DashboardService) GetCashFlowDetailedReport(from, to time.Time) (*CashFlowDetailedReport, error) {
	closures, _, _, err := s.GetCashFlowDetailedRaw(from, to)
	if err != nil {
		return nil, err
	}

	daysMap := make(map[string]*CashFlowDetailedDay)
	getOrCreateDay := func(date string) *CashFlowDetailedDay {
		if d, exists := daysMap[date]; exists {
			return d
		}
		d := &CashFlowDetailedDay{Date: date}
		daysMap[date] = d
		return d
	}

	var overallIncome, overallExpense float64

	// Turnos (Ingresos principales)
	for _, c := range closures {
		dayStr := c.Date.Format("2006-01-02")
		d := getOrCreateDay(dayStr)

		income := c.TotalCash + c.TotalTransfer
		d.Events = append(d.Events, CashFlowDetailedEvent{
			Type:        "INGRESO",
			Concept:     fmt.Sprintf("Cierre de Turno (ID: %d)", c.ID),
			IncomeCash:  c.TotalCash,
			IncomeOther: c.TotalTransfer,
			ExpenseTotal: c.TotalExpenses,
		})

		d.TotalIncome += income
		d.TotalExpense += c.TotalExpenses
		overallIncome += income
		overallExpense += c.TotalExpenses
	}


	var daysList []CashFlowDetailedDay
	for _, d := range daysMap {
		daysList = append(daysList, *d)
	}

	sort.Slice(daysList, func(i, j int) bool {
		return daysList[i].Date < daysList[j].Date
	})

	return &CashFlowDetailedReport{
		From:         from,
		To:           to,
		TotalIncome:  overallIncome,
		TotalExpense: overallExpense,
		TotalBalance: overallIncome - overallExpense,
		Days:         daysList,
	}, nil
}

