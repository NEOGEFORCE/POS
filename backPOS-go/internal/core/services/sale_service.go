package services

import (
	"fmt"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"errors"
	"strings"
)

type SaleService struct {
	saleRepo     ports.SaleRepository
	productRepo  ports.ProductRepository
	clientRepo   ports.ClientRepository
	movementRepo ports.StockMovementRepository
	printService *PrintService
}

func NewSaleService(sr ports.SaleRepository, pr ports.ProductRepository, cr ports.ClientRepository, mr ports.StockMovementRepository, ps *PrintService) *SaleService {
	return &SaleService{saleRepo: sr, productRepo: pr, clientRepo: cr, movementRepo: mr, printService: ps}
}

func (s *SaleService) CreateSale(sale *models.Sale) error {
	var total float64
	stockUpdates := make(map[string]float64)

	for i, detail := range sale.SaleDetails {
		if strings.HasPrefix(detail.Barcode, "MISC-") {
			total += sale.SaleDetails[i].Subtotal
			continue
		}

		product, err := s.productRepo.GetByBarcode(detail.Barcode)
		if err != nil {
			return errors.New("producto no encontrado: " + detail.Barcode)
		}
		if product.Quantity < detail.Quantity {
			return errors.New("stock insuficiente para: " + product.ProductName)
		}

		sale.SaleDetails[i].UnitPrice = product.SalePrice
		sale.SaleDetails[i].CostPrice = product.PurchasePrice // Store current cost for historical profit accuracy
		sale.SaleDetails[i].Subtotal = applyRounding(product.SalePrice * detail.Quantity)
		total += sale.SaleDetails[i].Subtotal

		stockUpdates[detail.Barcode] = product.Quantity - detail.Quantity
	}

	sale.TotalAmount = total

	paidTotal := sale.CashAmount + sale.TransferAmount + sale.CreditAmount

	if paidTotal < (total - 0.01) {
		return errors.New("pago insuficiente")
	}

	if sale.CreditAmount > 0 {
		if sale.ClientDNI == "0" || sale.ClientDNI == "" {
			return errors.New("debe seleccionar un cliente real para vender a crédito")
		}
		client, err := s.clientRepo.GetByDNI(sale.ClientDNI)
		if err != nil {
			return errors.New("cliente no encontrado para crédito")
		}
		if client.CurrentCredit+sale.CreditAmount > client.CreditLimit {
			return errors.New("el cliente supera su límite de crédito")
		}
		client.CurrentCredit += sale.CreditAmount
		s.clientRepo.Update(client.DNI, client)
	}

	sale.AmountPaid = paidTotal
	sale.Change = (sale.CashAmount + sale.TransferAmount) - (total - sale.CreditAmount)
	if sale.Change < 0 {
		sale.Change = 0
	}

	if err := s.saleRepo.Create(sale); err != nil {
		return err
	}

	if len(stockUpdates) > 0 {
		s.productRepo.BatchUpdateQuantities(stockUpdates)

		// 4.5. Log movements for Kárdex
		for i := range sale.SaleDetails {
			detail := sale.SaleDetails[i]
			if strings.HasPrefix(detail.Barcode, "MISC-") {
				continue
			}
			movement := &models.StockMovement{
				Date:         sale.SaleDate,
				Barcode:      detail.Barcode,
				Quantity:     detail.Quantity,
				Type:         "OUT",
				Reason:       "SALE",
				ReferenceID:  fmt.Sprintf("SALE-%d", sale.SaleID),
				EmployeeDNI:  sale.EmployeeDNI,
				EmployeeName: sale.Employee.Name,
			}
			_ = s.movementRepo.Save(movement)
		}
	}

	// 5. Impresión automática directa (Backend)
	fullSale, err := s.saleRepo.GetByID(sale.SaleID)
	if err == nil {
		s.printService.PrintReceipt(fullSale)
	}

	return nil
}

func (s *SaleService) ListSales(filter ports.SaleFilter) ([]models.Sale, int64, error) {
	if filter.Page <= 0 {
		filter.Page = 1
	}
	if filter.PageSize <= 0 {
		filter.PageSize = 10
	}
	return s.saleRepo.FindAll(filter)
}

func (s *SaleService) GetSale(id uint) (*models.Sale, error) {
	return s.saleRepo.GetByID(id)
}

func (s *SaleService) DeleteSale(id uint) error {
	return s.saleRepo.Delete(id)
}

func (s *SaleService) UpdateSalePayment(id uint, paymentUpdate *models.Sale) error {
	existing, err := s.saleRepo.GetByID(id)
	if err != nil {
		return errors.New("venta no encontrada")
	}

	// Validar que el pago cubre el total
	paidTotal := paymentUpdate.CashAmount + paymentUpdate.TransferAmount + paymentUpdate.CreditAmount
	if paidTotal < existing.TotalAmount {
		return errors.New("el pago actualizado no cubre el total de la venta")
	}

	paymentUpdate.AmountPaid = paidTotal
	// Cambio solo sobre efectivo (transferencia no devuelve)
	cashForGoods := existing.TotalAmount - paymentUpdate.TransferAmount - paymentUpdate.CreditAmount
	if cashForGoods < 0 {
		cashForGoods = 0
	}
	paymentUpdate.Change = paymentUpdate.CashAmount - cashForGoods
	if paymentUpdate.Change < 0 {
		paymentUpdate.Change = 0
	}

	// Calcular Método de Pago automáticamente
	typeCount := 0
	if paymentUpdate.CashAmount > 0 { typeCount++ }
	if paymentUpdate.TransferAmount > 0 { typeCount++ }
	if paymentUpdate.CreditAmount > 0 { typeCount++ }

	if typeCount > 1 {
		paymentUpdate.PaymentMethod = "MIXTO"
	} else if paymentUpdate.CreditAmount > 0 {
		paymentUpdate.PaymentMethod = "FIADO"
	} else if paymentUpdate.TransferAmount > 0 {
		paymentUpdate.PaymentMethod = "TRANSFERENCIA"
	} else {
		paymentUpdate.PaymentMethod = "EFECTIVO"
	}

	return s.saleRepo.UpdatePayment(id, paymentUpdate)
}
