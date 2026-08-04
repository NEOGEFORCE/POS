package main

import (
	"fmt"
	"log"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error connecting to db: %v", err)
	}

	var countBefore, countNow int64
	var salesBefore, salesNow float64

	// Start of today: 2026-07-30 00:00:00
	t755, _ := time.Parse("2006-01-02 15:04:05", "2026-07-30 07:55:00")
	t1131, _ := time.Parse("2006-01-02 15:04:05", "2026-07-30 11:31:00")

	db.Table("sales").Where("created_at >= '2026-07-30 00:00:00' AND created_at <= ?", t755).Count(&countBefore)
	db.Table("sales").Where("created_at >= '2026-07-30 00:00:00' AND created_at <= ?", t1131).Count(&countNow)

	db.Table("sales").Where("created_at >= '2026-07-30 00:00:00' AND created_at <= ?", t755).Select("COALESCE(SUM(total_amount), 0)").Row().Scan(&salesBefore)
	db.Table("sales").Where("created_at >= '2026-07-30 00:00:00' AND created_at <= ?", t1131).Select("COALESCE(SUM(total_amount), 0)").Row().Scan(&salesNow)

	fmt.Printf("Sales at 07:55 AM: %d transactions, Total: $%.2f\n", countBefore, salesBefore)
	fmt.Printf("Sales at 11:31 AM: %d transactions, Total: $%.2f\n", countNow, salesNow)
}
