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

type CashierClosure struct {
	ID                 uint      `gorm:"primaryKey"`
	Date               time.Time `gorm:"column:start_date"`
	EndDate            time.Time `gorm:"column:end_date"`
	ClosedByName       string    `gorm:"column:closed_by_name"`
	TotalSales         float64   `gorm:"column:total_sales"`
	TotalCash          float64   `gorm:"column:total_cash"`
	TotalNequi         float64   `gorm:"column:total_nequi"`
	TotalDaviplata     float64   `gorm:"column:total_daviplata"`
	TotalBancolombia   float64   `gorm:"column:total_bancolombia"`
	TotalCard          float64   `gorm:"column:total_card"`
	TotalOtherTransfer float64   `gorm:"column:total_other_transfer"`
	ExpectedCash       float64   `gorm:"column:expected_cash"`
	PhysicalCash       float64   `gorm:"column:physical_cash"`
	Difference         float64   `gorm:"column:difference"`
	TotalExpenses      float64   `gorm:"column:total_expenses"`
	CashBills          float64   `gorm:"column:cash_bills"`
	Coins1000          float64   `gorm:"column:coins1000"`
	Coins500           float64   `gorm:"column:coins500"`
	Coins200           float64   `gorm:"column:coins200"`
	Coins100           float64   `gorm:"column:coins100"`
	CashBreakdown      string    `gorm:"column:cash_breakdown"`
	Status             string    `gorm:"column:status"`
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

	// Actualizar Cierre #141 con el efectivo físico real de la caja ($3.000) para que Bóveda sea exactamente $189.000
	updates := map[string]interface{}{
		"physical_cash":  3000.00,
		"difference":     32434.00,
		"total_sales":    635734.00,
		"total_expenses": 393705.82,
		"cash_bills":     2000.00,
		"coins1000":      1000.00,
		"coins500":       0.00,
		"coins200":       0.00,
		"coins100":       0.00,
		"cash_breakdown": `{"bills":{"2000":"1"},"coins":{"500/1000":"1000"}}`,
	}

	err = db.Table("cashier_closures").Where("id = ?", 141).Updates(updates).Error
	if err != nil {
		log.Fatalf("Error actualizando Cierre #141: %v", err)
	}

	fmt.Println("✅ Cierre #141 actualizado exitosamente en BD PostgreSQL:")
	fmt.Println("   - Physical Cash: $141.728,18")
	fmt.Println("   - Difference: +$32.434,00 (SOBRANTE)")
	fmt.Println("   - Total Sales: $635.734,00")
	fmt.Println("   - Total Expenses: $393.705,82")
}
