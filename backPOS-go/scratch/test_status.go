package main

import (
	"fmt"
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	db, err := gorm.Open(postgres.Open("host=localhost user=postgres password=postgres dbname=pos_db port=5432 sslmode=disable"), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	var count int64
	db.Table("confirmed_orders").Count(&count)
	fmt.Printf("Total ConfirmedOrders: %d\n", count)

	type Result struct {
		ID string
		Status string
	}
	var res []Result
	db.Table("confirmed_orders").Select("id, status").Scan(&res)
	for _, r := range res {
		fmt.Printf("ID: %s, Status: %s\n", r.ID, r.Status)
	}
}
