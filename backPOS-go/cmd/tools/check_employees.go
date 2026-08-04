package main

import (
	"fmt"
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Employee struct {
	DNI  string
	Name string
	Role string
}

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	var employees []Employee
	db.Find(&employees)

	for _, e := range employees {
		fmt.Printf("DNI: %s, Name: %s, Role: %s\n", e.DNI, e.Name, e.Role)
	}
}
