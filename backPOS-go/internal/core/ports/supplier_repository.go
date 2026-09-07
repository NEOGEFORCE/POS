package ports

import (
	"errors"

	"backPOS-go/internal/core/domain/models"
)

var ErrSupplierNotFound = errors.New("proveedor no encontrado")

// SupplierScheduleUpdate contiene exclusivamente los campos manuales de agenda
// que el dueño decidió modificar. Un puntero nil significa "no tocar"; para
// LeadTimeDays, un valor apuntado nil limpia la columna a NULL.
type SupplierScheduleUpdate struct {
	VisitDays    *models.StringArray
	DeliveryDays *models.StringArray
	LeadTimeDays **int
}

// SupplierRepository define las operaciones del directorio de proveedores que
// consume la capa de servicios. La persistencia concreta vive en adapters.
type SupplierRepository interface {
	Save(supplier *models.Supplier) error
	GetByID(id uint) (*models.Supplier, error)
	GetByName(name string) (*models.Supplier, error)
	GetAll() ([]models.Supplier, error)
	Update(id uint, supplier *models.Supplier) error
	UpdateManualSchedule(id uint, update SupplierScheduleUpdate) (*models.Supplier, error)
	SetActive(id uint, active bool) error
	Delete(id uint) error
	GetByVisitDay(day string) ([]models.Supplier, error)
}
