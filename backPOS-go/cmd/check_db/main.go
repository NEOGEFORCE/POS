package main

import (
	"fmt"
	"log"
	"os"
	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"backPOS-go/internal/core/domain/models"
)

func main() {
	godotenv.Load()
	user := os.Getenv("DB_USER")
	password := os.Getenv("DB_PASSWORD")
	host := os.Getenv("DB_HOST")
	port := os.Getenv("DB_PORT")
	dbname := os.Getenv("DB_NAME")

	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable TimeZone=UTC", host, user, password, dbname, port)
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	var employees []models.Employee
	db.Find(&employees)

	if len(employees) == 0 {
		fmt.Println("\n⚠️ ¡LA BASE DE DATOS ESTÁ VACÍA!")
	} else {
		fmt.Println("\n--- EMPLEADOS ENCONTRADOS ---")
		for _, emp := range employees {
			fmt.Printf("DNI: %v | Nombre: '%s' | Email: '%s' | Rol: '%s'\n", emp.DNI, emp.Name, emp.Email, emp.Role)
		}
		fmt.Println("----------------------------\n")
	}
}
