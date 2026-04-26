package repositories

import (
	"strings"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"gorm.io/gorm"
)

type auditRepository struct {
	db *gorm.DB
}

func NewAuditRepository(db *gorm.DB) ports.AuditRepository {
	return &auditRepository{db: db}
}

func (r *auditRepository) Create(log *models.AuditLog) error {
	return r.db.Create(log).Error
}

func (r *auditRepository) GetAll() ([]models.AuditLog, error) {
	var logs []models.AuditLog
	err := r.db.Order("created_at desc").Limit(100).Find(&logs).Error // Limite de seguridad
	return logs, err
}

func (r *auditRepository) GetPaginated(page, pageSize int, search string, criticalOnly bool) ([]models.AuditLog, int64, error) {
	var logs []models.AuditLog
	var total int64

	query := r.db.Model(&models.AuditLog{})

	if criticalOnly {
		query = query.Where("is_critical = ?", true)
	}

	if search != "" {
		s := "%" + strings.ToLower(search) + "%"
		query = query.Where(
			"LOWER(details) LIKE ? OR LOWER(human_readable) LIKE ? OR LOWER(employee_name) LIKE ? OR LOWER(employee_dni) LIKE ?",
			s, s, s, s,
		)
	}

	// Contar total para metadatos de paginación
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	// Aplicar paginación y orden
	offset := (page - 1) * pageSize
	err := query.Order("created_at desc").
		Limit(pageSize).
		Offset(offset).
		Find(&logs).Error

	return logs, total, err
}
