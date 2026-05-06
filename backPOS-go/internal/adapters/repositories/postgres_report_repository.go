package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
)

type PostgresReportRepository struct {
	db *gorm.DB
}

func NewPostgresReportRepository(db *gorm.DB) *PostgresReportRepository {
	return &PostgresReportRepository{db: db}
}

func (r *PostgresReportRepository) Save(report *models.ReportHistory) error {
	return r.db.Create(report).Error
}

func (r *PostgresReportRepository) List(limit int) ([]models.ReportHistory, error) {
	var reports []models.ReportHistory
	err := r.db.Order("created_at DESC").Limit(limit).Find(&reports).Error
	return reports, err
}

func (r *PostgresReportRepository) Delete(id uint) error {
	return r.db.Delete(&models.ReportHistory{}, id).Error
}

func (r *PostgresReportRepository) Count() (int64, error) {
	var count int64
	err := r.db.Model(&models.ReportHistory{}).Count(&count).Error
	return count, err
}

func (r *PostgresReportRepository) CountByType(reportType string) (int64, error) {
	var count int64
	err := r.db.Model(&models.ReportHistory{}).
		Where("type = ?", reportType).
		Count(&count).Error
	return count, err
}

func (r *PostgresReportRepository) GetLastGenerated() (*models.ReportHistory, error) {
	var report models.ReportHistory
	err := r.db.Order("created_at DESC").First(&report).Error
	if err != nil {
		return nil, err
	}
	return &report, nil
}
