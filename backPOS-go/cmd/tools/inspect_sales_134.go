//go:build tools_legacy
// +build tools_legacy


﻿package main

import (
	"fmt"
	"log"
	"os"
	"time"

	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Sale struct {
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

	from, _ := time.Parse("2006-01-02 15:04:05", "2026-08-08 14:02:00")
	to, _ := time.Parse("2006-01-02 15:04:05", "2026-08-08 21:40:00")

	var sales []Sale
	db.Table("sales").Where("\"saleDate\" >= ? AND \"saleDate\" <= ? AND deleted_at IS NULL", from, to).Order("\"saleId\" ASC").Find(&sales)

	fmt.Printf("=== AUDITORIA DE VENTAS EN TURNO ID 134 (%d ventas) ===\n", len(sales))
	var sumTotal, sumCash, sumTransfer, sumNequi, sumDaviplata, sumCredit float64
	for _, s := range sales {
		netCash := s.CashAmount - s.Change
		if netCash < 0 { netCash = 0 }

		nequi := s.TransferNequi
		if nequi == 0 && s.TransferSource == "NEQUI" { nequi = s.TransferAmount }
		davi := s.TransferDaviplata
		if davi == 0 && (s.TransferSource == "DAVIPLATA" || s.TransferSource == "DAVI") { davi = s.TransferAmount }

		sumTotal += s.TotalAmount
		sumCash += netCash
		sumTransfer += s.TransferAmount
		sumNequi += nequi
		sumDaviplata += davi
		sumCredit += s.CreditAmount

		if s.PaymentMethod == "MIXTO" || (s.CashAmount > 0 && s.TransferAmount > 0) {
			fmt.Printf(" [MIXTA #%d] Total: $%.2f | Método: %s | Cash: $%.2f (Neto $%.2f) | Trans: $%.2f (Nequi: $%.2f, Davi: $%.2f) | Cambio: $%.2f\n",
				s.SaleID, s.TotalAmount, s.PaymentMethod, s.CashAmount, netCash, s.TransferAmount, nequi, davi, s.Change)
		}
	}

	fmt.Println("--------------------------------------------------")
	fmt.Printf("REPORTE CALCULADO REAL DEL TURNO:\n")
	fmt.Printf("  Total Ventas: $%.2f\n", sumTotal)
	fmt.Printf("  Efectivo Neto Cobrado: $%.2f\n", sumCash)
	fmt.Printf("  Transferencias Totales: $%.2f (Nequi: $%.2f, Daviplata: $%.2f)\n", sumTransfer, sumNequi, sumDaviplata)
	fmt.Printf("  Fiados / Créditos: $%.2f\n", sumCredit)
}
