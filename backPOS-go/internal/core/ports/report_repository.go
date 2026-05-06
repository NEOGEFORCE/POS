package ports

import "backPOS-go/internal/core/domain/models"

type ReportRepository interface {
	Save(report *models.ReportHistory) error
	List(limit int) ([]models.ReportHistory, error)
	Delete(id uint) error
	Count() (int64, error)
	CountByType(reportType string) (int64, error)
	GetLastGenerated() (*models.ReportHistory, error)
}
