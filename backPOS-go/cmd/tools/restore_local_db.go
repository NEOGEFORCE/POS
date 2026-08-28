//go:build tools_legacy
// +build tools_legacy


﻿package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"

	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	_ = godotenv.Load()
	host := "127.0.0.1"
	port := "5432"
	user := "postgres"
	pass := os.Getenv("LEGACY_DB_PASSWORD")

	// 1. Conectar a postgres (sin DB) para crear la BD si no existe
	dsnAdmin := fmt.Sprintf("host=%s user=%s password=%s dbname=postgres port=%s sslmode=disable", host, user, pass, port)
	adminDB, err := gorm.Open(postgres.Open(dsnAdmin), &gorm.Config{})
	if err != nil {
		log.Fatalf("❌ Error conectando a PostgreSQL local (127.0.0.1): %v", err)
	}

	// Terminar conexiones activas y recrear DB sistemapos limpia
	adminDB.Exec("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'sistemapos';")
	adminDB.Exec("DROP DATABASE IF EXISTS sistemapos;")
	adminDB.Exec("CREATE DATABASE sistemapos;")
	fmt.Println("✅ Base de datos 'sistemapos' recreada limpia en PostgreSQL local.")

	// 2. Probar buscar psql.exe en rutas típicas de PostgreSQL en Windows
	psqlPaths := []string{
		`S:\Program Files\PostgreSQL\18\bin\psql.exe`,
		`C:\Program Files\PostgreSQL\18\bin\psql.exe`,
		`C:\Program Files\PostgreSQL\17\bin\psql.exe`,
		`C:\Program Files\PostgreSQL\16\bin\psql.exe`,
		`C:\Program Files\PostgreSQL\15\bin\psql.exe`,
		`C:\Program Files\PostgreSQL\14\bin\psql.exe`,
		`psql.exe`,
	}

	psqlExe := ""
	for _, path := range psqlPaths {
		if _, err := os.Stat(path); err == nil {
			psqlExe = path
			break
		}
	}

	backupFile := `C:\Users\jaide\OneDrive\Desktop\backup_pos_2026-08-14_21-20 (2).sql`
	fmt.Printf("📦 Restaurando copia de seguridad: %s\n", backupFile)

	if psqlExe != "" {
		cmd := exec.Command(psqlExe, "-U", user, "-d", "sistemapos", "-h", host, "-p", port, "-f", backupFile)
		cmd.Env = append(os.Environ(), "PGPASSWORD="+pass)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		err = cmd.Run()
		if err != nil {
			log.Printf("⚠️ Advertencia durante restauración con psql: %v", err)
		} else {
			fmt.Println("✅ Copia de seguridad restaurada exitosamente con psql.")
		}
	} else {
		log.Println("⚠️ psql.exe no encontrado en rutas estándar. Intentando con ejecutor alternativo.")
	}

	// 3. Verificar tablas importadas en sistemapos
	dsnPOS := fmt.Sprintf("host=%s user=%s password=%s dbname=sistemapos port=%s sslmode=disable", host, user, pass, port)
	posDB, err := gorm.Open(postgres.Open(dsnPOS), &gorm.Config{})
	if err != nil {
		log.Fatalf("❌ Error conectando a sistemapos: %v", err)
	}

	var productCount, saleCount, expenseCount int64
	posDB.Table("products").Count(&productCount)
	posDB.Table("sales").Count(&saleCount)
	posDB.Table("expenses").Count(&expenseCount)

	fmt.Println("\n=== ESTADO FINAL DE LA BASE DE DATOS LOCAL (sistemapos) ===")
	fmt.Printf("🛍️ Productos: %d\n", productCount)
	fmt.Printf("🛒 Ventas: %d\n", saleCount)
	fmt.Printf("💸 Egresos: %d\n", expenseCount)
}
