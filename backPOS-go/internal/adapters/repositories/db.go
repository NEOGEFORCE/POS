package repositories

import (
	"context"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var DB *gorm.DB

type databasePoolConfig struct {
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
	ConnMaxIdleTime time.Duration
	PingTimeout     time.Duration
}

func boundedEnvInt(name string, fallback, minimum, maximum int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		log.Printf("⚠️ %s=%q fuera de rango; se usará %d", name, raw, fallback)
		return fallback
	}
	return value
}

func databasePoolConfigFromEnv() databasePoolConfig {
	maxOpen := boundedEnvInt("DB_MAX_OPEN_CONNS", 25, 1, 200)
	maxIdle := boundedEnvInt("DB_MAX_IDLE_CONNS", 5, 0, 200)
	if maxIdle > maxOpen {
		log.Printf("⚠️ DB_MAX_IDLE_CONNS=%d excede DB_MAX_OPEN_CONNS=%d; se ajustará al máximo abierto", maxIdle, maxOpen)
		maxIdle = maxOpen
	}
	lifetimeMinutes := boundedEnvInt("DB_CONN_MAX_LIFETIME_MINUTES", 30, 1, 1440)
	idleMinutes := boundedEnvInt("DB_CONN_MAX_IDLE_MINUTES", 5, 1, 120)
	pingSeconds := boundedEnvInt("DB_PING_TIMEOUT_SECONDS", 5, 1, 60)
	return databasePoolConfig{
		MaxOpenConns:    maxOpen,
		MaxIdleConns:    maxIdle,
		ConnMaxLifetime: time.Duration(lifetimeMinutes) * time.Minute,
		ConnMaxIdleTime: time.Duration(idleMinutes) * time.Minute,
		PingTimeout:     time.Duration(pingSeconds) * time.Second,
	}
}

func configureAndPingDatabase(db *gorm.DB) error {
	sqlDB, err := db.DB()
	if err != nil {
		return fmt.Errorf("obteniendo conexión SQL: %w", err)
	}
	config := databasePoolConfigFromEnv()
	sqlDB.SetMaxOpenConns(config.MaxOpenConns)
	sqlDB.SetMaxIdleConns(config.MaxIdleConns)
	sqlDB.SetConnMaxLifetime(config.ConnMaxLifetime)
	sqlDB.SetConnMaxIdleTime(config.ConnMaxIdleTime)

	ctx, cancel := context.WithTimeout(context.Background(), config.PingTimeout)
	defer cancel()
	if err := sqlDB.PingContext(ctx); err != nil {
		return fmt.Errorf("PostgreSQL no respondió en %s: %w", config.PingTimeout, err)
	}
	log.Printf("✅ PostgreSQL pool: open=%d idle=%d lifetime=%s idle-time=%s", config.MaxOpenConns, config.MaxIdleConns, config.ConnMaxLifetime, config.ConnMaxIdleTime)
	return nil
}

// OpenDatabase abre y verifica la base configurada. No crea bases, tablas,
// índices, vistas, roles ni datos: esos cambios pertenecen al comando migrate.
func OpenDatabase() (*gorm.DB, error) {
	user := strings.TrimSpace(os.Getenv("DB_USER"))
	password := os.Getenv("DB_PASSWORD")
	host := strings.TrimSpace(os.Getenv("DB_HOST"))
	port := strings.TrimSpace(os.Getenv("DB_PORT"))
	dbname := strings.TrimSpace(os.Getenv("DB_NAME"))

	for name, value := range map[string]string{
		"DB_USER": user,
		"DB_HOST": host,
		"DB_PORT": port,
		"DB_NAME": dbname,
	} {
		if value == "" {
			return nil, fmt.Errorf("la variable %s es obligatoria", name)
		}
	}

	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable TimeZone=UTC", host, user, password, dbname, port)
	newLogger := logger.New(
		log.New(os.Stdout, "\r\n", log.LstdFlags),
		logger.Config{
			SlowThreshold:             time.Second,
			LogLevel:                  logger.Warn,
			IgnoreRecordNotFoundError: true,
			Colorful:                  true,
		},
	)

	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger:                                   newLogger,
		DisableForeignKeyConstraintWhenMigrating: true,
	})
	if err != nil {
		return nil, fmt.Errorf("conectando a PostgreSQL: %w", err)
	}
	if err := configureAndPingDatabase(db); err != nil {
		sqlDB, sqlErr := db.DB()
		if sqlErr == nil {
			_ = sqlDB.Close()
		}
		return nil, err
	}

	log.Printf("✅ Database connection established: %s", dbname)
	return db, nil
}

// ConnectDB mantiene el contrato histórico de la aplicación. Sólo conecta;
// la compatibilidad del esquema se comprueba de forma separada en cmd/api.
func ConnectDB() {
	db, err := OpenDatabase()
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	DB = db
}
