package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"errors"
	"fmt"
	"math"
	"strconv"
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

func (s *ReturnService) CreateReturn(ret *models.Return, employeeDNI string, employeeName string) error {
	// 1. Validar que la venta existe
	if _, err := s.saleRepo.GetByID(ret.SaleID); err != nil {
		return errors.New("venta no encontrada")
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


func (s *ReturnService) ProcessAdvancedReturn(req ports.ProcessReturnReq, employeeDNI string, employeeName string) error {
	var originalSale *models.Sale
	var err error

	if req.InvoiceRef > 0 {
		originalSale, err = s.saleRepo.GetByID(req.InvoiceRef)
		if err != nil {
			return errors.New("venta original no encontrada")
		}

		if req.Type == "REFUND" && originalSale.PaymentMethod != "EFECTIVO" && originalSale.PaymentMethod != "CASH" {
			return errors.New("solo se permite reembolso en efectivo para ventas pagadas en efectivo")
		}
	} else if req.Type == "REFUND" {
		// En modo ciego sin factura, el GetBlindReturnData ya aseguró si había efectivo disponible
		// Pero para ser robustos, asumimos que el controlador validó la disponibilidad de efectivo.
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
	err = s.returnRepo.ProcessAdvancedReturnTransaction(req, originalSale, employeeDNI, employeeName, stockAdjustments, movements)
	if err != nil {
		return err
	}

	// Invalida cache de dashboard e inicia broadcast asíncrono
	cache.InvalidateCache(cache.CacheKeyDashboardOverview)
	sse.GetSSEService().BroadcastDashboardUpdate()

	return nil
}
