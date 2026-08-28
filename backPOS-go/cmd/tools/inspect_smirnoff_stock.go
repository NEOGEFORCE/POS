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

type Product struct {
	ID                 uint    `gorm:"primaryKey"`
	Barcode            string  `gorm:"column:barcode"`
	ProductName        string  `gorm:"column:productName"`
	Quantity           float64 `gorm:"column:quantity"`
	MinStock           float64 `gorm:"column:minStock"`
	BaseProductBarcode *string `gorm:"column:baseProductBarcode"`
	IsPack             bool    `gorm:"column:isPack"`
	PackMultiplier     int     `gorm:"column:packMultiplier"`
}

type SaleDetail struct {
	ID        uint    `gorm:"primaryKey"`
	SaleID    uint    `gorm:"column:saleId"`
	Barcode   string  `gorm:"column:barcode"`
	Quantity  float64 `gorm:"column:quantity"`
	UnitPrice float64 `gorm:"column:unitPrice"`
	Subtotal  float64 `gorm:"column:subtotal"`
}

type StockMovement struct {
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

	barcodes := []string{"5410316948999", "5410316983693", "5410316945981", "5410316997980"}

	fmt.Println("=== 1. ESTADO ACTUAL DE PRODUCTOS EN BD ===")
	var products []Product
	db.Table("products").Where("barcode IN ? OR UPPER(\"productName\") LIKE '%SMIRNOFF%'", barcodes).Find(&products)
	for _, p := range products {
		baseStr := "N/A"
		if p.BaseProductBarcode != nil { baseStr = *p.BaseProductBarcode }
		fmt.Printf("Barcode: %s | Nombre: %s | Quantity: %.2f | IsPack: %v (Mult: %d, Base: %s)\n",
			p.Barcode, p.ProductName, p.Quantity, p.IsPack, p.PackMultiplier, baseStr)
	}

	fmt.Println("\n=== 2. VENTAS REGISTRADAS HOY (DE CUALQUIER SMIRNOFF O PARECIDO) ===")
	todayStart := time.Now().Format("2006-01-02") + " 00:00:00"
	var details []SaleDetail
	db.Table("sale_details").
		Select("sale_details.*").
		Joins("JOIN sales ON sales.\"saleId\" = sale_details.\"saleId\"").
		Where("sales.deleted_at IS NULL AND sales.\"saleDate\" >= ? AND (sale_details.barcode IN ? OR sale_details.barcode IN (SELECT barcode FROM products WHERE UPPER(\"productName\") LIKE '%SMIRNOFF%'))", todayStart, barcodes).
		Find(&details)

	fmt.Printf("Total detalles de ventas de Smirnoff hoy: %d\n", len(details))
	for _, d := range details {
		fmt.Printf("   VentaID: %d | Barcode: %s | Qty: %.2f | Subtotal: $%.2f\n", d.SaleID, d.Barcode, d.Quantity, d.Subtotal)
	}

	fmt.Println("\n=== 3. MOVIMIENTOS DE INVENTARIO (STOCK MOVEMENTS) HOY ===")
	var movements []StockMovement
	db.Table("stock_movements").
		Where("date >= ? AND (barcode IN ? OR barcode IN (SELECT barcode FROM products WHERE UPPER(\"productName\") LIKE '%SMIRNOFF%'))", todayStart, barcodes).
		Order("date DESC").Limit(10).Find(&movements)

	fmt.Printf("Total movimientos hoy: %d\n", len(movements))
	for _, m := range movements {
		fmt.Printf("   Fecha: %s | Barcode: %s | Qty: %.2f | Type: %s | Reason: %s | Ref: %s\n",
			m.Date.Format("15:04:05"), m.Barcode, m.Quantity, m.Type, m.Reason, m.ReferenceID)
	}
}
