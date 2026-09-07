package ports

import "backPOS-go/internal/core/domain/models"

type ClientRepository interface {
	Save(client *models.Client) error
	GetByDNI(dni string) (*models.Client, error)
	GetAll() ([]models.Client, error)
	Update(dni string, client *models.Client) error
	Delete(dni string) error
	Count() (int64, error)
	// SumLiveDebt suma la cartera VIVA de clientes en SQL.
	//
	// "Viva" es la misma definición que ya usaban working_capital.go y
	// export_service.go: sólo los saldos positivos de clients."currentCredit".
	// Un saldo negativo es plata a favor del cliente, no cartera por cobrar, y
	// no debe restarse del total.
	SumLiveDebt() (float64, error)
}
