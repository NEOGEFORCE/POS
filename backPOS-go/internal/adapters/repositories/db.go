package repositories

import (
	"fmt"
	"log"
	"os"
	"time"

	"backPOS-go/internal/core/domain/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"golang.org/x/crypto/bcrypt"
	"strings"
)

var DB *gorm.DB

func ConnectDB() {
	user := os.Getenv("DB_USER")
	password := os.Getenv("DB_PASSWORD")
	host := os.Getenv("DB_HOST")
	port := os.Getenv("DB_PORT")
	dbname := os.Getenv("DB_NAME")

	// 1. Conectar primero a 'postgres' para asegurar que la base de datos destino existe
	dsn_postgres := fmt.Sprintf("host=%s user=%s password=%s dbname=postgres port=%s sslmode=disable TimeZone=UTC", host, user, password, port)
	db_init, err := gorm.Open(postgres.Open(dsn_postgres), &gorm.Config{})
	if err == nil {
		// Verificar si la base de datos ya existe antes de intentar crearla
		var exists int
		db_init.Raw("SELECT 1 FROM pg_database WHERE datname = ?", dbname).Scan(&exists)

		if exists == 0 {
			// Intentar crear la base de datos solo si no existe
			if err := db_init.Exec(fmt.Sprintf("CREATE DATABASE %s", dbname)).Error; err != nil {
				log.Printf("Warning: Could not create database: %v", err)
			} else {
				log.Printf("Database %s created successfully.", dbname)
			}
		}
		
		sqlDB, _ := db_init.DB()
		sqlDB.Close()
	}

	// 2. Ahora conectar a la base de datos real del sistema
	dsn := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable TimeZone=UTC", host, user, password, dbname, port)
	
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal("Failed to connect to database. \n", err)
	}

	// Limpiar restricciones antiguas que bloquean la migración (Email ya no es unique)
	m := db.Migrator()
	if m.HasConstraint(&models.Employee{}, "uni_employees_email") {
		m.DropConstraint(&models.Employee{}, "uni_employees_email")
	}
	if m.HasIndex(&models.Employee{}, "uni_employees_email") {
		m.DropIndex(&models.Employee{}, "uni_employees_email")
	}
	
	// LIMPIEZA NUCLEAR: Borrar todas las restricciones e índices redundantes antes de la migración
	// Esto asegura que 'name', 'email' y 'phoneNumber' (que vamos a borrar) no bloqueen nada.
	db.Exec(`
		DO $$ 
		DECLARE 
			r RECORD;
		BEGIN
			-- 1. Borrar todos los Índices Únicos (excepto la llave primaria)
			FOR r IN (
				SELECT indexname 
				FROM pg_indexes 
				WHERE tablename = 'employees' 
				AND indexname != 'employees_pkey'
				AND indexdef LIKE '%UNIQUE%'
			) LOOP
				EXECUTE 'DROP INDEX IF EXISTS ' || quote_ident(r.indexname);
			END LOOP;

			-- 2. Borrar todas las Restricciones de Unicidad
			FOR r IN (
				SELECT conname 
				FROM pg_constraint 
				WHERE conrelid = 'employees'::regclass 
				AND contype = 'u'
			) LOOP
				EXECUTE 'ALTER TABLE employees DROP CONSTRAINT IF EXISTS ' || quote_ident(r.conname);
			END LOOP;

			-- 3. ELIMINAR LA COLUMNA DE TELÉFONO (Petición del usuario en Employees)
			IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='employees' AND column_name='phoneNumber') THEN
				ALTER TABLE employees DROP COLUMN "phoneNumber";
			END IF;

			-- 4. LIMPIEZA DE DEVOLUCIONES (Borrar columnas obsoletas de versiones JS)
			IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='returns' AND column_name='quantity') THEN
				ALTER TABLE "returns" DROP COLUMN "quantity";
			END IF;
			IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='returns' AND column_name='barcode') THEN
				ALTER TABLE "returns" DROP COLUMN "barcode";
			END IF;
			IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='returns' AND column_name='createdAt') THEN
				ALTER TABLE "returns" DROP COLUMN "createdAt";
			END IF;
			IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='returns' AND column_name='updatedAt') THEN
				ALTER TABLE "returns" DROP COLUMN "updatedAt";
			END IF;
		END $$;
	`)

	// Migrar tablas una por una
	models_to_migrate := []interface{}{
		&models.Employee{},
		&models.Client{},
		&models.Category{},
		&models.Supplier{},
		&models.Product{},
		&models.Sale{},
		&models.SaleDetail{},
		&models.Expense{},
		&models.Return{},
		&models.ReturnDetail{},
		&models.CashierClosure{},
		&models.ActiveShift{},
		&models.CreditPayment{},
		&models.ProductSupplier{},
		&models.StockMovement{},
	}

	// Sesión especial para migraciones: sin transacciones y en modo SILENCIOSO para evitar ruido en el terminal
	migrationDB := db.Session(&gorm.Session{
		SkipDefaultTransaction: true,
		Logger:                 logger.Default.LogMode(logger.Silent),
	})

	for _, model := range models_to_migrate {
		if err := migrationDB.AutoMigrate(model); err != nil {
			// Ignorar el error específico de uni_employees_email que es benigno (ya no se usa)
			if !strings.Contains(err.Error(), "uni_employees_email") {
				log.Printf("Warning: Failed to auto-migrate model %T: %v", model, err)
			}
		}
	}

	DB = db
	log.Printf("✅ Database connection established: %s", dbname)

	SeedAdmin(db)
	SeedClient(db)
	// SeedShift(db)
}

func SeedAdmin(db *gorm.DB) {
	hashedPassword, _ := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.DefaultCost)
	admin := models.Employee{
		DNI:      "12345678",
		Name:     "Admin Inicial",
		Email:    "admin@pos.com",
		Password: string(hashedPassword),
		Role:     "admin",
	}
	// Usamos Save para que si ya existe se actualice/mantenga, 
	// asegurando que el DNI 12345678 esté presente para las llaves foráneas.
	if err := db.Save(&admin).Error; err != nil {
		log.Printf("⚠️ Warning: Failed to ensure default admin exists: %v", err)
	} else {
		log.Printf("👤 System Administrator (12345678) is ready.")
	}
}

func SeedClient(db *gorm.DB) {
	var count int64
	db.Unscoped().Model(&models.Client{}).Where("\"dni\" = ?", "0").Count(&count)
	if count == 0 {
		client := models.Client{
			DNI:          "0",
			Name:         "CONSUMIDOR FINAL",
			CreatedByDNI: "12345678", // Usamos el DNI del admin inicial que sí existe
			UpdatedByDNI: "12345678",
		}
		if err := db.Create(&client).Error; err != nil {
			log.Printf("⚠️ Warning: Failed to seed default client: %v", err)
		} else {
			log.Printf("👥 Default Client (CONSUMIDOR FINAL) is ready.")
		}
	}
}

func SeedShift(db *gorm.DB) {
	var count int64
	db.Model(&models.ActiveShift{}).Where("status = ?", "OPEN").Count(&count)
	if count == 0 {
		shift := models.ActiveShift{
			StartTime:   time.Now(),
			OpeningCash: 120000,
			CashierDNI:  "12345678",
			CashierName: "Admin Inicial",
			Status:      "OPEN",
		}
		if err := db.Create(&shift).Error; err != nil {
			log.Printf("⚠️ Warning: Failed to seed default shift: %v", err)
		} else {
			log.Printf("🚀 Active Shift started with base $120.000.")
		}
	}
}

