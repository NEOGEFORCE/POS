package repositories

import (
	"backPOS-go/internal/core/domain/models"
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
	var employee models.Employee
	err := r.db.Where("dni = ?", dni).First(&employee).Error
	return &employee, err
}

func (r *PostgresAdminRepository) GetAll() ([]models.Employee, error) {
	var employees []models.Employee
	err := r.db.Find(&employees).Error
	return employees, err
}

func (r *PostgresAdminRepository) Save(employee *models.Employee) error {
	return r.db.Create(employee).Error
}

func (r *PostgresAdminRepository) Update(dni string, employee *models.Employee) error {
	return r.db.Model(&models.Employee{}).Where("dni = ?", dni).Updates(employee).Error
}

func (r *PostgresAdminRepository) Delete(dni string) error {
	return r.db.Where("dni = ?", dni).Delete(&models.Employee{}).Error
}
