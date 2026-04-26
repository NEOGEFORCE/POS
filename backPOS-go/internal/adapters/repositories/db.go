package repositories

import (
	"fmt"
	"log"
	"os"

	"backPOS-go/internal/core/domain/models"
	"strings"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"time"
	"golang.org/x/crypto/bcrypt"
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

			-- 5. BACKFILL PARA COSTPRICE (Evitar error 23502 en sale_details)
			IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sale_details' AND column_name='costPrice') THEN
				UPDATE sale_details SET "costPrice" = 0 WHERE "costPrice" IS NULL;
			END IF;

			-- 6. MIGRACIÓN DE AUDITORÍA EN EGRESOS (camelCase to snake_case)
			IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='expenses' AND column_name='created_by_dni') THEN
				-- Primero, si existe la columna vieja, migrar los datos
				IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='expenses' AND column_name='createdByDni') THEN
					UPDATE expenses SET "created_by_dni" = "createdByDni" WHERE "created_by_dni" IS NULL OR "created_by_dni" = '';
					ALTER TABLE expenses DROP COLUMN "createdByDni";
				END IF;

				-- Segundo, asegurar que NO haya nulos (usar el primer empleado como fallback para registros huérfanos)
				UPDATE expenses 
				SET "created_by_dni" = COALESCE(
					(SELECT dni FROM employees ORDER BY role DESC LIMIT 1), 
					'SISTEMA'
				) 
				WHERE "created_by_dni" IS NULL OR "created_by_dni" = '';
			END IF;
			-- 7. REFINAMIENTO LOGÍSTICO (Eliminar Dirección física irrelevante)
			IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='suppliers' AND column_name='address') THEN
				ALTER TABLE suppliers DROP COLUMN "address";
			END IF;

			-- 8. MIGRACIÓN DE CIERRE DE CAJA (Asegurar columnas de desglose y auditoría)
			IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cashier_closures' AND column_name='cash_bills') THEN
				ALTER TABLE cashier_closures ADD COLUMN cash_bills DECIMAL(10,2) DEFAULT 0;
			END IF;
			IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cashier_closures' AND column_name='coins200') THEN
				ALTER TABLE cashier_closures ADD COLUMN coins200 DECIMAL(10,2) DEFAULT 0;
			END IF;
			IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cashier_closures' AND column_name='coins100') THEN
				ALTER TABLE cashier_closures ADD COLUMN coins100 DECIMAL(10,2) DEFAULT 0;
			END IF;
			IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cashier_closures' AND column_name='coins500_1000') THEN
				ALTER TABLE cashier_closures ADD COLUMN coins500_1000 DECIMAL(10,2) DEFAULT 0;
			END IF;
			IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cashier_closures' AND column_name='closed_by_dni') THEN
				ALTER TABLE cashier_closures ADD COLUMN closed_by_dni VARCHAR(50) DEFAULT '';
			END IF;
			IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cashier_closures' AND column_name='closed_by_name') THEN
				ALTER TABLE cashier_closures ADD COLUMN closed_by_name VARCHAR(255) DEFAULT '';
			END IF;
			IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cashier_closures' AND column_name='physical_cash') THEN
				ALTER TABLE cashier_closures ADD COLUMN physical_cash DECIMAL(10,2) DEFAULT 0;
			END IF;
			IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cashier_closures' AND column_name='difference') THEN
				ALTER TABLE cashier_closures ADD COLUMN difference DECIMAL(10,2) DEFAULT 0;
			END IF;
			IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cashier_closures' AND column_name='authorized_by') THEN
				ALTER TABLE cashier_closures ADD COLUMN authorized_by VARCHAR(255) DEFAULT '';
			END IF;
			IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cashier_closures' AND column_name='total_card') THEN
				ALTER TABLE cashier_closures ADD COLUMN total_card DECIMAL(10,2) DEFAULT 0;
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
		&models.AuditLog{},
		&models.MissingItem{},
		&models.ExpectedOrder{}, // CRITICAL FIX: Tabla de pedidos esperados/preventa
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

	// --- OPTIMIZACIÓN TIER 1: CONNECTION POOL ---
	sqlDB, err := db.DB()
	if err == nil {
		sqlDB.SetMaxIdleConns(10)
		sqlDB.SetMaxOpenConns(100)
		sqlDB.SetConnMaxLifetime(time.Hour)
	}

	// Ejecutar setup avanzado (RLS, roles, migraciones adicionales)
	if err := runDatabaseSetup(db); err != nil {
		log.Printf("⚠️ Warning: Database setup encountered issues: %v", err)
	}

	// 5. Crear Índices Globales para escalabilidad masiva
	if err := createGlobalIndexes(db); err != nil {
		log.Printf("⚠️ Warning: Index creation encountered issues: %v", err)
	}

	// 6. Crear Vistas Materializadas para Dashboard HFT
	if err := createMaterializedViews(db); err != nil {
		log.Printf("⚠️ Warning: Materialized views encountered issues: %v", err)
	}

	// 7. Seed Admin y Client
	SeedAdmin(db)
	SeedClient(db, "1000128428")
}

