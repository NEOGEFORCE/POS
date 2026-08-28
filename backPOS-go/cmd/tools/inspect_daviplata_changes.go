//go:build tools_legacy
// +build tools_legacy


﻿package main

import (
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

	type Expense struct {
		ID              uint
		Description     string
		PaymentSource   string
		Amount          float64
		CashAmount      float64
		DaviplataAmount float64
		NequiAmount     float64
		FondoAmount     float64
		Date            string
	}

	var expenses []Expense
	db.Table("expenses").Where("status = 'PAID'").Order("id desc").Limit(50).Find(&expenses)

	for _, e := range expenses {
		fmt.Printf("ID %d | %s | Source: %s | Amount: %.2f | Cash: %.2f | Davi: %.2f | Date: %s\n",
			e.ID, e.Description, e.PaymentSource, e.Amount, e.CashAmount, e.DaviplataAmount, e.Date)
	}
}
