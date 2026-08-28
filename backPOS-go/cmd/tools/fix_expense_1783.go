//go:build tools_legacy
// +build tools_legacy


﻿package main

import (
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Expense struct {
	ID              uint    `gorm:"primaryKey"`
	Description     string
	Amount          float64
	PaymentSource   string  `gorm:"column:paymentSource"`
	CashAmount      float64 `gorm:"column:cash_amount"`
	NequiAmount     float64 `gorm:"column:nequi_amount"`
	DaviplataAmount float64 `gorm:"column:daviplata_amount"`
	FondoAmount     float64 `gorm:"column:fondo_amount"`
	CoinsAmount     float64 `gorm:"column:coins_amount"`
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
	db.Table("expenses").Where("deleted_at IS NULL AND \"paymentSource\" LIKE '%/%'").Find(&expenses)

	fmt.Printf("=== ENCONTRADOS %d EGRESOS MULTI-PAGO ===\n", len(expenses))

	re := regexp.MustCompile(`(NEQUI|DAVIPLATA|CAJA|CASH|EFECTIVO|FONDO|BOVEDA|BÓVEDA|MONEDAS|ALCANCIA|ALCANCÍA):\s*\$?([\d.,]+)`)

	for _, e := range expenses {
		matches := re.FindAllStringSubmatch(e.PaymentSource, -1)
		if len(matches) == 0 {
			continue
		}

		var cash, nequi, davi, fondo, coins float64

		for _, m := range matches {
			method := strings.ToUpper(m[1])
			valStr := strings.ReplaceAll(m[2], ".", "")
			valStr = strings.ReplaceAll(valStr, ",", ".")
			val, _ := strconv.ParseFloat(valStr, 64)

			switch {
			case strings.Contains(method, "NEQUI"):
				nequi += val
			case strings.Contains(method, "DAVIPLATA"):
				davi += val
			case strings.Contains(method, "FONDO") || strings.Contains(method, "BOVEDA"):
				fondo += val
			case strings.Contains(method, "MONEDA") || strings.Contains(method, "ALCANCIA"):
				coins += val
			default:
				cash += val
			}
		}

		fmt.Printf("ID %d: '%s' => Cash: $%.2f | Nequi: $%.2f | Davi: $%.2f | Fondo: $%.2f | Coins: $%.2f\n",
			e.ID, e.PaymentSource, cash, nequi, davi, fondo, coins)

		updates := map[string]interface{}{
			"cash_amount":      cash,
			"nequi_amount":     nequi,
			"daviplata_amount": davi,
			"fondo_amount":     fondo,
			"coins_amount":     coins,
		}

		db.Table("expenses").Where("id = ?", e.ID).Updates(updates)
	}

	fmt.Println("✅ Backfill de egresos multi-pago completado exitosamente.")
}
