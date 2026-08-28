//go:build tools_legacy
// +build tools_legacy


﻿package main

import (
	"encoding/json"
	"fmt"
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=invalid.invalid user=disabled dbname=disabled port=1 sslmode=disable connect_timeout=1"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error connecting to db: %v", err)
	}

	var rawJSON string
	err = db.Table("cashier_closures").Select("expenses_detail").Where("id = ?", 94).Row().Scan(&rawJSON)
	if err != nil {
		log.Fatalf("Error scanning expenses_detail for 94: %v", err)
	}

	var expenses []map[string]interface{}
	_ = json.Unmarshal([]byte(rawJSON), &expenses)
	fmt.Printf("Expenses items 1 to 7:\n")
	for i := 0; i < 7 && i < len(expenses); i++ {
		b, _ := json.Marshal(expenses[i])
		fmt.Printf("[%d] %s\n", i+1, string(b))
	}
}
