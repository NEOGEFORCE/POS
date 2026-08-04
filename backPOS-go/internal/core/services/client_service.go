package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"
	"strings"
	"time"
)

type ClientService struct {
	repo       ports.ClientRepository
	creditRepo ports.CreditPaymentRepository
}

func NewClientService(repo ports.ClientRepository, cr ports.CreditPaymentRepository) *ClientService {
	return &ClientService{repo: repo, creditRepo: cr}
}

type ClientStatement struct {
	Client          *models.Client          `json:"client"`
	Pending         []models.Sale           `json:"pending"`
	Payments        []models.CreditPayment  `json:"payments"`
	HistorySales    []models.Sale           `json:"historySales"`
	HistoryPayments []models.CreditPayment  `json:"historyPayments"`
}

func (s *ClientService) GetClientStatement(dni string, saleRepo ports.SaleRepository) (*ClientStatement, error) {
	client, err := s.repo.GetByDNI(dni)
	if err != nil {
		return nil, err
	}

	allPayments, err := s.creditRepo.GetByClient(dni)
	if err != nil {
		allPayments = []models.CreditPayment{}
	}

	historySales, err := saleRepo.GetCreditHistoryByClient(dni)
	if err != nil {
		historySales = []models.Sale{}
	}

	pending, err := saleRepo.GetPendingByClient(dni)
	if err != nil {
		pending = []models.Sale{}
	}

	// Auto-recálculo y auto-sanación del saldo actual del cliente basado en las facturas pendientes
	currentPendingDebt := 0.0
	for _, pSale := range pending {
		currentPendingDebt += pSale.DebtPending
	}

	if client.CurrentCredit != currentPendingDebt {
		client.CurrentCredit = currentPendingDebt
		_ = s.repo.Update(client.DNI, client)
	}

	var cyclePayments []models.CreditPayment
	if len(pending) > 0 {
		oldestDate := pending[0].SaleDate
		for _, p := range allPayments {
			if p.PaymentDate.After(oldestDate) || p.PaymentDate.Equal(oldestDate) {
				cyclePayments = append(cyclePayments, p)
			}
		}
	} else if len(allPayments) > 0 {
		cyclePayments = allPayments
	}

	return &ClientStatement{
		Client:          client,
		Pending:         pending,
		Payments:        cyclePayments,
		HistorySales:    historySales,
		HistoryPayments: allPayments,
	}, nil
}

func (s *ClientService) DeleteCreditPayment(paymentID uint, saleRepo ports.SaleRepository) error {
	payment, err := s.creditRepo.GetByID(paymentID)
	if err != nil {
		return err
	}

	if err := s.creditRepo.Delete(paymentID); err != nil {
		return err
	}

	// Lógica LIFO: Restaurar el monto abonado ÚNICAMENTE en las ventas recientemente reducidas
	amountToRestore := payment.TotalPaid
	sales, err := saleRepo.GetCreditHistoryByClient(payment.ClientDNI)
	if err == nil {
		for i := len(sales) - 1; i >= 0; i-- {
			if amountToRestore <= 0 {
				break
			}
			sale := &sales[i]
			paidOnThisSale := sale.CreditAmount - sale.DebtPending
			if paidOnThisSale <= 0 {
				continue
			}
			restoreForSale := paidOnThisSale
			if amountToRestore < paidOnThisSale {
				restoreForSale = amountToRestore
			}
			newDebt := sale.DebtPending + restoreForSale
			amountToRestore -= restoreForSale
			_ = saleRepo.UpdateDebt(sale.SaleID, newDebt)
		}
	}

	// Recalcular saldo total de deuda del cliente con exactitud basada únicamente en deudas pendientes activas
	client, err := s.repo.GetByDNI(payment.ClientDNI)
	if err == nil {
		updatedPending, err := saleRepo.GetPendingByClient(client.DNI)
		if err == nil {
			newCreditSum := 0.0
			for _, ps := range updatedPending {
				newCreditSum += ps.DebtPending
			}
			client.CurrentCredit = newCreditSum
			_ = s.repo.Update(client.DNI, client)
		}
	}

	cache.InvalidateCache(cache.CacheKeyDashboardOverview)

	return nil
}

func (s *ClientService) PayCredit(payment *models.CreditPayment, saleRepo ports.SaleRepository) (*models.Client, error) {
	client, err := s.repo.GetByDNI(payment.ClientDNI)
	if err != nil {
		return nil, err
	}

	// Actualizar quién hizo el movimiento para evitar errores de FK
	client.UpdatedByDNI = payment.EmployeeDNI

	// Asegurar fecha de pago si no viene definida
	if payment.PaymentDate.IsZero() {
		payment.PaymentDate = time.Now()
	}

	if err := s.creditRepo.Save(payment); err != nil {
		return nil, err
	}

	// Lógica FIFO: Obtener ventas a crédito pendientes ordenadas de más antiguas a más nuevas
	pendingSales, err := saleRepo.GetPendingByClient(client.DNI)
	if err == nil && len(pendingSales) > 0 {
		remainingPayment := payment.TotalPaid
		for _, sale := range pendingSales {
			if remainingPayment <= 0 {
				break
			}
			
			debt := sale.DebtPending
			if debt <= 0 {
				debt = sale.CreditAmount
			}
			if debt <= 0 {
				continue
			}

			newDebt := 0.0
			if remainingPayment >= debt {
				remainingPayment -= debt
				newDebt = 0.0
			} else {
				newDebt = debt - remainingPayment
				remainingPayment = 0.0
			}

			// Actualizar en BD
			_ = saleRepo.UpdateDebt(sale.SaleID, newDebt)
		}
	}

	// Recalcular saldo total de deuda del cliente con exactitud basada en deudas pendientes
	updatedPending, err := saleRepo.GetPendingByClient(client.DNI)
	if err == nil {
		newCreditSum := 0.0
		for _, ps := range updatedPending {
			newCreditSum += ps.DebtPending
		}
		client.CurrentCredit = newCreditSum
		_ = s.repo.Update(client.DNI, client)
	}

	cache.InvalidateCache(cache.CacheKeyDashboardOverview)

	return client, nil
}



func (s *ClientService) CreateClient(client *models.Client) error {
	return s.repo.Save(client)
}

func (s *ClientService) GetClient(dni string) (*models.Client, error) {
	return s.repo.GetByDNI(dni)
}

func (s *ClientService) GetAllClients() ([]models.Client, error) {
	return s.repo.GetAll()
}

func (s *ClientService) UpdateClient(dni string, client *models.Client) error {
	return s.repo.Update(dni, client)
}

func (s *ClientService) DeleteClient(dni string) error {
	return s.repo.Delete(dni)
}

func (s *ClientService) UpdateCreditPaymentMethod(paymentID uint, newMethod string) (*models.CreditPayment, error) {
	payment, err := s.creditRepo.GetByID(paymentID)
	if err != nil {
		return nil, err
	}

	methodUpper := strings.ToUpper(strings.TrimSpace(newMethod))
	if methodUpper == "EFECTIVO" {
		payment.AmountCash = payment.TotalPaid
		payment.AmountTransfer = 0
		payment.TransferSource = ""
	} else {
		payment.AmountCash = 0
		payment.AmountTransfer = payment.TotalPaid
		payment.TransferSource = methodUpper
	}

	if err := s.creditRepo.Update(payment); err != nil {
		return nil, err
	}

	return payment, nil
}

func (s *ClientService) GetCreditPaymentByID(id uint) (*models.CreditPayment, error) {
	return s.creditRepo.GetByID(id)
}
