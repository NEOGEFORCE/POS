package main

import (
	"fmt"
	"log"
	"os"

	"backPOS-go/internal/core/domain/models"
	"github.com/joho/godotenv"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	_ = godotenv.Load(".env")

	// Configuración Postgres (Destino)
	pgUser := os.Getenv("DB_USER")
	pgPass := os.Getenv("DB_PASSWORD")
	pgHost := os.Getenv("DB_HOST")
	pgPort := os.Getenv("DB_PORT")
	pgDBName := os.Getenv("DB_NAME")
	pgDSN := fmt.Sprintf("host=%s user=%s password=%s dbname=%s port=%s sslmode=disable TimeZone=UTC", pgHost, pgUser, pgPass, pgDBName, pgPort)

	pgDB, err := gorm.Open(postgres.Open(pgDSN), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error conectando a Postgres: %v", err)
	}

	// Configuración MySQL (Origen)
	// Usamos el servidor que levantamos en el puerto 3307
	myDSN := "root@tcp(127.0.0.1:3307)/basereal?charset=utf8mb4&parseTime=True&loc=Local"
	myDB, err := gorm.Open(mysql.Open(myDSN), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error conectando a MySQL: %v", err)
	}

	adminDNI := "1000128428" // SEBASTIAN
	adminName := "SEBASTIAN (MIGRACION)"

	fmt.Println("🚀 Iniciando migración...")

	// 1. Migrar Categorías
	fmt.Println("📦 Migrando Categorías...")
	var oldCategories []struct {
		ID   string `gorm:"column:ID"`
		Name string `gorm:"column:NAME"`
	}
	myDB.Table("categories").Find(&oldCategories)

	catMap := make(map[string]uint)
	for _, oldCat := range oldCategories {
		newCat := models.Category{
			Name:          oldCat.Name,
			CreatedByDNI:  adminDNI,
			CreatedByName: adminName,
			UpdatedByDNI:  adminDNI,
			UpdatedByName: adminName,
		}
		// Evitar duplicados por nombre
		if err := pgDB.Where("name = ?", oldCat.Name).FirstOrCreate(&newCat).Error; err == nil {
			catMap[oldCat.ID] = newCat.ID
		}
	}
	fmt.Printf("✅ %d Categorías procesadas.\n", len(oldCategories))

	// 2. Migrar Proveedores
	fmt.Println("🚚 Migrando Proveedores...")
	var oldSuppliers []struct {
		ID   string `gorm:"column:ID"`
		Name string `gorm:"column:NAME"`
	}
	myDB.Table("suppliers").Find(&oldSuppliers)
	for _, oldSup := range oldSuppliers {
		newSup := models.Supplier{
			Name:          oldSup.Name,
			CreatedByDNI:  adminDNI,
			CreatedByName: adminName,
			UpdatedByDNI:  adminDNI,
			UpdatedByName: adminName,
		}
		pgDB.Where("name = ?", oldSup.Name).FirstOrCreate(&newSup)
	}
	fmt.Printf("✅ %d Proveedores procesados.\n", len(oldSuppliers))

	// 3. Migrar Clientes
	fmt.Println("👥 Migrando Clientes...")
	var oldCustomers []struct {
		ID        string `gorm:"column:ID"`
		TaxID     string `gorm:"column:TAXID"`
		SearchKey string `gorm:"column:SEARCHKEY"`
		Name      string `gorm:"column:NAME"`
		Phone     string `gorm:"column:PHONE"`
		Address   string `gorm:"column:ADDRESS"`
		Email     string `gorm:"column:EMAIL"`
	}
	myDB.Table("customers").Find(&oldCustomers)
	for _, oldCust := range oldCustomers {
		dni := oldCust.TaxID
		if dni == "" {
			dni = oldCust.SearchKey
		}
		if dni == "" {
			continue // Necesitamos un DNI
		}

		newClient := models.Client{
			DNI:           dni,
			Name:          oldCust.Name,
			Phone:         oldCust.Phone,
			Address:       oldCust.Address,
			CreatedByDNI:  adminDNI,
			CreatedByName: adminName,
			UpdatedByDNI:  adminDNI,
			UpdatedByName: adminName,
		}
		pgDB.Where("dni = ?", dni).FirstOrCreate(&newClient)
	}
	fmt.Printf("✅ %d Clientes procesados.\n", len(oldCustomers))

	// 4. Migrar Productos
	fmt.Println("🏷️ Migrando Productos (solo con precio > 100)...")
	
	// Limpiar migración anterior para evitar duplicados o basura
	pgDB.Unscoped().Where("\"createdByName\" = ?", adminName).Delete(&models.Product{})
	
	var oldProducts []struct {
		Reference string  `gorm:"column:REFERENCE"`
		Code      string  `gorm:"column:CODE"`
		Name      string  `gorm:"column:NAME"`
		PriceBuy  float64 `gorm:"column:PRICEBUY"`
		PriceSell float64 `gorm:"column:PRICESELL"`
		Category  string  `gorm:"column:CATEGORY"`
		IsScale   bool    `gorm:"column:ISSCALE"`
	}
	// Aplicamos el filtro solicitado por el usuario: PRICESELL > 100
	myDB.Table("products").Where("PRICESELL > 100").Find(&oldProducts)
	for _, oldProd := range oldProducts {
		barcode := oldProd.Code
		if barcode == "" {
			barcode = oldProd.Reference
		}
		if barcode == "" {
			continue
		}

		catID, ok := catMap[oldProd.Category]
		if !ok {
			catID = 0
		}

		newProduct := models.Product{
			Barcode:       barcode,
			ProductName:   oldProd.Name,
			PurchasePrice: oldProd.PriceBuy,
			SalePrice:     oldProd.PriceSell,
			IsWeighted:    oldProd.IsScale,
			CategoryID:    catID,
			CreatedByDNI:  adminDNI,
			CreatedByName: adminName,
			UpdatedByDNI:  adminDNI,
			UpdatedByName: adminName,
			IsActive:      true,
			Quantity:      0,
		}
		pgDB.Create(&newProduct)
	}
	fmt.Printf("✅ %d Productos migrados exitosamente.\n", len(oldProducts))

	fmt.Println("\n✨ Migración finalizada con éxito!")
}
