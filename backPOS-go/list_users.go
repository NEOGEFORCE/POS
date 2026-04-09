package main

import (
	"fmt"
	"log"
	"os"

	"backPOS-go/internal/core/domain/models"
	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	_ = godotenv.Load(".env")
	user := os.Getenv("DB_USER")
	password := os.Getenv("DB_PASSWORD")
	host := os.Getenv("DB_HOST")
	port := os.Getenv("DB_PORT")
	dbname := os.Getenv("DB_NAME")

	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable", host, user, password, dbname, port)
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	var users []models.Employee
	db.Find(&users)

	fmt.Println("\n--- LISTA DE USUARIOS ---")
	for _, u := range users {
		fmt.Printf("DNI: %s | Nombre: %s | Rol: %s\n", u.DNI, u.Name, u.Role)
	}
	fmt.Println("-------------------------\n")
}
