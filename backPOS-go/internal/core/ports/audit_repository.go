package ports

import "backPOS-go/internal/core/domain/models"

type AuditRepository interface {
	Create(log *models.AuditLog) error
	GetAll() ([]models.AuditLog, error)
	GetPaginated(page, pageSize int, search string, criticalOnly bool) ([]models.AuditLog, int64, error)
}
