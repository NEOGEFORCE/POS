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

type Expense struct {
	ID              uint      `gorm:"primaryKey" json:"id"`
	Description     string    `json:"description"`
	Amount          float64   `json:"amount"`
	PaymentSource   string    `gorm:"column:paymentSource" json:"paymentSource"`
	Status          string    `json:"status"`
	CashAmount      float64   `gorm:"column:cash_amount" json:"cashAmount"`
	NequiAmount     float64   `gorm:"column:nequi_amount" json:"nequiAmount"`
	DaviplataAmount float64   `gorm:"column:daviplata_amount" json:"daviplataAmount"`
	FondoAmount     float64   `gorm:"column:fondo_amount" json:"fondoAmount"`
	CoinsAmount     float64   `gorm:"column:coins_amount" json:"coinsAmount"`
	Date            time.Time `json:"date"`
	DeletedAt       gorm.DeletedAt
}

func main() {
	_ = godotenv.Load()
	host := os.Getenv("DB_HOST")
	if host == "" { host = "127.0.0.1" }
	port := os.Getenv("DB_PORT")
	if port == "" { port = "5432" }
	user := os.Getenv("DB_USER")
	if user == "" { user = "postgres" }
	pass := os.Getenv("DB_PASSWORD")
	if pass == "" { pass = "postgres" }
	dbname := os.Getenv("DB_NAME")
	if dbname == "" { dbname = "sistemapos" }

	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable TimeZone=America/Bogota", host, user, pass, dbname, port)
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error conectando a BD: %v", err)
	}

	var expenses []Expense
	err = db.Table("expenses").Where("LOWER(description) LIKE '%altipal%' OR LOWER(description) LIKE '%cigarrillo%' OR coins_amount > 0 OR LOWER(COALESCE(\"paymentSource\", '')) LIKE '%moneda%' OR LOWER(COALESCE(\"paymentSource\", '')) LIKE '%alcancia%'").Order("id DESC").Limit(10).Find(&expenses).Error
	if err != nil {
		log.Fatalf("Error buscando egresos: %v", err)
	}

	fmt.Println("=== EGRESOS ALTIPAL / MONEDAS / ALCANCIA RECIENTES ===")
	for _, e := range expenses {
		fmt.Printf("ID: %d | Desc: %s | Monto: $%.2f | Status: %s | Source: '%s'\n", e.ID, e.Description, e.Amount, e.Status, e.PaymentSource)
		fmt.Printf("   Cash: $%.2f | Nequi: $%.2f | Davi: $%.2f | Fondo: $%.2f | Coins: $%.2f\n", e.CashAmount, e.NequiAmount, e.DaviplataAmount, e.FondoAmount, e.CoinsAmount)
		fmt.Printf("   Date: %v | DeletedAt: %v\n", e.Date, e.DeletedAt)
		fmt.Println("--------------------------------------------------")
	}

	var allRecent []Expense
	db.Table("expenses").Where("deleted_at IS NULL").Order("id DESC").Limit(15).Find(&allRecent)
	fmt.Println("=== ULTIMOS 15 EGRESOS CUALQUIERA ===")
	for _, e := range allRecent {
		fmt.Printf("ID: %d | Desc: %s | Monto: $%.2f | Status: %s | Source: '%s'\n", e.ID, e.Description, e.Amount, e.Status, e.PaymentSource)
		fmt.Printf("   Cash: $%.2f | Nequi: $%.2f | Davi: $%.2f | Fondo: $%.2f | Coins: $%.2f\n", e.CashAmount, e.NequiAmount, e.DaviplataAmount, e.FondoAmount, e.CoinsAmount)
		fmt.Printf("   Date: %v\n", e.Date)
		fmt.Println("--------------------------------------------------")
	}
}
