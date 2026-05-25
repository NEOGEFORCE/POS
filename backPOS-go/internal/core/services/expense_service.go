package services

import (
	"errors"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/sse"
)

type ExpenseService struct {
	repo         ports.ExpenseRepository
	supplierRepo *repositories.PostgresSupplierRepository
	orderRepo    *repositories.PostgresPurchaseOrderRepository
	productRepo  ports.ProductRepository
	expected     *ExpectedOrderService
}

func NewExpenseService(repo ports.ExpenseRepository, supplierRepo *repositories.PostgresSupplierRepository, orderRepo *repositories.PostgresPurchaseOrderRepository, productRepo ports.ProductRepository, expected *ExpectedOrderService) *ExpenseService {
	return &ExpenseService{
		repo:         repo,
		supplierRepo: supplierRepo,
		orderRepo:    orderRepo,
		productRepo:  productRepo,
		expected:     expected,
	}
}

func (s *ExpenseService) CreateExpense(expense *models.Expense) error {
	if expense.Amount <= 0 {
		return errors.New("el monto del egreso debe ser mayor a cero")
	}

	// Si viene un nombre de proveedor nuevo, crearlo primero
	if expense.NewSupplierName != "" && expense.Category == "Proveedores" {
		newSup := &models.Supplier{
			Name: expense.NewSupplierName,
		}
		if err := s.supplierRepo.Save(newSup); err == nil {
			expense.SupplierID = &newSup.ID
			expense.Description = "PAGO PROVEEDOR: " + newSup.Name
		}
	}

	// Lógica de Estado Inicial para Préstamos
	if expense.PaymentSource == "PRESTAMO" || expense.PaymentSource == "PREST." {
		expense.Status = "PENDING"
		expense.RemainingAmount = expense.Amount
		expense.PaidAmount = 0
	} else if expense.Status == "" {
		expense.Status = "PAID"
		expense.RemainingAmount = 0
		expense.PaidAmount = expense.Amount
	} else if expense.Status == "PENDING" {
		expense.RemainingAmount = expense.Amount
		expense.PaidAmount = 0
	} else if expense.Status == "PAID" {
		expense.RemainingAmount = 0
		expense.PaidAmount = expense.Amount
	}

	err := s.repo.Save(expense)
	if err == nil {
		// Automatización: Si es un pago a proveedor, marcar pedido esperado como recibido
		if expense.SupplierID != nil {
			_ = s.expected.MarkAsReceivedBySupplier(*expense.SupplierID)
		}

		cache.InvalidateCache(cache.CacheKeyDashboardOverview)
		sse.GetSSEService().BroadcastDashboardUpdate()
	}
	return err
}

func (s *ExpenseService) GetAllExpenses() ([]models.Expense, error) {
	return s.repo.GetAll()
}

func (s *ExpenseService) DeleteExpense(id uint) error {
	err := s.repo.Delete(id)
	if err == nil {
		cache.InvalidateCache(cache.CacheKeyDashboardOverview)
		sse.GetSSEService().BroadcastDashboardUpdate()
	}
	return err
}

func (s *ExpenseService) UpdateExpense(id uint, expense *models.Expense) error {
	err := s.repo.Update(id, expense)
	if err == nil {
		cache.InvalidateCache(cache.CacheKeyDashboardOverview)
		sse.GetSSEService().BroadcastDashboardUpdate()
	}
	return err
}

// SettleExpense marca un egreso como pagado y define su fuente real de dinero
func (s *ExpenseService) SettleExpense(id uint, newPaymentSource, updaterDNI string, paymentAmount float64) (*models.Expense, error) {
	expense, err := s.repo.GetByID(id)
	if err != nil {
		return nil, errors.New("egreso no encontrado")
	}

	if expense.Status == "PAID" {
		return nil, errors.New("este egreso ya está marcado como pagado")
	}

	if expense.RemainingAmount == 0 {
		expense.RemainingAmount = expense.Amount
	}

	amountToPay := paymentAmount
	if amountToPay <= 0 || amountToPay > expense.RemainingAmount {
		amountToPay = expense.RemainingAmount
	}

	expense.PaidAmount += amountToPay
	expense.RemainingAmount -= amountToPay

	if expense.RemainingAmount <= 0 {
		expense.Status = "PAID"
	}

	expense.PaymentSource = newPaymentSource
	expense.Date = time.Now()
	expense.CreatedByDNI = updaterDNI

	if err := s.repo.Update(id, expense); err != nil {
		return nil, err
	}

	cache.InvalidateCache(cache.CacheKeyDashboardOverview)
	sse.GetSSEService().BroadcastDashboardUpdate()

	return expense, nil
}

// CreateLinkedExpense crea un egreso vinculado a una orden de compra pendiente
// 1. Crea el egreso
// 2. Marca la orden como RECIBIDA
// 3. Actualiza el stock automáticamente según los items de la orden
func (s *ExpenseService) CreateLinkedExpense(expense *models.Expense, orderID uint) (*models.Expense, error) {
	if expense.Amount <= 0 {
		return nil, errors.New("el monto del egreso debe ser mayor a cero")
	}

	// Obtener la orden de compra con sus items
	order, err := s.orderRepo.GetByID(orderID)
	if err != nil {
		return nil, errors.New("no se encontró la orden de compra especificada")
	}

	if order.Status != models.PurchaseOrderPending {
		return nil, errors.New("la orden de compra ya no está pendiente")
	}

	// Verificar que el proveedor coincida
	if expense.SupplierID != nil && *expense.SupplierID != order.SupplierID {
		return nil, errors.New("el proveedor del egreso no coincide con el de la orden")
	}

	// Si no tiene proveedor asignado, usar el de la orden
	if expense.SupplierID == nil {
		expense.SupplierID = &order.SupplierID
	}

	// Crear el egreso
	if err := s.repo.Save(expense); err != nil {
		return nil, err
	}

	// Automatización: Marcar pedido esperado como recibido
	if expense.SupplierID != nil {
		_ = s.expected.MarkAsReceivedBySupplier(*expense.SupplierID)
	}

	// Preparar entradas de recepción basadas en los items de la orden
	var receiveEntries []ports.ReceiveEntry
	for _, item := range order.OrderItems {
		entry := ports.ReceiveEntry{
			Barcode:          item.ProductBarcode,
			AddedQuantity:    item.Quantity,
			NewPurchasePrice: item.UnitPrice,
			Iva:              0, // TODO: calcular si es necesario
			Icui:             0,
			Ibua:             0,
			NewSalePrice:     0, // Mantener precio actual
		}
		receiveEntries = append(receiveEntries, entry)
	}

	// Actualizar stock usando BulkReceive (que también marca la orden como recibida)
	// BypassExpense = true porque el egreso se acaba de crear arriba manualmente
	if _, err := s.productRepo.BulkReceive(receiveEntries, &orderID, true, expense.PaymentSource, expense.CreatedByDNI, expense.SupplierID, 0, 0, true); err != nil {
		// Loggear error si falla el stock, pero el egreso ya es exitoso
	}

	// SINCRONIZACIÓN INMEDIATA
	cache.InvalidateCache(cache.CacheKeyDashboardOverview)
	sse.GetSSEService().BroadcastDashboardUpdate()

	return expense, nil
}
