package main

import (
	"encoding/json"
	"fmt"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type ExpectedOrder struct {
	ID             uint    `json:"id"`
	SupplierName   string  `json:"supplier_name"`
	TotalEstimated float64 `json:"total_estimated"`
	ExpectedDate   string  `json:"expected_date"`
}

type ConfirmedOrder struct {
	ID             uint    `json:"id"`
	SupplierID     uint    `json:"supplier_id"`
	EstimatedTotal float64 `json:"estimated_total"`
	ExpectedDate   string  `json:"expected_date"`
}

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		fmt.Println("Error connecting:", err)
		return
	}

	var expected []ExpectedOrder
	db.Table("expected_orders").Where("expected_date = ?", "2026-06-12").Find(&expected)
	b, _ := json.MarshalIndent(expected, "", "  ")
	fmt.Println("Expected:")
	fmt.Println(string(b))

	var confirmed []ConfirmedOrder
	db.Table("restock_orders").Where("expected_date = ? AND status = ?", "2026-06-12", "PENDING").Find(&confirmed)
	c, _ := json.MarshalIndent(confirmed, "", "  ")
	fmt.Println("Confirmed:")
	fmt.Println(string(c))
}
