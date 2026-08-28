package repositories

import (
	"fmt"
	"log"

	"backPOS-go/internal/core/domain/models"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

func ensureClient(db *gorm.DB, adminDNI string) error {
	var count int64
	if err := db.Unscoped().Model(&models.Client{}).Where("\"dni\" = ?", "0").Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	return db.Create(&models.Client{
		DNI:          "0",
		Name:         "CONSUMIDOR FINAL",
		CreatedByDNI: adminDNI,
		UpdatedByDNI: adminDNI,
	}).Error
}

func ensureAdmin(db *gorm.DB) error {
	var count int64
	if err := db.Model(&models.Employee{}).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	return db.Create(&models.Employee{
		DNI:      "ADMIN",
		Name:     "ADMINISTRADOR",
		Email:    "admin@pos.com",
		Password: string(hashedPassword),
		Role:     "SUPERADMIN",
	}).Error
}

func ensureCategory(db *gorm.DB, adminDNI string) error {
	var count int64
	if err := db.Model(&models.Category{}).Where("id = ?", 1).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	return db.Create(&models.Category{
		ID:           1,
		Name:         "GENERAL",
		CreatedByDNI: adminDNI,
		UpdatedByDNI: adminDNI,
		IsActive:     true,
	}).Error
}

func ensureProducts(db *gorm.DB, adminDNI string) error {
	var count int64
	if err := db.Model(&models.Product{}).Where("barcode = ?", "0000").Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	return db.Create(&models.Product{
		Barcode:          "0000",
		ProductName:      "VARIOS / VENTA RÁPIDA",
		Quantity:         999999,
		PurchasePrice:    0,
		SalePrice:        0,
		MarginPercentage: 20,
		IsActive:         true,
		CategoryID:       1,
		CreatedByDNI:     adminDNI,
		CreatedByName:    "ADMINISTRADOR",
		UpdatedByDNI:     adminDNI,
		UpdatedByName:    "ADMINISTRADOR",
	}).Error
}

// SeedDefaults crea únicamente los registros canónicos faltantes. Debe
// invocarse desde un comando explícito y nunca durante el arranque del API.
func SeedDefaults(db *gorm.DB, adminDNI string, createDefaultAdmin bool) error {
	return db.Transaction(func(tx *gorm.DB) error {
		if createDefaultAdmin {
			if err := ensureAdmin(tx); err != nil {
				return fmt.Errorf("creando administrador por defecto: %w", err)
			}
		}

		var admins int64
		if err := tx.Model(&models.Employee{}).Where("dni = ?", adminDNI).Count(&admins).Error; err != nil {
			return fmt.Errorf("verificando administrador %s: %w", adminDNI, err)
		}
		if admins == 0 {
			return fmt.Errorf("no existe el empleado %q; créelo mediante setup o use --create-default-admin de forma consciente", adminDNI)
		}
		if err := ensureClient(tx, adminDNI); err != nil {
			return fmt.Errorf("creando cliente por defecto: %w", err)
		}
		if err := ensureCategory(tx, adminDNI); err != nil {
			return fmt.Errorf("creando categoría por defecto: %w", err)
		}
		if err := ensureProducts(tx, adminDNI); err != nil {
			return fmt.Errorf("creando producto por defecto: %w", err)
		}
		return nil
	})
}

// Las funciones individuales conservan compatibilidad con servicios existentes.
func SeedClient(db *gorm.DB, adminDNI string) {
	if err := ensureClient(db, adminDNI); err != nil {
		log.Printf("⚠️ Warning: Failed to seed default client: %v", err)
	}
}

func SeedAdmin(db *gorm.DB) {
	if err := ensureAdmin(db); err != nil {
		log.Printf("❌ Failed to seed Superadmin: %v", err)
	}
}

func SeedCategory(db *gorm.DB, adminDNI string) {
	if err := ensureCategory(db, adminDNI); err != nil {
		log.Printf("⚠️ Warning: Failed to seed default category: %v", err)
	}
}

func SeedProducts(db *gorm.DB, adminDNI string) {
	if err := ensureProducts(db, adminDNI); err != nil {
		log.Printf("⚠️ Warning: Failed to seed 'Varios' product: %v", err)
	}
}
