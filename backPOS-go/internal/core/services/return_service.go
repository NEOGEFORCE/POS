package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"errors"
)

type ReturnService struct {
	returnRepo  ports.ReturnRepository
	productRepo ports.ProductRepository
	saleRepo    ports.SaleRepository
}

func NewReturnService(rr ports.ReturnRepository, pr ports.ProductRepository, sr ports.SaleRepository) *ReturnService {
	return &ReturnService{returnRepo: rr, productRepo: pr, saleRepo: sr}
}

func (s *ReturnService) CreateReturn(ret *models.Return) error {
	// 1. Validar que la venta existe
	_, err := s.saleRepo.GetByID(ret.SaleID)
	if err != nil {
		return errors.New("venta no encontrada")
	}

	// 2. Procesar detalles y actualizar stock
	for _, detail := range ret.Details {
		product, err := s.productRepo.GetByBarcode(detail.Barcode)
		if err != nil {
			return errors.New("producto no encontrado: " + detail.Barcode)
		}
		
		var newQty float64
		if detail.IsExchange {
			// Es un producto que sale (cambio) -> Restar stock
			if product.Quantity < detail.Quantity && !product.IsWeighted {
				return errors.New("insuficiente stock para cambio: " + product.ProductName)
			}
			newQty = product.Quantity - detail.Quantity
		} else {
			// Es un producto que entra (devolución) -> Sumar stock
			newQty = product.Quantity + detail.Quantity
		}

		if err := s.productRepo.UpdateQuantity(detail.Barcode, newQty); err != nil {
			return err
		}
	}

	// 3. Guardar devolución
	if err := s.returnRepo.Create(ret); err != nil {
		return err
	}

	return nil
}

func (s *ReturnService) ListReturns() ([]models.Return, error) {
	return s.returnRepo.GetAll()
}
