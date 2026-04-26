package main

import (
	"log"

	"backPOS-go/internal/core/domain/models"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=localhost user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("failed to connect database: %v", err)
	}

	hashedPassword, _ := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.DefaultCost)
	
	err = db.Model(&models.Employee{}).Where("dni = ?", "321987654").Update("password", string(hashedPassword)).Error
	if err != nil {
		log.Fatalf("failed to update password: %v", err)
	}

	log.Println("Password updated for DILAN (321987654) to 123456")
}
