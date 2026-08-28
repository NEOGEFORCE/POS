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

type SaleDetailFull struct {
	SaleID      uint      `gorm:"column:saleId"`
	SaleDate    time.Time `gorm:"column:saleDate"`
	Barcode     string    `gorm:"column:barcode"`
	ProductName string    `gorm:"column:productName"`
	Quantity    float64   `gorm:"column:quantity"`
	UnitPrice   float64   `gorm:"column:unitPrice"`
	Subtotal    float64   `gorm:"column:subtotal"`
}

type MovementFull struct {
	ID          uint      `gorm:"primaryKey"`
	Date        time.Time `gorm:"column:date"`
	Barcode     string    `gorm:"column:barcode"`
	Quantity    float64   `gorm:"column:quantity"`
	Type        string    `gorm:"column:type"`
	Reason      string    `gorm:"column:reason"`
	ReferenceID string    `gorm:"column:reference_id"`
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

	barcodes := []string{"5410316948999", "5410316983693", "5410316945981", "5410316997980", "7707096200019"}

	// Buscar en los ultimos 20 dias
	fromDate := time.Now().AddDate(0, 0, -20).Format("2006-01-02 00:00:00")

	fmt.Println("=== 1. VENTAS EN LOS ULTIMOS 20 DIAS DE SMIRNOFF ===")
	var details []SaleDetailFull
	db.Table("sale_details").
		Select("sale_details.*, sales.\"saleDate\", products.\"productName\"").
		Joins("JOIN sales ON sales.\"saleId\" = sale_details.\"saleId\"").
		Joins("LEFT JOIN products ON products.barcode = sale_details.barcode").
		Where("sales.deleted_at IS NULL AND sales.\"saleDate\" >= ? AND (sale_details.barcode IN ? OR UPPER(products.\"productName\") LIKE '%SMIRNOFF%')", fromDate, barcodes).
		Order("sales.\"saleDate\" DESC").
		Find(&details)

	fmt.Printf("Total detalles de ventas encontrados: %d\n", len(details))
	for _, d := range details {
		fmt.Printf("   VentaID: %d | Fecha: %s | Barcode: %s | Nombre: %s | Qty: %.2f | Subtotal: $%.2f\n",
			d.SaleID, d.SaleDate.Format("2006-01-02 15:04"), d.Barcode, d.ProductName, d.Quantity, d.Subtotal)
	}

	fmt.Println("\n=== 2. MOVIMIENTOS DE INVENTARIO EN LOS ULTIMOS 20 DIAS DE SMIRNOFF ===")
	var movements []MovementFull
	db.Table("stock_movements").
		Where("date >= ? AND (barcode IN ? OR barcode IN (SELECT barcode FROM products WHERE UPPER(\"productName\") LIKE '%SMIRNOFF%'))", fromDate, barcodes).
		Order("date DESC").Find(&movements)

	fmt.Printf("Total movimientos encontrados: %d\n", len(movements))
	for _, m := range movements {
		fmt.Printf("   Fecha: %s | Barcode: %s | Qty: %.2f | Type: %s | Reason: %s | Ref: %s\n",
			m.Date.Format("2006-01-02 15:04"), m.Barcode, m.Quantity, m.Type, m.Reason, m.ReferenceID)
	}

	fmt.Println("\n=== 3. VENTAS CON '0000' (VENTA RAPIDA / VARIOS) EN LOS ULTIMOS 20 DIAS ===")
	var miscCount int64
	db.Table("sale_details").
		Joins("JOIN sales ON sales.\"saleId\" = sale_details.\"saleId\"").
		Where("sales.deleted_at IS NULL AND sales.\"saleDate\" >= ? AND (sale_details.barcode = '0000' OR sale_details.barcode LIKE 'MISC-%')", fromDate).
		Count(&miscCount)
	fmt.Printf("Total ventas rápidas / varios ('0000' / 'MISC'): %d\n", miscCount)
}