// runDatabaseSetup ejecuta configuraciones avanzadas de BD (idempotente)
func runDatabaseSetup(db *gorm.DB) error {
	log.Printf("🔧 Running advanced database setup...")

	// 1. Crear roles de PostgreSQL si no existen (idempotente)
	if err := createPostgreSQLRoles(db); err != nil {
		log.Printf("⚠️ Role creation warning (may already exist): %v", err)
	}

	// 2. Agregar columnas nuevas para proveedores (multi-días)
	if err := addSupplierMultiDayColumns(db); err != nil {
		log.Printf("⚠️ Supplier columns warning: %v", err)
	}

	// 3. Habilitar RLS en tablas transaccionales
	if err := enableRLS(db); err != nil {
		log.Printf("⚠️ RLS setup warning: %v", err)
	}

	// 4. Crear políticas RLS
	if err := createRLSPolicies(db); err != nil {
		log.Printf("⚠️ RLS policies warning: %v", err)
	}

	log.Printf("✅ Advanced database setup completed")
	return nil
}

// createPostgreSQLRoles crea los roles necesarios (idempotente)
func createPostgreSQLRoles(db *gorm.DB) error {
	log.Printf("👤 Creating PostgreSQL roles...")

	// Crear rol 'authenticated' si no existe (idempotente)
	sql := `
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
				CREATE ROLE authenticated NOLOGIN;
				RAISE NOTICE 'Role authenticated created';
			ELSE
				RAISE NOTICE 'Role authenticated already exists';
			END IF;
		END $$;
	`
	if err := db.Exec(sql).Error; err != nil {
		return fmt.Errorf("failed to create authenticated role: %w", err)
	}

	// Crear rol 'employee' si no existe
	sql = `
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'employee') THEN
				CREATE ROLE employee NOLOGIN;
				RAISE NOTICE 'Role employee created';
			ELSE
				RAISE NOTICE 'Role employee already exists';
			END IF;
		END $$;
	`
	if err := db.Exec(sql).Error; err != nil {
		return fmt.Errorf("failed to create employee role: %w", err)
	}

	log.Printf("✅ PostgreSQL roles ready")
	return nil
}

