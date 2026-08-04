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
	StartDate  time.Time `json:"startDate"`
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
	db.Table("cashier_closures").Where("deleted_at IS NULL").Order("id DESC").Limit(20).Find(&closures)

	loc := time.FixedZone("America/Bogota", -5*60*60)
	fmt.Println("=== CLOSURES IN DB ===")
	for _, c := range closures {
		fmt.Printf("ID: %d | TotalSales: %.2f | Date: %s | StartDate: %s | EndDate: %s\n",
			c.ID, c.TotalSales,
			c.Date.In(loc).Format("2006-01-02 15:04:05"),
			c.StartDate.In(loc).Format("2006-01-02 15:04:05"),
			c.EndDate.In(loc).Format("2006-01-02 15:04:05"),
		)
	}
}
