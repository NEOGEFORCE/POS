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

// GetCriticalThreshold calcula el umbral entero por debajo del cual el stock
// entra en la banda ROJA del semaforo. Con la regla del dueno (agosto 2026)
// el corte es ratio < 25% del minimo. Esta funcion existe solo para exponer
// el numero como campo `threshold` en las respuestas JSON de suggested
// orders y del dashboard; la clasificacion real vive en models.ClassifyStockBand.
//
// El resultado se usa como referencia visual ("stock critico por debajo de
// N"), no como fuente de la banda. Sigue devolviendo un entero para no
// romper el contrato con el frontend historico.
func GetCriticalThreshold(minStock int) int {
	if minStock <= 0 {
		return 0
	}
	return int(math.Ceil(float64(minStock) * models.StockBandRedRatio))
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
	SystemBalance         float64 `json:"systemBalance"`
	ReportedBalance       float64 `json:"reportedBalance"`
	GlobalDifference      float64 `json:"globalDifference"`
	TotalExpensesPaid     float64 `json:"totalExpensesPaid"`
	TotalCashExpensesPaid float64 `json:"totalCashExpensesPaid"`
	EstimatedNetProfit    float64 `json:"estimatedNetProfit"`
	InventoryCostValue    float64 `json:"inventoryCostValue"`
	InventoryRetailValue  float64 `json:"inventoryRetailValue"`
	TodayNetProfit        float64 `json:"todayNetProfit"`
	// Vault/Fondo V9.5
	VaultBalance  float64 `json:"vaultBalance"`
	VaultExpenses float64 `json:"vaultExpenses"`
	CoinsSavings  float64 `json:"coinsSavings"`
	BillsBalance  float64 `json:"billsBalance"`

	GlobalHistoricalExpected float64 `json:"globalHistoricalExpected"`
	GlobalHistoricalReal     float64 `json:"globalHistoricalReal"`
	ShiftEfectivoFisico      float64 `json:"shiftEfectivoFisico"`
	ShiftIngresosDigitales   float64 `json:"shiftIngresosDigitales"`
	ShiftEgresosEfectivo     float64 `json:"shiftEgresosEfectivo"`
	ShiftVentaReal           float64 `json:"shiftVentaReal"`
	TotalLiquidity           float64 `json:"totalLiquidity"`
	Coins100                 float64 `json:"coins100"`
	Coins200                 float64 `json:"coins200"`
	Coins500                 float64 `json:"coins500"`
	Coins1000                float64 `json:"coins1000"`
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
	TotalRevenue     float64   `json:"totalRevenue"`
	TotalCOGS        float64   `json:"totalCogs"`
	GrossProfit      float64   `json:"grossProfit"`
	TotalExpenses    float64   `json:"totalExpenses"`
	NetProfit        float64   `json:"netProfit"`
	MarginPercentage float64   `json:"marginPercentage"`
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
	// CACHÉ L1 EN RAM, ahora sí en uso.
	//
	// Antes se hacía Delete() al entrar y Set() al salir, pero NUNCA un Get():
	// la caché era de escritura pura y cada petición recalculaba el dashboard
	// completo (decenas de consultas). Con varias pestañas abiertas y el
	// refresco automático, eso era carga constante sobre Postgres.
	//
	// El TTL es corto a propósito: el dashboard tiene que sentirse en vivo. Se
	// invalida de inmediato al guardar una venta, un cierre o un egreso, así que
	// una cifra recién registrada no espera el vencimiento.
	cacheKey := cache.DashboardOverviewKey(startDateStr, endDateStr)
	if cached, found := cache.CacheManager.Get(cacheKey); found {
		if ov, ok := cached.(*DashboardOverview); ok {
			return ov, nil
		}
	}

	key := fmt.Sprintf("overview_%s_%s", startDateStr, endDateStr)
	val, err, _ := s.sg.Do(key, func() (interface{}, error) {
		log.Println("âš¡ HFT: Dashboard MISS (Ejecutando Goroutines de Alta Intensidad...)")

		// Usar el contexto de la peticiÃ³n para permitir cancelaciÃ³n
		g, _ := errgroup.WithContext(ctx)

		// 0. Determinar Rango del Turno Actual (Para Cierre y Caja)
		activeShift, err := s.shiftRepo.GetActive()
		if err != nil {
			return nil, fmt.Errorf("obteniendo turno activo del dashboard: %w", err)
		}
		var shiftStartDate time.Time
		var lastClosure *models.CashierClosure
		var globalHistoricalExpected, globalHistoricalReal float64

		// Usar la zona horaria local (Colombia) para determinar los lÃ­mites del dÃ­a
		loc := time.FixedZone("America/Bogota", -5*60*60)
		nowLocal := time.Now().In(loc)

		if activeShift != nil {
			shiftStartDate = activeShift.StartTime
		} else {
			lastClosure, err = s.closureRepo.GetLast()
			if err != nil {
				return nil, fmt.Errorf("obteniendo último cierre del dashboard: %w", err)
			}
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
			var err error
			globalHistoricalExpected, globalHistoricalReal, err = s.closureRepo.GetGlobalHistoricalSum()
			return err
		})

		var totalSalesAmount, totalProductsSold, totalExpensesAmount, monthlyCollectedDebts float64
		var mvStats *ports.MVMonthlyStats
		var mvTrend []ports.MVMonthlyStats
		// La vista materializada agrupa por 'YYYY-MM' en hora Colombia, así que
		// la clave debe salir de nowLocal. Con time.Now().UTC() el último día del
		// mes después de las 19:00 consultaba el mes siguiente y el dashboard
		// mensual quedaba en $0.
		currentMonthKey := nowLocal.Format("2006-01")

		var todayExpensesRaw []models.Expense
		var todayPaymentsRaw []models.CreditPayment
		var todaySalesAmount, shiftSalesAmount float64
		var todaySalesCount, shiftSalesCount int64
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
			pendingDebtsList, err = s.expenseRepo.GetExpensesByStatus("PENDING")
			if err != nil {
				log.Printf("[Dashboard] Error listando deudas pendientes: %v", err)
			}
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
			if err != nil {
				log.Printf("â Œ [Dashboard] Error Expenses Shift: %v", err)
			}
			return nil
		})
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetByDateRange (Expenses Day) desde %v", dayStart)
			var err error
			dayExpensesRaw, err = s.expenseRepo.GetByDateRange(dayStart, nowUTC)
			if err != nil {
				log.Printf("â Œ [Dashboard] Error Expenses Day: %v", err)
			}
			return nil
		})
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetByDateRange (Payments Shift) desde %v", shiftStartDate)
			var err error
			todayPaymentsRaw, err = s.creditRepo.GetByDateRange(shiftStartDate, nowUTC)
			if err != nil {
				log.Printf("â Œ [Dashboard] Error Payments Shift: %v", err)
			}
			return nil
		})
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetByDateRange (Payments Day) desde %v", dayStart)
			var err error
			dayPaymentsRaw, err = s.creditRepo.GetByDateRange(dayStart, nowUTC)
			if err != nil {
				log.Printf("â Œ [Dashboard] Error Payments Day: %v", err)
			}
			return nil
		})
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetDashboardStats (Day) desde %v", dayStart)
			var err error
			todaySalesAmount, todaySalesCount, _, err = s.saleRepo.GetDashboardStats(dayStart, nowUTC)
			if err != nil {
				log.Printf("â Œ [Dashboard] Error Stats (Day): %v", err)
			}
			return nil
		})
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetDashboardStats (Shift) desde %v", shiftStartDate)
			var err error
			shiftSalesAmount, shiftSalesCount, _, err = s.saleRepo.GetDashboardStats(shiftStartDate, nowUTC)
			if err != nil {
				log.Printf("â Œ [Dashboard] Error Stats (Shift): %v", err)
			}
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
			if err != nil {
				log.Printf("â Œ [Dashboard] Error LowStock: %v", err)
			}
			return nil
		})
		g.Go(func() error {
			var err error
			salesFilter := ports.SaleFilter{Page: 1, PageSize: 20, From: currentMonthStart.Format("2006-01-02"), To: nextMonthStart.Format("2006-01-02")}
			recentSalesRaw, _, err = s.saleRepo.FindAll(salesFilter)
			if err != nil {
				log.Printf("â Œ [Dashboard] Error RecentSales: %v", err)
			}
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
			if err != nil {
				log.Printf("â Œ [Dashboard] Error SalesByPayment (Day): %v", err)
			}
			return nil
		})
		g.Go(func() error {
			var err error
			log.Printf("ðŸ“Š [Dashboard] Sincronizando Shift desde GetCashierClosure")
			shiftClosure, err = s.GetCashierClosure()
			if err != nil {
				log.Printf("â Œ [Dashboard] Error GetCashierClosure: %v", err)
			}
			return nil
		})
		// Global Reconciliation Queries
		g.Go(func() error {
			log.Printf("ðŸ“Š [Dashboard] Iniciando GetGlobalTotalPaidExpenses")
			var err error
			globalExpenses, err = s.expenseRepo.GetGlobalTotalPaidExpenses()
			if err != nil {
				log.Printf("â Œ [Dashboard] Error GlobalExpenses: %v", err)
			}
			return nil
		})
		// Financial Stats V5.5
		g.Go(func() error {
			var err error
			inventoryCostValue, err = s.productRepo.GetGlobalInventoryValue()
			if err != nil {
				log.Printf("â Œ [Dashboard] Error InventoryCost: %v", err)
			}
			return nil
		})
		g.Go(func() error {
			var err error
			inventoryRetailValue, err = s.productRepo.GetGlobalInventoryRetailValue()
			if err != nil {
				log.Printf("â Œ [Dashboard] Error InventoryRetail: %v", err)
			}
			return nil
		})
		// Breakdown Reconciliation Queries
		g.Go(func() error {
			var err error
			globalSalesByMethod, err = s.saleRepo.GetGlobalSalesByMethod()
			if err != nil {
				log.Printf("â Œ [Dashboard] Error GlobalSalesByMethod: %v", err)
			}
			return nil
		})
		g.Go(func() error {
			var err error
			globalCollectedByMethod, err = s.saleRepo.GetGlobalCollectedDebtsByMethod()
			if err != nil {
				log.Printf("â Œ [Dashboard] Error GlobalCollectedByMethod: %v", err)
			}
			return nil
		})
		g.Go(func() error {
			var err error
			globalPaidByMethodRaw, err := s.expenseRepo.GetGlobalPaidExpensesByMethod()
			if err != nil {
				log.Printf("â Œ [Dashboard] Error GlobalPaidByMethod: %v", err)
			}

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
			if err != nil {
				log.Printf("â Œ [Dashboard] Error TodayExpenses (Shift): %v", err)
			}
			return nil
		})
		g.Go(func() error {
			var err error
			todayReturns, err = s.returnRepo.GetTotalReturnedByRange(shiftStartDate, nowUTC)
			if err != nil {
				log.Printf("â Œ [Dashboard] Error TodayReturns (Shift): %v", err)
			}
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

		if err := g.Wait(); err != nil {
			return nil, fmt.Errorf("calculando dashboard: %w", err)
		}

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
			totalCOGS, err = s.saleRepo.GetCOGSByRange(dayStart, nowUTC)
			if err != nil {
				return nil, fmt.Errorf("calculando COGS del rango: %w", err)
			}
			monthlyExpenses, err = s.expenseRepo.GetPaidAmountByRange(dayStart, nowUTC)
			if err != nil {
				return nil, fmt.Errorf("calculando egresos del rango: %w", err)
			}
			// Products Sold viene de todaySalesCount (o podemos dejar totalProductsSold en 0 temporalmente)
			totalProductsSold = 0
		}

		// El COGS y los gastos vienen de la vista materializada, que mide las
		// ventas REGISTRADAS EN EL POS. Se guarda esa base aparte para calcular
		// el ratio de costo sobre la misma población que produjo el COGS.
		posSalesBase := totalSalesAmount

		totalExpensesAmount = monthlyExpenses
		// FUENTE ÚNICA de clasificación por canal: parseExpenseChannels (SSOT).
		// Antes esta función tenía una copia inline con reglas distintas —
		// específicamente, no excluía DEVOLUCIONES, no reconocía fuentes
		// mixtas "CAJA: $X/FONDO: $Y" y clasificaba MONEDA/ALCANCIA como
		// efectivo de caja. El resultado eran diferencias entre el
		// dashboard, el detalle del cierre y los PDFs.
		//
		// ExpenseChannelBuckets también aplica los mismos filtros que
		// alimentan el arqueo (PENDING, PRESTAMO/DEUDA, DEVOLUCIONES) para
		// que las tarjetas del dashboard sean coherentes con lo que sale
		// en /reports.
		todayExpensesByMethod := ExpenseChannelBuckets(todayExpensesRaw)

		dayExpensesByMethod := ExpenseChannelBuckets(dayExpensesRaw)

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
				if method == "" {
					method = "NEQUI"
				}
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
				if method == "" {
					method = "NEQUI"
				}
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
			// TARJETA "EGRESOS DEL TURNO" en el dashboard:
			//   amount = ComputeClosureMetrics(shiftClosure).EgresosTotales
			//   count  = líneas que aportaron a ese total canónico
			//
			// TotalExpenses del cierre queda igual (solo efectivo de caja,
			// que alimenta el arqueo y ExpectedCash), pero el usuario ve el
			// gasto operativo completo del turno, multicanal: caja + Nequi +
			// Daviplata + fondo + alcancía. Excluye pendientes, préstamos y
			// devoluciones porque no forman parte del gasto operativo real.
			shiftEgresosTotal, shiftEgresosCount := ComputeShiftExpenseTotals(shiftClosure.Expenses)
			shiftExpensesAmount = shiftEgresosTotal
			shiftExpensesCount = int64(shiftEgresosCount)
		}

		// Reconstruir mapas históricos iterando los cierres reales para la Venta Real
		salesByMonth = make(map[string]float64)
		dailySalesMap = make(map[string]float64)
		allClosures, _ := s.GetClosuresHistory()
		for i := range allClosures {
			c := &allClosures[i]
			if c.EndDate.IsZero() {
				continue
			}
			// FUENTE ÚNICA: la misma función que alimenta la columna
			// "VENTAS TOTALES" del historial de cierres en /reports.
			cVentasCajero := ComputeClosureMetrics(c).VentasCajero
			if cVentasCajero == 0 {
				cVentasCajero = c.TotalSales
			}
			salesByMonth[c.EndDate.In(loc).Format("2006-01")] += cVentasCajero
			dailySalesMap[c.EndDate.In(loc).Format("2006-01-02")] += cVentasCajero
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

		// VENTA FIJADA EN MESES CERRADOS (decisión del dueño, 2026-08-31).
		// Ver closed_month_overrides.go para el motivo, los límites y cómo se
		// quita. Se aplica ACÁ, después de sumar el turno en curso y ANTES de
		// calcular profitByMonth, para que la ganancia del mes fijado sea
		// coherente con la venta fijada.
		//
		// El mes en curso NUNCA se pisa: el candado está dentro de la función.
		if pinnedMonths := applyClosedMonthSalesOverrides(salesByMonth, currentMonthStr); len(pinnedMonths) > 0 {
			log.Printf("[DASHBOARD] venta fijada por el dueño en meses cerrados: %v", pinnedMonths)
		}

		if startDateStr == "" && endDateStr == "" && salesByMonth[currentMonthStr] > 0 {
			totalSalesAmount = salesByMonth[currentMonthStr]
		}

		// La UTILIDAD se calcula AQUÍ, después de que totalSalesAmount quedó en
		// su valor definitivo (la venta auditada de los cierres).
		//
		// Antes se calculaba 137 líneas más arriba, con la cifra de la vista
		// materializada, que en los cierres editados incluye los egresos del
		// FONDO dentro de las ventas. O sea el recibo de luz inflaba la ganancia.
		//
		// totalExpensesAmount se declaraba y NUNCA se asignaba, así que la
		// tarjeta de Gastos salía en $0 y Profit quedaba igual a las ventas.
		estimatedNetProfit := totalSalesAmount - totalCOGS - monthlyExpenses

		for _, trend := range mvTrend {
			expensesByMonth[trend.MonthYear] = trend.TotalExpenses
			profitByMonth[trend.MonthYear] = salesByMonth[trend.MonthYear] - trend.TotalExpenses
		}
		// ReconciliaciÃ³n Global
		var globalSalesTotal, globalCollected float64
		for _, v := range globalSalesByMethod {
			globalSalesTotal += v
		}
		for _, v := range globalCollectedByMethod {
			globalCollected += v
		}

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

			if int(p.Quantity) == -1 {
				continue
			}

			// Regla del dueno (agosto 2026): la banda es ROJO/AMARILLO/VERDE
			// contra el minimo configurado, no el 20/50 anterior. Usamos la
			// funcion canonica del paquete models para que el dashboard, el
			// stats y el pedido inteligente cuenten con el mismo criterio.
			//
			// OJO: como la banda AMARILLA crece (25%–75% en vez de 20%–50%),
			// el contador warningCount va a subir respecto a la version anterior.
			// Es un cambio buscado por el dueno.
			band := models.ClassifyStockBand(p.Quantity, p.MinStock)
			switch band {
			case models.StockBandRed:
				criticalCount++
				lowStockProducts = append(lowStockProducts, LowStockItem{
					Barcode: p.Barcode, Name: p.ProductName, Stock: p.Quantity, MinStock: float64(minStock), Threshold: threshold, Status: StockCritical,
				})
			case models.StockBandYellow:
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
			if sale.Client.Name != "" {
				clientName = sale.Client.Name
			}
			recentSales = append(recentSales, map[string]interface{}{
				"id":              sale.SaleID,
				"total":           sale.TotalAmount,
				"date":            sale.SaleDate.Format(time.RFC3339),
				"client":          clientName,
				"payment_method":  sale.PaymentMethod,
				"transfer_source": sale.TransferSource,
				"cash_amount":     sale.CashAmount,
				"transfer_amount": sale.TransferAmount,
				"credit_amount":   sale.CreditAmount,
			})
		}
		if len(recentSales) > 18 {
			recentSales = recentSales[:18]
		}

		dailySalesLast7 := []DailyPoint{}
		// Las claves de dailySalesMap se escriben en hora Colombia
		// (c.EndDate.In(loc)), así que hay que LEERLAS en hora Colombia.
		// Con time.Now().UTC() el gráfico pedía la clave de mañana a partir de
		// las 19:00 y el día en curso aparecía en $0.
		for i := 6; i >= 0; i-- {
			dStr := nowLocal.AddDate(0, 0, -i).Format("2006-01-02")
			dailySalesLast7 = append(dailySalesLast7, DailyPoint{Date: dStr, Amount: dailySalesMap[dStr]})
		}

		totalReports, _ := s.reportRepo.Count()

		// CALCULOS DE BOVEDA Y FONDO CON PUNTO DE PARTIDA MAESTRO
		// Base fija acordada: Efectivo Billetes = $1.050.000, Monedas 500/1000 = $91.500
		baseBilletesInicial := 1050000.0
		baseMonedas1000Inicial := 91500.0
		baseMonedas200Inicial := 0.0
		baseMonedas100Inicial := 0.0

		// Fecha de corte del punto de partida maestro (8 de Agosto de 2026, 22:00)
		baselineDate := time.Date(2026, time.August, 8, 22, 0, 0, 0, loc)

		// Acumular solo los cierres nuevos realizados POSTERIORMENTE al punto de partida.
		// Se reutiliza allClosures, que ya se cargó arriba: antes se volvía a
		// llamar closureRepo.GetAll(), trayendo todo el historial dos veces por
		// cada carga del dashboard.
		var newPhysicalCash, newCoins1000, newCoins200, newCoins100 float64
		for _, c := range allClosures {
			closureTime := c.EndDate
			if closureTime.IsZero() {
				closureTime = c.Date
			}
			if closureTime.After(baselineDate) {
				cCoins1000 := c.Coins1000 + c.Coins500
				cCoins200 := c.Coins200
				cCoins100 := c.Coins100
				cCoinsTotal := cCoins1000 + cCoins200 + cCoins100

				cCashBills := c.PhysicalCash - cCoinsTotal
				if cCashBills < 0 {
					cCashBills = 0
				}

				newPhysicalCash += cCashBills
				newCoins1000 += cCoins1000
				newCoins200 += cCoins200
				newCoins100 += cCoins100
			}
		}

		// Acumular solo los egresos de FONDO y MONEDAS nuevos realizados POSTERIORMENTE al punto de partida
		var newFundExpenses, newCoinsExpenses float64
		fondoExpensesMap, err := s.expenseRepo.GetGlobalPaidExpensesByMethodInRange(baselineDate, nowUTC)
		if err == nil {
			newFundExpenses = fondoExpensesMap["FONDO"]
			newCoinsExpenses = fondoExpensesMap["MONEDAS"] + fondoExpensesMap["ALCANCIA"]
		}

		// SIN PISO A CERO. Si la cuenta da negativo hay que mostrarlo: significa
		// que el sistema cree que salió más plata de la bóveda de la que entró,
		// y eso solo puede pasar por dos razones reales:
		//   - Salió efectivo de la bóveda registrado en otro canal (una
		//     consignación al banco, o un egreso marcado como CAJA).
		//   - Un egreso quedó mal clasificado.
		//
		// Taparlo con un $0 hacía imposible distinguir "la bóveda está vacía" de
		// "las cuentas no cuadran".
		bovedaBilletes := baseBilletesInicial + newPhysicalCash - newFundExpenses

		totalCoins1000 := baseMonedas1000Inicial + newCoins1000 - newCoinsExpenses
		totalCoins200 := baseMonedas200Inicial + newCoins200
		totalCoins100 := baseMonedas100Inicial + newCoins100
		totalMonedasAcumuladas := totalCoins1000 + totalCoins200 + totalCoins100

		bovedaFisicaAcumulada := bovedaBilletes + totalMonedasAcumuladas
		saldoNequiReal := globalSalesByMethod["NEQUI"] + globalCollectedByMethod["NEQUI"] - globalPaidByMethod["NEQUI"]
		saldoDaviplataReal := globalSalesByMethod["DAVIPLATA"] + globalCollectedByMethod["DAVIPLATA"] - globalPaidByMethod["DAVIPLATA"]

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
				Cash:      bovedaBilletes, // Efectivo Operativo de Bóveda
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
			// CÁLCULO DE SALDOS (Bóveda Estricta y Restauración Digital)
			VaultBalance: bovedaBilletes,
			CoinsSavings: totalMonedasAcumuladas,
			BillsBalance: bovedaBilletes,

			SystemBalance: bovedaFisicaAcumulada,

			GlobalDifference: (globalHistoricalReal - globalPaidByMethod["FONDO"]) - (globalHistoricalExpected - globalPaidByMethod["FONDO"]),

			ReportedBalance: bovedaFisicaAcumulada,

			VaultExpenses:            shiftFundExpenses,
			TotalExpensesPaid:        globalExpenses,
			TotalCashExpensesPaid:    globalPaidByMethod["EFECTIVO"],
			GlobalHistoricalExpected: globalHistoricalExpected - globalPaidByMethod["FONDO"],
			GlobalHistoricalReal:     globalHistoricalReal - globalPaidByMethod["FONDO"],

			ShiftEfectivoFisico: (func() float64 {
				if shiftClosure != nil {
					return shiftClosure.ExpectedCash
				}
				return 0
			})(),
			ShiftIngresosDigitales: (func() float64 {
				if shiftClosure != nil {
					return shiftClosure.TotalNequi + shiftClosure.TotalDaviplata + shiftClosure.TotalBancolombia + shiftClosure.TotalCard + shiftClosure.TotalOtherTransfer
				}
				return 0
			})(),
			ShiftEgresosEfectivo: (func() float64 {
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
			TodayNetProfit: (todaySalesAmount - (func() float64 {
				if posSalesBase > 0 {
					return (totalCOGS / posSalesBase) * todaySalesAmount
				}
				return 0
			}())) - (todayExpenses - todayExpensesByMethod["FONDO"]),
			Coins100:  totalCoins100,
			Coins200:  totalCoins200,
			Coins500:  0,
			Coins1000: totalCoins1000,
		}

		// El sistema opera en pesos colombianos: no existen centavos. Los
		// decimales que aparecían en el dashboard ($35.890.820,78) venían de
		// acumular float64 sobre miles de operaciones. Se redondea al salir.
		roundOverviewMoney(&result)

		// TTL corto: el dashboard debe sentirse en vivo. Cualquier venta, cierre
		// o egreso invalida la caché de inmediato, así que este vencimiento solo
		// protege contra ráfagas de peticiones idénticas.
		cache.CacheManager.Set(cacheKey, &result, 20*time.Second)

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
				e.CashAmount = 0
				e.NequiAmount = 0
				e.DaviplataAmount = 0
				e.FondoAmount = 0
				e.CoinsAmount = 0
			}
		}
		// Se reutiliza el mismo parser del cierre en lugar de una copia ad-hoc.
		// La copia anterior forzaba el 100% a FONDO cuando el texto contenía
		// "FOND", así que un egreso mixto CAJA/FONDO/ALCANCIA perdía el resto
		// del desglose y la alcancía nunca se descontaba.
		if err := normalizeClosureExpenses(expenses); err != nil {
			log.Printf("⚠️ No se pudo normalizar los canales de egreso del cierre %d: %v", closure.ID, err)
		}
		if len(expenses) > 0 {
			eb, _ := json.Marshal(expenses)
			updates["expenses_detail"] = string(eb)
		} else {
			updates["expenses_detail"] = "[]"
		}

		// FUENTE ÚNICA del arqueo: ComputeClosureMetrics sobre los egresos ya
		// normalizados. Antes este bloque tenía su propia suma inline.
		snapshot := *closure
		snapshot.Expenses = expenses
		snapshot.ExpensesDetail = ""

		physicalCash := closure.PhysicalCash
		if pc, ok := updates["physical_cash"]; ok {
			switch v := pc.(type) {
			case float64:
				physicalCash = v
			case int:
				physicalCash = float64(v)
			}
		}
		snapshot.PhysicalCash = physicalCash

		m := ComputeClosureMetrics(&snapshot)
		egresosEfectivo := m.EgresosCaja
		physicalCash = m.PhysicalCash

		// Recalcular ventas reales del turno desde las ventas grabadas en BD
		salesInPeriod, _ := s.saleRepo.GetByDateRangeWithoutDetails(closure.StartDate, closure.EndDate)
		realTotalSales := 0.0
		for _, sale := range salesInPeriod {
			status := strings.ToUpper(sale.Status)
			if status == "PAID" || status == "CREDIT" {
				netCash := sale.CashAmount - sale.Change
				if netCash < 0 {
					netCash = 0
				}
				cleanTransfer := sale.TransferAmount
				if cleanTransfer < 0 {
					cleanTransfer = 0
				}
				realTotalSales += (netCash + cleanTransfer)
			}
		}
		paymentsInPeriod, _ := s.creditRepo.GetByDateRange(closure.StartDate, closure.EndDate)
		for _, p := range paymentsInPeriod {
			realTotalSales += p.TotalPaid
		}

		// MATEMÁTICA REAL, SIN PISO A CERO.
		//
		// Si en un turno los egresos superan las ventas registradas en el POS
		// (típico al vender productos sin código de barras y pagar gastos con
		// ese dinero), el esperado da NEGATIVO. Eso es correcto y hay que
		// mostrarlo: forzarlo a $0 escondía el sobrante real del cajero.
		//
		// Ejemplo real del cierre #158: esperado -$72.780 con $16.500 contados
		// da un sobrante de +$89.280, no de +$16.500.
		expectedCash := closure.OpeningCash + closure.TotalCash - egresosEfectivo - closure.TotalReturns
		diferencia := physicalCash - expectedCash

		if realTotalSales > 0 {
			updates["total_sales"] = realTotalSales
		} else if closure.TotalSales > 0 {
			updates["total_sales"] = closure.TotalSales
		}
		updates["expected_cash"] = expectedCash
		updates["difference"] = diferencia
		// total_expenses es la columna de EGRESOS EN EFECTIVO. Antes aquí se
		// escribía el total global (efectivo + nequi + davi + FONDO), y como la
		// vista materializada del mes la suma dentro de las ventas, el recibo de
		// luz pagado del fondo terminaba contando como venta.
		updates["total_expenses"] = egresosEfectivo
	}
	err = s.closureRepo.Update(id, updates)
	if err == nil {
		cache.InvalidateDashboard()
	}
	return err
}

