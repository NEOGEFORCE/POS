package main

import (
	"fmt"
	"log"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=localhost user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	var columns []string
	db.Raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'cashier_closures'").Scan(&columns)

	fmt.Println("Columns in cashier_closures:")
	for _, c := range columns {
		fmt.Println("- " + c)
	}
}
