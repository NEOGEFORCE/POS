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
	Client   *models.Client          `json:"client"`
	Pending  []models.Sale           `json:"pending"`
	Payments []models.CreditPayment `json:"payments"`
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
	oldestDate := pending[0].SaleDate

	// Traer todos los abonos realizados desde esa fecha
	allPayments, err := s.creditRepo.GetByClient(dni)
	if err != nil {
		allPayments = []models.CreditPayment{}
	}

	var cyclePayments []models.CreditPayment
	for _, p := range allPayments {
		if p.PaymentDate.After(oldestDate) || p.PaymentDate.Equal(oldestDate) {
			cyclePayments = append(cyclePayments, p)
		}
	}

	return &ClientStatement{
		Client:   client,
		Pending:  pending,
		Payments: cyclePayments,
	}, nil
}

func (s *ClientService) PayCredit(payment *models.CreditPayment) (*models.Client, error) {
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
