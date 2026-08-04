package main

import (
	"fmt"
	"log"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type CashierClosure struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	Date       time.Time `json:"date"`
	EndDate    time.Time `json:"endDate"`
	TotalSales float64   `json:"totalSales"`
}

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error connecting to db: %v", err)
	}

	var closures []CashierClosure
	db.Table("cashier_closures").Where("deleted_at IS NULL").Order("id ASC").Find(&closures)

	loc := time.FixedZone("America/Bogota", -5*60*60)
	julyTotal := 0.0
	dailySum := make(map[string]float64)

	for _, c := range closures {
		dateToUse := c.EndDate
		if dateToUse.IsZero() {
			dateToUse = c.Date
		}
		if dateToUse.In(loc).Format("2006-01") == "2026-07" {
			julyTotal += c.TotalSales
			dayStr := dateToUse.In(loc).Format("2006-01-02")
			dailySum[dayStr] += c.TotalSales
		}
	}

	fmt.Printf("=== SUM OF ALL CLOSURES IN JULY 2026 ===\n")
	fmt.Printf("Total Sales July 2026 = $%.2f\n", julyTotal)
	fmt.Printf("Number of days with closures = %d\n", len(dailySum))
	for day, sum := range dailySum {
		fmt.Printf("Day %s: $%.2f\n", day, sum)
	}
}
