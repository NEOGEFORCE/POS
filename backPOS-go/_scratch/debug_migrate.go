package main

import (
	"fmt"
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"backPOS-go/internal/core/domain/models"
)

func main() {
	dsn := "host=localhost user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		DisableForeignKeyConstraintWhenMigrating: true,
	})
	if err != nil {
		log.Fatal(err)
	}

	db = db.Debug()

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
		&models.ExpectedOrder{},
		&models.ExpectedOrderItem{},
		&models.ReportHistory{},
		&models.PriceLog{},
		&models.Shrinkage{},
		&models.ActivePurchaseList{},
		&models.ConfirmedOrder{},
		&models.ConfirmedOrderItem{},
	}

	for _, model := range models_to_migrate {
		fmt.Printf("Migrating %T...\n", model)
		if err := db.AutoMigrate(model); err != nil {
			fmt.Printf("Error migrating %T: %v\n", model, err)
		}
	}
	fmt.Println("Migration completed successfully!")
}
