package main

import (
	"fmt"
	"log"
	"os"

	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Employee struct {
	DNI      string
	Name     string
	Role     string
	IsActive bool
}

func main() {
	err := godotenv.Load("../backPOS-go/.env")
	if err != nil {
		log.Fatal("Error loading .env file")
	}

	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable",
		os.Getenv("DB_HOST"), os.Getenv("DB_USER"), os.Getenv("DB_PASSWORD"), os.Getenv("DB_NAME"), os.Getenv("DB_PORT"))
	
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	var employees []Employee
	if err := db.Table("employees").Find(&employees).Error; err != nil {
		log.Fatal(err)
	}

	fmt.Println("Employees in DB:")
	for _, e := range employees {
		fmt.Printf("DNI: %s, Name: %s, Role: %s, Active: %t\n", e.DNI, e.Name, e.Role, e.IsActive)
	}
}
