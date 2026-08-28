package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/migrations"
	"github.com/joho/godotenv"
)

func usage() {
	fmt.Fprintln(os.Stderr, "Uso:")
	fmt.Fprintln(os.Stderr, "  migrate status")
	fmt.Fprintln(os.Stderr, "  migrate up --confirm")
}

func main() {
	_ = godotenv.Load()
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
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

	switch strings.ToLower(os.Args[1]) {
	case "status":
		statusFlags := flag.NewFlagSet("status", flag.ExitOnError)
		_ = statusFlags.Parse(os.Args[2:])
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		statuses, err := migrations.Statuses(ctx, db)
		if err != nil {
			log.Fatalf("❌ No se pudo consultar el estado: %v", err)
		}
		for _, status := range statuses {
			state := "PENDIENTE"
			when := ""
			if status.Applied {
				state = "APLICADA"
				when = " " + status.AppliedAt.Local().Format(time.RFC3339)
			}
			fmt.Printf("%-10s %03d_%s%s\n", state, status.Version, status.Name, when)
		}
	case "up":
		upFlags := flag.NewFlagSet("up", flag.ExitOnError)
		confirm := upFlags.Bool("confirm", false, "confirma que existe respaldo y ventana controlada")
		timeout := upFlags.Duration("timeout", 30*time.Minute, "tiempo máximo de migración")
		_ = upFlags.Parse(os.Args[2:])
		if !*confirm {
			log.Fatal("❌ Operación cancelada: use --confirm sólo después de respaldo, preflight y ventana controlada")
		}
		ctx, cancel := context.WithTimeout(context.Background(), *timeout)
		defer cancel()
		if err := migrations.ApplyPending(ctx, db); err != nil {
			log.Fatalf("❌ Migración abortada: %v", err)
		}
		log.Println("✅ Esquema actualizado al catálogo vigente")
	default:
		usage()
		os.Exit(2)
	}
}
