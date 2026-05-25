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
	_ = godotenv.Load()
	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable TimeZone=UTC",
		os.Getenv("DB_HOST"), os.Getenv("DB_USER"), os.Getenv("DB_PASSWORD"), os.Getenv("DB_NAME"), os.Getenv("DB_PORT"))
	
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	fmt.Println("Conectado a la base de datos...")

	err = db.Exec(`
		CREATE TABLE IF NOT EXISTS price_logs (
			id SERIAL PRIMARY KEY,
			product_barcode VARCHAR(50) NOT NULL,
			product_name VARCHAR(255),
			old_price DECIMAL(10,2),
			new_price DECIMAL(10,2),
			created_at BIGINT
		);
		CREATE INDEX IF NOT EXISTS idx_price_logs_barcode ON price_logs(product_barcode);
	`).Error

	if err != nil {
		log.Fatal("Error creando tabla:", err)
	}

	fmt.Println("✅ Tabla price_logs verificada/creada exitosamente.")
}
