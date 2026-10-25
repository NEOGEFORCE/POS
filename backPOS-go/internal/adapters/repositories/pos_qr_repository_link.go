package repositories

import (
	"context"
	"errors"
	"time"

	"backPOS-go/internal/core/domain/models"

	"gorm.io/gorm"
)

// =========================================================================
// Enlazar un pago QR sin asignar a una venta YA registrada
// =========================================================================
//
// Caso real (2026-10-24): el cliente pagó por QR Bold, pero la venta quedó
// registrada en EFECTIVO (o el cobro QR se venció). El pago llega como evento
// UNMATCHED y no hay intención viva del mismo monto. Estas consultas ayudan a
// encontrar la venta por monto y hora para que un admin la enlace.
//
// Sólo lectura. La mutación vive en el servicio y reutiliza el flujo canónico
// intención → asignación → materializador (sin migración).

// SaleCandidate es una venta que podría corresponder a un pago QR.
type SaleCandidate struct {
	SaleID         uint      `gorm:"column:sale_id"`
	SaleDate       time.Time `gorm:"column:sale_date"`
	TotalAmount    float64   `gorm:"column:total_amount"`
	CashNet        float64   `gorm:"column:cash_net"`
	TransferAmount float64   `gorm:"column:transfer_amount"`
	CreditAmount   float64   `gorm:"column:credit_amount"`
	PaymentMethod  string    `gorm:"column:payment_method"`
	EmployeeName   string    `gorm:"column:employee_name"`
	ClientName     string    `gorm:"column:client_name"`
}

// GetWebhookEventByID lee un evento por id. ErrQREventNotFound si no existe.
func (r *QrPaymentRepository) GetWebhookEventByID(ctx context.Context, id uint64) (*models.QrWebhookEvent, error) {
	if id == 0 {
		return nil, ErrQRInvalidInput
	}
	var ev models.QrWebhookEvent
	if err := r.db.WithContext(ctx).Where("id = ?", id).First(&ev).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrQREventNotFound
		}
		return nil, err
	}
	return &ev, nil
}

// ListSaleCandidates devuelve ventas vivas (PAID/CREDIT) registradas entre
// `around - window` y `around + window` cuyo EFECTIVO neto (cash - cambio)
// cubre `amount`: es la parte que se pasaría a Bold. Orden: primero las de
// total exacto, luego por cercanía de hora al pago. Máximo `limit` (1..20).
func (r *QrPaymentRepository) ListSaleCandidates(ctx context.Context, amount int64, around time.Time, window time.Duration, limit int) ([]SaleCandidate, error) {
	if amount <= 0 || around.IsZero() || window <= 0 {
		return nil, ErrQRInvalidInput
	}
	if limit <= 0 || limit > 20 {
		limit = 20
	}
	from := around.Add(-window)
	to := around.Add(window)
	var out []SaleCandidate
	err := r.db.WithContext(ctx).Raw(`
		SELECT s."saleId" AS sale_id, s."saleDate" AS sale_date, s."totalAmount" AS total_amount,
		       (COALESCE(s."cashAmount",0) - COALESCE(s."change",0)) AS cash_net,
		       COALESCE(s."transferAmount",0) AS transfer_amount, COALESCE(s."creditAmount",0) AS credit_amount,
		       COALESCE(s."paymentMethod",'') AS payment_method,
		       COALESCE(e.name, '') AS employee_name, COALESCE(c.name, '') AS client_name
		FROM sales s
		LEFT JOIN employees e ON e.dni = s."employeeDni"
		LEFT JOIN clients c ON c.dni = s."clientDni"
		WHERE s.deleted_at IS NULL AND s.status IN ('PAID','CREDIT')
		  AND s."saleDate" BETWEEN ? AND ?
		  AND (COALESCE(s."cashAmount",0) - COALESCE(s."change",0)) >= ?
		ORDER BY (ABS(s."totalAmount" - ?) < 1) DESC,
		         ABS(EXTRACT(EPOCH FROM (s."saleDate" - ?))) ASC
		LIMIT ?`,
		from, to, float64(amount)-1, float64(amount), around, limit).Scan(&out).Error
	if err != nil {
		return nil, err
	}
	return out, nil
}