func (s *DashboardService) getSavingsOpportunitiesCached() ([]ports.SavingsOpportunity, error) {
	if cached, found := cache.CacheManager.Get(cache.CacheKeySavingsOpportunities); found {
		return cached.([]ports.SavingsOpportunity), nil
	}
	savings, err := s.productRepo.GetSavingsOpportunities()
	if err == nil {
		// TTL corto + invalidación explícita. La invalidación vive en
		// cache.InvalidateSavingsOpportunities() y la disparan las escrituras de
		// productos, las recepciones y UpdateSupplierPrice. El TTL de 10 minutos
		// es el cinturón de seguridad para cualquier ruta de escritura que se nos
		// haya pasado; antes era de 1 hora y NADIE invalidaba esta clave.
		cache.CacheManager.Set(cache.CacheKeySavingsOpportunities, savings, cache.SavingsOpportunitiesTTL)
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
	cache.InvalidateDashboard()

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
	activeShift, err := s.shiftRepo.GetActive()
	if err != nil {
		return nil, fmt.Errorf("obteniendo turno activo: %w", err)
	}

	loc := time.FixedZone("America/Bogota", -5*60*60)
	nowLocal := time.Now().In(loc)

	var startDate time.Time
	var lastClosure *models.CashierClosure

	lastClosure, err = s.closureRepo.GetLast()
	if err != nil {
		return nil, fmt.Errorf("obteniendo último cierre: %w", err)
	}
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
		if status == "PAID" || status == "CREDIT" {
			closure.SalesCount++
			netCashInSale := sale.CashAmount - sale.Change
			if netCashInSale < 0 {
				netCashInSale = 0
			}
			cleanTransfer := sale.TransferAmount
			if cleanTransfer < 0 {
				cleanTransfer = 0
			}
			cleanCredit := sale.CreditAmount
			if cleanCredit < 0 {
				cleanCredit = 0
			}

			// TotalSales se calculará al final según las reglas del usuario
			closure.TotalCash += netCashInSale
			closure.TotalTransfer += cleanTransfer
			closure.TotalCreditIssued += cleanCredit

			// Si la venta tiene mÃ¡s de un medio de pago, es MIXTA
			methodsCount := 0
			if netCashInSale > 0 {
				methodsCount++
			}
			if cleanTransfer > 0 {
				methodsCount++
			}
			if cleanCredit > 0 {
				methodsCount++
			}
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
				case "NEQUI":
					closure.TotalNequi += sale.TransferAmount
				case "DAVIPLATA":
					closure.TotalDaviplata += sale.TransferAmount
				case "BANCOLOMBIA":
					closure.TotalBancolombia += sale.TransferAmount
				case "TARJETA":
					closure.TotalCard += sale.TransferAmount
				default:
					closure.TotalOtherTransfer += sale.TransferAmount
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
			case "NEQUI":
				closure.TotalNequi += p.AmountTransfer
			case "DAVIPLATA":
				closure.TotalDaviplata += p.AmountTransfer
			case "BANCOLOMBIA":
				closure.TotalBancolombia += p.AmountTransfer
			case "TARJETA":
				closure.TotalCard += p.AmountTransfer
			default:
				closure.TotalOtherTransfer += p.AmountTransfer
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

	// TotalExpenses = solo egresos en EFECTIVO (para cuadre de caja física).
	// Los egresos de FONDO/NEQUI/DIGITAL no salen de la gaveta.
	//
	// FUENTE ÚNICA: parseExpenseChannels, la misma clasificación que usan el
	// historial, el dashboard y los reportes. Antes aquí había dos parseos
	// distintos, y ninguno excluía la categoría DEVOLUCIONES, así que las
	// devoluciones se restaban dos veces del efectivo esperado.
	var cashExpenses float64
	for i := range expenses {
		expense := expenses[i]
		cash, _, _, _, _ := parseExpenseChannels(&expense)
		if !strings.EqualFold(strings.TrimSpace(expense.Category), "DEVOLUCIONES") {
			cashExpenses += cash
		}
		closure.Expenses = append(closure.Expenses, expense)
	}
	closure.TotalExpenses = cashExpenses

	// Regla del usuario: Ventas Totales = Efectivo (Caja) + Transferencias (Los abonos ya están sumados en TotalCash y TotalTransfer)
	closure.TotalSales = closure.TotalCash + closure.TotalTransfer

	closure.NetBalance = closure.TotalSales - closure.TotalReturns - closure.TotalExpenses

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
	now := time.Now()
	err := s.closureRepo.Transaction(func(tx interface{}) error {
		for i := range closureDTO.Expenses {
			expense := &closureDTO.Expenses[i]
			if expense.ID != 0 {
				continue
			}
			if expense.Date.IsZero() {
				expense.Date = now
			}
			expense.CreatedByDNI = closureDTO.ClosedByDNI
			if err := s.expenseRepo.SaveWithTx(tx, expense); err != nil {
				return fmt.Errorf("guardando egreso manual del cierre: %w", err)
			}
		}

		if err := normalizeClosureExpenses(closureDTO.Expenses); err != nil {
			return err
		}
		if len(closureDTO.Expenses) > 0 {
			expensesJSON, err := json.Marshal(closureDTO.Expenses)
			if err != nil {
				return fmt.Errorf("serializando egresos del cierre: %w", err)
			}
			closureDTO.ExpensesDetail = string(expensesJSON)
		}
		if err := applyCashBreakdown(closureDTO); err != nil {
			return err
		}

		metrics := ComputeClosureMetrics(closureDTO)
		closureDTO.TotalExpenses = metrics.EgresosCaja
		closureDTO.ExpectedCash = closureDTO.OpeningCash + closureDTO.TotalCash - metrics.EgresosCaja - closureDTO.TotalReturns
		closureDTO.Difference = metrics.PhysicalCash - closureDTO.ExpectedCash

		if err := s.closureRepo.SaveWithTx(tx, closureDTO); err != nil {
			return fmt.Errorf("guardando cierre: %w", err)
		}
		if err := s.shiftRepo.CloseActiveWithTx(tx); err != nil {
			return fmt.Errorf("cerrando turno activo: %w", err)
		}
		newShift := &models.ActiveShift{
			StartTime:   now,
			OpeningCash: 0,
			CashierDNI:  closureDTO.ClosedByDNI,
			CashierName: closureDTO.ClosedByName,
			Status:      "OPEN",
		}
		if err := s.shiftRepo.SaveWithTx(tx, newShift); err != nil {
			return fmt.Errorf("abriendo siguiente turno: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	cache.InvalidateDashboard()
	return nil
}

func normalizeClosureExpenses(expenses []models.Expense) error {
	for i := range expenses {
		expense := &expenses[i]
		if strings.EqualFold(expense.Status, "PENDING") {
			continue
		}
		if expense.CashAmount+expense.NequiAmount+expense.DaviplataAmount+expense.FondoAmount+expense.CoinsAmount != 0 {
			continue
		}
		total := expense.Amount + expense.TaxAmount
		source := strings.ToUpper(expense.PaymentSource)
		if strings.Contains(source, "/") || strings.Contains(source, ":") {
			for _, part := range strings.Split(source, "/") {
				part = strings.TrimSpace(part)
				value := total
				if index := strings.Index(part, "$"); index >= 0 {
					clean := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(part[index+1:], ".", ""), ",", "."))
					parsed, err := strconv.ParseFloat(clean, 64)
					if err != nil {
						return fmt.Errorf("monto inválido en canal de egreso %q: %w", part, err)
					}
					value = parsed
				}
				assignExpenseChannel(expense, part, value)
			}
			continue
		}
		assignExpenseChannel(expense, source, total)
	}
	return nil
}

func assignExpenseChannel(expense *models.Expense, source string, value float64) {
	switch {
	// DAVIPLATA se evalúa primero: contiene "DAVI" y también es un canal digital.
	case strings.Contains(source, "DAVIPLATA"), strings.Contains(source, "DAVI"):
		expense.DaviplataAmount += value
	case strings.Contains(source, "NEQUI"), strings.Contains(source, "BANCOLOMBIA"),
		strings.Contains(source, "TRANSFERENCIA"), strings.Contains(source, "BANCO"),
		strings.Contains(source, "DIGITAL"):
		expense.NequiAmount += value
	// La alcancía se evalúa antes que el fondo: sin este caso, un egreso pagado
	// con monedas caía en el default y se descontaba del efectivo de caja.
	case strings.Contains(source, "MONEDA"), strings.Contains(source, "ALCANCIA"), strings.Contains(source, "ALCANCÍA"):
		expense.CoinsAmount += value
	case strings.Contains(source, "FONDO"), strings.Contains(source, "BOVEDA"), strings.Contains(source, "BÓVEDA"), strings.Contains(source, "FOND"):
		expense.FondoAmount += value
	case strings.Contains(source, "PREST"), strings.Contains(source, "DEUDA"), strings.Contains(source, "PENDING"):
		return
	default:
		expense.CashAmount += value
	}
}

func applyCashBreakdown(closure *models.CashierClosure) error {
	if closure.CashBills == 0 && strings.TrimSpace(closure.CashBreakdown) != "" {
		var breakdown struct {
			Bills map[string]string `json:"bills"`
			Coins map[string]string `json:"coins"`
		}
		if err := json.Unmarshal([]byte(closure.CashBreakdown), &breakdown); err != nil {
			return fmt.Errorf("desglose de efectivo inválido: %w", err)
		}
		for denomination, rawQuantity := range breakdown.Bills {
			value, err := strconv.ParseFloat(denomination, 64)
			if err != nil {
				return fmt.Errorf("denominación inválida %q: %w", denomination, err)
			}
			quantity, err := strconv.ParseFloat(rawQuantity, 64)
			if err != nil {
				return fmt.Errorf("cantidad inválida para denominación %q: %w", denomination, err)
			}
			closure.CashBills += value * quantity
		}
	}
	coinsTotal := closure.Coins1000 + closure.Coins500 + closure.Coins200 + closure.Coins100
	if closure.PhysicalCash == 0 && (closure.CashBills > 0 || coinsTotal > 0) {
		closure.PhysicalCash = closure.CashBills + coinsTotal
	}
	return nil
}

func (s *DashboardService) GetClosuresHistory() ([]models.CashierClosure, error) {
	closures, err := s.closureRepo.GetAll()
	if err != nil {
		return nil, err
	}

	// FUENTE ÚNICA: misma hidratación de egresos y mismo arqueo que el detalle
	// del cierre y que el reporte de flujo desglosado. Por lotes: una sola
	// consulta de egresos para todo el historial.
	if _, err := s.HydrateClosuresBatch(closures); err != nil {
		return nil, err
	}

	return closures, nil
}

// HydrateClosuresBatch hidrata y calcula el arqueo de MUCHOS cierres con UNA
// sola consulta de egresos, en vez de una por cierre.
//
// RENDIMIENTO: HydrateClosureExpenses consulta la base por cada cierre. Llamarla
// en un bucle sobre el historial completo son cientos de consultas por cada
// carga del dashboard y de cada reporte. Esta versión trae todos los egresos del
// rango completo una vez y los reparte en memoria.
func (s *DashboardService) HydrateClosuresBatch(closures []models.CashierClosure) ([]ClosureMetrics, error) {
	metrics := make([]ClosureMetrics, len(closures))
	if len(closures) == 0 {
		return metrics, nil
	}

	// Rango que cubre todos los turnos.
	var minStart, maxEnd time.Time
	for i := range closures {
		c := &closures[i]
		if !c.StartDate.IsZero() && (minStart.IsZero() || c.StartDate.Before(minStart)) {
			minStart = c.StartDate
		}
		if !c.EndDate.IsZero() && c.EndDate.After(maxEnd) {
			maxEnd = c.EndDate
		}
	}

	var allExpenses []models.Expense
	if !minStart.IsZero() && !maxEnd.IsZero() {
		var err error
		allExpenses, err = s.expenseRepo.GetByDateRange(minStart, maxEnd)
		if err != nil {
			return nil, fmt.Errorf("hidratando egresos de cierres: %w", err)
		}
	}

	// Ordenar una sola vez permite ubicar cada rango de turno con búsqueda
	// binaria. Se preserva el comportamiento inclusivo y también cierres que
	// pudieran solaparse, sin recorrer todos los egresos por cada cierre.
	sort.Slice(allExpenses, func(i, j int) bool { return allExpenses[i].Date.Before(allExpenses[j].Date) })
	for i := range closures {
		c := &closures[i]
		realExp := expensesWithinRange(allExpenses, c.StartDate, c.EndDate)
		mergeClosureExpenses(c, realExp)
		metrics[i] = s.publishClosureMetrics(c)
	}

	return metrics, nil
}

func expensesWithinRange(expenses []models.Expense, start, end time.Time) []models.Expense {
	if start.IsZero() || end.IsZero() || end.Before(start) || len(expenses) == 0 {
		return nil
	}
	first := sort.Search(len(expenses), func(i int) bool { return !expenses[i].Date.Before(start) })
	last := sort.Search(len(expenses), func(i int) bool { return expenses[i].Date.After(end) })
	if first >= last {
		return nil
	}
	return expenses[first:last]
}

// mergeClosureExpenses combina el snapshot guardado con los egresos vivos.
// Los vivos ganan cuando coincide el ID; los manuales sin ID se conservan.
// El orden es estable (por ID) porque el recorrido de un map en Go es aleatorio.
func mergeClosureExpenses(c *models.CashierClosure, realExp []models.Expense) {
	var snapExp []models.Expense
	if strings.TrimSpace(c.ExpensesDetail) != "" && c.ExpensesDetail != "[]" {
		_ = json.Unmarshal([]byte(c.ExpensesDetail), &snapExp)
	}

	var expenses []models.Expense
	if len(realExp) > 0 {
		expMap := make(map[uint]models.Expense, len(snapExp)+len(realExp))
		var noIDExpenses []models.Expense
		for _, e := range snapExp {
			if e.ID > 0 {
				expMap[e.ID] = e
			} else {
				noIDExpenses = append(noIDExpenses, e)
			}
		}
		for _, e := range realExp {
			expMap[e.ID] = e
		}
		for _, e := range expMap {
			expenses = append(expenses, e)
		}
		expenses = append(expenses, noIDExpenses...)
	}
	if len(expenses) == 0 && len(snapExp) > 0 {
		expenses = snapExp
	}

	if len(expenses) > 0 {
		sort.Slice(expenses, func(i, j int) bool {
			if expenses[i].ID != expenses[j].ID {
				return expenses[i].ID < expenses[j].ID
			}
			return expenses[i].Description < expenses[j].Description
		})
		c.Expenses = expenses
	}
}

// publishClosureMetrics calcula el arqueo y publica los campos calculados.
// Asume que los egresos ya están hidratados.
func (s *DashboardService) publishClosureMetrics(c *models.CashierClosure) ClosureMetrics {
	m := ComputeClosureMetrics(c)

	if len(c.Expenses) > 0 {
		expBytes, _ := json.Marshal(c.Expenses)
		c.ExpensesDetail = string(expBytes)

		c.TotalExpenses = m.EgresosCaja
		// MISMA fórmula que SaveClosure y que la pantalla del cajero: incluye la
		// base de apertura y NO tiene piso a cero, para que el sobrante o
		// faltante que se muestre sea el real.
		c.ExpectedCash = c.OpeningCash + c.TotalCash - m.EgresosCaja - c.TotalReturns
		c.Difference = m.PhysicalCash - c.ExpectedCash
	}

	c.VentasCajero = m.VentasCajero
	c.PhysicalCashReal = m.PhysicalCash
	c.DigitalIncome = m.DigitalIncome
	c.EgresosCaja = m.EgresosCaja
	c.EgresosFondo = m.EgresosFondo
	c.EgresosDigital = m.EgresosDigital
	c.EgresosTotales = m.EgresosTotales

	return m
}

// applyClosureMetrics hidrata los egresos de UN cierre y calcula su arqueo.
//
// OJO: hace una consulta a la base. Para procesar varios cierres usar
// HydrateClosuresBatch, que resuelve todo con una sola consulta.
func (s *DashboardService) applyClosureMetrics(c *models.CashierClosure) (ClosureMetrics, error) {
	var realExp []models.Expense
	if !c.StartDate.IsZero() && !c.EndDate.IsZero() {
		var err error
		realExp, err = s.expenseRepo.GetByDateRange(c.StartDate, c.EndDate)
		if err != nil {
			return ClosureMetrics{}, fmt.Errorf("hidratando egresos del cierre: %w", err)
		}
	}
	mergeClosureExpenses(c, realExp)
	return s.publishClosureMetrics(c), nil
}

func (s *DashboardService) GetClosureByID(id uint) (*models.CashierClosure, error) {
	closure, err := s.closureRepo.GetByID(id)
	if err != nil {
		return nil, err
	}

	// FUENTE ÚNICA: misma hidratación de egresos y mismo arqueo que el historial
	// y que el reporte de flujo desglosado.
	if _, err := s.applyClosureMetrics(closure); err != nil {
		return nil, err
	}

	// Fetch Credits Issued
	sales, err := s.saleRepo.GetByDateRange(closure.StartDate, closure.EndDate)
	if err != nil {
		return nil, fmt.Errorf("consultando ventas del cierre: %w", err)
	}
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
	cache.InvalidateDashboard()

	log.Printf("ðŸ—‘ï¸ [DeleteClosure] Cierre ID #%d eliminado permanentemente del sistema", id)
	return nil
}

func (s *DashboardService) GetRankingReport(from, to time.Time) ([]ports.ProductRankingItem, error) {
	return s.saleRepo.GetTopSellingProducts(from, to, 0)
}

func (s *DashboardService) GetCategoryReport(from, to time.Time) ([]CategoryReportItem, error) {
	aggregates, err := s.saleRepo.GetSalesByCategoryByRange(from, to)
	if err != nil {
		return nil, err
	}

	report := make([]CategoryReportItem, 0, len(aggregates))
	for _, aggregate := range aggregates {
		category := aggregate.Category
		if category == "" {
			category = "SIN CATEGORÃA"
		}
		report = append(report, CategoryReportItem{
			Category: category,
			Quantity: aggregate.Quantity,
			Total:    aggregate.Total,
		})
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
		if st != "PAID" && st != "CREDIT" {
			continue
		}
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
	endDate := to
	if to.Hour() == 0 && to.Minute() == 0 {
		endDate = to.Add(24*time.Hour - time.Second)
	}

	g, _ := errgroup.WithContext(context.Background())
	var salesRevenue, cogs, totalExpenses, collectedPayments float64

	g.Go(func() error {
		var err error
		salesRevenue, err = s.saleRepo.GetRevenueByRange(from, endDate)
		return err
	})
	g.Go(func() error {
		var err error
		cogs, err = s.saleRepo.GetCOGSByRange(from, endDate)
		return err
	})
	g.Go(func() error {
		var err error
		totalExpenses, err = s.expenseRepo.GetTotalAmountByDateRange(from, endDate)
		return err
	})
	g.Go(func() error {
		var err error
		collectedPayments, err = s.creditRepo.GetTotalCollectedByDateRange(from, endDate)
		return err
	})

	if err := g.Wait(); err != nil {
		return nil, err
	}

	return buildPnLReport(from, to, salesRevenue+collectedPayments, cogs, totalExpenses), nil
}

func buildPnLReport(from, to time.Time, revenue, cogs, totalExpenses float64) *PnLReport {
	grossProfit := revenue - cogs
	netProfit := grossProfit - totalExpenses
	margin := 0.0
	if revenue > 0 {
		margin = (netProfit / revenue) * 100
	}

	return &PnLReport{
		From: from, To: to, TotalRevenue: revenue, TotalCOGS: cogs,
		GrossProfit: grossProfit, TotalExpenses: totalExpenses,
		NetProfit: netProfit, MarginPercentage: margin,
	}
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

// GetGlobalDebt devuelve la cartera total por cobrar.
//
// Antes traía TODOS los clientes con GetAll() (que además los deja cacheados en
// RAM 24h) y sumaba en Go. Ahora es un SUM en SQL. La definición de deuda viva
// no cambia: es la de working_capital.go y export_service.go, sólo saldos
// positivos de "currentCredit".
func (s *DashboardService) GetGlobalDebt() (float64, error) {
	return s.clientRepo.SumLiveDebt()
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
	StartTime time.Time          `json:"startTime"`
	EndTime   time.Time          `json:"endTime"`
	Employee  string             `json:"employee"`
	Movements []MovementDetail   `json:"movements"`
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
			if strings.ToUpper(exp.Status) != "PENDING" {
				sumChannels := exp.CashAmount + exp.NequiAmount + exp.DaviplataAmount + exp.FondoAmount + exp.CoinsAmount
				if sumChannels > 0 {
					if exp.CashAmount > 0 {
						totals["EFECTIVO"] -= exp.CashAmount
					}
					if exp.NequiAmount > 0 {
						totals["NEQUI"] -= exp.NequiAmount
					}
					if exp.DaviplataAmount > 0 {
						totals["DAVIPLATA"] -= exp.DaviplataAmount
					}
					if exp.FondoAmount > 0 {
						totals["FONDO"] -= exp.FondoAmount
					}
					if exp.CoinsAmount > 0 {
						totals["MONEDAS"] -= exp.CoinsAmount
					}
				} else if strings.Contains(method, "/") || strings.Contains(method, ":") {
					parts := strings.Split(method, "/")
					for _, part := range parts {
						p := strings.TrimSpace(part)
						var num float64
						if idx := strings.Index(p, "$"); idx != -1 {
							cleanStr := strings.ReplaceAll(p[idx+1:], ".", "")
							cleanStr = strings.ReplaceAll(cleanStr, ",", ".")
							cleanStr = strings.TrimSpace(cleanStr)
							fmt.Sscanf(cleanStr, "%f", &num)
						}
						if num == 0 {
							num = exp.Amount + exp.TaxAmount
						}
						if strings.Contains(p, "NEQUI") {
							totals["NEQUI"] -= num
						} else if strings.Contains(p, "DAVIPLATA") || strings.Contains(p, "DAVI") {
							totals["DAVIPLATA"] -= num
						} else if strings.Contains(p, "FONDO") || strings.Contains(p, "BOVEDA") || strings.Contains(p, "BÓVEDA") || strings.Contains(p, "FOND") {
							totals["FONDO"] -= num
						} else if strings.Contains(p, "CAJA") || strings.Contains(p, "EFECTIVO") || strings.Contains(p, "CASH") {
							totals["EFECTIVO"] -= num
						}
					}
				} else if method == "NEQUI" {
					totals["NEQUI"] -= (exp.Amount + exp.TaxAmount)
				} else if method == "DAVIPLATA" || method == "DAVI" {
					totals["DAVIPLATA"] -= (exp.Amount + exp.TaxAmount)
				} else if method == "FONDO" || method == "BOVEDA" || method == "BÓVEDA" || strings.Contains(method, "FOND") {
					totals["FONDO"] -= (exp.Amount + exp.TaxAmount)
				} else if strings.Contains(method, "PREST") || strings.Contains(method, "DEUDA") {
					// Debt - 0
				} else {
					totals["EFECTIVO"] -= (exp.Amount + exp.TaxAmount)
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
				if method == "" {
					method = "TRANSFERENCIA"
				}
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
	Date    string  `json:"date"`
	Income  float64 `json:"income"`
	Expense float64 `json:"expense"`
	Balance float64 `json:"balance"`
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

	// Hora Colombia y arqueo canónico, igual que el flujo desglosado.
	// Antes: dayStr en UTC, income = TotalCash + TotalTransfer (el efectivo que
	// dice el sistema, no el contado) y expense = TotalExpenses (columna
	// contaminada con el FONDO en los cierres editados).
	loc := time.FixedZone("America/Bogota", -5*60*60)
	allMetrics, err := s.HydrateClosuresBatch(closures)
	if err != nil {
		return nil, err
	}

	for i := range closures {
		c := &closures[i]
		m := allMetrics[i]

		// El turno se agrupa por el DIA DEL NEGOCIO (c.Date), el mismo campo con
		// el que agrupa el historial visual de /reports (ClosuresHistory.tsx usa
		// c.date). NO cambiar a EndDate: un turno que cierra a las 7 a.m.
		// pertenece al día anterior porque casi toda su venta es de ese día.
		ref := c.Date
		if ref.IsZero() {
			ref = c.EndDate
		}
		dayStr := ref.In(loc).Format("2006-01-02")

		income := m.VentasCajero
		expense := m.EgresosTotales

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

	// DESGLOSE DEL EGRESO POR TIPO DE GASTO (pedido del dueño, 2026-09-04).
	//
	// El gran total ya trae el egreso repartido por CANAL (caja, fondo,
	// digital), que responde "por dónde salió la plata". Estos dos campos
	// responden la otra pregunta, la que el dueño usa para decidir: "en QUÉ se
	// gastó". Cada uno suma TODOS los canales.
	//
	// INVARIANTE: ExpenseSuppliers + ExpenseOthers == TotalExpense. Ambos
	// recorren el mismo universo de egresos operativos que alimenta
	// EgresosTotales, con las mismas exclusiones (pendientes, préstamos y
	// devoluciones). Si dejaran de sumar, el reporte no se podría cuadrar a
	// mano y perdería su razón de ser.
	ExpenseSuppliers float64 `json:"expenseSuppliers"`
	ExpenseOthers    float64 `json:"expenseOthers"`
}

type CashFlowDetailedDay struct {
	Date           string                  `json:"date"`
	ClosureCount   int                     `json:"closureCount"`
	TotalIncome    float64                 `json:"totalIncome"`
	TotalExpense   float64                 `json:"totalExpense"`
	IncomeCash     float64                 `json:"incomeCash"`
	IncomeNequi    float64                 `json:"incomeNequi"`
	IncomeDavi     float64                 `json:"incomeDavi"`
	IncomeOther    float64                 `json:"incomeOther"`
	Returns        float64                 `json:"returns"`
	ExpenseCash    float64                 `json:"expenseCash"`
	ExpenseFondo   float64                 `json:"expenseFondo"`
	ExpenseDigital float64                 `json:"expenseDigital"`
	ExpectedCash   float64                 `json:"expectedCash"`
	Difference     float64                 `json:"difference"`
	Events         []CashFlowDetailedEvent `json:"events"`
}

type CashFlowDetailedEvent struct {
	Type           string  `json:"type"`
	Concept        string  `json:"concept"`
	IncomeCash     float64 `json:"incomeCash"`
	IncomeNequi    float64 `json:"incomeNequi"`
	IncomeDavi     float64 `json:"incomeDavi"`
	IncomeOther    float64 `json:"incomeOther"`
	Returns        float64 `json:"returns"`
	IncomeTotal    float64 `json:"incomeTotal"`
	ExpenseCash    float64 `json:"expenseCash"`
	ExpenseFondo   float64 `json:"expenseFondo"`
	ExpenseDigital float64 `json:"expenseDigital"`
	ExpenseTotal   float64 `json:"expenseTotal"`
	// Cifras del arqueo, las mismas que muestra el modal "Ver detalle de cierre".
	ExpectedCash  float64 `json:"expectedCash"`
	Difference    float64 `json:"difference"`
	IncomeSystem  float64 `json:"incomeSystem"`
	NetBalance    float64 `json:"netBalance"`
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

	// Hidratar y calcular el arqueo AQUÍ, en la fuente, para que todos los
	// consumidores (PDF, Excel, CSV) reciban exactamente la misma lista de
	// egresos y las mismas cifras que el detalle del cierre en pantalla.
	// Por lotes: una sola consulta de egresos para todo el rango.
	if _, err := s.HydrateClosuresBatch(closures); err != nil {
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
	// Desglose del egreso por TIPO de gasto para el gran total. Se acumula en el
	// mismo recorrido de cierres para no volver a consultar nada.
	var overallSuppliers, overallOthers float64

	// Zona horaria de Colombia: la pantalla de historial agrupa los cierres en
	// hora local del navegador, así que el reporte debe agrupar igual o los
	// turnos cercanos a medianoche caen en días distintos en cada vista.
	loc := time.FixedZone("America/Bogota", -5*60*60)

	// Turnos (Ingresos principales)
	for i := range closures {
		c := &closures[i]

		// El turno se agrupa por el DIA DEL NEGOCIO (c.Date), el mismo campo con
		// el que agrupa el historial visual de /reports (ClosuresHistory.tsx usa
		// c.date || c.startDate). El dueño lo pidió explícitamente así.
		//
		// EJEMPLO REAL (cierre CC-166): cerró el 29/08 a las 07:38 a.m. pero casi
		// toda su venta es del 28, y la pantalla lo muestra bajo el viernes 28.
		//
		// NO cambiar a EndDate. Se probó el 2026-09-04 asumiendo que la pantalla
		// agrupaba por fecha de cierre y quedó al revés.
		ref := c.Date
		if ref.IsZero() {
			ref = c.EndDate
		}
		dayStr := ref.In(loc).Format("2006-01-02")
		d := getOrCreateDay(dayStr)

		// FUENTE ÚNICA: el arqueo ya viene calculado desde
		// GetCashFlowDetailedRaw, con los egresos hidratados (snapshot + vivos),
		// igual que el detalle del cierre en pantalla.
		m := ComputeClosureMetrics(c)

		otros := c.TotalCard + c.TotalBancolombia + c.TotalOtherTransfer

		cashierName := c.ClosedByName
		if cashierName == "" {
			cashierName = "SIN CAJERO"
		}

		// MISMA fórmula del arqueo que usa el modal en pantalla y SaveClosure:
		// con base de apertura y sin piso a cero.
		expectedCash := c.OpeningCash + c.TotalCash - m.EgresosCaja - c.TotalReturns

		d.Events = append(d.Events, CashFlowDetailedEvent{
			Type: "CIERRE",
			// Sin rango de horas: mostrar "22:00 a 01:00" hacía parecer que el
			// movimiento pertenece a dos días. El turno se identifica por su
			// número y su cajero, y la fecha de la fila ya dice el día.
			Concept:        fmt.Sprintf("Turno #%d - %s", c.ID, cashierName),
			IncomeCash:     m.PhysicalCash,
			IncomeNequi:    c.TotalNequi,
			IncomeDavi:     c.TotalDaviplata,
			IncomeOther:    otros,
			Returns:        c.TotalReturns,
			IncomeTotal:    m.VentasCajero,
			ExpenseCash:    m.EgresosCaja,
			ExpenseFondo:   m.EgresosFondo,
			ExpenseDigital: m.EgresosDigital,
			ExpenseTotal:   m.EgresosTotales,
			// Mismas cifras que el modal "Ver detalle de cierre".
			ExpectedCash: expectedCash,
			Difference:   m.PhysicalCash - expectedCash,
			IncomeSystem: c.TotalCash + m.DigitalIncome,
			NetBalance:   (c.TotalCash + m.DigitalIncome) - m.EgresosTotales - c.TotalReturns,
		})

		d.IncomeCash += m.PhysicalCash
		d.IncomeNequi += c.TotalNequi
		d.IncomeDavi += c.TotalDaviplata
		d.IncomeOther += otros
		d.Returns += c.TotalReturns
		d.ExpenseCash += m.EgresosCaja
		d.ExpenseFondo += m.EgresosFondo
		d.ExpenseDigital += m.EgresosDigital
		d.ExpectedCash += expectedCash
		d.Difference += m.PhysicalCash - expectedCash

		d.TotalIncome += m.VentasCajero
		d.TotalExpense += m.EgresosTotales
		d.ClosureCount++
		overallIncome += m.VentasCajero
		overallExpense += m.EgresosTotales

		// Mismo universo de egresos que EgresosTotales, partido por tipo de
		// gasto. Las dos bolsas suman exactamente EgresosTotales.
		supplierPart, otherPart := SplitExpensesByKind(c.Expenses)
		overallSuppliers += supplierPart
		overallOthers += otherPart
	}

	var daysList []CashFlowDetailedDay
	for _, d := range daysMap {
		daysList = append(daysList, *d)
	}

	sort.Slice(daysList, func(i, j int) bool {
		return daysList[i].Date < daysList[j].Date
	})

	return &CashFlowDetailedReport{
		From:             from,
		To:               to,
		TotalIncome:      overallIncome,
		TotalExpense:     overallExpense,
		TotalBalance:     overallIncome - overallExpense,
		ExpenseSuppliers: overallSuppliers,
		ExpenseOthers:    overallOthers,
		Days:             daysList,
	}, nil
}
