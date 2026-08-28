//go:build tools_legacy
// +build tools_legacy


﻿package main

import (
	"fmt"
	"log"
	"os"

	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

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
		log.Fatalf("❌ Error conectando a BD local: %v", err)
	}

	var saleCount, productCount, expenseCount int64
	db.Table("sales").Count(&saleCount)
	db.Table("products").Count(&productCount)
	db.Table("expenses").Count(&expenseCount)

	var lastSaleDate string
	db.Table("sales").Select("MAX(date)").Scan(&lastSaleDate)

	fmt.Printf("=== ESTADO DE BD EN ESTE COMPUTADOR (127.0.0.1) ===\n")
	fmt.Printf("✅ Productos: %d | Ventas: %d | Egresos: %d\n", productCount, saleCount, expenseCount)
	fmt.Printf("📅 Última venta registrada: %s\n", lastSaleDate)
}
