package main

import (
	"fmt"
	"log"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Expense struct {
	ID     uint
	Status string
	Amount float64
}

func main() {
	dsn := "host=localhost user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	var stats []struct {
		Status string
		Count  int
		Sum    float64
	}
	db.Table("expenses").Select("status, count(*), sum(amount)").Group("status").Scan(&stats)

	fmt.Println("Status Stats:")
	for _, s := range stats {
		fmt.Printf("Status: [%s], Count: %d, Sum: %.2f\n", s.Status, s.Count, s.Sum)
	}
}
