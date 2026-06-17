package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/sse"
)

type ReturnService struct {
	returnRepo   ports.ReturnRepository
	productRepo  ports.ProductRepository
	saleRepo     ports.SaleRepository
	movementRepo ports.StockMovementRepository
}

func NewReturnService(rr ports.ReturnRepository, pr ports.ProductRepository, sr ports.SaleRepository, mr ports.StockMovementRepository) *ReturnService {
	return &ReturnService{returnRepo: rr, productRepo: pr, saleRepo: sr, movementRepo: mr}
}

// ============================================================
// Helpers compartidos: política de devoluciones
// ============================================================
//
// REGLA DE NEGOCIO (ratificada en el sprint 2026-05-30):
//   - Solo se permite REFUND (devolución de dinero) si la venta original
//     fue pagada en EFECTIVO. Cualquier otro método (transferencia, fiado,
//     tarjeta, mixto, etc.) obliga a EXCHANGE: el cliente debe llevarse
//     producto por valor equivalente o mayor.
//   - El stock SIEMPRE se ajusta: items devueltos suman al inventario
//     (regresan a la góndola) e items de reemplazo restan (salen al cliente).
//   - El dinero solo se mueve si hay diferencia: en REFUND se crea un
//     Expense category=Devoluciones (egreso real de caja); en EXCHANGE con
//     chargeAmount > 0 se crea una mini-Sale (ingreso real de caja).

// isCashOnlyMethod verifica si el método de pago es estrictamente efectivo
// (única vía para permitir REFUND). Aplica normalización case-insensitive
// y trimspace para tolerar variantes del frontend.
func isCashOnlyMethod(method string) bool {
	m := strings.ToUpper(strings.TrimSpace(method))
	return m == "EFECTIVO" || m == "CASH"
}

// validateRefundAllowed retorna error si la venta original no permite REFUND.
// Centraliza la decisión para que tanto CreateReturn como ProcessAdvancedReturn
// apliquen la misma regla y el mensaje de error sea consistente.
func validateRefundAllowed(sale *models.Sale) error {
	if sale == nil {
		return errors.New("solo se permite reembolso con factura asociada (modo ciego no aplica)")
	}
	if !isCashOnlyMethod(sale.PaymentMethod) {
		return fmt.Errorf(
			"solo se permite reembolso en efectivo (esta venta fue pagada con %s) — usa EXCHANGE para que el cliente se lleve otro producto",
			sale.PaymentMethod,
		)
	}
	return nil
}

// validateItemsAgainstSale verifica que cada item solicitado para devolver
// (1) está en la venta original y (2) no excede la cantidad disponible
// (vendida menos la ya devuelta previamente). Esto previene:
//   - Devolver productos que NO fueron vendidos en esa factura.
//   - Devolver más de lo realmente comprado.
//   - Doble devolución del mismo item.
//
// La tolerancia de 0.001 evita falsos positivos por floats en productos
// pesables (kg, lb).
func validateItemsAgainstSale(sale *models.Sale, items []ports.ReturnItemReq) error {
	if sale == nil {
		return errors.New("no se puede validar items: venta original no encontrada")
	}
	available := make(map[string]float64)
	for _, det := range sale.SaleDetails {
		available[det.Barcode] += det.Quantity - det.ReturnedQty
	}
	for _, it := range items {
		if it.Qty <= 0 {
			continue
		}
		avail, ok := available[it.Barcode]
		if !ok {
			return fmt.Errorf("el producto %s no fue vendido en la factura #%d", it.Barcode, sale.SaleID)
		}
		if it.Qty > avail+0.001 {
			return fmt.Errorf(
				"cantidad %.2f de %s excede lo disponible para devolución (vendido pendiente: %.2f)",
				it.Qty, it.Barcode, avail,
			)
		}
	}
	return nil
}

// returnDetailsToItemReqs adapta los []ReturnDetail del flujo legacy
// CreateReturn al []ReturnItemReq usado por validateItemsAgainstSale.
// Solo considera items NO-IsExchange (los que el cliente está devolviendo);
// los IsExchange son productos de salida (reemplazos) y no aplican.
func returnDetailsToItemReqs(details []models.ReturnDetail) []ports.ReturnItemReq {
	out := make([]ports.ReturnItemReq, 0, len(details))
	for _, d := range details {
		if d.IsExchange {
			continue
		}
		out = append(out, ports.ReturnItemReq{Barcode: d.Barcode, Qty: d.Quantity})
	}
	return out
}

