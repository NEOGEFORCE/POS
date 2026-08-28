//go:build tools_legacy
// +build tools_legacy


﻿package main

import (
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type ClosureRecord struct {
	ID                 uint      `gorm:"primaryKey"`
	Date               time.Time
	EndDate            time.Time
	ClosedByName       string
	TotalSales         float64
	TotalCash          float64
	TotalNequi         float64
	TotalDaviplata     float64
	TotalBancolombia   float64
	TotalCard          float64
	TotalOtherTransfer float64
	ExpectedCash       float64
	PhysicalCash       float64
	Difference         float64
	TotalExpenses      float64
	Coins1000          float64
	Coins500           float64
	Coins200           float64
	Coins100           float64
}

type SaleRecord struct {
	SaleID            uint      `gorm:"column:saleId"`
	SaleDate          time.Time `gorm:"column:saleDate"`
	TotalAmount       float64   `gorm:"column:totalAmount"`
	PaymentMethod     string    `gorm:"column:paymentMethod"`
	AmountPaid        float64   `gorm:"column:amountPaid"`
	CashAmount        float64   `gorm:"column:cashAmount"`
	TransferAmount    float64   `gorm:"column:transferAmount"`
	TransferNequi     float64   `gorm:"column:transferNequi"`
	TransferDaviplata float64   `gorm:"column:transferDaviplata"`
	TransferSource    string    `gorm:"column:transferSource"`
	CreditAmount      float64   `gorm:"column:creditAmount"`
	Change            float64   `gorm:"column:change"`
	Status            string    `gorm:"column:status"`
}

type ExpenseRecord struct {
	ID            uint    `gorm:"primaryKey"`
	Amount        float64
	TaxAmount     float64
	PaymentSource string `gorm:"column:paymentSource"`
	Date          time.Time
	Status        string
}

func main() {
	_ = godotenv.Load()
	host := os.Getenv("DB_HOST")
	if host == "" { host = "192.168.1.6" }
	port := os.Getenv("DB_PORT")
	if port == "" { port = "5432" }
	user := os.Getenv("DB_USER")
	if user == "" { user = "postgres" }
	pass := os.Getenv("DB_PASSWORD")
	if pass == "" { pass = "123" }
	dbname := os.Getenv("DB_NAME")
	if dbname == "" { dbname = "sistemapos" }

	dbURL := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=disable", host, port, user, pass, dbname)

	db, err := gorm.Open(postgres.Open(dbURL), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error conectando a BD: %v", err)
	}

	var closures []ClosureRecord
	db.Table("cashier_closures").Order("id DESC").Limit(3).Find(&closures)

	fmt.Println("=== AUDITORIA Y AJUSTE DE ULTIMOS 3 CIERRES ===")
	for i := len(closures) - 1; i >= 0; i-- {
		c := closures[i]
		
		var prevClosureEnd time.Time
		if i < len(closures)-1 {
			prevClosureEnd = closures[i+1].EndDate
			if prevClosureEnd.IsZero() { prevClosureEnd = closures[i+1].Date }
		} else {
			// Cierre previo al antepenúltimo
			var prevC ClosureRecord
			db.Table("cashier_closures").Where("id < ?", c.ID).Order("id DESC").First(&prevC)
			prevClosureEnd = prevC.EndDate
			if prevClosureEnd.IsZero() { prevClosureEnd = prevC.Date }
		}

		cEnd := c.EndDate
		if cEnd.IsZero() { cEnd = c.Date }

		var sales []SaleRecord
		db.Table("sales").Where("\"saleDate\" >= ? AND \"saleDate\" <= ? AND deleted_at IS NULL", prevClosureEnd, cEnd).Find(&sales)

		var totalSales, cashSales, nequiSales, daviplataSales, creditSales float64
		for _, s := range sales {
			netCash := s.CashAmount - s.Change
			if netCash < 0 { netCash = 0 }

			nequi := s.TransferNequi
			if nequi == 0 && strings.ToUpper(s.TransferSource) == "NEQUI" { nequi = s.TransferAmount }
			davi := s.TransferDaviplata
			if davi == 0 && (strings.ToUpper(s.TransferSource) == "DAVIPLATA" || strings.ToUpper(s.TransferSource) == "DAVI") { davi = s.TransferAmount }

			totalSales += s.TotalAmount
			cashSales += netCash
			nequiSales += nequi
			daviplataSales += davi
			creditSales += s.CreditAmount
		}

		var expenses []ExpenseRecord
		db.Table("expenses").Where("date >= ? AND date <= ? AND UPPER(status) != 'PENDING' AND deleted_at IS NULL", prevClosureEnd, cEnd).Find(&expenses)

		var totalExpenses, cashExpenses float64
		for _, e := range expenses {
			amt := e.Amount + e.TaxAmount
			totalExpenses += amt
			src := strings.ToUpper(e.PaymentSource)
			if src == "" || src == "EFECTIVO" || src == "CAJA" || strings.HasPrefix(src, "CAJA") {
				cashExpenses += amt
			}
		}

		// Reconstruir Efectivo Esperado Real: CashSales - CashExpenses
		// (Nota: Si había base inicial se considera, pero para el turno: CashSales - CashExpenses)
		expectedCashReal := cashSales - cashExpenses
		if expectedCashReal < 0 { expectedCashReal = 0 }
		diffReal := c.PhysicalCash - expectedCashReal

		fmt.Printf("\nCIERRE ID %d (%s):\n", c.ID, c.Date.Format("2006-01-02 15:04"))
		fmt.Printf("  [EN BD]   Ventas: $%.2f | Nequi: $%.2f | Daviplata: $%.2f | Esp: $%.2f | Fis: $%.2f | Dif: $%.2f\n",
			c.TotalSales, c.TotalNequi, c.TotalDaviplata, c.ExpectedCash, c.PhysicalCash, c.Difference)
		fmt.Printf("  [REAL]    Ventas: $%.2f | Nequi: $%.2f | Daviplata: $%.2f | Cash: $%.2f | EgresosEfe: $%.2f\n",
			totalSales, nequiSales, daviplataSales, cashSales, cashExpenses)

		// Actualizar la fila en BD con los valores reales auditados
		updates := map[string]interface{}{
			"total_sales":      totalSales,
			"total_cash":       cashSales,
			"total_nequi":      nequiSales,
			"total_daviplata":  daviplataSales,
			"total_expenses":   totalExpenses,
			"expected_cash":    expectedCashReal,
			"difference":       diffReal,
		}

		err := db.Table("cashier_closures").Where("id = ?", c.ID).Updates(updates).Error
		if err != nil {
			fmt.Printf("  ❌ Error actualizando Cierre ID %d: %v\n", c.ID, err)
		} else {
			fmt.Printf("  ✅ Cierre ID %d actualizado exitosamente en BD con ventas reales.\n", c.ID)
		}
	}
}
