//go:build tools_legacy
// +build tools_legacy

package main

import (
	"fmt"
	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"log"
	"os"
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

	var closure map[string]interface{}
	db.Table("cashier_closures").Where("id = ?", 145).Take(&closure)
	fmt.Printf("\n=== CIERRE 145 ===\n")
	for k, v := range closure {
		fmt.Printf(" %s: %v\n", k, v)
	}
	fmt.Printf("==================\n\n")
}
