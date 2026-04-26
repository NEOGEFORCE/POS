package main

import (
	"fmt"
	"log"
	"backPOS-go/internal/core/domain/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	user := "postgres"
	password := "123"
	host := "localhost"
	port := "5432"
	dbname := "sistemapos"

	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable TimeZone=UTC", host, user, password, dbname, port)
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	var totalProducts int64
	db.Model(&models.Product{}).Count(&totalProducts)
	fmt.Printf("Total Products: %d\n", totalProducts)

	var products []models.Product
	db.Unscoped().Limit(10).Find(&products)
	for _, p := range products {
		fmt.Printf("Product: %s, ID: %v, DeletedAt: %v\n", p.ProductName, p.CategoryID, p.DeletedAt)
	}

	var categories []models.Category
	db.Find(&categories)
	for _, c := range categories {
		var count int64
		db.Model(&models.Product{}).Where("\"categoryId\" = ?", c.ID).Count(&count)
		fmt.Printf("Category: %s (ID: %d), Product Count: %d\n", c.Name, c.ID, count)
	}
}
