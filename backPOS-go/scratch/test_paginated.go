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
	var total int64

	query := db.Model(&models.Product{}).Where("\"isActive\" = ?", true)
	if err := query.Count(&total).Error; err != nil {
		fmt.Println("Count Error:", err)
		return
	}

	err = query.Preload("Category").
		Preload("BaseProduct").
		Preload("Suppliers").
		Order("\"productName\" ASC").
		Limit(25).
		Offset(0).
		Find(&products).Error
	if err != nil {
		fmt.Println("Find Error:", err)
		return
	}
	fmt.Printf("GetPaginated 25 items in %v (total %d)\n", time.Since(start), total)
}
