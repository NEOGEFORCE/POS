package main

import (
	"fmt"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"log"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	var updatedBy, createdBy string
	db.Raw("SELECT \"updatedByDni\", \"createdByDni\" FROM products WHERE barcode = '7715032110278'").Row().Scan(&updatedBy, &createdBy)
	fmt.Printf("UpdatedBy: '%s', CreatedBy: '%s'\n", updatedBy, createdBy)
}
