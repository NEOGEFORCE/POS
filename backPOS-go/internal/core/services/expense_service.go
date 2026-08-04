package services

import (
	"errors"
	"log"
	"strings"
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
	restockRepo  ports.RestockRepository
}

func NewExpenseService(repo ports.ExpenseRepository, supplierRepo *repositories.PostgresSupplierRepository, orderRepo *repositories.PostgresPurchaseOrderRepository, productRepo ports.ProductRepository, expected *ExpectedOrderService, restockRepo ports.RestockRepository) *ExpenseService {
	return &ExpenseService{
		repo:         repo,
		supplierRepo: supplierRepo,
		orderRepo:    orderRepo,
		productRepo:  productRepo,
		expected:     expected,
		restockRepo:  restockRepo,
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

	// Auto-asignar campos de monto por canal si no vinieron del frontend
	// para que los reportes puedan distinguir el canal correctamente
	if expense.Status != "PENDING" &&
		expense.CashAmount == 0 && expense.NequiAmount == 0 &&
		expense.DaviplataAmount == 0 && expense.FondoAmount == 0 {
		src := strings.ToUpper(strings.TrimSpace(expense.PaymentSource))
		switch {
		case strings.Contains(src, "NEQUI") || strings.Contains(src, "BANCOLOMBIA") || strings.Contains(src, "TRANSFERENCIA") || strings.Contains(src, "BANCO") || strings.Contains(src, "DIGITAL"):
			expense.NequiAmount = expense.Amount
		case strings.Contains(src, "DAVIPLATA"):
			expense.DaviplataAmount = expense.Amount
		case strings.Contains(src, "FONDO") || strings.Contains(src, "BOVEDA") || strings.Contains(src, "BÓVEDA"):
			expense.FondoAmount = expense.Amount
			expense.PaymentSource = "FONDO"
		case strings.Contains(src, "PREST") || strings.Contains(src, "DEUDA") || strings.Contains(src, "PENDING"):
			// Deudas y préstamos no afectan la caja ni cuentas digitales
		default:
			expense.CashAmount = expense.Amount
		}
	}

	err := s.repo.Save(expense)
	if err == nil {
		// Si es un pago a proveedor, registrar día de entrega para aprendizaje de rutas
		if expense.SupplierID != nil {
			// IMPORTANTE: NO auto-completar ni marcar pedidos como recibidos al crear un egreso.
			// Los pedidos de recepción deben permanecer PENDIENTES (EN CAMINO) hasta que el usuario
			// haga la recepción física de mercancía o haga clic en "Ya llegó".
			_ = s.supplierRepo.LearnDay(*expense.SupplierID, "delivery_days")
		}

		cache.InvalidateCache(cache.CacheKeyDashboardOverview)
		sse.GetSSEService().BroadcastDashboardUpdate()
	}
	return err
}

func (s *ExpenseService) GetAllExpenses(supplier, concept string) ([]models.Expense, error) {
	if supplier == "" && concept == "" {
		return s.repo.GetAll()
	}
	return s.repo.GetAllFiltered(supplier, concept)
}

func (s *ExpenseService) GetExpensesPaginated(filter ports.ExpenseFilter) ([]models.Expense, int64, error) {
	return s.repo.GetExpensesPaginated(filter)
}

func (s *ExpenseService) GetPendingRestockExpensesBySupplier(supplierID uint) ([]models.Expense, error) {
	return s.repo.GetPendingRestockExpensesBySupplier(supplierID)
}

func (s *ExpenseService) GetByID(id uint) (*models.Expense, error) {
	return s.repo.GetByID(id)
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

// SettleExpense registra un abono (parcial o total) a una deuda pendiente
func (s *ExpenseService) SettleExpense(id uint, newPaymentSource, updaterDNI string, paymentAmount, cashAmount, nequiAmount, daviplataAmount, fondoAmount float64) (*models.Expense, error) {
	expense, err := s.repo.GetByID(id)
	if err != nil {
		return nil, errors.New("egreso no encontrado")
	}

	if expense.Status == "PAID" || expense.Status == "SETTLED" {
		return nil, errors.New("este egreso ya está completamente pagado")
	}

	if expense.RemainingAmount == 0 {
		expense.RemainingAmount = expense.Amount
	}

	if paymentAmount <= 0 {
		return nil, errors.New("debe ingresar un monto de abono mayor a cero")
	}

	amountToPay := paymentAmount
	if amountToPay > expense.RemainingAmount {
		amountToPay = expense.RemainingAmount
	}

	isPartial := amountToPay < expense.RemainingAmount

	// Prefijo de descripcion para identificar abonos
	abonoDesc := "ABONO A DEUDA: " + expense.Description
	if !isPartial {
		abonoDesc = expense.Description
	}

	// 1. Crear un nuevo egreso para registrar el Abono exacto con el método de pago exacto y fecha de hoy
	abonoExpense := &models.Expense{
		Description:     abonoDesc,
		Amount:          amountToPay,
		PaidAmount:      amountToPay,
		RemainingAmount: 0,
		Status:          "PAID",
		Category:        expense.Category,
		PaymentSource:   newPaymentSource,
		Date:            time.Now(),
		CreatedByDNI:    updaterDNI,
		SupplierID:      expense.SupplierID,
		CashAmount:      cashAmount,
		NequiAmount:     nequiAmount,
		DaviplataAmount: daviplataAmount,
		FondoAmount:     fondoAmount,
	}

	// 2. Descontar la deuda original sin cambiar su PaymentSource ni fecha inicial
	expense.PaidAmount += amountToPay
	expense.RemainingAmount -= amountToPay

	if expense.RemainingAmount <= 0 {
		expense.RemainingAmount = 0
		expense.Status = "SETTLED"
	}

	if err := s.repo.Update(id, expense); err != nil {
		return nil, err
	}

	// 3. Guardar el abono como un egreso nuevo para que cuadre en la caja de hoy
	if err := s.repo.Save(abonoExpense); err != nil {
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

		// Auto-aprendizaje de ruta: día actual = día de entrega (delivery_days).
		_ = s.supplierRepo.LearnDay(*expense.SupplierID, "delivery_days")
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
	if _, err := s.productRepo.BulkReceive(receiveEntries, &orderID, nil, nil, true, expense.PaymentSource, expense.CreatedByDNI, expense.SupplierID, 0, 0, true, ""); err != nil {
		// Loggear error si falla el stock, pero el egreso ya es exitoso
	}

	// SINCRONIZACIÓN INMEDIATA
	cache.InvalidateCache(cache.CacheKeyDashboardOverview)
	sse.GetSSEService().BroadcastDashboardUpdate()

	return expense, nil
}


// autoCompletePendingPurchaseOrders cierra automáticamente las órdenes de
// compra (PurchaseOrder) en estado PENDING del proveedor cuya deliveryDate
// sea hoy o anterior, marcándolas como RECEIVED. Disparado tras registrar
// un egreso al proveedor — la hipótesis es que si el operador pagó, la
// mercancía ya llegó.
//
// Las órdenes con deliveryDate en el FUTURO se respetan: si el operador
// pagó por adelantado un pedido programado para mañana, no queremos
// cerrarlo prematuramente — la entrega aún no ocurrió.
//
// No-fatal: cualquier error queda en log; el flujo principal no se
// interrumpe.
func (s *ExpenseService) autoCompletePendingPurchaseOrders(supplierID uint) {
	if supplierID == 0 {
		return
	}

	bogotaLoc, _ := time.LoadLocation("America/Bogota")
	if bogotaLoc == nil {
		bogotaLoc = time.FixedZone("COT", -5*3600)
	}
	// Fin del día de HOY en Bogotá: cualquier deliveryDate < esto es candidata.
	todayEnd := time.Now().In(bogotaLoc).Truncate(24 * time.Hour).Add(24 * time.Hour)
	todayStr := time.Now().In(bogotaLoc).Format("2006-01-02")

	closed := 0

	// 1. Cerrar PurchaseOrders (Legado)
	if s.orderRepo != nil {
		if pendingOrders, err := s.orderRepo.GetBySupplierAndStatus(supplierID, models.PurchaseOrderPending); err == nil && len(pendingOrders) > 0 {
			for _, ord := range pendingOrders {
				if ord.DeliveryDate.IsZero() || ord.DeliveryDate.Before(todayEnd) {
					if err := s.orderRepo.UpdateStatus(ord.ID, models.PurchaseOrderReceived); err == nil {
						closed++
						log.Printf(
							"[ExpenseService] Auto-completado PurchaseOrder #%d (supplier %d, deliveryDate %s) por egreso",
							ord.ID, supplierID, ord.DeliveryDate.Format("2006-01-02"),
						)
					}
				}
			}
		}
	}

	// 2. Cerrar ConfirmedOrders (Actuales)
	if s.restockRepo != nil {
		if pendingConfirmed, err := s.restockRepo.GetPendingOrdersBySupplier(supplierID); err == nil && len(pendingConfirmed) > 0 {
			for _, ord := range pendingConfirmed {
				// expected_date es YYYY-MM-DD
				if ord.ExpectedDate == "" || ord.ExpectedDate <= todayStr {
					if err := s.restockRepo.UpdateOrderStatus(ord.ID, "received", "SISTEMA (Auto-pago)"); err == nil {
						closed++
						log.Printf(
							"[ExpenseService] Auto-completado ConfirmedOrder %s (supplier %d, expectedDate %s) por egreso",
							ord.ID, supplierID, ord.ExpectedDate,
						)
					}
				}
			}
		}
	}

	if closed > 0 {
		// Notificar al frontend para que la vista de "Entregas programadas hoy"
		// refresque y oculte los pedidos recién cerrados.
		sse.GetSSEService().Broadcast("INVENTORY_UPDATE", nil)
	}
}
