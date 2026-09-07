package services

import (
	"errors"
	"reflect"
	"testing"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

type supplierScheduleRepoStub struct {
	update ports.SupplierScheduleUpdate
	calls  int
}

func (s *supplierScheduleRepoStub) Save(*models.Supplier) error { return nil }
func (s *supplierScheduleRepoStub) GetByID(uint) (*models.Supplier, error) {
	return &models.Supplier{}, nil
}
func (s *supplierScheduleRepoStub) GetByName(string) (*models.Supplier, error) {
	return &models.Supplier{}, nil
}
func (s *supplierScheduleRepoStub) GetAll() ([]models.Supplier, error)  { return nil, nil }
func (s *supplierScheduleRepoStub) Update(uint, *models.Supplier) error { return nil }
func (s *supplierScheduleRepoStub) SetActive(uint, bool) error          { return nil }
func (s *supplierScheduleRepoStub) Delete(uint) error                   { return nil }
func (s *supplierScheduleRepoStub) GetByVisitDay(string) ([]models.Supplier, error) {
	return nil, nil
}
func (s *supplierScheduleRepoStub) UpdateManualSchedule(id uint, update ports.SupplierScheduleUpdate) (*models.Supplier, error) {
	s.calls++
	s.update = update
	return &models.Supplier{ID: id}, nil
}

func TestUpdateSupplierScheduleNormalizaDeduplicaYOrdena(t *testing.T) {
	repo := &supplierScheduleRepoStub{}
	service := NewSupplierService(repo)
	visit := []string{" sábado ", "lunes", "Miércoles", "LUNES", "sabado"}
	delivery := []string{}
	lead := 4

	got, err := service.UpdateSupplierSchedule(9, SupplierSchedulePatch{
		VisitDays: &visit, DeliveryDays: &delivery, LeadTimeDays: &lead,
	})
	if err != nil {
		t.Fatalf("UpdateSupplierSchedule() error = %v", err)
	}
	if got.ID != 9 || repo.calls != 1 {
		t.Fatalf("resultado/calls = id %d, %d; want 9, 1", got.ID, repo.calls)
	}
	if repo.update.VisitDays == nil || !reflect.DeepEqual([]string(*repo.update.VisitDays), []string{"Lunes", "Miércoles", "Sábado"}) {
		t.Fatalf("VisitDays = %v", repo.update.VisitDays)
	}
	if repo.update.DeliveryDays == nil || len(*repo.update.DeliveryDays) != 0 {
		t.Fatalf("DeliveryDays debe ser [] explícito, got %v", repo.update.DeliveryDays)
	}
	if repo.update.LeadTimeDays == nil || *repo.update.LeadTimeDays == nil || **repo.update.LeadTimeDays != 4 {
		t.Fatalf("LeadTimeDays = %v, want 4", repo.update.LeadTimeDays)
	}
}

func TestUpdateSupplierScheduleEsParcialYLeadCeroLimpia(t *testing.T) {
	repo := &supplierScheduleRepoStub{}
	service := NewSupplierService(repo)
	lead := 0

	_, err := service.UpdateSupplierSchedule(3, SupplierSchedulePatch{LeadTimeDays: &lead})
	if err != nil {
		t.Fatalf("UpdateSupplierSchedule() error = %v", err)
	}
	if repo.update.VisitDays != nil || repo.update.DeliveryDays != nil {
		t.Fatalf("campos ausentes no deben tocarse: %+v", repo.update)
	}
	if repo.update.LeadTimeDays == nil {
		t.Fatal("LeadTimeDays ausente; 0 debe producir una actualización explícita")
	}
	if *repo.update.LeadTimeDays != nil {
		t.Fatalf("LeadTimeDays = %v; 0 debe limpiar a NULL", **repo.update.LeadTimeDays)
	}
}

func TestUpdateSupplierScheduleRechazaValoresInvalidos(t *testing.T) {
	tests := []struct {
		name  string
		patch SupplierSchedulePatch
	}{
		{name: "día basura", patch: func() SupplierSchedulePatch { v := []string{"Luness"}; return SupplierSchedulePatch{VisitDays: &v} }()},
		{name: "lead negativo", patch: func() SupplierSchedulePatch { v := -1; return SupplierSchedulePatch{LeadTimeDays: &v} }()},
		{name: "lead mayor a 60", patch: func() SupplierSchedulePatch { v := 61; return SupplierSchedulePatch{LeadTimeDays: &v} }()},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &supplierScheduleRepoStub{}
			_, err := NewSupplierService(repo).UpdateSupplierSchedule(1, tt.patch)
			if !errors.Is(err, ErrInvalidSupplierSchedule) {
				t.Fatalf("error = %v, want ErrInvalidSupplierSchedule", err)
			}
			if repo.calls != 0 {
				t.Fatalf("repo calls = %d, want 0", repo.calls)
			}
		})
	}
}
