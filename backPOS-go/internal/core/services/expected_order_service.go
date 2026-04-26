package services

import (
	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"fmt"
	"log"
	"strings"
	"time"
)

type ExpectedOrderService struct {
	repo *repositories.PostgresExpectedOrderRepository
}

func NewExpectedOrderService(repo *repositories.PostgresExpectedOrderRepository) *ExpectedOrderService {
	return &ExpectedOrderService{repo: repo}
}

// CreateExpectedOrder crea un nuevo pedido esperado
// Si supplierId es 0, busca o crea el proveedor por nombre
func (s *ExpectedOrderService) CreateExpectedOrder(order *models.ExpectedOrder) error {
	// Si no tiene SupplierID válido, buscar o crear el proveedor por nombre
	if order.SupplierID == 0 && order.SupplierName != "" {
		supplier, err := s.getOrCreateSupplier(order.SupplierName)
		if err != nil {
			return fmt.Errorf("error al obtener/crear proveedor: %w", err)
		}
		order.SupplierID = supplier.ID
		// Actualizar el nombre del proveedor con el nombre exacto de la BD
		order.SupplierName = supplier.Name
	}
	
	return s.repo.Save(order)
}

// getOrCreateSupplier busca un proveedor por nombre o lo crea si no existe
func (s *ExpectedOrderService) getOrCreateSupplier(name string) (*models.Supplier, error) {
	// Limpiar el nombre
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("el nombre del proveedor no puede estar vacío")
	}
	
	// Intentar encontrar el proveedor existente (case insensitive)
	supplier, err := s.repo.GetSupplierByName(name)
	if err == nil && supplier != nil {
		log.Printf("[ExpectedOrderService] Proveedor existente encontrado: %s (ID: %d)", supplier.Name, supplier.ID)
		return supplier, nil
	}
	
	// Si no existe, crear nuevo proveedor
	newSupplier := &models.Supplier{
		Name: name,
		// Campos opcionales con valores por defecto
		Phone:       "",
		VendorName:  "",
		ImageUrl:    "",
		VisitDay:    "",
		DeliveryDay: "",
	}
	
	if err := s.repo.CreateSupplier(newSupplier); err != nil {
		return nil, fmt.Errorf("error creando proveedor: %w", err)
	}
	
	log.Printf("[ExpectedOrderService] Nuevo proveedor creado: %s (ID: %d)", newSupplier.Name, newSupplier.ID)
	return newSupplier, nil
}

// GetExpectedOrder obtiene un pedido esperado por ID
func (s *ExpectedOrderService) GetExpectedOrder(id uint) (*models.ExpectedOrder, error) {
	return s.repo.GetByID(id)
}

// GetAllExpectedOrders obtiene todos los pedidos esperados
func (s *ExpectedOrderService) GetAllExpectedOrders() ([]models.ExpectedOrder, error) {
	return s.repo.GetAll()
}

// GetExpectedOrdersToday obtiene los pedidos esperados para hoy
func (s *ExpectedOrderService) GetExpectedOrdersToday() ([]models.ExpectedOrder, error) {
	return s.repo.GetExpectedToday()
}

// GetExpectedOrdersBySupplier obtiene pedidos esperados por proveedor
func (s *ExpectedOrderService) GetExpectedOrdersBySupplier(supplierID uint) ([]models.ExpectedOrder, error) {
	return s.repo.GetBySupplier(supplierID)
}

// UpdateExpectedOrderStatus actualiza el estado de un pedido esperado
func (s *ExpectedOrderService) UpdateExpectedOrderStatus(id uint, status string) error {
	// Validar estado
	validStatuses := map[string]bool{
		"PENDING":   true,
		"RECEIVED":  true,
		"CANCELLED": true,
	}
	if !validStatuses[status] {
		return fmt.Errorf("estado inválido: %s", status)
	}
	
	return s.repo.UpdateStatus(id, status)
}

// DeleteExpectedOrder elimina un pedido esperado
func (s *ExpectedOrderService) DeleteExpectedOrder(id uint) error {
	return s.repo.Delete(id)
}

// MarkAsReceived marca un pedido esperado como recibido
func (s *ExpectedOrderService) MarkAsReceived(id uint) error {
	return s.repo.UpdateStatus(id, "RECEIVED")
}

// CreateExpectedOrderFromRequest crea un pedido esperado desde un request
// Maneja la lógica de supplierId = 0 (nuevo proveedor)
func (s *ExpectedOrderService) CreateExpectedOrderFromRequest(supplierId uint, supplierName string, expectedDate time.Time, totalEstimated float64, itemCount int, createdByDNI string, createdByName string) (*models.ExpectedOrder, error) {
	order := &models.ExpectedOrder{
		SupplierID:     supplierId,
		SupplierName:   supplierName,
		ExpectedDate:   expectedDate,
		TotalEstimated: totalEstimated,
		ItemCount:      itemCount,
		Status:         "PENDING",
		CreatedByDNI:   createdByDNI,
		CreatedByName:  createdByName,
	}
	
	if err := s.CreateExpectedOrder(order); err != nil {
		return nil, err
	}
	
	return order, nil
}
