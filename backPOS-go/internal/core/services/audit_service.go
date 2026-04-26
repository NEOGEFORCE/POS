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

func (s *AuditService) Log(dni, name, action, module, details, human, changes, ip, device string, isCritical bool) {
	log := &models.AuditLog{
		EmployeeDNI:   dni,
		EmployeeName:  name,
		Action:        action,
		Module:        module,
		Details:       details,
		HumanReadable: human,
		Changes:       changes,
		IsCritical:    isCritical,
		IPAddress:     ip,
		Device:        device,
		CreatedAt:     time.Now(),
	}
	_ = s.repo.Create(log)
}

func (s *AuditService) GetLogs() ([]models.AuditLog, error) {
	return s.repo.GetAll()
}