// addSupplierMultiDayColumns agrega columnas JSONB para multi-días (idempotente)
func addSupplierMultiDayColumns(db *gorm.DB) error {
	log.Printf("📦 Adding supplier multi-day columns...")

	sql := `
		-- Agregar columnas si no existen
		DO $$
		BEGIN
			-- visit_days (JSONB)
			IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='suppliers' AND column_name='visit_days') THEN
				ALTER TABLE suppliers ADD COLUMN visit_days JSONB DEFAULT '[]';
			END IF;

			-- delivery_days (JSONB)
			IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='suppliers' AND column_name='delivery_days') THEN
				ALTER TABLE suppliers ADD COLUMN delivery_days JSONB DEFAULT '[]';
			END IF;

			-- restock_method
			IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='suppliers' AND column_name='restock_method') THEN
				ALTER TABLE suppliers ADD COLUMN restock_method VARCHAR(50) DEFAULT '';
			END IF;
		END $$;

		-- Migrar datos legacy a nuevo formato (bloques independientes con excepciones)
		-- Intento 1: Migrar visitDay (variante camelCase)
		DO $$
		BEGIN
			UPDATE suppliers SET visit_days = CASE 
				WHEN "visitDay" IS NOT NULL AND "visitDay" != '' AND (visit_days IS NULL OR visit_days = '[]'::jsonb)
				THEN jsonb_build_array("visitDay")
				ELSE visit_days
			END
			WHERE "visitDay" IS NOT NULL;
		EXCEPTION WHEN undefined_column THEN
			RAISE NOTICE 'Column visitDay does not exist, skipping migration';
		END $$;

		-- Intento 2: Migrar visit_day (variante snake_case)
		DO $$
		BEGIN
			UPDATE suppliers SET visit_days = CASE 
				WHEN "visit_day" IS NOT NULL AND "visit_day" != '' AND (visit_days IS NULL OR visit_days = '[]'::jsonb)
				THEN jsonb_build_array("visit_day")
				ELSE visit_days
			END
			WHERE "visit_day" IS NOT NULL;
		EXCEPTION WHEN undefined_column THEN
			RAISE NOTICE 'Column visit_day does not exist, skipping migration';
		END $$;

		-- Intento 3: Migrar deliveryDay (variante camelCase)
		DO $$
		BEGIN
			UPDATE suppliers SET delivery_days = CASE 
				WHEN "deliveryDay" IS NOT NULL AND "deliveryDay" != '' AND (delivery_days IS NULL OR delivery_days = '[]'::jsonb)
				THEN jsonb_build_array("deliveryDay")
				ELSE delivery_days
			END
			WHERE "deliveryDay" IS NOT NULL;
		EXCEPTION WHEN undefined_column THEN
			RAISE NOTICE 'Column deliveryDay does not exist, skipping migration';
		END $$;

		-- Intento 4: Migrar delivery_day (variante snake_case)
		DO $$
		BEGIN
			UPDATE suppliers SET delivery_days = CASE 
				WHEN "delivery_day" IS NOT NULL AND "delivery_day" != '' AND (delivery_days IS NULL OR delivery_days = '[]'::jsonb)
				THEN jsonb_build_array("delivery_day")
				ELSE delivery_days
			END
			WHERE "delivery_day" IS NOT NULL;
		EXCEPTION WHEN undefined_column THEN
			RAISE NOTICE 'Column delivery_day does not exist, skipping migration';
		END $$;
	`
	if err := db.Exec(sql).Error; err != nil {
		return fmt.Errorf("failed to add supplier columns: %w", err)
	}

	log.Printf("✅ Supplier multi-day columns ready")
	return nil
}

// enableRLS habilita Row Level Security en tablas transaccionales
func enableRLS(db *gorm.DB) error {
	log.Printf("🔒 Enabling Row Level Security...")

	tables := []string{
		"sales",
		"sale_details",
		"products",
		"expenses",
		"clients",
		"returns",
		"return_details",
		"stock_movements",
		"missing_items",
		"expected_orders", // CRITICAL FIX: RLS para pedidos esperados/preventa
	}

	for _, table := range tables {
		sql := fmt.Sprintf(`
			DO $$
			BEGIN
				-- Habilitar RLS si no está habilitado
				IF NOT EXISTS (
					SELECT 1 FROM pg_tables 
					WHERE tablename = '%s' 
					AND rowsecurity = true
				) THEN
					EXECUTE 'ALTER TABLE %s ENABLE ROW LEVEL SECURITY';
					EXECUTE 'ALTER TABLE %s FORCE ROW LEVEL SECURITY';
					RAISE NOTICE 'RLS enabled on %s';
				END IF;
			END $$;
		`, table, table, table, table)

		if err := db.Exec(sql).Error; err != nil {
			log.Printf("⚠️ Warning: Could not enable RLS on %s: %v", table, err)
		}
	}

	log.Printf("✅ RLS enabled on transactional tables")
	return nil
}

