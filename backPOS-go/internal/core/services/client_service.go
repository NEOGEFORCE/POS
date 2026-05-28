package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
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

	pending, err := saleRepo.GetPendingByClient(dni)
	if err != nil {
		pending = []models.Sale{}
	}

	// LÓGICA DE CICLO: Si no hay deudas, el estado de cuenta está limpio
	if len(pending) == 0 {
		return &ClientStatement{
			Client:   client,
			Pending:  []models.Sale{},
			Payments: []models.CreditPayment{},
		}, nil
	}

	// Encontrar la fecha de la venta pendiente más antigua para definir el inicio del ciclo
	// Como ahora el repo devuelve en ASC, la más antigua es la primera [0]
	// oldestDate := pending[0].SaleDate

	// Traer todos los abonos realizados desde esa fecha
	allPayments, err := s.creditRepo.GetByClient(dni)
	if err != nil {
		allPayments = []models.CreditPayment{}
	}

	historySales, err := saleRepo.GetCreditHistoryByClient(dni)
	if err != nil {
		historySales = []models.Sale{}
	}

	var cyclePayments []models.CreditPayment
	if len(pending) > 0 {
		oldestDate := pending[0].SaleDate
		for _, p := range allPayments {
			if p.PaymentDate.After(oldestDate) || p.PaymentDate.Equal(oldestDate) {
				cyclePayments = append(cyclePayments, p)
			}
		}
	}

	return &ClientStatement{
		Client:          client,
		Pending:         pending,
		Payments:        cyclePayments,
		HistorySales:    historySales,
		HistoryPayments: allPayments,
	}, nil
}

func (s *ClientService) PayCredit(payment *models.CreditPayment, saleRepo ports.SaleRepository) (*models.Client, error) {
	client, err := s.repo.GetByDNI(payment.ClientDNI)
	if err != nil {
		return nil, err
	}

	client.CurrentCredit -= payment.TotalPaid
	if client.CurrentCredit < 0 {
		client.CurrentCredit = 0
	}

	// Actualizar quién hizo el movimiento para evitar errores de FK
	client.UpdatedByDNI = payment.EmployeeDNI

	if err := s.repo.Update(client.DNI, client); err != nil {
		return nil, err
	}

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
				// Fallback si por alguna razón debtPending es 0 pero está marcado como pendiente
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

	return client, nil
}

func (s *ClientService) DeleteCreditPayment(paymentID uint, saleRepo ports.SaleRepository) error {
	payment, err := s.creditRepo.GetByID(paymentID)
	if err != nil {
		return err
	}

	if err := s.creditRepo.Delete(paymentID); err != nil {
		return err
	}

	client, err := s.repo.GetByDNI(payment.ClientDNI)
	if err == nil {
		client.CurrentCredit += payment.TotalPaid
		s.repo.Update(client.DNI, client)
	}

	sales, err := saleRepo.GetCreditHistoryByClient(payment.ClientDNI)
	if err != nil {
		return err
	}

	payments, err := s.creditRepo.GetByClient(payment.ClientDNI)
	if err != nil {
		return err
	}

	totalAbonos := 0.0
	for _, p := range payments {
		totalAbonos += p.TotalPaid
	}

	for _, sale := range sales {
		originalDebt := sale.CreditAmount
		newDebt := 0.0
		if totalAbonos >= originalDebt {
			totalAbonos -= originalDebt
			newDebt = 0.0
		} else {
			newDebt = originalDebt - totalAbonos
			totalAbonos = 0.0
		}
		_ = saleRepo.UpdateDebt(sale.SaleID, newDebt)
	}

	return nil
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
