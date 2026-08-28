package main

import (
	"context"
	"flag"
	"log"
	"os"
	"strings"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/migrations"
	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()
	confirm := flag.Bool("confirm", false, "confirma la creación de registros canónicos faltantes")
	adminDNI := flag.String("admin-dni", "ADMIN", "DNI del administrador que será autor de los registros")
	createDefaultAdmin := flag.Bool("create-default-admin", false, "crea ADMIN/123456 sólo si no existe ningún empleado")
	flag.Parse()
	if !*confirm {
		log.Fatal("❌ Operación cancelada: use --confirm después de verificar la base destino")
	}
	if *createDefaultAdmin && *adminDNI != "ADMIN" {
		log.Fatal("❌ --create-default-admin crea el DNI ADMIN; no puede combinarse con otro --admin-dni")
	}
	log.Printf("🎯 PostgreSQL destino: host=%s db=%s user=%s", strings.TrimSpace(os.Getenv("DB_HOST")), strings.TrimSpace(os.Getenv("DB_NAME")), strings.TrimSpace(os.Getenv("DB_USER")))

	db, err := repositories.OpenDatabase()
	if err != nil {
		log.Fatalf("❌ %v", err)
	}
	sqlDB, err := db.DB()
	if err == nil {
		defer sqlDB.Close()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := migrations.VerifyCurrent(ctx, db); err != nil {
		log.Fatalf("❌ El esquema no está listo: %v", err)
	}
	if err := repositories.SeedDefaults(db.WithContext(ctx), *adminDNI, *createDefaultAdmin); err != nil {
		log.Fatalf("❌ No se pudieron crear las semillas: %v", err)
	}
	if *createDefaultAdmin {
		log.Println("⚠️ Se solicitó el administrador temporal ADMIN/123456; cambie su contraseña inmediatamente")
	}
	log.Println("✅ Registros canónicos verificados/creados sin borrar datos existentes")
}
