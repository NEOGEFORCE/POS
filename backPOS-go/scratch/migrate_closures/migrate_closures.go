package main

import (
	"log"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=localhost user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	log.Println("Migrating cashier_closures table...")

	// Add columns if they don't exist
	err = db.Exec(`
		ALTER TABLE cashier_closures 
		ADD COLUMN IF NOT EXISTS total_cash_real numeric DEFAULT 0,
		ADD COLUMN IF NOT EXISTS total_nequi_real numeric DEFAULT 0,
		ADD COLUMN IF NOT EXISTS total_daviplata_real numeric DEFAULT 0
	`).Error
	if err != nil {
		log.Fatalf("Failed to add columns: %v", err)
	}

	// Initialize new columns with current values for historical data
	err = db.Exec(`
		UPDATE cashier_closures 
		SET total_cash_real = physical_cash,
		    total_nequi_real = total_nequi,
		    total_daviplata_real = total_daviplata
		WHERE total_cash_real = 0 AND total_nequi_real = 0 AND total_daviplata_real = 0
	`).Error
	if err != nil {
		log.Printf("Warning: Failed to initialize historical data: %v", err)
	}

	log.Println("Migration completed successfully.")
}
