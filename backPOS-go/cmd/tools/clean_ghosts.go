//go:build tools_legacy
// +build tools_legacy


﻿package main

import (
	"fmt"
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=invalid.invalid user=disabled dbname=disabled port=1 sslmode=disable connect_timeout=1"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error conectando: %v", err)
	}

	if err := db.Exec("DELETE FROM expenses WHERE UPPER(status) != 'PENDING';").Error; err != nil {
		log.Fatalf("Error borrando fantasmas: %v", err)
	}
	fmt.Println("¡Fantasmas borrados con éxito!")
}
