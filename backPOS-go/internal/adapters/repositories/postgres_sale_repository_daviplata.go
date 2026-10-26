package repositories

import "time"

// DaviplataNetSince devuelve el movimiento neto del bolsillo Daviplata desde
// `since` (inclusive): ventas cobradas por Daviplata + abonos recibidos por
// Daviplata − egresos pagados con Daviplata. Lo usa el dashboard para el
// saldo Daviplata con punto de partida fijo (ver dashboard_service.go,
// DaviplataBaselineAmount). Sólo lectura.
func (r *PostgresSaleRepository) DaviplataNetSince(since time.Time) (float64, error) {
	var sales, collected, paid float64
	if err := r.db.Raw(`
		SELECT COALESCE(SUM(CASE WHEN "transferDaviplata" > 0 THEN "transferDaviplata"
		                         WHEN UPPER(COALESCE("transferSource", '')) IN ('DAVIPLATA', 'DAVI') THEN "transferAmount"
		                         ELSE 0 END), 0)
		FROM sales
		WHERE deleted_at IS NULL AND status IN ('PAID', 'CREDIT', 'FIADO') AND "saleDate" >= ?`, since).
		Scan(&sales).Error; err != nil {
		return 0, err
	}
	if err := r.db.Raw(`
		SELECT COALESCE(SUM("amountTransfer"), 0)
		FROM credit_payments
		WHERE deleted_at IS NULL AND "amountTransfer" > 0
		  AND UPPER(COALESCE("transferSource", '')) IN ('DAVIPLATA', 'DAVI') AND "paymentDate" >= ?`, since).
		Scan(&collected).Error; err != nil {
		return 0, err
	}
	if err := r.db.Raw(`
		SELECT COALESCE(SUM(CASE
		         WHEN daviplata_amount > 0 THEN daviplata_amount
		         WHEN cash_amount = 0 AND nequi_amount = 0 AND fondo_amount = 0 AND coins_amount = 0 AND bold_qr_amount = 0
		              AND UPPER(COALESCE("paymentSource", '')) IN ('DAVIPLATA', 'DAVI') THEN amount + tax_amount
		         ELSE 0 END), 0)
		FROM expenses
		WHERE deleted_at IS NULL AND UPPER(status) = 'PAID'
		  AND UPPER(COALESCE("paymentSource", '')) NOT IN ('PRESTAMO', 'PREST.') AND date >= ?`, since).
		Scan(&paid).Error; err != nil {
		return 0, err
	}
	return sales + collected - paid, nil
}
