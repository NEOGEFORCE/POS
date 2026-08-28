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

type Closure struct {
	ID                     uint      `gorm:"primaryKey"`
	Date                   time.Time
	EndDate                time.Time
	ClosedByName           string
	TotalSales             float64
	TotalCash              float64
	TotalNequi             float64
	TotalDaviplata         float64
	TotalBancolombia       float64
	TotalCard              float64
	TotalOtherTransfer     float64
	ExpectedCash           float64
	PhysicalCash           float64
	Difference             float64
	TotalExpenses          float64
	Coins1000              float64
	Coins500               float64
	Coins200               float64
	Coins100               float64
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

	var closures []Closure
	db.Table("cashier_closures").Order("id DESC").Limit(3).Find(&closures)

	fmt.Println("=== ULTIMOS 3 CIERRES DE CAJA ===")
	for _, c := range closures {
		fmt.Printf("ID: %d | Fecha: %s - %s | Creado por: %s\n", c.ID, c.Date.Format("2006-01-02 15:04"), c.EndDate.Format("15:04"), c.ClosedByName)
		fmt.Printf("   Venta Total: $%.2f | Efectivo Esperado: $%.2f | Efectivo Físico: $%.2f | Dif: $%.2f\n", c.TotalSales, c.ExpectedCash, c.PhysicalCash, c.Difference)
		fmt.Printf("   Nequi: $%.2f | Daviplata: $%.2f | Bancolombia: $%.2f | Egresos: $%.2f\n", c.TotalNequi, c.TotalDaviplata, c.TotalBancolombia, c.TotalExpenses)
		fmt.Printf("   Monedas: 1000/500=$%.2f, 200=$%.2f, 100=$%.2f\n", c.Coins1000+c.Coins500, c.Coins200, c.Coins100)
		fmt.Println("--------------------------------------------------")
	}
}
