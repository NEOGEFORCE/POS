package main

import (
	"backPOS-go/internal/core/domain/models"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

var amountRegex = regexp.MustCompile(`\$?([0-9.,]+)`)

func extractAmountFromText(text string) float64 {
	match := amountRegex.FindStringSubmatch(text)
	if len(match) < 2 {
		return 0
	}
	s := match[1]
	if strings.Contains(s, ",") {
		s = strings.ReplaceAll(s, ".", "")
		s = strings.ReplaceAll(s, ",", ".")
	} else if strings.Contains(s, ".") {
		matched, _ := regexp.MatchString(`\.\d{1,2}$`, s)
		if !matched {
			s = strings.ReplaceAll(s, ".", "")
		}
	}
	val, _ := strconv.ParseFloat(s, 64)
	return val
}

func parseExpenseChannels(e *models.Expense) (finalCash, finalNequi, finalDavi, finalFondo float64) {
	if strings.ToUpper(e.Status) == "PENDING" {
		return 0, 0, 0, 0
	}
	src := strings.ToUpper(e.PaymentSource)
	tax := e.TaxAmount
	base := e.Amount
	total := base + tax

	if strings.Contains(src, "/") {
		parts := strings.Split(src, "/")
		for _, part := range parts {
			p := strings.TrimSpace(part)
			val := extractAmountFromText(p)
			if strings.Contains(p, "NEQUI") || strings.Contains(p, "NEQ") {
				finalNequi += val
			} else if strings.Contains(p, "DAVIPLATA") || strings.Contains(p, "DAVI") {
				finalDavi += val
			} else if strings.Contains(p, "FONDO") || strings.Contains(p, "BOVEDA") || strings.Contains(p, "BÓVEDA") || strings.Contains(p, "FOND") {
				finalFondo += val
			} else if strings.Contains(p, "CAJA") || strings.Contains(p, "EFECTIVO") || strings.Contains(p, "CASH") || strings.Contains(p, "EFEC") {
				finalCash += val
			}
		}
		if finalCash+finalNequi+finalDavi+finalFondo > 0 {
			return finalCash, finalNequi, finalDavi, finalFondo
		}
	}

	if src == "NEQUI" {
		return 0, total, 0, 0
	} else if src == "DAVIPLATA" || src == "DAVI" {
		return 0, 0, total, 0
	} else if src == "FONDO" || src == "BOVEDA" || src == "BÓVEDA" || strings.Contains(src, "FOND") {
		return 0, 0, 0, total
	} else if strings.Contains(src, "PREST") || src == "DEUDA" {
		return 0, 0, 0, 0
	}

	rawCash := e.CashAmount
	rawNequi := e.NequiAmount
	rawDavi := e.DaviplataAmount
	rawFondo := e.FondoAmount
	sum := rawCash + rawNequi + rawDavi + rawFondo

	if sum > 0 {
		finalCash = rawCash
		finalNequi = rawNequi
		finalDavi = rawDavi
		finalFondo = rawFondo
		if tax > 0 && sum == base {
			count := 0
			if rawCash > 0 { count++ }
			if rawNequi > 0 { count++ }
			if rawDavi > 0 { count++ }
			if rawFondo > 0 { count++ }
			if count <= 1 {
				if rawCash > 0 { finalCash += tax }
				if rawNequi > 0 { finalNequi += tax }
				if rawDavi > 0 { finalDavi += tax }
				if rawFondo > 0 { finalFondo += tax }
			} else {
				if rawNequi > 0 { finalNequi += tax } else if rawDavi > 0 { finalDavi += tax } else if rawFondo > 0 { finalFondo += tax } else { finalCash += tax }
			}
		}
		return finalCash, finalNequi, finalDavi, finalFondo
	}

	return total, 0, 0, 0
}

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error connecting DB: %v", err)
	}

	loc, _ := time.LoadLocation("America/Bogota")
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, loc)
	to := time.Date(2026, 7, 31, 23, 59, 59, 999999999, loc)

	var closures []models.CashierClosure
	if err := db.Where("deleted_at IS NULL AND start_date >= ? AND start_date <= ?", from.UTC(), to.UTC()).Find(&closures).Error; err != nil {
		log.Fatalf("Error fetching closures: %v", err)
	}

	var sumVentasCajero float64
	var sumVentasSistema float64
	var sumRealBalance float64

	for i := range closures {
		c := &closures[i]
		if c.ExpensesDetail != "" {
			var snapshotExps []models.Expense
			if err := json.Unmarshal([]byte(c.ExpensesDetail), &snapshotExps); err == nil && len(snapshotExps) > 0 {
				c.Expenses = snapshotExps
			}
		}

		cDigitalIncome := c.TotalNequi + c.TotalDaviplata + c.TotalCard + c.TotalBancolombia + c.TotalOtherTransfer
		cCashIngresos := c.TotalCash + c.TotalCreditCollected

		cEgresosCaja := 0.0
		for _, e := range c.Expenses {
			cash, _, _, _ := parseExpenseChannels(&e)
			cEgresosCaja += cash
		}

		cExpectedCashFinal := c.ExpectedCash
		if cExpectedCashFinal == 0 {
			cExpectedCashFinal = cCashIngresos - cEgresosCaja - c.TotalReturns
		}

		cVentasCajero := c.PhysicalCash + cDigitalIncome + cEgresosCaja + c.TotalReturns
		cVentasSistema := cExpectedCashFinal + cDigitalIncome + cEgresosCaja
		cRealBalance := cVentasCajero - cVentasSistema

		sumVentasCajero += cVentasCajero
		sumVentasSistema += cVentasSistema
		sumRealBalance += cRealBalance
	}

	fmt.Printf("=== SUM OF ALL 37 INDIVIDUAL SHIFTS ===\n")
	fmt.Printf("Sum of Ventas Totales (Cajero): $%.2f\n", sumVentasCajero)
	fmt.Printf("Sum of Ventas Totales (Sist.): $%.2f\n", sumVentasSistema)
	fmt.Printf("Sum of Balance Real / Descuadre: $%.2f\n", sumRealBalance)
}
