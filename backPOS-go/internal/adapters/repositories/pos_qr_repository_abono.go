package repositories

import (
	"context"
	"time"
)

// FindQrAbonoPayment busca un abono ya registrado para un cobro QR de abono:
// mismo cliente, mismo monto, por Daviplata, registrado desde `since` (la
// creación de la intención). Devuelve 0 si no existe. Lo usa el materializador
// para no registrar dos veces el mismo abono si un reintento llega después de
// que el abono ya se guardó. Sólo lectura.
func (r *QrPaymentRepository) FindQrAbonoPayment(ctx context.Context, clientDNI string, amount float64, since time.Time) (uint64, error) {
	var id uint64
	err := r.db.WithContext(ctx).Raw(`
		SELECT id FROM credit_payments
		WHERE deleted_at IS NULL AND "clientDni" = ? AND ABS("totalPaid" - ?) < 0.5
		  AND UPPER(COALESCE("transferSource", '')) = 'DAVIPLATA' AND "paymentDate" >= ?
		ORDER BY id ASC LIMIT 1`, clientDNI, amount, since).Scan(&id).Error
	if err != nil {
		return 0, err
	}
	return id, nil
}
