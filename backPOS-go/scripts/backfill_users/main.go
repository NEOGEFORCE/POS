package main

import (
	"fmt"
	"log"
	"os"

	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	// 1. Cargar .env
	err := godotenv.Load()
	if err != nil {
		log.Println("No .env file found, using system environment variables")
	}

	user := os.Getenv("DB_USER")
	password := os.Getenv("DB_PASSWORD")
	host := os.Getenv("DB_HOST")
	port := os.Getenv("DB_PORT")
	dbname := os.Getenv("DB_NAME")

	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable TimeZone=UTC", host, user, password, dbname, port)
	
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal("Failed to connect to database:", err)
	}

	fmt.Println("Conectado a la base de datos:", dbname)
	fmt.Println("--- INICIANDO BACKFILL DE INTEGRIDAD DE USUARIOS ---")

	// 2. Desactivar usuarios con nombre vacío o que solo contienen espacios
	fmt.Println("Detectando usuarios con nombres inválidos...")
	result := db.Exec("UPDATE employees SET is_active = false WHERE TRIM(name) = ''")
	if result.Error != nil {
		log.Printf("Error desactivando nombres vacíos: %v", result.Error)
	} else {
		fmt.Printf("Usuarios desactivados por nombre vacío: %d\n", result.RowsAffected)
	}

	// 3. Normalizar nombres (quitar espacios extra y pasar a MAYÚSCULAS)
	fmt.Println("Normalizando nombres de usuarios activos...")
	result = db.Exec("UPDATE employees SET name = UPPER(TRIM(name)) WHERE TRIM(name) != ''")
	if result.Error != nil {
		log.Printf("Error normalizando nombres: %v", result.Error)
	} else {
		fmt.Printf("Usuarios normalizados: %d\n", result.RowsAffected)
	}

	// 4. Desactivar usuarios inactivos que NO tienen un DNI válido (por si quedaron huérfanos)
	// Definimos DNI inválido como vacío o menor a 3 caracteres (ajustable)
	fmt.Println("Limpiando registros sin DNI válido...")
	result = db.Exec("UPDATE employees SET is_active = false WHERE TRIM(dni) = '' OR LENGTH(TRIM(dni)) < 3")
	if result.Error != nil {
		log.Printf("Error limpiando DNI inválidos: %v", result.Error)
	} else {
		fmt.Printf("Registros invalidados por DNI: %d\n", result.RowsAffected)
	}

	fmt.Println("--- BACKFILL COMPLETADO CON ÉXITO ---")
}
