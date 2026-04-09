package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

type ClientService struct {
	repo       ports.ClientRepository
	creditRepo ports.CreditPaymentRepository
}

func NewClientService(repo ports.ClientRepository, cr ports.CreditPaymentRepository) *ClientService {
	return &ClientService{repo: repo, creditRepo: cr}
}

func (s *ClientService) PayCredit(payment *models.CreditPayment) error {
	client, err := s.repo.GetByDNI(payment.ClientDNI)
	if err != nil {
		return err
	}

	client.CurrentCredit -= payment.TotalPaid
	if client.CurrentCredit < 0 {
		// Opcional: Permitir saldo a favor o truncar a 0
		client.CurrentCredit = 0
	}

	if err := s.repo.Update(client.DNI, client); err != nil {
		return err
	}

	return s.creditRepo.Save(payment)
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
