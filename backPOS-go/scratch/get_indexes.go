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
		log.Fatal(err)
	}

	var results []struct {
		Tablename string
		Indexname string
		Indexdef  string
	}
	db.Raw("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname").Scan(&results)

	for _, r := range results {
		fmt.Printf("Table: %s | Index: %s\n%s\n\n", r.Tablename, r.Indexname, r.Indexdef)
	}
}
