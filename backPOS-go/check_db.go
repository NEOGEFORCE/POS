package main

import (
	"fmt"
	"log"
	"os"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"github.com/joho/godotenv"
)

type Client struct {
	DNI  string `gorm:"primaryKey"`
	Name string
}

func main() {
	// Ahora que estamos dentro de backPOS-go, cargamos el .env local
	_ = godotenv.Load(".env")
	
	host := os.Getenv("DB_HOST")
	user := os.Getenv("DB_USER")
	password := os.Getenv("DB_PASSWORD")
	dbname := os.Getenv("DB_NAME")
	port := os.Getenv("DB_PORT")

	if host == "" {
		log.Fatal("DB_HOST no encontrado en las variables de entorno")
	}

	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable", host, user, password, dbname, port)
	fmt.Printf("Intentando conectar a %s:%s...\n", host, port)
	
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error conectando a la DB: %v", err)
	}

	var client Client
	err = db.Table("clients").Where("dni = ?", "99999").First(&client).Error
	if err != nil {
		fmt.Printf("🔴 Geraldine (99999) NO encontrada en %s. Error: %v\n", host, err)
	} else {
		fmt.Printf("✅ Geraldine ENCONTRADA: %s en el servidor %s\n", client.Name, host)
	}
}
