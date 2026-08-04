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

	var rawJSON string
	db.Table("cashier_closures").Select("expenses_detail").Where("id = ?", 94).Row().Scan(&rawJSON)

	var expenses []map[string]interface{}
	json.Unmarshal([]byte(rawJSON), &expenses)
	fmt.Printf("Original JSON for Closure 94 has %d items:\n", len(expenses))
	cashSum := 0.0
	for i, e := range expenses {
		id := e["id"]
		desc := e["description"]
		src := e["paymentSource"]
		cash := e["cashAmount"]
		fmt.Printf("[%d] ID=%v | %v | Source=%v | Cash=%v\n", i+1, id, desc, src, cash)
		if c, ok := cash.(float64); ok {
			cashSum += c
		}
	}
	fmt.Printf("Total Cash Expenses in JSON = %.2f\n", cashSum)
}
