package main

import (
	"log"
	"backPOS-go/internal/core/domain/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("failed to connect database: %v", err)
	}

	err = db.AutoMigrate(&models.Product{})
	if err != nil {
		log.Fatalf("failed to migrate: %v", err)
	}
	log.Println("Migration successful!")
}
