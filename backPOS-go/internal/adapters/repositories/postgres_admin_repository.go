package repositories

import (
	"fmt"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/cache"
	"gorm.io/gorm"
)

type PostgresAdminRepository struct {
	db *gorm.DB
}

func NewPostgresAdminRepository(db *gorm.DB) *PostgresAdminRepository {
	return &PostgresAdminRepository{db: db}
}

func (r *PostgresAdminRepository) FindByName(name string) (*models.Employee, error) {
	var employee models.Employee
	err := r.db.Where("name = ?", name).First(&employee).Error
	return &employee, err
}

func (r *PostgresAdminRepository) FindByEmail(email string) (*models.Employee, error) {
	var employee models.Employee
	err := r.db.Where("email = ?", email).First(&employee).Error
	return &employee, err
}

func (r *PostgresAdminRepository) FindByDNI(dni string) (*models.Employee, error) {
	cacheKey := fmt.Sprintf("employee_dni_%s", dni)
	if cached, found := cache.CacheManager.Get(cacheKey); found {
		return cached.(*models.Employee), nil
	}

	var employee models.Employee
	// Usamos Unscoped para poder encontrar usuarios incluso si fueron borrados lógicamente
	err := r.db.Unscoped().Where("dni = ?", dni).First(&employee).Error
	
	if err == nil {
		cache.CacheManager.Set(cacheKey, &employee, 24*time.Hour)
	}
	return &employee, err
}

func (r *PostgresAdminRepository) GetAll() ([]models.Employee, error) {
	var employees []models.Employee
	err := r.db.Where("is_active = ?", true).Find(&employees).Error
	return employees, err
}

func (r *PostgresAdminRepository) Save(employee *models.Employee) error {
	err := r.db.Create(employee).Error
	if err == nil {
		cache.InvalidateCache(fmt.Sprintf("employee_dni_%s", employee.DNI))
	}
	return err
}

func (r *PostgresAdminRepository) Update(dni string, employee *models.Employee) error {
	// Al actualizar, aseguramos que deleted_at sea NULL para "restaurar" al usuario si estaba borrado
	// Usamos una interfaz o mapa para forzar la actualización de deleted_at a NULL (GORM ignora campos zero en Structs)
	updates := map[string]interface{}{
		"name":       employee.Name,
		"email":      employee.Email,
		"role":       employee.Role,
		"is_active":  employee.IsActive,
		"last_login": employee.LastLogin,
		"deleted_at": nil,
	}
	if employee.Password != "" {
		updates["password"] = employee.Password
	}
	err := r.db.Unscoped().Model(&models.Employee{}).Where("dni = ?", dni).Updates(updates).Error
	if err == nil {
		cache.InvalidateCache(fmt.Sprintf("employee_dni_%s", dni))
	}
	return err
}

func (r *PostgresAdminRepository) Delete(dni string) error {
	err := r.db.Model(&models.Employee{}).Where("dni = ?", dni).Update("is_active", false).Error
	if err == nil {
		cache.InvalidateCache(fmt.Sprintf("employee_dni_%s", dni))
	}
	return err
}

func (r *PostgresAdminRepository) CountAll() (int64, error) {
	var count int64
	// Usamos Unscoped para detectar si la base de datos tiene CUALQUIER usuario (incluso eliminados)
	// Esto previene que el sistema pida /setup si ya fue inicializado alguna vez.
	err := r.db.Unscoped().Model(&models.Employee{}).Count(&count).Error
	return count, err
}

// Faltantes Module Implementation

func (r *PostgresAdminRepository) SaveMissingItem(item *models.MissingItem) error {
	return r.db.Omit("Reporter").Create(item).Error
}

func (r *PostgresAdminRepository) GetMissingItems() ([]models.MissingItem, error) {
	var items []models.MissingItem
	// Preload Reporter to see who reported it, order by most recent
	err := r.db.Preload("Reporter").Order("created_at desc").Find(&items).Error
	return items, err
}

func (r *PostgresAdminRepository) UpdateMissingItemStatus(id uint, status string) error {
	return r.db.Model(&models.MissingItem{}).Where("id = ?", id).Update("status", status).Error
}

// Database Maintenance (V7.0)
func (r *PostgresAdminRepository) PurgeDataBefore(date string) (int64, error) {
	// Comenzar transacción
	tx := r.db.Begin()
	if tx.Error != nil {
		return 0, tx.Error
	}

	var totalDeleted int64

	// Delete related items before deleting parent records (if no cascade)
	// Pero GORM a menudo tiene ON DELETE CASCADE si está configurado en la DB.
	// Por seguridad borramos manualmente.
	
	// 1. Sale details (vinculados a sales)
	res := tx.Exec("DELETE FROM sale_details WHERE \"saleId\" IN (SELECT \"saleId\" FROM sales WHERE \"saleDate\" < ?)", date)
	if res.Error != nil {
		tx.Rollback()
		return 0, res.Error
	}

	// 2. Sales
	res = tx.Exec("DELETE FROM sales WHERE \"saleDate\" < ?", date)
	if res.Error != nil {
		tx.Rollback()
		return 0, res.Error
	}
	totalDeleted += res.RowsAffected

	// 3. Stock Movements
	res = tx.Exec("DELETE FROM stock_movements WHERE \"date\" < ?", date)
	if res.Error != nil {
		tx.Rollback()
		return 0, res.Error
	}
	totalDeleted += res.RowsAffected

	// 4. Expenses
	res = tx.Exec("DELETE FROM expenses WHERE \"date\" < ?", date)
	if res.Error != nil {
		tx.Rollback()
		return 0, res.Error
	}
	totalDeleted += res.RowsAffected

	// 5. Audit Logs
	res = tx.Exec("DELETE FROM audit_logs WHERE timestamp < ?", date)
	if res.Error != nil {
		tx.Rollback()
		return 0, res.Error
	}
	totalDeleted += res.RowsAffected

	if err := tx.Commit().Error; err != nil {
		return 0, err
	}

	return totalDeleted, nil
}

func (r *PostgresAdminRepository) GetRecentPendingMissingItems(limit int) ([]models.MissingItem, error) {
	var items []models.MissingItem
	err := r.db.Preload("Reporter").
		Where("UPPER(status) = ?", "PENDIENTE").
		Order("created_at desc").
		Limit(limit).
		Find(&items).Error
	return items, err
}
