//go:build tools_legacy
// +build tools_legacy


﻿package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"time"

	"backPOS-go/internal/infrastructure/dbbackup"
	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()
	host := "127.0.0.1"
	port := "5432"
	user := "postgres"
	pass := os.Getenv("LEGACY_DB_PASSWORD")
	dbname := "sistemapos"

	pgDumpPath, _, err := dbbackup.ResolvePgDumpPath()
	if err != nil {
		log.Fatalf("❌ Error encontrando pg_dump: %v", err)
	}

	timeStr := time.Now().Format("2006-01-02_15-04")
	filename := fmt.Sprintf("backup_pos_AL_DIA_%s.sql", timeStr)
	desktopPath := fmt.Sprintf(`C:\Users\jaide\OneDrive\Desktop\%s`, filename)

	args := []string{"-h", host, "-p", port, "-U", user, "-d", dbname, "-F", "p", "-f", desktopPath}
	cmd := exec.Command(pgDumpPath, args...)
	cmd.Env = append(os.Environ(), "PGPASSWORD="+pass)

	fmt.Printf("🛠️ Generando respaldo actual al instante: %s\n", desktopPath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Fatalf("❌ Error ejecutando pg_dump: %v. Output: %s", err, string(output))
	}

	info, err := os.Stat(desktopPath)
	if err != nil {
		log.Fatalf("❌ No se encontró el archivo generado: %v", err)
	}

	fmt.Println("===================================================")
	fmt.Println("✅ COPIA DE SEGURIDAD GENERADA EXITOSAMENTE AHORA")
	fmt.Printf("📄 Archivo: %s\n", desktopPath)
	fmt.Printf("📦 Tamaño: %.2f MB\n", float64(info.Size())/(1024*1024))
	fmt.Println("===================================================")
}
