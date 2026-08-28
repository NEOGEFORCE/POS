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
	confirm := flag.Bool("confirm", false, "confirma el refresco de la vista materializada")
	timeout := flag.Duration("timeout", 10*time.Minute, "tiempo máximo del refresco")
	flag.Parse()
	if !*confirm {
		log.Fatal("❌ Operación cancelada: use --confirm después de verificar la base destino")
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

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	if err := migrations.VerifyCurrent(ctx, db); err != nil {
		log.Fatalf("❌ El esquema no está listo: %v", err)
	}
	if err := db.WithContext(ctx).Exec("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_dashboard_stats_monthly").Error; err != nil {
		log.Fatalf("❌ No se pudo refrescar mv_dashboard_stats_monthly: %v", err)
	}
	log.Println("✅ Vista mv_dashboard_stats_monthly refrescada")
}
