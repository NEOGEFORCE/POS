package services

import (
	"encoding/json"
	"sort"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

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
	}
}

// --- New structs for Dashboard V5 widgets ---

type LowStockItem struct {
	Barcode  string  `json:"barcode"`
	Name     string  `json:"name"`
	Stock    float64 `json:"stock"`
	MinStock float64 `json:"minStock"`
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
	TodaySalesAmount float64            `json:"todaySalesAmount"`
	TodaySalesCount  int64              `json:"todaySalesCount"`
	TodayExpenses    float64            `json:"todayExpenses"`
	ActiveProducts   int64              `json:"activeProducts"`
	TotalProducts    int64              `json:"totalProducts"`
	CategoriesCount  int64              `json:"categoriesCount"`
	LowStockProducts []LowStockItem     `json:"lowStockProducts"`
	SalesByPayment   map[string]float64 `json:"salesByPayment"`
	DailySalesLast7  []DailyPoint       `json:"dailySalesLast7"`
}

type ProductRankingItem struct {
	Barcode  string  `json:"barcode"`
	Name     string  `json:"name"`
	Quantity float64 `json:"quantity"`
	Total    float64 `json:"total"`
}

type CategoryReportItem struct {
	Category string  `json:"category"`
	Total    float64 `json:"total"`
	Quantity float64 `json:"quantity"`
}

type VIPClientItem struct {
	DNI      string  `json:"dni"`
	Name     string  `json:"name"`
	Total    float64 `json:"total"`
	Count    int     `json:"count"`
}

type VoidReportItem struct {
	SaleID    uint      `json:"saleId"`
	Date      time.Time `json:"date"`
	Total     float64   `json:"total"`
	Employee  string    `json:"employee"`
	VoidedAt  time.Time `json:"voidedAt"`
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
	now := time.Now()
	currentMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	nextMonth := currentMonth.AddDate(0, 1, 0)
	todayStr := now.Format("2006-01-02")

	sales, _ := s.saleRepo.GetByDateRange(currentMonth.Format("2006-01-02"), nextMonth.Format("2006-01-02"))
	expenses, _ := s.expenseRepo.GetByDateRange(currentMonth.Format("2006-01-02"), nextMonth.Format("2006-01-02"))
	clientCount, _ := s.clientRepo.Count()

	var totalSalesAmount float64
	var totalProductsSold float64
	var todaySalesAmount float64
	var todaySalesCount int64
	var todayExpenses float64
	salesByDay := make(map[string]float64)
	salesByMonth := make(map[string]float64)
	expensesByMonth := make(map[string]float64)
	profitByMonth := make(map[string]float64)
	salesByPayment := make(map[string]float64)

	for _, sale := range sales {
		totalSalesAmount += sale.TotalAmount

		dayKey := sale.SaleDate.Format("2006-01-02")
		monthKey := sale.SaleDate.Format("2006-01")

		salesByDay[dayKey] += sale.TotalAmount
		salesByMonth[monthKey] += sale.TotalAmount

		// Today's sales
		if dayKey == todayStr {
			todaySalesAmount += sale.TotalAmount
			todaySalesCount++
		}

		// Payment method breakdown (month)
		if sale.CashAmount > 0 {
			salesByPayment["EFECTIVO"] += sale.CashAmount
		}
		if sale.TransferAmount > 0 {
			source := sale.TransferSource
			if source == "" {
				source = "TRANSFERENCIA"
			}
			salesByPayment[source] += sale.TransferAmount
		}
		if sale.CreditAmount > 0 {
			salesByPayment["FIADO"] += sale.CreditAmount
		}

		for _, detail := range sale.SaleDetails {
			totalProductsSold += detail.Quantity
		}
	}

	var totalExpensesAmount float64
	for _, expense := range expenses {
		totalExpensesAmount += expense.Amount
		monthKey := expense.Date.Format("2006-01")
		expensesByMonth[monthKey] += expense.Amount
		// Today's expenses
		if expense.Date.Format("2006-01-02") == todayStr {
			todayExpenses += expense.Amount
		}
	}

	for month, sAmount := range salesByMonth {
		profitByMonth[month] = sAmount - expensesByMonth[month]
	}

	recentSales := []map[string]interface{}{}
	count := len(sales)
	if count > 5 {
		count = 5
	}
	for i := 0; i < count; i++ {
		sale := sales[len(sales)-1-i]
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
		})
	}

	salesByMonth, _ = s.saleRepo.GetMonthlyTotals()
	expensesByMonth, _ = s.expenseRepo.GetMonthlyTotals()
	
	for month, sAmount := range salesByMonth {
		profitByMonth[month] = sAmount - expensesByMonth[month]
	}

	// --- V5: Products, Categories, Low Stock ---
	allProducts, _ := s.productRepo.GetAll()
	totalProducts := int64(len(allProducts))
	var activeProducts int64
	lowStockProducts := []LowStockItem{}
	for _, p := range allProducts {
		if p.Quantity > 0 {
			activeProducts++
		}
		
		threshold := p.MinStock
		if threshold <= 0 {
			threshold = 5 // Default heuristic if not set
		}

		if p.Quantity <= threshold {
			lowStockProducts = append(lowStockProducts, LowStockItem{
				Barcode:  p.Barcode,
				Name:     p.ProductName,
				Stock:    p.Quantity,
				MinStock: threshold,
			})
		}
	}
	// Limit low stock to 10 items
	if len(lowStockProducts) > 10 {
		lowStockProducts = lowStockProducts[:10]
	}

	// Categories count
	categories, _ := s.categoryRepo.GetAll()
	categoriesCount := int64(len(categories))

	// --- V5: Daily Sales Last 7 Days ---
	dailySalesLast7 := []DailyPoint{}
	for i := 6; i >= 0; i-- {
		d := now.AddDate(0, 0, -i)
		key := d.Format("2006-01-02")
		dailySalesLast7 = append(dailySalesLast7, DailyPoint{
			Date:   key,
			Amount: salesByDay[key],
		})
	}
	// Sort by date ascending
	sort.Slice(dailySalesLast7, func(i, j int) bool {
		return dailySalesLast7[i].Date < dailySalesLast7[j].Date
	})

	return &DashboardOverview{
		TotalSalesAmount:    totalSalesAmount,
		TotalExpensesAmount: totalExpensesAmount,
		Profit:              totalSalesAmount - totalExpensesAmount,
		TotalProductsSold:   totalProductsSold,
		TotalClients:        clientCount,
		SalesByDay:          salesByDay,
		RecentSales:         recentSales,
		Monthly: map[string]interface{}{
			"salesByMonth":    salesByMonth,
			"expensesByMonth": expensesByMonth,
			"profitByMonth":   profitByMonth,
		},
		// V5 fields
		TodaySalesAmount: todaySalesAmount,
		TodaySalesCount:  todaySalesCount,
		TodayExpenses:    todayExpenses,
		ActiveProducts:   activeProducts,
		TotalProducts:    totalProducts,
		CategoriesCount:  categoriesCount,
		LowStockProducts: lowStockProducts,
		SalesByPayment:   salesByPayment,
		DailySalesLast7:  dailySalesLast7,
	}, nil
}