func (s *ReturnService) CreateReturn(ret *models.Return, employeeDNI string, employeeName string) error {
	// 1. Validar que la venta existe y aplicar política de devoluciones
	originalSale, err := s.saleRepo.GetByID(ret.SaleID)
	if err != nil {
		return errors.New("venta no encontrada")
	}

	// 1a. Si es REFUND, la venta debe haber sido pagada en EFECTIVO.
	// Para TRANSFERENCIA/CRÉDITO/MIXTO/etc. solo se permite EXCHANGE.
	if strings.ToUpper(ret.ReturnType) == "REFUND" {
		if err := validateRefundAllowed(originalSale); err != nil {
			return err
		}
	}

	// 1b. Validar que cada item devuelto esté efectivamente en la venta
	// original y que la cantidad no exceda lo disponible (vendido menos
	// previamente devuelto).
	if err := validateItemsAgainstSale(originalSale, returnDetailsToItemReqs(ret.Details)); err != nil {
		return err
	}

	// 2. Procesar detalles y calcular ajustes de stock
	stockAdjustments := make(map[string]float64)
	var movements []*models.StockMovement

	for _, detail := range ret.Details {
		// Preload product with BaseProduct to handle Pack logic
		product, err := s.productRepo.GetByBarcodeWithPreloads(detail.Barcode, "BaseProduct")
		if err != nil {
			return errors.New("producto no encontrado: " + detail.Barcode)
		}

		movementType := "RETURN_RESTOCK"
		reason := "RETURN"
		if detail.IsExchange {
			movementType = "OUT"
			reason = "EXCHANGE_OUT"
		}

		// Cantidad a ajustar (positiva o negativa)
		adjustQty := detail.Quantity
		if detail.IsExchange {
			adjustQty = -detail.Quantity
		}

		// Lógica de Packs
		if product.IsPack && product.BaseProduct != nil && product.PackMultiplier > 0 {
			targetBarcode := *product.BaseProductBarcode
			baseAdjustQty := adjustQty * float64(product.PackMultiplier)
			
			// Validar stock si es salida (aproximado, la DB lo validará mejor si ponemos constraints)
			if detail.IsExchange && product.BaseProduct.Quantity < -baseAdjustQty && !product.IsWeighted {
				return errors.New("insuficiente stock base para cambio: " + product.ProductName)
			}

			stockAdjustments[targetBarcode] -= baseAdjustQty
			
			// Log en el base
			baseMovement := &models.StockMovement{
				Date:         time.Now(),
				Barcode:      targetBarcode,
				Quantity:     math.Abs(baseAdjustQty),
				Type:         movementType,
				Reason:       "PACK_RETURN_RESTOCK",
				ReferenceID:  fmt.Sprintf("RET-%d-%s", ret.SaleID, time.Now().Format("20060102")),
				EmployeeDNI:  employeeDNI,
				EmployeeName: employeeName,
			}
			movements = append(movements, baseMovement)
		} else {
			// Comportamiento normal
			if detail.IsExchange && product.Quantity < detail.Quantity && !product.IsWeighted {
				return errors.New("insuficiente stock para cambio: " + product.ProductName)
			}
			stockAdjustments[detail.Barcode] -= adjustQty
		}

		// Log the movement for Kárdex (del producto original)
		movement := &models.StockMovement{
			Date:         time.Now(),
			Barcode:      detail.Barcode,
			Quantity:     detail.Quantity,
			Type:         movementType,
			Reason:       reason,
			ReferenceID:  fmt.Sprintf("RET-%d-%s", ret.SaleID, time.Now().Format("20060102")),
			EmployeeDNI:  employeeDNI,
			EmployeeName: employeeName,
		}
		movements = append(movements, movement)
	}

	// 3. Guardar devolución con transacción ACID síncrona
	if err := s.returnRepo.CreateWithTransaction(ret, employeeDNI, employeeName, stockAdjustments, movements); err != nil {
		return err
	}

	// Invalida cache de dashboard e inicia broadcast asíncrono
	cache.InvalidateCache(cache.CacheKeyDashboardOverview)
	sse.GetSSEService().BroadcastDashboardUpdate()

	return nil
}

func (s *ReturnService) ListReturns() ([]models.Return, error) {
	return s.returnRepo.GetAll()
}

func (s *ReturnService) GetSaleForReturn(refStr string) (*models.Sale, error) {
	id, err := strconv.ParseUint(refStr, 10, 32)
	if err != nil {
		return nil, errors.New("formato de id invalido")
	}
	sale, err := s.saleRepo.GetByID(uint(id))
	if err != nil {
		return nil, err
	}
	return sale, nil
}

