package ports

import "backPOS-go/internal/core/domain/models"

type AdminRepository interface {
	FindByName(name string) (*models.Employee, error)
	FindByEmail(email string) (*models.Employee, error)
	FindByDNI(dni string) (*models.Employee, error)
	GetAll() ([]models.Employee, error)
	Save(employee *models.Employee) error
	Update(dni string, employee *models.Employee) error
	Delete(dni string) error
	CountAll() (int64, error)

	// Faltantes Module
	SaveMissingItem(item *models.MissingItem) error
	GetMissingItems() ([]models.MissingItem, error)
	UpdateMissingItemStatus(id uint, status string) error
	GetRecentPendingMissingItems(limit int) ([]models.MissingItem, error)
	
	// Database Maintenance (V7.0)
	PurgeDataBefore(date string) (int64, error)
}