type CashierClosure struct {
	Date                 time.Time `json:"date"`
	StartDate            time.Time `json:"startDate"`
	EndDate              time.Time `json:"endDate"`
	SalesCount           int       `json:"salesCount"`
	TotalSales           float64   `json:"totalSales"`
	TotalCash            float64   `json:"totalCash"`
	TotalTransfer        float64   `json:"totalTransfer"`
	TotalNequi           float64   `json:"totalNequi"`
	TotalDaviplata       float64   `json:"totalDaviplata"`
	TotalBancolombia     float64   `json:"totalBancolombia"`
	TotalOtherTransfer   float64   `json:"totalOtherTransfer"`
	TotalExpenses        float64   `json:"totalExpenses"`
	TotalReturns         float64   `json:"totalReturns"`
	TotalCreditIssued    float64   `json:"totalCreditIssued"`
	TotalCreditCollected float64   `json:"totalCreditCollected"`
	OpeningCash          float64          `json:"openingCash"`
	NetBalance           float64          `json:"netBalance"`
	Expenses             []models.Expense `json:"expenses"`
	ExpensesDetail       string           `json:"expensesDetail"`
}

func (s *DashboardService) GetCashierClosure() (*CashierClosure, error) {
	activeShift, err := s.shiftRepo.GetActive()
	var startDate time.Time
	var openingCash float64

	if err == nil && activeShift != nil {
		startDate = activeShift.StartTime
		openingCash = activeShift.OpeningCash
	} else {
		lastClosure, _ := s.closureRepo.GetLast()
		startDate = time.Date(time.Now().Year(), time.Now().Month(), time.Now().Day(), 0, 0, 0, 0, time.UTC)
		if lastClosure != nil {
			startDate = lastClosure.EndDate
		}
	}

	startStr := startDate.Format("2006-01-02")
	endStr := time.Now().AddDate(0, 0, 1).Format("2006-01-02")

	sales, _ := s.saleRepo.GetByDateRange(startStr, endStr)
	expenses, _ := s.expenseRepo.GetByDateRange(startStr, endStr)
	returns, _ := s.returnRepo.GetByDateRange(startStr, endStr)

	var closure CashierClosure
	closure.Date = time.Now()
	closure.StartDate = startDate
	closure.EndDate = time.Now()

	for _, sale := range sales {
		if !sale.SaleDate.Before(startDate) {
			closure.SalesCount++
			closure.TotalSales += sale.TotalAmount
			closure.TotalCash += sale.CashAmount
			closure.TotalTransfer += sale.TransferAmount
			closure.TotalCreditIssued += sale.CreditAmount

			// Desglose por origen
			if sale.TransferAmount > 0 {
				switch sale.TransferSource {
				case "NEQUI":
					closure.TotalNequi += sale.TransferAmount
				case "DAVIPLATA":
					closure.TotalDaviplata += sale.TransferAmount
				case "BANCOLOMBIA":
					closure.TotalBancolombia += sale.TransferAmount
				default:
					closure.TotalOtherTransfer += sale.TransferAmount
				}
			}
		}
	}

	// Obtener y sumar abonos (pagos de deudas)
	payments, _ := s.creditRepo.GetByDateRange(startDate, time.Now())
	for _, p := range payments {
		closure.TotalCash += p.AmountCash
		closure.TotalTransfer += p.AmountTransfer
		closure.TotalCreditCollected += p.TotalPaid

		if p.AmountTransfer > 0 {
			switch p.TransferSource {
			case "NEQUI":
				closure.TotalNequi += p.AmountTransfer
			case "DAVIPLATA":
				closure.TotalDaviplata += p.AmountTransfer
			case "BANCOLOMBIA":
				closure.TotalBancolombia += p.AmountTransfer
			default:
				closure.TotalOtherTransfer += p.AmountTransfer
			}
		}
	}

	for _, ret := range returns {
		if !ret.Date.Before(startDate) {
			closure.TotalReturns += ret.TotalReturned
		}
	}

	for _, expense := range expenses {
		if !expense.Date.Before(startDate) {
			closure.TotalExpenses += expense.Amount
			closure.Expenses = append(closure.Expenses, expense)
		}
	}

	// El NetBalance ahora NO incluye el OpeningCash (petición del usuario: "no debería sumarse")
	// Es puramente operativo del turno
	closure.NetBalance = (closure.TotalSales - closure.TotalCreditIssued) + closure.TotalCreditCollected - closure.TotalReturns - closure.TotalExpenses
	closure.OpeningCash = openingCash

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

	// 3. Automatically open a new shift with the default base ($120,000)
	newShift := &models.ActiveShift{
		StartTime:   time.Now(),
		OpeningCash: 120000,
		CashierDNI:  closureDTO.ClosedByDNI,
		CashierName: closureDTO.ClosedByName,
		Status:      "OPEN",
	}
	return s.shiftRepo.Save(newShift)
}

