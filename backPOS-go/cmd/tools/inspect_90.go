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
	var closure struct {
		ID           uint    `json:"id"`
		ExpectedCash float64 `json:"expectedCash"`
		PhysicalCash float64 `json:"physicalCash"`
		Difference   float64 `json:"difference"`
		TotalSales   float64 `json:"totalSales"`
		TotalCash    float64 `json:"totalCash"`
	}
	err = db.Table("cashier_closures").Where("id = ?", 90).First(&closure).Error
	if err != nil {
		log.Fatalf("Error finding closure 90: %v", err)
	}

	fmt.Printf("Closure 90 DB: ExpectedCash=%.2f, PhysicalCash=%.2f, Diff=%.2f, TotalSales=%.2f, TotalCash=%.2f\n",
		closure.ExpectedCash, closure.PhysicalCash, closure.Difference, closure.TotalSales, closure.TotalCash)

	err = db.Table("cashier_closures").Select("expenses_detail").Where("id = ?", 90).Row().Scan(&rawJSON)
	if err != nil {
		log.Fatalf("Error scanning expenses_detail for 90: %v", err)
	}

	var expenses []map[string]interface{}
	_ = json.Unmarshal([]byte(rawJSON), &expenses)
	fmt.Printf("Expenses in JSON (%d items):\n", len(expenses))
	cashSum := 0.0
	for i, e := range expenses {
		b, _ := json.Marshal(e)
		fmt.Printf("[%d] %s\n", i+1, string(b))
		if c, ok := e["cashAmount"].(float64); ok {
			cashSum += c
		}
	}
	fmt.Printf("Total Cash Expenses in JSON = %.2f\n", cashSum)
}
