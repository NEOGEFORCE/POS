package services

import (
	"log"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/sse"
)

type AuditService struct {
	repo ports.AuditRepository
}

func NewAuditService(repo ports.AuditRepository) *AuditService {
	return &AuditService{repo: repo}
}

func (s *AuditService) Log(dni, name, action, module, details, human, changes, ip, device string, isCritical bool) {
	auditLog := &models.AuditLog{
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
		if err := s.repo.Create(auditLog); err != nil {
			log.Printf("[AUDIT] no se pudo persistir %s/%s: %v", module, action, err)
			return
		}

		// AVISO GLOBAL: Nueva acción registrada en auditoría
		sse.GetSSEService().BroadcastAuditUpdate()
	}()
}

func (s *AuditService) GetLogs() ([]models.AuditLog, error) {
	return s.repo.GetAll()
}
