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
	db.Raw("SELECT COALESCE(SUM(total), 0), COUNT(*) FROM sales").Row().Scan(&totalSales, &count)
	fmt.Printf("All Time Sales: $%v (Count: %v)\n", totalSales, count)
}
