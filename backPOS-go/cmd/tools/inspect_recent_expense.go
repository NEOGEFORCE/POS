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
	ID              uint      `gorm:"primaryKey"`
	Description     string
	Amount          float64
	Date            time.Time
	PaymentSource   string    `gorm:"column:paymentSource"`
	CashAmount      float64   `gorm:"column:cash_amount"`
	NequiAmount     float64   `gorm:"column:nequi_amount"`
	DaviplataAmount float64   `gorm:"column:daviplata_amount"`
	FondoAmount     float64   `gorm:"column:fondo_amount"`
	Status          string
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

	var expenses []Expense
	db.Table("expenses").Order("id DESC").Limit(5).Find(&expenses)

	fmt.Println("=== ULTIMOS 5 EGRESOS EN BD ===")
	for _, e := range expenses {
		fmt.Printf("ID: %d | Desc: %s | Total: $%.2f | Fecha: %s | PaymentSource: %s\n",
			e.ID, e.Description, e.Amount, e.Date.Format("2006-01-02 15:04"), e.PaymentSource)
		fmt.Printf("   Cash: $%.2f | Nequi: $%.2f | Daviplata: $%.2f | Fondo: $%.2f\n",
			e.CashAmount, e.NequiAmount, e.DaviplataAmount, e.FondoAmount)
		fmt.Println("--------------------------------------------------")
	}
}
