package ports

import "backPOS-go/internal/core/domain/models"

type CategoryRepository interface {
	Save(category *models.Category) error
	GetByID(id uint) (*models.Category, error)
	GetAll() ([]models.Category, error)
	Update(id uint, category *models.Category) error
	Delete(id uint) error
}
