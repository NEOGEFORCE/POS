package main

import (
	"fmt"
	"log"
	"os"
	"github.com/joho/godotenv"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"golang.org/x/crypto/bcrypt"
	"backPOS-go/internal/core/domain/models"
)

func main() {
	godotenv.Load()
	user := os.Getenv("DB_USER")
	password := os.Getenv("DB_PASSWORD")
	host := os.Getenv("DB_HOST")
	port := os.Getenv("DB_PORT")
	dbname := os.Getenv("DB_NAME")

	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable TimeZone=UTC", host, user, password, dbname, port)
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal(err)
	}

	hashedPassword, _ := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.DefaultCost)
	
	result := db.Model(&models.Employee{}).Where("name = ?", "sebastian").Update("password", string(hashedPassword))
	
	if result.Error != nil {
		fmt.Printf("❌ Error al actualizar: %v\n", result.Error)
	} else if result.RowsAffected == 0 {
		fmt.Println("⚠️ No se encontró al usuario 'sebastian' para actualizar.")
	} else {
		fmt.Println("✅ ¡CONTRASEÑA RESETEADA! Ahora 'sebastian' puede entrar con '123456'.")
	}
}
