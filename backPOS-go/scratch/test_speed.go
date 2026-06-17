package main

import (
	"fmt"
	"time"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"backPOS-go/internal/core/domain/models"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable TimeZone=America/Bogota"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		fmt.Println("DB Connect Error:", err)
		return
	}

	start := time.Now()
	var products []models.Product
	err = db.Preload("Category").Where("\"isActive\" = ?", true).Order("\"productName\" ASC").Find(&products).Error
	if err != nil {
		fmt.Println("Find Error:", err)
		return
	}
	fmt.Printf("Fetched %d products in %v\n", len(products), time.Since(start))
}
