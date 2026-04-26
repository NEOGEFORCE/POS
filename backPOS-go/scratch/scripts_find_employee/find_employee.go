package main

import (
	"encoding/json"
	"fmt"
	"log"

	"backPOS-go/internal/core/domain/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=localhost user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("failed to connect database: %v", err)
	}

	var employees []models.Employee
	err = db.Where("role NOT IN ('admin', 'superadmin', 'administrador', 'ADMIN', 'SUPERADMIN', 'ADMINISTRADOR')").Find(&employees).Error
	if err != nil {
		log.Fatalf("failed to find employees: %v", err)
	}

	result, _ := json.MarshalIndent(employees, "", "  ")
	fmt.Println(string(result))
}
