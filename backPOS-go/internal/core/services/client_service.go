package services

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type ClientService struct {
	repo       ports.ClientRepository
	creditRepo ports.CreditPaymentRepository
}

func NewClientService(repo ports.ClientRepository, cr ports.CreditPaymentRepository) *ClientService {
	return &ClientService{repo: repo, creditRepo: cr}
}

type ClientStatement struct {
	Client          *models.Client         `json:"client"`
	Pending         []models.Sale          `json:"pending"`
	Payments        []models.CreditPayment `json:"payments"`
	HistorySales    []models.Sale          `json:"historySales"`
	HistoryPayments []models.CreditPayment `json:"historyPayments"`
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

	// Esta consulta es deliberadamente de solo lectura. Las inconsistencias de
	// cartera se corrigen dentro de las transacciones de abono/anulación.
	currentPendingDebt := 0.0
	for _, pendingSale := range pending {
		currentPendingDebt += pendingSale.DebtPending
	}
	clientCopy := *client
	clientCopy.CurrentCredit = currentPendingDebt

	cyclePayments := []models.CreditPayment{}
	if len(pending) > 0 {
		oldestDate := pending[0].SaleDate
		for _, payment := range allPayments {
			if !payment.PaymentDate.Before(oldestDate) {
				cyclePayments = append(cyclePayments, payment)
			}
		}
	} else if len(allPayments) > 0 {
		cyclePayments = allPayments
	}
	return &ClientStatement{
		Client: &clientCopy, Pending: pending, Payments: cyclePayments,
		HistorySales: historySales, HistoryPayments: allPayments,
	}, nil
}

