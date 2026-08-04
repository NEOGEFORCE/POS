package main

import (
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

	var closure map[string]interface{}
	err = db.Table("cashier_closures").Where("id = ?", 119).Take(&closure).Error
	if err != nil {
		log.Fatalf("Error finding closure 119: %v", err)
	}

	fmt.Println("=== CLOSURE 119 RECORD IN DB ===")
	for k, v := range closure {
		if k != "expenses_detail" {
			fmt.Printf("%s: %v\n", k, v)
		}
	}
}
