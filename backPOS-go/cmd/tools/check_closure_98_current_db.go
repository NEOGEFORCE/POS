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
	err = db.Table("cashier_closures").Select("expenses_detail").Where("id = ?", 98).Row().Scan(&rawJSON)
	if err != nil {
		log.Fatalf("Error scanning expenses_detail for 98: %v", err)
	}

	var expenses []map[string]interface{}
	_ = json.Unmarshal([]byte(rawJSON), &expenses)
	fmt.Printf("Closure 98 JSON currently in DB has %d items:\n", len(expenses))

	cashSum := 0.0
	for i, e := range expenses {
		desc := e["description"]
		cash := e["cashAmount"]
		if c, ok := cash.(float64); ok {
			cashSum += c
			fmt.Printf("[%d] %v | Cash: %.2f\n", i+1, desc, c)
		}
	}
	fmt.Printf("TOTAL CASH EGRESOS IN CLOSURE 98 JSON = %.2f\n", cashSum)
}
