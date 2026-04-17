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

	// 2. Restaurar todos los empleados (quitar soft delete)
	fmt.Println("Restaurando empleados borrados...")
	result := db.Exec("UPDATE employees SET deleted_at = NULL")
	if result.Error != nil {
		log.Fatal("Error restaurando empleados:", result.Error)
	}
	fmt.Printf("Filas afectadas (restauración): %d\n", result.RowsAffected)

	// 3. Corregir el rol 'adminestrador' a 'SUPERADMIN'
	fmt.Println("Normalizando roles de administrador...")
	result = db.Exec("UPDATE employees SET role = 'SUPERADMIN' WHERE role ILIKE 'admin%'")
	if result.Error != nil {
		log.Fatal("Error corrigiendo roles:", result.Error)
	}
	fmt.Printf("Filas afectadas (roles): %d\n", result.RowsAffected)

	// 4. Asegurar que el Superadmin esté activo
	fmt.Println("Asegurando que el Superadmin esté activo...")
	result = db.Exec("UPDATE employees SET is_active = true WHERE role = 'SUPERADMIN'")
	if result.Error != nil {
		log.Fatal("Error activando Superadmin:", result.Error)
	}
	
	fmt.Println("¡Proceso completado con éxito!")
}