// createRLSPolicies crea políticas RLS (idempotente)
func createRLSPolicies(db *gorm.DB) error {
	log.Printf("📋 Creating RLS policies...")

	tables := []string{
		"sales",
		"sale_details",
		"products",
		"expenses",
		"clients",
		"returns",
		"return_details",
		"stock_movements",
		"missing_items",
		"expected_orders", // CRITICAL FIX: RLS para pedidos esperados/preventa
	}

	for _, table := range tables {
		policyName := fmt.Sprintf("allow_all_authenticated_%s", table)

		sql := fmt.Sprintf(`
			DO $$
			BEGIN
				-- Crear política si no existe
				IF NOT EXISTS (
					SELECT 1 FROM pg_policies 
					WHERE tablename = '%s' 
					AND policyname = '%s'
				) THEN
					EXECUTE 'CREATE POLICY %s ON %s FOR ALL TO authenticated USING (true) WITH CHECK (true)';
					RAISE NOTICE 'Policy %s created on %s';
				ELSE
					RAISE NOTICE 'Policy %s already exists on %s';
				END IF;
			END $$;
		`, table, policyName, policyName, table, policyName, table, policyName, table)

		if err := db.Exec(sql).Error; err != nil {
			log.Printf("⚠️ Warning: Could not create policy on %s: %v", table, err)
		}
	}

	log.Printf("✅ RLS policies created")
	return nil
}

// createGlobalIndexes asegura que la BD tenga los índices necesarios para millones de registros
func createGlobalIndexes(db *gorm.DB) error {
	log.Printf("🚀 Creating global performance indexes...")

	indexes := []string{
		// VENTAS: Búsqueda por fecha, cliente y cajero
		`CREATE INDEX IF NOT EXISTS idx_sales_date ON sales("saleDate" DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_sales_client ON sales("clientDni")`,
		`CREATE INDEX IF NOT EXISTS idx_sales_employee ON sales("employeeDni")`,
		`CREATE INDEX IF NOT EXISTS idx_sales_payment_method ON sales("paymentMethod")`,

		// DETALLES DE VENTA: Join con ventas y productos
		`CREATE INDEX IF NOT EXISTS idx_sale_details_id ON sale_details("saleId")`,
		`CREATE INDEX IF NOT EXISTS idx_sale_details_barcode ON sale_details("barcode")`,

		// AUDITORÍA: Búsqueda forense rápida por fecha y criticidad
		`CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs("created_at" DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_critical ON audit_logs("is_critical") WHERE is_critical = true`,
		`CREATE INDEX IF NOT EXISTS idx_audit_employee ON audit_logs("employee_dni")`,
		`CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_logs("module")`,

		// INVENTARIO Y MOVIMIENTOS
		`CREATE INDEX IF NOT EXISTS idx_stock_movements_barcode ON stock_movements("barcode")`,
		`CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements("date" DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_products_category ON products("categoryId")`,
		`CREATE INDEX IF NOT EXISTS idx_products_supplier ON products("supplierId")`,

		// CIERRES DE CAJA
		`CREATE INDEX IF NOT EXISTS idx_cashier_closures_date ON cashier_closures("date" DESC)`,
	}

	for _, idx := range indexes {
		if err := db.Exec(idx).Error; err != nil {
			log.Printf("⚠️ Warning creating index: %v", err)
		}
	}

	log.Printf("✅ Global performance indexes ready")
	return nil
}

