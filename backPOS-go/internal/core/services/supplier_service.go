package services

import (
	"errors"
	"fmt"
	"log"
	"strings"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

var ErrInvalidSupplierSchedule = errors.New("agenda de proveedor inválida")

type SupplierService struct {
	repo ports.SupplierRepository
}

func NewSupplierService(repo ports.SupplierRepository) *SupplierService {
	return &SupplierService{repo: repo}
}

// SupplierSchedulePatch representa el JSON parcial ya decodificado. Los
// punteros distinguen campo ausente de una lista vacía enviada para limpiar.
type SupplierSchedulePatch struct {
	VisitDays    *[]string
	DeliveryDays *[]string
	LeadTimeDays *int
}

var canonicalSupplierDays = []string{
	"Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo",
}

func normalizeSupplierDay(day string) (string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(day))
	normalized = strings.NewReplacer(
		"á", "a", "é", "e", "í", "i", "ó", "o", "ú", "u", "ü", "u",
	).Replace(normalized)
	for _, canonical := range canonicalSupplierDays {
		candidate := strings.ToLower(strings.NewReplacer(
			"á", "a", "é", "e", "í", "i", "ó", "o", "ú", "u", "ü", "u",
		).Replace(canonical))
		if normalized == candidate {
			return canonical, true
		}
	}
	return "", false
}

func normalizeSupplierDays(days []string) (models.StringArray, error) {
	seen := make(map[string]bool, len(days))
	for _, raw := range days {
		day, ok := normalizeSupplierDay(raw)
		if !ok {
			return nil, fmt.Errorf("%w: día desconocido %q", ErrInvalidSupplierSchedule, raw)
		}
		seen[day] = true
	}

	result := make(models.StringArray, 0, len(seen))
	for _, day := range canonicalSupplierDays {
		if seen[day] {
			result = append(result, day)
		}
	}
	return result, nil
}

// UpdateSupplierSchedule valida y aplica sólo los campos presentes. Un lead
// time de 0 se traduce a NULL; el rango válido explícito es 1..60 días.
func (s *SupplierService) UpdateSupplierSchedule(id uint, patch SupplierSchedulePatch) (*models.Supplier, error) {
	if id == 0 {
		return nil, fmt.Errorf("%w: id inválido", ErrInvalidSupplierSchedule)
	}

	update := ports.SupplierScheduleUpdate{}
	if patch.VisitDays != nil {
		days, err := normalizeSupplierDays(*patch.VisitDays)
		if err != nil {
			return nil, err
		}
		update.VisitDays = &days
	}
	if patch.DeliveryDays != nil {
		days, err := normalizeSupplierDays(*patch.DeliveryDays)
		if err != nil {
			return nil, err
		}
		update.DeliveryDays = &days
	}
	if patch.LeadTimeDays != nil {
		value := *patch.LeadTimeDays
		if value < 0 || value > 60 {
			return nil, fmt.Errorf("%w: leadTimeDays debe ser 0 o estar entre 1 y 60", ErrInvalidSupplierSchedule)
		}
		var stored *int
		if value > 0 {
			stored = &value
		}
		update.LeadTimeDays = &stored
	}

	return s.repo.UpdateManualSchedule(id, update)
}

func (s *SupplierService) CreateSupplier(supplier *models.Supplier) error {
	return s.repo.Save(supplier)
}

func (s *SupplierService) GetSupplierByName(name string) (*models.Supplier, error) {
	return s.repo.GetByName(name)
}

func (s *SupplierService) GetSupplier(id uint) (*models.Supplier, error) {
	return s.repo.GetByID(id)
}

func (s *SupplierService) GetAllSuppliers() ([]models.Supplier, error) {
	log.Printf("[SupplierService] Iniciando GetAllSuppliers...")

	suppliers, err := s.repo.GetAll()
	if err != nil {
		log.Printf("[SupplierService] ERROR en repositorio: %v", err)
		return nil, fmt.Errorf("error en repositorio: %w", err)
	}

	log.Printf("[SupplierService] Éxito: %d proveedores obtenidos", len(suppliers))
	return suppliers, nil
}

func (s *SupplierService) UpdateSupplier(id uint, supplier *models.Supplier) error {
	return s.repo.Update(id, supplier)
}

// SetActive activa o desactiva un proveedor explicitamente. Es la unica ruta
// autorizada para tocar is_active — evita la trampa de que UpdateSupplier
// pudiera desactivar por omision cuando un llamador olvida enviar isActive.
func (s *SupplierService) SetActive(id uint, active bool) error {
	return s.repo.SetActive(id, active)
}

func (s *SupplierService) DeleteSupplier(id uint) error {
	return s.repo.Delete(id)
}

func (s *SupplierService) GetSuppliersByVisitDay(day string) ([]models.Supplier, error) {
	return s.repo.GetByVisitDay(day)
}
