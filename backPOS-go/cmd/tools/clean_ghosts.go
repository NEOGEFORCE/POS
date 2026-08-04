package main

import (
	"fmt"
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error conectando: %v", err)
	}

	if err := db.Exec("DELETE FROM expenses WHERE UPPER(status) != 'PENDING';").Error; err != nil {
		log.Fatalf("Error borrando fantasmas: %v", err)
	}
	fmt.Println("¡Fantasmas borrados con éxito!")
}
