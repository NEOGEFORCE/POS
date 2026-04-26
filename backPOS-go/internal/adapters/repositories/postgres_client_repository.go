package repositories

import (
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/cache"
	"gorm.io/gorm"
)

type PostgresClientRepository struct {
	db *gorm.DB
}

func NewPostgresClientRepository(db *gorm.DB) *PostgresClientRepository {
	return &PostgresClientRepository{db: db}
}

func (r *PostgresClientRepository) Save(client *models.Client) error {
	err := r.db.Create(client).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeyClients)
		cache.InvalidateCache(cache.CacheKeyClientCount)
	}
	return err
}

func (r *PostgresClientRepository) GetByDNI(dni string) (*models.Client, error) {
	var client models.Client
	
	query := `
		SELECT c.*, 
		       COALESCE(s_agg.total_spent, 0) as "totalSpent", 
		       s_agg.last_purchase_date as "lastPurchaseDate"
		FROM clients c
		LEFT JOIN (
			SELECT "clientDni", 
			       SUM("totalAmount") as total_spent, 
			       MAX("saleDate") as last_purchase_date
			FROM sales
			GROUP BY "clientDni"
		) s_agg ON c.dni = s_agg."clientDni"
		WHERE c.dni = ?
		LIMIT 1
	`
	
	err := r.db.Raw(query, dni).Scan(&client).Error
	if err != nil {
		return nil, err
	}
	if client.DNI == "" {
		return nil, gorm.ErrRecordNotFound
	}
	return &client, nil
}

func (r *PostgresClientRepository) GetAll() ([]models.Client, error) {
	// CACHÉ L1: Intentar recuperar de RAM primero
	if cached, found := cache.CacheManager.Get(cache.CacheKeyClients); found {
		return cached.([]models.Client), nil
	}

	clients := []models.Client{}
	
	query := `
		SELECT c.*, 
		       COALESCE(s_agg.total_spent, 0) as "totalSpent", 
		       s_agg.last_purchase_date as "lastPurchaseDate"
		FROM clients c
		LEFT JOIN (
			SELECT "clientDni", 
			       SUM("totalAmount") as total_spent, 
			       MAX("saleDate") as last_purchase_date
			FROM sales
			GROUP BY "clientDni"
		) s_agg ON c.dni = s_agg."clientDni"
		ORDER BY c.name ASC
		LIMIT 100
	`
	
	err := r.db.Raw(query).Scan(&clients).Error

	// PERSISTENCIA EN RAM: Guardar si la consulta fue exitosa
	if err == nil {
		cache.CacheManager.Set(cache.CacheKeyClients, clients, 24*time.Hour) // Clientes tienen TTL de 24h
	}

	return clients, err
}

func (r *PostgresClientRepository) Update(dni string, client *models.Client) error {
	err := r.db.Save(client).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeyClients)
		cache.InvalidateCache(cache.CacheKeyClientCount)
	}
	return err
}

func (r *PostgresClientRepository) Delete(dni string) error {
	err := r.db.Where("dni = ?", dni).Delete(&models.Client{}).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeyClients)
		cache.InvalidateCache(cache.CacheKeyClientCount)
	}
	return err
}

func (r *PostgresClientRepository) Count() (int64, error) {
	if cached, found := cache.CacheManager.Get(cache.CacheKeyClientCount); found {
		return cached.(int64), nil
	}
	var count int64
	err := r.db.Model(&models.Client{}).Count(&count).Error
	if err == nil {
		cache.CacheManager.Set(cache.CacheKeyClientCount, count, 1*time.Hour)
	}
	return count, err
}
