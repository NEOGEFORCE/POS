package ports

import "backPOS-go/internal/core/domain/models"

type AuditRepository interface {
	Create(log *models.AuditLog) error
	GetAll() ([]models.AuditLog, error)
}