func (s *ClientService) DeleteCreditPayment(paymentID uint, saleRepo ports.SaleRepository) error {
	rawDB, ok := saleRepo.GetDB().(*gorm.DB)
	if !ok {
		return errors.New("error de sistema: base de datos inválida")
	}
	var clientDNI string
	err := rawDB.Transaction(func(tx *gorm.DB) error {
		var payment models.CreditPayment
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&payment, paymentID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errors.New("abono no encontrado o ya anulado")
			}
			return fmt.Errorf("error bloqueando abono: %w", err)
		}
		clientDNI = payment.ClientDNI

		var client models.Client
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("dni = ?", clientDNI).First(&client).Error; err != nil {
			return fmt.Errorf("error bloqueando cliente: %w", err)
		}
		var sales []models.Sale
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("\"clientDni\" = ? AND \"creditAmount\" > 0", clientDNI).
			Order("\"saleDate\" ASC, \"saleId\" ASC").Find(&sales).Error; err != nil {
			return fmt.Errorf("error bloqueando ventas a crédito: %w", err)
		}
		if err := tx.Delete(&payment).Error; err != nil {
			return fmt.Errorf("error anulando abono: %w", err)
		}

		var totalPaid float64
		if err := tx.Model(&models.CreditPayment{}).Where("\"clientDni\" = ?", clientDNI).
			Select("COALESCE(SUM(\"totalPaid\"), 0)").Scan(&totalPaid).Error; err != nil {
			return fmt.Errorf("error recalculando pagos: %w", err)
		}
		remainingPaid := totalPaid
		totalDebt := 0.0
		for _, sale := range sales {
			applied := 0.0
			if remainingPaid > 0 {
				applied = sale.CreditAmount
				if remainingPaid < applied {
					applied = remainingPaid
				}
				remainingPaid -= applied
			}
			newDebt := sale.CreditAmount - applied
			totalDebt += newDebt
			if err := tx.Model(&models.Sale{}).Where("\"saleId\" = ?", sale.SaleID).Update("debtPending", newDebt).Error; err != nil {
				return fmt.Errorf("error restaurando deuda de venta #%d: %w", sale.SaleID, err)
			}
		}
		if err := tx.Model(&models.Client{}).Where("dni = ?", clientDNI).Update("currentCredit", totalDebt).Error; err != nil {
			return fmt.Errorf("error restaurando cartera del cliente: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	invalidateClientDebtCaches(clientDNI)
	saleRepo.AfterCommit()
	return nil
}

func (s *ClientService) PayCredit(payment *models.CreditPayment, saleRepo ports.SaleRepository) (*models.Client, error) {
	if payment.TotalPaid <= 0 {
		payment.TotalPaid = payment.AmountCash + payment.AmountTransfer
	}
	if payment.TotalPaid <= 0 {
		return nil, errors.New("el monto del abono debe ser mayor que cero")
	}
	if payment.PaymentDate.IsZero() {
		payment.PaymentDate = time.Now()
	}

	rawDB, ok := saleRepo.GetDB().(*gorm.DB)
	if !ok {
		return nil, errors.New("error de sistema: base de datos inválida")
	}
	var updatedClient models.Client
	err := rawDB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("dni = ?", payment.ClientDNI).First(&updatedClient).Error; err != nil {
			return fmt.Errorf("cliente no encontrado: %w", err)
		}
		var pendingSales []models.Sale
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("\"clientDni\" = ? AND \"debtPending\" > 0", payment.ClientDNI).
			Order("\"saleDate\" ASC, \"saleId\" ASC").Find(&pendingSales).Error; err != nil {
			return fmt.Errorf("error bloqueando cartera: %w", err)
		}
		totalDebt := 0.0
		for _, sale := range pendingSales {
			totalDebt += sale.DebtPending
		}
		if totalDebt <= 0 {
			return errors.New("el cliente no tiene deuda pendiente")
		}
		if payment.TotalPaid > totalDebt+0.001 {
			return fmt.Errorf("el abono %.2f supera la deuda pendiente %.2f", payment.TotalPaid, totalDebt)
		}
		if payment.AmountCash+payment.AmountTransfer <= 0 {
			payment.AmountCash = payment.TotalPaid
		}
		if err := tx.Omit("Client", "Employee").Create(payment).Error; err != nil {
			return fmt.Errorf("error guardando abono: %w", err)
		}

		remaining := payment.TotalPaid
		for _, sale := range pendingSales {
			if remaining <= 0 {
				break
			}
			applied := sale.DebtPending
			if remaining < applied {
				applied = remaining
			}
			newDebt := sale.DebtPending - applied
			remaining -= applied
			if err := tx.Model(&models.Sale{}).Where("\"saleId\" = ?", sale.SaleID).Update("debtPending", newDebt).Error; err != nil {
				return fmt.Errorf("error aplicando abono a venta #%d: %w", sale.SaleID, err)
			}
		}
		updatedClient.CurrentCredit = totalDebt - payment.TotalPaid
		if updatedClient.CurrentCredit < 0 {
			updatedClient.CurrentCredit = 0
		}
		updatedClient.UpdatedByDNI = payment.EmployeeDNI
		if err := tx.Model(&models.Client{}).Where("dni = ?", payment.ClientDNI).Updates(map[string]interface{}{
			"currentCredit": updatedClient.CurrentCredit,
			"updatedByDni":  payment.EmployeeDNI,
		}).Error; err != nil {
			return fmt.Errorf("error actualizando cartera del cliente: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	invalidateClientDebtCaches(payment.ClientDNI)
	saleRepo.AfterCommit()
	return &updatedClient, nil
}

func invalidateClientDebtCaches(dni string) {
	cache.InvalidateCache(cache.CacheKeyClients)
	cache.InvalidateCache(cache.CacheKeyClientCount)
	cache.InvalidateCache(fmt.Sprintf("client_dni_%s", dni))
	cache.InvalidateDashboard()
}

func (s *ClientService) CreateClient(client *models.Client) error     { return s.repo.Save(client) }
func (s *ClientService) GetClient(dni string) (*models.Client, error) { return s.repo.GetByDNI(dni) }
func (s *ClientService) GetAllClients() ([]models.Client, error)      { return s.repo.GetAll() }
func (s *ClientService) UpdateClient(dni string, client *models.Client) error {
	return s.repo.Update(dni, client)
}
func (s *ClientService) DeleteClient(dni string) error { return s.repo.Delete(dni) }

func (s *ClientService) UpdateCreditPaymentMethod(paymentID uint, newMethod string) (*models.CreditPayment, error) {
	payment, err := s.creditRepo.GetByID(paymentID)
	if err != nil {
		return nil, err
	}
	methodUpper := strings.ToUpper(strings.TrimSpace(newMethod))
	if methodUpper == "" {
		return nil, errors.New("método de pago requerido")
	}
	if methodUpper == "EFECTIVO" {
		payment.AmountCash, payment.AmountTransfer, payment.TransferSource = payment.TotalPaid, 0, ""
	} else {
		payment.AmountCash, payment.AmountTransfer, payment.TransferSource = 0, payment.TotalPaid, methodUpper
	}
	if err := s.creditRepo.Update(payment); err != nil {
		return nil, err
	}
	cache.InvalidateDashboard()
	return payment, nil
}

func (s *ClientService) GetCreditPaymentByID(id uint) (*models.CreditPayment, error) {
	return s.creditRepo.GetByID(id)
}
