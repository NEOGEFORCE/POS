package main

import (
	"backPOS-go/internal/adapters/repositories"
	"fmt"
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error connecting DB: %v", err)
	}

	fmt.Println("Re-creating mv_dashboard_stats_monthly on DB 192.168.1.6...")
	if err := repositories.InitMaterializedViews(db); err != nil {
		log.Fatalf("Error InitMaterializedViews: %v", err)
	}

	var stats struct {
		MonthYear  string  `gorm:"column:month_year"`
		TotalSales float64 `gorm:"column:total_sales"`
	}
	db.Table("mv_dashboard_stats_monthly").Where("month_year = ?", "2026-07").First(&stats)
	fmt.Printf("✅ Materialized View Refreshed! July 2026 Dashboard Sales: $%.2f\n", stats.TotalSales)
}
