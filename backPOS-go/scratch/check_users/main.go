
package main

import (
	"fmt"
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Employee struct {
	DNI      string `gorm:"primaryKey"`
	Name     string
	IsActive bool
	Role     string
}

func main() {
	dsn := "host=localhost user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	dni := "123456789"
	var emp Employee
	if err := db.Unscoped().Where("dni = ?", dni).First(&emp).Error; err != nil {
		fmt.Printf("Error finding user: %v\n", err)
	} else {
		// Intentar activar
		updates := map[string]interface{}{"is_active": true}
		if err := db.Unscoped().Model(&emp).Updates(updates).Error; err != nil {
			fmt.Printf("Error updating user: %v\n", err)
		} else {
			fmt.Printf("User %s (%s) activated successfully!\n", emp.Name, emp.DNI)
		}
	}
}
