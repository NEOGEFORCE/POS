package main

import (
	"fmt"
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

	var indexes []struct {
		IndexName string `gorm:"column:indexname"`
		IndexDef  string `gorm:"column:indexdef"`
	}
	db.Raw("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'product_suppliers'").Scan(&indexes)

	fmt.Println("Indexes in product_suppliers:")
	for _, idx := range indexes {
		fmt.Printf("- %s: %s\n", idx.IndexName, idx.IndexDef)
	}
}
