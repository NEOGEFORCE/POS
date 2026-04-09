package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
)

type PostgresClientRepository struct {
	db *gorm.DB
}

func NewPostgresClientRepository(db *gorm.DB) *PostgresClientRepository {
	return &PostgresClientRepository{db: db}
}

func (r *PostgresClientRepository) Save(client *models.Client) error {
	return r.db.Create(client).Error
}

func (r *PostgresClientRepository) GetByDNI(dni string) (*models.Client, error) {
	var client models.Client
	err := r.db.Where("dni = ?", dni).First(&client).Error
	return &client, err
}

func (r *PostgresClientRepository) GetAll() ([]models.Client, error) {
	clients := []models.Client{}
	
	query := `
		SELECT c.*, 
		       COALESCE(SUM(s."totalAmount"), 0) as "totalSpent", 
		       MAX(s."saleDate") as "lastPurchaseDate"
		FROM clients c
		LEFT JOIN sales s ON c.dni = s."clientDni"
		GROUP BY c.dni, c.name, c.phone, c.address, c."createdByDni", c."createdByName", c."updatedByDni", c."updatedByName", c."creditLimit", c."currentCredit"
	`
	
	err := r.db.Raw(query).Scan(&clients).Error
	return clients, err
}

func (r *PostgresClientRepository) Update(dni string, client *models.Client) error {
	return r.db.Model(&models.Client{}).Where("dni = ?", dni).Updates(client).Error
}

func (r *PostgresClientRepository) Delete(dni string) error {
	return r.db.Where("dni = ?", dni).Delete(&models.Client{}).Error
}

func (r *PostgresClientRepository) Count() (int64, error) {
	var count int64
	err := r.db.Model(&models.Client{}).Count(&count).Error
	return count, err
}
