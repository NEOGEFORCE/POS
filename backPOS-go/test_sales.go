package main

import (
	"fmt"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"log"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	var totalSales float64
	var count int64
	db.Raw("SELECT COALESCE(SUM(total), 0), COUNT(*) FROM sales WHERE sale_date >= '2026-06-16 00:00:00' AND sale_date <= '2026-06-16 23:59:59' AND status IN ('PAID', 'CREDIT')").Row().Scan(&totalSales, &count)
	fmt.Printf("June 16 Sales: $%v (Count: %v)\n", totalSales, count)

	var totalSales17 float64
	var count17 int64
	db.Raw("SELECT COALESCE(SUM(total), 0), COUNT(*) FROM sales WHERE sale_date >= '2026-06-17 00:00:00' AND sale_date <= '2026-06-17 23:59:59' AND status IN ('PAID', 'CREDIT')").Row().Scan(&totalSales17, &count17)
	fmt.Printf("June 17 Sales: $%v (Count: %v)\n", totalSales17, count17)
}
