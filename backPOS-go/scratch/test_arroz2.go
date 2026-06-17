package main

import (
	"fmt"
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Product struct {
	Barcode    string `gorm:"primaryKey"`
	Name       string
	SupplierID uint
}

func main() {
	dsn := "host=localhost user=postgres password=postgres dbname=pos_pro port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal("failed to connect database")
	}

	var products []Product
	db.Where("name ILIKE ?", "%ARROZ%").Find(&products)
	for _, p := range products {
		fmt.Printf("Barcode: %s, Name: %s, Supplier: %d\n", p.Barcode, p.Name, p.SupplierID)
	}
}
