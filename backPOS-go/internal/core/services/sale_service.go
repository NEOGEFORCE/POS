package services

import (
	"fmt"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"errors"
	"strings"
	"time"
)

type SaleService struct {
	saleRepo     ports.SaleRepository
	productRepo  ports.ProductRepository
	clientRepo   ports.ClientRepository
	movementRepo ports.StockMovementRepository
	creditRepo   ports.CreditPaymentRepository
	printService *PrintService
}

func NewSaleService(sr ports.SaleRepository, pr ports.ProductRepository, cr ports.ClientRepository, mr ports.StockMovementRepository, ps *PrintService, cpr ports.CreditPaymentRepository) *SaleService {
	return &SaleService{saleRepo: sr, productRepo: pr, clientRepo: cr, movementRepo: mr, printService: ps, creditRepo: cpr}
}

func (s *SaleService) CreateSale(sale *models.Sale) error {
	var total float64
	
	// 1. Agrupar deducciones y pre-cargar productos para consistencia
	deductions := make(map[string]float64)
	productCache := make(map[string]*models.Product)

	for _, detail := range sale.SaleDetails {
		if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
			continue
		}

		// Obtener producto (usar caché si ya se cargó en este ciclo)
		product, ok := productCache[detail.Barcode]
		if !ok {
			var err error
			product, err = s.productRepo.GetByBarcodeWithPreloads(detail.Barcode, "BaseProduct")
			if err != nil {
				return errors.New("producto no encontrado: " + detail.Barcode)
			}
			productCache[detail.Barcode] = product
		}

		effectiveQty := detail.Quantity
		targetBarcode := detail.Barcode

		// Lógica de Packs
		if product.IsPack && product.BaseProduct != nil && product.PackMultiplier > 0 {
			targetBarcode = *product.BaseProductBarcode
			effectiveQty = detail.Quantity * float64(product.PackMultiplier)
			
			// Cargar el producto base si no está en caché
			if _, exists := productCache[targetBarcode]; !exists {
				base, err := s.productRepo.GetByBarcode(targetBarcode)
				if err != nil {
					return errors.New("producto base no encontrado para el pack: " + targetBarcode)
				}
				productCache[targetBarcode] = base
			}
		}

		deductions[targetBarcode] += effectiveQty
	}

	// 2. Validar stock total requerido antes de procesar detalles
	for barcode, totalNeeded := range deductions {
		product, ok := productCache[barcode]
		if !ok {
			continue // No debería pasar
		}
		if product.Quantity < totalNeeded && !product.IsWeighted {
			return fmt.Errorf("stock insuficiente para %s: disponible %.2f, requerido %.2f", product.ProductName, product.Quantity, totalNeeded)
		}
	}

	// 3. Procesar detalles de la venta y calcular totales
	for i := range sale.SaleDetails {
		detail := &sale.SaleDetails[i]
		if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
			total += detail.Subtotal
			continue
		}

		product := productCache[detail.Barcode]
		detail.UnitPrice = product.SalePrice
		detail.CostPrice = product.PurchasePrice
		detail.Subtotal = applyRounding(product.SalePrice * detail.Quantity)
		total += detail.Subtotal
	}

	sale.TotalAmount = total
	paidTotal := sale.CashAmount + sale.TransferAmount + sale.CreditAmount

	if paidTotal < (total - 0.01) {
		return errors.New("pago insuficiente")
	}

	if sale.CreditAmount > 0 {
		sale.DebtPending = sale.CreditAmount
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
	
	// El cambio solo debe salir del efectivo
	cashNeeded := total - sale.TransferAmount - sale.CreditAmount
	if cashNeeded < 0 {
		cashNeeded = 0
	}
	
	sale.Change = sale.CashAmount - cashNeeded
	if sale.Change < 0 {
		sale.Change = 0
	}

	if err := s.saleRepo.Create(sale); err != nil {
		return err
	}

	// 4. Aplicar actualizaciones de stock
	if len(deductions) > 0 {
		stockUpdates := make(map[string]float64)
		for barcode, totalDeducted := range deductions {
			product := productCache[barcode]
			stockUpdates[barcode] = product.Quantity - totalDeducted
		}

		if err := s.productRepo.BatchUpdateQuantities(stockUpdates); err != nil {
			// Si falla la actualización de stock, logueamos pero la venta ya se creó
			// Idealmente esto debería estar en una transacción mayor, pero depende de la arquitectura del repo
			fmt.Printf("ERROR CRÍTICO: No se pudo actualizar el stock en BatchUpdateQuantities: %v\n", err)
		}

		// 4.5. Log movements for Kárdex
		for i := range sale.SaleDetails {
			detail := sale.SaleDetails[i]
			if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
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

func (s *SaleService) ListPendingDebts() ([]models.Sale, error) {
	return s.saleRepo.FindPendingDebts()
}

func (s *SaleService) RegisterDebtPayment(saleID uint, amount float64, method string, employeeDNI string) error {
	sale, err := s.saleRepo.GetByID(saleID)
	if err != nil {
		return errors.New("venta no encontrada")
	}

	if sale.DebtPending <= 0 {
		return errors.New("esta venta no tiene saldo pendiente")
	}

	if amount > sale.DebtPending {
		amount = sale.DebtPending // No permitir pagar más de la deuda
	}

	// 1. Actualizar Saldo de la Venta
	newDebt := sale.DebtPending - amount
	if err := s.saleRepo.UpdateDebt(saleID, newDebt); err != nil {
		return err
	}

	// 2. Actualizar Crédito del Cliente
	if sale.ClientDNI != "" && sale.ClientDNI != "0" {
		client, err := s.clientRepo.GetByDNI(sale.ClientDNI)
		if err == nil {
			client.CurrentCredit -= amount
			if client.CurrentCredit < 0 {
				client.CurrentCredit = 0
			}
			client.UpdatedByDNI = employeeDNI
			_ = s.clientRepo.Update(client.DNI, client)

			// 3. Registrar en Historial de Abonos (CreditPayment)
			payment := &models.CreditPayment{
				ClientDNI:      sale.ClientDNI,
				EmployeeDNI:    employeeDNI,
				TotalPaid:      amount,
				PaymentDate:    time.Now(),
			}
			if method == "EFECTIVO" {
				payment.AmountCash = amount
			} else {
				payment.AmountTransfer = amount
				payment.TransferSource = method
			}
			
			_ = s.creditRepo.Save(payment)
		}
	}

	return nil
}
