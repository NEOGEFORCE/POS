package main

import (
	"fmt"
	"log"
	"os"

	"backPOS-go/internal/adapters/repositories"
	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	// 1. Cargar entorno
	err := godotenv.Load()
	if err != nil {
		log.Println("No .env file found, relying on environment variables")
	}

	user := os.Getenv("DB_USER")
	password := os.Getenv("DB_PASSWORD")
	host := os.Getenv("DB_HOST")
	port := os.Getenv("DB_PORT")
	dbname := os.Getenv("DB_NAME")

	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable TimeZone=UTC", host, user, password, dbname, port)

	// 2. Conectar manualmente para el WIPE
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("❌ Error al conectar para limpieza: %v", err)
	}

	fmt.Println("🚀 INICIANDO RESET TOTAL PARA PRODUCCIÓN...")

	// 3. WIPE TOTAL: Borrar el esquema public y recrearlo
	// Esto elimina tablas, tipos, vistas y funciones.
	err = db.Exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;").Error
	if err != nil {
		log.Fatalf("❌ Fallo crítico en limpieza (WIPE): %v", err)
	}

	fmt.Println("✅ Base de datos vaciada (WIPE) con éxito.")

	// 4. Cerrar conexión temporal
	sqlDB, _ := db.DB()
	sqlDB.Close()

	// 5. Inicializar sistema normalmente (AutoMigrate + SeedAdmin)
	// Esto recreará toda la estructura y el usuario SEBASTIAN
	repositories.ConnectDB()

	fmt.Println("\n✨ PROCESO DE SEEDING COMPLETADO ✨")
}