func (s *DashboardService) GetClosuresHistory() ([]models.CashierClosure, error) {
	return s.closureRepo.GetAll()
}

func (s *DashboardService) GetRankingReport(from, to string) ([]ProductRankingItem, error) {
	sales, err := s.saleRepo.GetByDateRange(from, to)
	if err != nil {
		return nil, err
	}

	rankingMap := make(map[string]*ProductRankingItem)
	for _, sale := range sales {
		for _, detail := range sale.SaleDetails {
			if _, ok := rankingMap[detail.Barcode]; !ok {
				name := detail.Barcode
				if detail.Product.ProductName != "" {
					name = detail.Product.ProductName
				}
				rankingMap[detail.Barcode] = &ProductRankingItem{
					Barcode: detail.Barcode,
					Name:    name,
				}
			}
			rankingMap[detail.Barcode].Quantity += detail.Quantity
			rankingMap[detail.Barcode].Total += detail.Subtotal
		}
	}

	ranking := []ProductRankingItem{}
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
			SaleID:    r.SaleID,
			Date:      r.Date, // Effective return date
			Total:     r.TotalReturned,
			Employee:  r.EmployeeDNI,
			VoidedAt:  r.Date,
		})
	}

	// Add deleted sales
	for _, ds := range deletedSales {
		report = append(report, VoidReportItem{
			SaleID:    ds.SaleID,
			Date:      ds.SaleDate,
			Total:     ds.TotalAmount,
			Employee:  ds.EmployeeDNI,
			VoidedAt:  ds.DeletedAt.Time,
		})
	}

	// Sort by voidedAt descending
	sort.Slice(report, func(i, j int) bool {
		return report[i].VoidedAt.After(report[j].VoidedAt)
	})

	return report, nil
}

func (s *DashboardService) GetPnLReport(from, to string) (*PnLReport, error) {
	sales, err := s.saleRepo.GetByDateRange(from, to)
	if err != nil {
		return nil, err
	}

	expenses, err := s.expenseRepo.GetByDateRange(from, to)
	if err != nil {
		expenses = []models.Expense{}
	}

	var revenue float64
	var cogs float64
	for _, sale := range sales {
		revenue += sale.TotalAmount
		for _, detail := range sale.SaleDetails {
			// Usar el CostPrice guardado en la venta para integridad histórica
			// Si no existe (ventas antiguas), usar el PurchasePrice actual del producto
			cost := detail.CostPrice
			if cost == 0 {
				cost = detail.Product.PurchasePrice
			}
			cogs += detail.Quantity * cost
		}
	}

	var totalExpenses float64
	for _, e := range expenses {
		totalExpenses += e.Amount
	}

	grossProfit := revenue - cogs
	netProfit := grossProfit - totalExpenses
	margin := 0.0
	if revenue > 0 {
		margin = (netProfit / revenue) * 100
	}

	return &PnLReport{
		From:             from,
		To:               to,
		TotalRevenue:     revenue,
		TotalCOGS:        cogs,
		GrossProfit:      grossProfit,
		TotalExpenses:    totalExpenses,
		NetProfit:        netProfit,
		MarginPercentage: margin,
	}, nil
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
