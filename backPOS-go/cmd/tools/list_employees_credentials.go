//go:build tools_legacy
// +build tools_legacy


﻿package main

import (
	"fmt"
	"log"
	"os"

	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Employee struct {
	ID       uint   `gorm:"primaryKey"`
	Name     string `gorm:"column:name"`
	DNI      string `gorm:"column:dni"`
	Role     string `gorm:"column:role"`
	PIN      string `gorm:"column:pin"`
	Password string `gorm:"column:password"`
}

func main() {
	_ = godotenv.Load()
	host := os.Getenv("DB_HOST")
	if host == "" { host = "127.0.0.1" }
	port := os.Getenv("DB_PORT")
	if port == "" { port = "5432" }
	user := os.Getenv("DB_USER")
	if user == "" { user = "postgres" }
	pass := os.Getenv("DB_PASSWORD")
	if pass == "" { pass = "123" }
	dbname := os.Getenv("DB_NAME")
	if dbname == "" { dbname = "sistemapos" }

	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable TimeZone=America/Bogota", host, user, pass, dbname, port)
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("❌ Error conectando a BD: %v", err)
	}

	var employees []Employee
	db.Table("employees").Find(&employees)

	fmt.Println("=== EMPLEADOS Y USUARIOS REGISTRADOS EN EL SISTEMA ===")
	for _, e := range employees {
		fmt.Printf("👤 Nombre: %s | DNI/Usuario: %s | Rol: %s | PIN: %s\n", e.Name, e.DNI, e.Role, e.PIN)
	}
}
