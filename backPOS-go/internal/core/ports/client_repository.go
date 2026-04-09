package ports

import "backPOS-go/internal/core/domain/models"

type ClientRepository interface {
	Save(client *models.Client) error
	GetByDNI(dni string) (*models.Client, error)
	GetAll() ([]models.Client, error)
	Update(dni string, client *models.Client) error
	Delete(dni string) error
	Count() (int64, error)
}
