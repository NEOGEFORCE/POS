package migrations

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

//go:embed sql/*.sql
var migrationFiles embed.FS

var migrationFilename = regexp.MustCompile(`^(\d{3})_([a-z0-9_]+)\.sql$`)

type Migration struct {
	Version       int64
	Name          string
	Source        string
	Transactional bool
	Apply         func(context.Context, *gorm.DB) error
	Checksum      string
}

func schemaModels() []interface{} {
	return []interface{}{
		&models.Employee{},
		&models.Client{},
		&models.Category{},
		&models.Supplier{},
		&models.SupplierOrderMethod{},
		&models.Product{},
		&models.ProductSupplier{},
		&models.Sale{},
		&models.SaleDetail{},
		&models.Expense{},
		&models.Return{},
		&models.ReturnDetail{},
		&models.CashierClosure{},
		&models.ActiveShift{},
		&models.CreditPayment{},
		&models.StockMovement{},
		&models.AuditLog{},
		&models.MissingItem{},
		&models.ExpectedOrder{},
		&models.ExpectedOrderItem{},
		&models.ReportHistory{},
		&models.PriceLog{},
		&models.Shrinkage{},
		&models.ActivePurchaseList{},
		&models.ConfirmedOrder{},
		&models.ConfirmedOrderItem{},
		&models.SupplierProductAlias{},
		&models.SupplierInvoiceParams{},
		&models.DailyStockSnapshot{},
		&models.ProductRestockMetric{},
		&models.PurchaseOrder{},
		&models.PurchaseOrderItem{},
	}
}

func applyModelSchema(ctx context.Context, db *gorm.DB) error {
	migrationDB := db.WithContext(ctx).Session(&gorm.Session{
		SkipDefaultTransaction: true,
		Logger:                 logger.Default.LogMode(logger.Silent),
	})
	for _, model := range schemaModels() {
		if err := migrationDB.AutoMigrate(model); err != nil {
			return fmt.Errorf("AutoMigrate %T: %w", model, err)
		}
	}
	return nil
}

func migrationChecksum(version int64, name, source string, transactional bool) string {
	payload := fmt.Sprintf("%03d\n%s\n%t\n%s", version, name, transactional, strings.ReplaceAll(source, "\r\n", "\n"))
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

func Catalog() ([]Migration, error) {
	entries, err := fs.ReadDir(migrationFiles, "sql")
	if err != nil {
		return nil, fmt.Errorf("leyendo migraciones embebidas: %w", err)
	}

	catalog := make([]Migration, 0, len(entries)+1)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		matches := migrationFilename.FindStringSubmatch(entry.Name())
		if matches == nil {
			return nil, fmt.Errorf("nombre de migración inválido: %s", entry.Name())
		}
		version, err := strconv.ParseInt(matches[1], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("versión inválida en %s: %w", entry.Name(), err)
		}
		body, err := migrationFiles.ReadFile(filepath.ToSlash(filepath.Join("sql", entry.Name())))
		if err != nil {
			return nil, fmt.Errorf("leyendo %s: %w", entry.Name(), err)
		}
		// Migraciones no transaccionales: 008, 009 y 011 usan CREATE INDEX
		// CONCURRENTLY, la 013 hace lo mismo para el índice parcial sobre
		// stock_movements (reason='RECEPTION'), la 014 para el índice parcial
		// sobre confirmed_orders(supplier_id, received_at) usado por el batch
		// de aprendizaje de agenda, y la 015 agrega seis índices parciales
		// más (clients con saldo vivo, sales con deuda viva, expenses en
		// mora, missing_items PENDIENTE, shrinkages por fecha, price_logs
		// por created_at) junto con las columnas de porcentajes de recepción
		// en stock_movements. PostgreSQL prohíbe CONCURRENTLY dentro de una
		// transacción, así que estas seis corren en autocommit.
		transactional := version != 8 && version != 9 && version != 11 && version != 13 && version != 14 && version != 15
		migration := Migration{
			Version:       version,
			Name:          matches[2],
			Source:        string(body),
			Transactional: transactional,
		}
		migration.Checksum = migrationChecksum(migration.Version, migration.Name, migration.Source, migration.Transactional)
		catalog = append(catalog, migration)
	}

	const modelSchemaSource = "gorm-model-schema-v1:employees,clients,categories,suppliers,supplier_order_methods,products,product_suppliers,sales,sale_details,expenses,returns,return_details,cashier_closures,active_shifts,credit_payments,stock_movements,audit_logs,missing_items,expected_orders,expected_order_items,report_histories,price_logs,shrinkages,active_purchase_list,confirmed_orders,confirmed_order_items,supplier_product_aliases,supplier_invoice_params,daily_stock_snapshots,product_restock_metrics,purchase_orders,purchase_order_items"
	modelMigration := Migration{
		Version:       2,
		Name:          "model_schema",
		Source:        modelSchemaSource,
		Transactional: true,
		Apply:         applyModelSchema,
	}
	modelMigration.Checksum = migrationChecksum(modelMigration.Version, modelMigration.Name, modelMigration.Source, modelMigration.Transactional)
	catalog = append(catalog, modelMigration)

	sort.Slice(catalog, func(i, j int) bool { return catalog[i].Version < catalog[j].Version })
	for i, migration := range catalog {
		if strings.TrimSpace(migration.Source) == "" {
			return nil, fmt.Errorf("la migración %03d_%s está vacía", migration.Version, migration.Name)
		}
		if i > 0 && catalog[i-1].Version == migration.Version {
			return nil, fmt.Errorf("versión de migración duplicada: %03d", migration.Version)
		}
		if migration.Version != int64(i+1) {
			return nil, fmt.Errorf("catálogo incompleto: se esperaba versión %03d y se encontró %03d", i+1, migration.Version)
		}
	}
	return catalog, nil
}