// createMaterializedViews crea las vistas para acelerar el Dashboard 100x
func createMaterializedViews(db *gorm.DB) error {
	log.Printf("🚀 Creating High-Performance Materialized Views...")

	sql := `
	CREATE MATERIALIZED VIEW IF NOT EXISTS mv_dashboard_stats_monthly AS
	WITH sale_stats AS (
		SELECT 
			TO_CHAR(s."saleDate", 'YYYY-MM') as month_year,
			SUM(s."totalAmount") as total_sales,
			COUNT(s.*) as transaction_count,
			SUM(CASE WHEN s."paymentMethod" = 'EFECTIVO' THEN s."totalAmount" ELSE 0 END) as sales_cash,
			SUM(CASE WHEN s."paymentMethod" = 'TRANSFERENCIA' THEN s."totalAmount" ELSE 0 END) as sales_transfer,
			SUM(CASE WHEN s."paymentMethod" = 'CREDITO' THEN s."totalAmount" ELSE 0 END) as sales_credit,
			COALESCE(SUM(sd.quantity), 0) as products_sold
		FROM sales s
		LEFT JOIN sale_details sd ON s."saleId" = sd."saleId"
		WHERE s."deleted_at" IS NULL
		GROUP BY 1
	),
	expense_stats AS (
		SELECT 
			TO_CHAR(date, 'YYYY-MM') as month_year,
			SUM(amount) as total_expenses
		FROM expenses
		WHERE "deleted_at" IS NULL
		GROUP BY 1
	),
	payment_stats AS (
		SELECT 
			TO_CHAR("paymentDate", 'YYYY-MM') as month_year,
			SUM("totalPaid") as total_abonos
		FROM credit_payments
		WHERE "deleted_at" IS NULL
		GROUP BY 1
	),
	all_months AS (
		SELECT month_year FROM sale_stats
		UNION
		SELECT month_year FROM expense_stats
		UNION
		SELECT month_year FROM payment_stats
	)
	SELECT 
		am.month_year,
		COALESCE(s.total_sales, 0) as total_sales,
		COALESCE(s.transaction_count, 0) as transaction_count,
		COALESCE(s.sales_cash, 0) as sales_cash,
		COALESCE(s.sales_transfer, 0) as sales_transfer,
		COALESCE(s.sales_credit, 0) as sales_credit,
		COALESCE(s.products_sold, 0) as products_sold,
		COALESCE(e.total_expenses, 0) as total_expenses,
		COALESCE(p.total_abonos, 0) as total_abonos
	FROM all_months am
	LEFT JOIN sale_stats s ON am.month_year = s.month_year
	LEFT JOIN expense_stats e ON am.month_year = e.month_year
	LEFT JOIN payment_stats p ON am.month_year = p.month_year;

	CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_dashboard_month_year ON mv_dashboard_stats_monthly(month_year);
	`

	if err := db.Exec(sql).Error; err != nil {
		return err
	}

	log.Printf("✅ Materialized Views initialized")
	return nil
}

func SeedClient(db *gorm.DB, adminDNI string) {
	var count int64
	db.Unscoped().Model(&models.Client{}).Where("\"dni\" = ?", "0").Count(&count)
	if count == 0 {
		client := models.Client{
			DNI:          "0",
			Name:         "CONSUMIDOR FINAL",
			CreatedByDNI: adminDNI,
			UpdatedByDNI: adminDNI,
		}
		if err := db.Create(&client).Error; err != nil {
			log.Printf("⚠️ Warning: Failed to seed default client: %v", err)
		} else {
			log.Printf("👥 Default Client (CONSUMIDOR FINAL) is ready for user %s.", adminDNI)
		}
	}
}

func SeedAdmin(db *gorm.DB) {
	var count int64
	db.Model(&models.Employee{}).Count(&count)
	if count == 0 {
		hashedPassword, _ := bcrypt.GenerateFromPassword([]byte("admin123"), bcrypt.DefaultCost)
		admin := models.Employee{
			DNI:      "1000128428",
			Name:     "Admin Maestro",
			Email:    "admin@pos.com",
			Password: string(hashedPassword),
			Role:     "admin",
		}
		db.Create(&admin)
		log.Println("👤 Default Admin Seeded")
	}
}
