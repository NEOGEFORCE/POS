package main

import (
	"encoding/json"
	"fmt"
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error connecting to db: %v", err)
	}

	// READ ONLY - NO MODIFICATIONS

	var closure map[string]interface{}
	err = db.Table("cashier_closures").Where("id = ?", 99).Take(&closure).Error
	if err != nil {
		log.Fatalf("Error finding closure 99: %v", err)
	}

	fmt.Println("=== CLOSURE 99 RECORD IN DB ===")
	for k, v := range closure {
		if k != "expenses_detail" {
			fmt.Printf("%s: %v\n", k, v)
		}
	}

	rawJSON := fmt.Sprintf("%v", closure["expenses_detail"])
	var expenses []map[string]interface{}
	_ = json.Unmarshal([]byte(rawJSON), &expenses)

	fmt.Printf("\n=== EXPENSES DETAIL IN SNAPSHOT (%d items) ===\n", len(expenses))
	totalCashExps := 0.0
	totalNequiExps := 0.0
	totalDaviExps := 0.0
	totalFondoExps := 0.0

	for i, e := range expenses {
		desc := e["description"]
		amount := e["amount"]
		src := e["paymentSource"]
		fmt.Printf("[%d] %v | Amount: %v | Source: %v\n", i+1, desc, amount, src)

		if c, ok := e["cashAmount"].(float64); ok {
			totalCashExps += c
		}
		if n, ok := e["nequiAmount"].(float64); ok {
			totalNequiExps += n
		}
		if d, ok := e["daviplataAmount"].(float64); ok {
			totalDaviExps += d
		}
		if f, ok := e["fondoAmount"].(float64); ok {
			totalFondoExps += f
		}
	}

	fmt.Printf("\n--- EXPENSE SUMMARIES IN SNAPSHOT ---\n")
	fmt.Printf("Cash Egresos: %.2f\n", totalCashExps)
	fmt.Printf("Nequi Egresos: %.2f\n", totalNequiExps)
	fmt.Printf("Daviplata Egresos: %.2f\n", totalDaviExps)
	fmt.Printf("Fondo Egresos: %.2f\n", totalFondoExps)
}
