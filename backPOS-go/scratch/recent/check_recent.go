package main

import (
	"fmt"
	"log"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Expense struct {
	ID             uint
	Description    string         `gorm:"column:description"`
	Amount         float64        `gorm:"column:amount"`
	Status         string         `gorm:"column:status"`
	PaymentSource  string         `gorm:"column:paymentSource"`
	Date           string         `gorm:"column:date"`
}

func main() {
	dsn := "host=localhost user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	var expenses []Expense
	db.Table("expenses").Order("id DESC").Limit(10).Find(&expenses)

	fmt.Println("Recent Expenses with Source:")
	for _, e := range expenses {
		fmt.Printf("ID: %d, Desc: %s, Amount: %.2f, Status: [%s], Source: [%s]\n", e.ID, e.Description, e.Amount, e.Status, e.PaymentSource)
	}
}