func (s *ReturnService) GetBlindReturnData(barcode string) (map[string]interface{}, error) {
	// Find in recent sales using FindAll
	sales, _, err := s.saleRepo.FindAll(ports.SaleFilter{Page: 1, PageSize: 100})
	if err != nil {
		return nil, err
	}

	var productFound bool
	var totalValidQty float64
	var cashRefundable float64
	var lastSaleMethod string
	var lastSaleId uint
	var productName string
	var unitPrice float64

	for _, sale := range sales {
		for _, detail := range sale.SaleDetails {
			if detail.Barcode == barcode {
				productFound = true
				productName = detail.Product.ProductName
				unitPrice = detail.UnitPrice
				available := detail.Quantity - detail.ReturnedQty
				if available > 0 {
					totalValidQty += available
					if lastSaleId == 0 {
						lastSaleId = sale.SaleID
						lastSaleMethod = sale.PaymentMethod
					}
					// Proporcionalmente sumar efectivo
					if sale.CashAmount > 0 {
						cashRefundable += available * detail.UnitPrice // Simplificado, asumiendo que el efectivo cubrió esto
					}
				}
			}
		}
	}

	if !productFound || totalValidQty == 0 {
		return nil, errors.New("Este producto no fue vendido recientemente o ya fue devuelto completamente")
	}

	return map[string]interface{}{
		"barcode": barcode,
		"productName": productName,
		"unitPrice": unitPrice,
		"validQty": totalValidQty,
		"lastSaleId": lastSaleId,
		"lastPaymentMethod": lastSaleMethod,
		"cashRefundable": cashRefundable,
	}, nil
}


func (s *ReturnService) ProcessAdvancedReturn(req ports.ProcessReturnReq, employeeDNI string, employeeName string) (*models.Return, error) {
	var originalSale *models.Sale
	var err error

	if req.InvoiceRef > 0 {
		originalSale, err = s.saleRepo.GetByID(req.InvoiceRef)
		if err != nil {
			return nil, errors.New("venta original no encontrada")
		}

		// Solo REFUND en efectivo. Cualquier otro método (TRANSFER/CREDIT/MIXTO/...)
		// obliga a EXCHANGE: el cliente debe llevarse otro producto.
		if strings.ToUpper(req.Type) == "REFUND" {
			if err := validateRefundAllowed(originalSale); err != nil {
				return nil, err
			}
		}

		// Validar que los items devueltos pertenecen a la venta original
		// y que las cantidades no exceden lo disponible. Bloquea:
		//   - barcode que no fue vendido en esta factura
		//   - cantidad mayor a lo vendido (descontando devoluciones previas)
		if err := validateItemsAgainstSale(originalSale, req.ReturnedItems); err != nil {
			return nil, err
		}
	} else {
		// Modo ciego (sin factura): NO se permite REFUND porque no podemos
		// auditar el método de pago original con seguridad. El usuario debe
		// usar el flujo con factura para reembolsar dinero.
		if strings.ToUpper(req.Type) == "REFUND" {
			return nil, errors.New("modo ciego sin factura: solo se permite cambio por otro producto (EXCHANGE), no reembolso en efectivo")
		}
	}

	// Calculate stock adjustments and Kárdex movements
	stockAdjustments := make(map[string]float64)
	var movements []*models.StockMovement

	for _, item := range req.ReturnedItems {
		stockAdjustments[item.Barcode] += item.Qty
		movements = append(movements, &models.StockMovement{
			Date:         time.Now(),
			Barcode:      item.Barcode,
			Quantity:     item.Qty,
			Type:         "RETURN",
			Reason:       "RETURN",
			ReferenceID:  fmt.Sprintf("RET-%d-%s", req.InvoiceRef, time.Now().Format("20060102")),
			EmployeeDNI:  employeeDNI,
			EmployeeName: employeeName,
		})
	}

	for _, item := range req.ReplacementItems {
		stockAdjustments[item.Barcode] -= item.Qty
		movements = append(movements, &models.StockMovement{
			Date:         time.Now(),
			Barcode:      item.Barcode,
			Quantity:     item.Qty,
			Type:         "SALE",
			Reason:       "EXCHANGE",
			ReferenceID:  fmt.Sprintf("RET-%d-%s", req.InvoiceRef, time.Now().Format("20060102")),
			EmployeeDNI:  employeeDNI,
			EmployeeName: employeeName,
		})
	}

	// 3. Guardar devolución con transacción ACID síncrona
	ret, err := s.returnRepo.ProcessAdvancedReturnTransaction(req, originalSale, employeeDNI, employeeName, stockAdjustments, movements)
	if err != nil {
		return nil, err
	}

	// Invalida cache de dashboard e inicia broadcast asíncrono
	cache.InvalidateCache(cache.CacheKeyDashboardOverview)
	sse.GetSSEService().BroadcastDashboardUpdate()

	return ret, nil
}
