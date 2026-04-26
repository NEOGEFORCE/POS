package main

import (
	"fmt"
	"log"
	"os"
	"backPOS-go/internal/core/domain/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"github.com/joho/godotenv"
)

func main() {
	godotenv.Load()
	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable TimeZone=UTC",
		os.Getenv("DB_HOST"), os.Getenv("DB_USER"), os.Getenv("DB_PASSWORD"), os.Getenv("DB_NAME"), os.Getenv("DB_PORT"))
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	var expenses []models.Expense
	db.Preload("Creator").Find(&expenses)

	fmt.Println("ID | Description | CreatedByDNI | CreatorName | CreatorRole")
	fmt.Println("---------------------------------------------------------")
	for _, e := range expenses {
		fmt.Printf("%d | %s | %s | %s | %s\n", 
			e.ID, e.Description, e.CreatedByDNI, e.Creator.Name, e.Creator.Role)
	}
}
