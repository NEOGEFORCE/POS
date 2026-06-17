package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/sse"
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
	go func() {
		defer func() { recover() }()
		_ = s.repo.Create(log)
		
		// AVISO GLOBAL: Nueva acción registrada en auditoría
		sse.GetSSEService().BroadcastAuditUpdate()
	}()
}

func (s *AuditService) GetLogs() ([]models.AuditLog, error) {
	return s.repo.GetAll()
}
