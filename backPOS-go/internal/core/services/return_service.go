package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"errors"
	"fmt"
	"math"
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
	for _, detail := range ret.Details {
		// Preload product with BaseProduct to handle Pack logic
		product, err := s.productRepo.GetByBarcodeWithPreloads(detail.Barcode, "BaseProduct")
		if err != nil {
			return errors.New("producto no encontrado: " + detail.Barcode)
		}

		movementType := "IN"
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
				Reason:       "PACK_" + reason,
				ReferenceID:  fmt.Sprintf("RET-%d-%s", ret.SaleID, time.Now().Format("20060102")),
				EmployeeDNI:  employeeDNI,
				EmployeeName: employeeName,
			}
			_ = s.movementRepo.Save(baseMovement)
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
		_ = s.movementRepo.Save(movement)
	}

	if len(stockAdjustments) > 0 {
		if err := s.productRepo.BatchAdjustQuantities(stockAdjustments); err != nil {
			fmt.Printf("ERROR ACTUALIZANDO STOCK EN DEVOLUCIÓN: %v\n", err)
		}
	}

	// 3. Guardar devolución
	if err := s.returnRepo.Create(ret); err != nil {
		return err
	}

	cache.InvalidateCache(cache.CacheKeyDashboardOverview)
	sse.GetSSEService().BroadcastDashboardUpdate()

	return nil
}

func (s *ReturnService) ListReturns() ([]models.Return, error) {
	return s.returnRepo.GetAll()
}
