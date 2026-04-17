package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"time"
)

type AuditService struct {
	repo ports.AuditRepository
}

func NewAuditService(repo ports.AuditRepository) *AuditService {
	return &AuditService{repo: repo}
}

func (s *AuditService) Log(dni, action, module, details, ip string) {
	log := &models.AuditLog{
		EmployeeDNI: dni,
		Action:      action,
		Module:      module,
		Details:     details,
		IPAddress:   ip,
		CreatedAt:   time.Now(),
	}
	_ = s.repo.Create(log) // Quiet log
}

func (s *AuditService) GetLogs() ([]models.AuditLog, error) {
	return s.repo.GetAll()
}
