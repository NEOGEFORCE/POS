package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"errors"
	"fmt"
	"math"
	"time"
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
	sale, err := s.saleRepo.GetByID(ret.SaleID)
	if err != nil {
		return errors.New("venta no encontrada")
	}

	// 2. Procesar detalles y actualizar stock
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
			baseProduct := product.BaseProduct
			baseAdjustQty := adjustQty * float64(product.PackMultiplier)
			
			// Validar stock si es salida
			if detail.IsExchange && baseProduct.Quantity < -baseAdjustQty && !product.IsWeighted {
				return errors.New("insuficiente stock base para cambio: " + product.ProductName)
			}

			baseProduct.Quantity += baseAdjustQty
			if baseProduct.Quantity < 0 {
				baseProduct.Quantity = 0
			}
			_ = s.productRepo.UpdateQuantity(baseProduct.Barcode, baseProduct.Quantity)
			
			// Sincronizar el stock del pack
			product.Quantity = math.Floor(baseProduct.Quantity / float64(product.PackMultiplier))
			_ = s.productRepo.UpdateQuantity(product.Barcode, product.Quantity)

			// Log en el base
			baseMovement := &models.StockMovement{
				Date:         time.Now(),
				Barcode:      baseProduct.Barcode,
				Quantity:     baseAdjustQty,
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
			product.Quantity += adjustQty
			if product.Quantity < 0 {
				product.Quantity = 0
			}
			_ = s.productRepo.UpdateQuantity(product.Barcode, product.Quantity)
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

	// 3. Guardar devolución
	if err := s.returnRepo.Create(ret); err != nil {
		return err
	}

	// Log a reference movement for the sale
	_ = sale // Use sale to avoid unused variable warning

	return nil
}

func (s *ReturnService) ListReturns() ([]models.Return, error) {
	return s.returnRepo.GetAll()
}
