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
	err = db.Table("cashier_closures").Select("expenses_detail").Where("id = ?", 90).Row().Scan(&rawJSON)
	if err != nil {
		log.Fatalf("Error scanning expenses_detail for 90: %v", err)
	}

	var expenses []map[string]interface{}
	_ = json.Unmarshal([]byte(rawJSON), &expenses)
	fmt.Printf("Expenses items 1 to 13:\n")
	for i := 0; i < 13 && i < len(expenses); i++ {
		b, _ := json.Marshal(expenses[i])
		fmt.Printf("[%d] %s\n", i+1, string(b))
	}
}
