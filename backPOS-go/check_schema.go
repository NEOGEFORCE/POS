package main

import (
	"fmt"
	"log"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable TimeZone=America/Bogota"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}
	
	type Table struct {
		TableName string
	}
	
	var tables []Table
	db.Raw("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'").Scan(&tables)

	for _, t := range tables {
		fmt.Println(t.TableName)
	}
}
