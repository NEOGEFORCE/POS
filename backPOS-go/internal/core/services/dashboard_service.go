package services

import (
	"encoding/json"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

type DashboardService struct {
	saleRepo    ports.SaleRepository
	productRepo ports.ProductRepository
	clientRepo  ports.ClientRepository
	expenseRepo ports.ExpenseRepository
	returnRepo  ports.ReturnRepository
	closureRepo ports.ClosureRepository
	shiftRepo   ports.ActiveShiftRepository
	creditRepo  ports.CreditPaymentRepository
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
) *DashboardService {
	return &DashboardService{
		saleRepo:    s,
		productRepo: p,
		clientRepo:  c,
		expenseRepo: e,
		returnRepo:  r,
		closureRepo: cl,
		shiftRepo:   sh,
		creditRepo:  cr,
	}
}

type DashboardOverview struct {
	TotalSalesAmount    float64                  `json:"totalSalesAmount"`
	TotalExpensesAmount float64                  `json:"totalExpensesAmount"`
	Profit              float64                  `json:"profit"`
	TotalProductsSold   int64                    `json:"totalProductsSold"`
	TotalClients        int64                    `json:"totalClients"`
	SalesByDay          map[string]float64       `json:"salesByDay"`
	RecentSales         []map[string]interface{} `json:"recentSales"`
	Monthly             map[string]interface{}   `json:"monthly"`
}

func (s *DashboardService) GetOverview() (*DashboardOverview, error) {
	now := time.Now()
	currentMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	nextMonth := currentMonth.AddDate(0, 1, 0)

	sales, _ := s.saleRepo.GetByDateRange(currentMonth.Format("2006-01-02"), nextMonth.Format("2006-01-02"))
	expenses, _ := s.expenseRepo.GetByDateRange(currentMonth.Format("2006-01-02"), nextMonth.Format("2006-01-02"))
	clientCount, _ := s.clientRepo.Count()

	var totalSalesAmount float64
	var totalProductsSold int64
	salesByDay := make(map[string]float64)
	salesByMonth := make(map[string]float64)
	expensesByMonth := make(map[string]float64)
	profitByMonth := make(map[string]float64)

	for _, sale := range sales {
		totalSalesAmount += sale.TotalAmount

		dayKey := sale.SaleDate.Format("2006-01-02")
		monthKey := sale.SaleDate.Format("2006-01")

		salesByDay[dayKey] += sale.TotalAmount
		salesByMonth[monthKey] += sale.TotalAmount

		for _, detail := range sale.SaleDetails {
			totalProductsSold += int64(detail.Quantity)
		}
	}

	var totalExpensesAmount float64
	for _, expense := range expenses {
		totalExpensesAmount += expense.Amount
		monthKey := expense.Date.Format("2006-01")
		expensesByMonth[monthKey] += expense.Amount
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

	allTimeSales, _ := s.saleRepo.GetAll()
	for _, sale := range allTimeSales {
		monthKey := sale.SaleDate.Format("2006-01")
		salesByMonth[monthKey] += sale.TotalAmount
	}
	allTimeExpenses, _ := s.expenseRepo.GetAll()
	for _, expense := range allTimeExpenses {
		monthKey := expense.Date.Format("2006-01")
		expensesByMonth[monthKey] += expense.Amount
	}
	for month, sAmount := range salesByMonth {
		profitByMonth[month] = sAmount - expensesByMonth[month]
	}

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
