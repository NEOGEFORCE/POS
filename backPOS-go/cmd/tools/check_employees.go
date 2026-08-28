//go:build tools_legacy
// +build tools_legacy


﻿package main

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
	dsn := "host=invalid.invalid user=disabled dbname=disabled port=1 sslmode=disable connect_timeout=1"
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
