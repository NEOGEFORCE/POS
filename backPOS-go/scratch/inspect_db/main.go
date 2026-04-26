package main

import (
	"fmt"
	"log"
	"os"

	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	godotenv.Load(".env")

	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable",
		os.Getenv("DB_HOST"), os.Getenv("DB_USER"), os.Getenv("DB_PASSWORD"), os.Getenv("DB_NAME"), os.Getenv("DB_PORT"))

	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("FAILED TO CONNECT: %v", err)
	}

	fmt.Println("--- ULTIMOS 5 EGRESOS ---")
	rows3, err := db.Raw("SELECT id, description, amount, \"createdByDni\" FROM expenses ORDER BY id DESC LIMIT 5").Rows()
	if err != nil {
		log.Printf("Error al consultar gastos: %v", err)
	} else {
		defer rows3.Close()
		for rows3.Next() {
			var id uint
			var desc, dni string
			var amount float64
			rows3.Scan(&id, &desc, &amount, &dni)
			fmt.Printf("ID: %d | Desc: %s | Amt: %.2f | Creator: %s\n", id, desc, amount, dni)
		}
	}
}
