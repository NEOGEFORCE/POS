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

type SaleInfo struct {
	SaleID        uint      `gorm:"column:saleId"`
	SaleDate      time.Time `gorm:"column:saleDate"`
	EmployeeDNI   string    `gorm:"column:employeeDni"`
	TotalAmount   float64   `gorm:"column:totalAmount"`
	PaymentMethod string    `gorm:"column:paymentMethod"`
}

type SaleDetailInfo struct {
	SaleID      uint    `gorm:"column:saleId"`
	Barcode     string  `gorm:"column:barcode"`
	ProductName string  `gorm:"column:productName"`
	Quantity    float64 `gorm:"column:quantity"`
	Subtotal    float64 `gorm:"column:subtotal"`
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

	todayStart := time.Now().Format("2006-01-02") + " 00:00:00"

	var sales []SaleInfo
	db.Table("sales").Where("deleted_at IS NULL AND \"saleDate\" >= ?", todayStart).Order("\"saleId\" DESC").Find(&sales)

	fmt.Printf("=== VENTAS REGISTRADAS HOY (%s) ===\n", time.Now().Format("2006-01-02"))
	fmt.Printf("Total de ventas hoy: %d\n\n", len(sales))

	for _, s := range sales {
		fmt.Printf("Venta #%d | Hora: %s | Empleado: %s | Total: $%.2f | Método: %s\n",
			s.SaleID, s.SaleDate.Format("15:04:05"), s.EmployeeDNI, s.TotalAmount, s.PaymentMethod)

		var details []SaleDetailInfo
		db.Table("sale_details").
			Select("sale_details.*, products.\"productName\"").
			Joins("LEFT JOIN products ON products.barcode = sale_details.barcode").
			Where("sale_details.\"saleId\" = ?", s.SaleID).
			Find(&details)

		for _, d := range details {
			fmt.Printf("   -> [%s] %s | Qty: %.2f | Subtotal: $%.2f\n", d.Barcode, d.ProductName, d.Quantity, d.Subtotal)
		}
		fmt.Println("--------------------------------------------------")
	}
}
