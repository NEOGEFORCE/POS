package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

type ReportService struct {
	repo ports.ReportRepository
}

func NewReportService(repo ports.ReportRepository) *ReportService {
	return &ReportService{repo: repo}
}

func (s *ReportService) RecordReport(name, reportType, category, createdBy, url string) error {
	report := &models.ReportHistory{
		Name:     name,
		Type:     reportType,
		Category: category,
		CreatedBy: createdBy,
		URL:      url,
	}
	return s.repo.Save(report)
}

func (s *ReportService) GetHistory(limit int) ([]models.ReportHistory, error) {
	if limit <= 0 {
		limit = 50
	}
	return s.repo.List(limit)
}

func (s *ReportService) DeleteReport(id uint) error {
	return s.repo.Delete(id)
}

func (s *ReportService) GetReportStats() (map[string]interface{}, error) {
	total, err := s.repo.Count()
	if err != nil {
		return nil, err
	}
	last, _ := s.repo.GetLastGenerated()

	stats := map[string]interface{}{
		"totalReports": total,
	}
	if last != nil {
		stats["lastGeneratedAt"] = last.CreatedAt
		stats["lastType"]        = last.Type
	}
	return stats, nil
}
