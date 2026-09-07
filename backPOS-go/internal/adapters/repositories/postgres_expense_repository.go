package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/refresher"
	"backPOS-go/internal/infrastructure/sse"
	"gorm.io/gorm"
	"log"
	"sort"
	"strings"
	"time"
)

type PostgresExpenseRepository struct {
	db *gorm.DB
}

func NewPostgresExpenseRepository(db *gorm.DB) *PostgresExpenseRepository {
	return &PostgresExpenseRepository{db: db}
}

func (r *PostgresExpenseRepository) invalidateDashboardCache() {
	// Invalidate RAM cache: TODAS las variantes por rango de fechas, no sólo la
	// clave base (que nadie escribe nunca).
	cache.InvalidateDashboard()

	// Solicitar refresco asíncrono y debounced
	refresher.GetRefresherService(r.db).RequestRefresh("mv_dashboard_stats_monthly")

	// Notificar sincronización global
	sse.GetSSEService().BroadcastExpenseUpdate(nil)
}

func (r *PostgresExpenseRepository) Save(expense *models.Expense) error {
	err := r.db.Create(expense).Error
	if err == nil {
		r.invalidateDashboardCache()
	}
	return err
}

// GetAll delega en GetAllFiltered sin filtros para que exista UNA sola
// implementación de "los egresos que ve la pantalla".
//
// Antes tenía su propia consulta con Limit(1000), y como el servicio llama a
// GetAll cuando no hay filtros (que es la carga inicial de la pantalla), era
// justamente la ruta por la que desaparecían las cuentas por pagar viejas.
func (r *PostgresExpenseRepository) GetAll() ([]models.Expense, error) {
	return r.GetAllFiltered("", "")
}

func (r *PostgresExpenseRepository) SaveWithTx(tx interface{}, expense *models.Expense) error {
	gormTx, ok := tx.(*gorm.DB)
	if !ok {
		return gorm.ErrInvalidDB
	}
	return gormTx.Create(expense).Error
}

// pendingDebtCondition es la condición canónica de "deuda viva" (cuenta por
// pagar). Debe coincidir con GetPendingDebtsSummary y con GetExpensesByStatus,
// que son las otras dos puertas al mismo universo.
const pendingDebtCondition = `(UPPER(status) = 'PENDING' OR UPPER("paymentSource") IN ('PRESTAMO', 'PREST.')) AND UPPER(status) NOT IN ('PAID', 'SETTLED')`

// GetAllFiltered devuelve los egresos que alimentan la pantalla de Egresos.
//
// POR QUÉ SON DOS CONSULTAS Y NO UNA:
//
// La lista principal está acotada a las 1000 filas más recientes por fecha,
// porque el historial completo de egresos crece sin techo y la pantalla no
// necesita años de movimientos para operar.
//
// Pero ese LIMIT hacía DESAPARECER cuentas por pagar. La pantalla suma la
// tarjeta "Cuentas por Pagar" sobre las filas que recibe, así que una factura
// fiada más vieja que la fila 1000 quedaba fuera del total aunque siguiera
// viva en la base. Con el ritmo de egresos diarios del negocio la ventana
// avanza sola, y las deudas viejas se caían por atrás: el total bajaba día a
// día sin que nadie tocara esas facturas.
//
// Por eso las deudas vivas se traen SIN LÍMITE en una segunda consulta y se
// mezclan sin duplicar. Es un conjunto chico (lo que realmente se debe), así
// que no reintroduce el problema de tamaño que motivó el LIMIT.
func (r *PostgresExpenseRepository) GetAllFiltered(supplier, concept string) ([]models.Expense, error) {
	applyFilters := func(q *gorm.DB) *gorm.DB {
		if supplier != "" {
			// Filtro por nombre de proveedor vía join; expenses.supplier_id es la FK.
			q = q.Joins("LEFT JOIN suppliers ON suppliers.id = expenses.supplier_id").
				Where("suppliers.name ILIKE ?", "%"+supplier+"%")
		}
		if concept != "" {
			q = q.Where("description ILIKE ?", "%"+concept+"%")
		}
		return q
	}

	// 1) Ventana reciente: lo que la pantalla muestra en la tabla y usa para
	//    los totales del período.
	recent := []models.Expense{}
	if err := applyFilters(r.db.Preload("Creator").Model(&models.Expense{})).
		Order("date DESC").Limit(1000).Find(&recent).Error; err != nil {
		return nil, err
	}

	// 2) Deudas vivas COMPLETAS: ninguna cuenta por pagar puede quedar invisible.
	debts := []models.Expense{}
	if err := applyFilters(r.db.Preload("Creator").Model(&models.Expense{})).
		Where(pendingDebtCondition).
		Order("date DESC").Find(&debts).Error; err != nil {
		return nil, err
	}

	// Mezclar sin duplicar: las deudas recientes ya vienen en la ventana.
	seen := make(map[uint]struct{}, len(recent)+len(debts))
	merged := make([]models.Expense, 0, len(recent)+len(debts))
	for i := range recent {
		if _, dup := seen[recent[i].ID]; dup {
			continue
		}
		seen[recent[i].ID] = struct{}{}
		merged = append(merged, recent[i])
	}
	for i := range debts {
		if _, dup := seen[debts[i].ID]; dup {
			continue
		}
		seen[debts[i].ID] = struct{}{}
		merged = append(merged, debts[i])
	}

	// Orden estable por fecha descendente para que la tabla no cambie de forma.
	sort.SliceStable(merged, func(a, b int) bool {
		return merged[a].Date.After(merged[b].Date)
	})

	return merged, nil
}

func (r *PostgresExpenseRepository) GetExpensesPaginated(filter ports.ExpenseFilter) ([]models.Expense, int64, error) {
	var expenses []models.Expense
	var total int64

	query := r.db.Model(&models.Expense{})

	if filter.Supplier != "" {
		query = query.Joins("LEFT JOIN suppliers ON suppliers.id = expenses.supplier_id").
			Where("suppliers.name ILIKE ?", "%"+filter.Supplier+"%")
	}

	if filter.Concept != "" {
		query = query.Where("description ILIKE ?", "%"+filter.Concept+"%")
	}

	err := query.Count(&total).Error
	if err != nil {
		return nil, 0, err
	}

	offset := (filter.Page - 1) * filter.PageSize
	err = query.Preload("Creator").Order("date DESC").Offset(offset).Limit(filter.PageSize).Find(&expenses).Error

	return expenses, total, err
}

func (r *PostgresExpenseRepository) GetByID(id uint) (*models.Expense, error) {
	var expense models.Expense
	err := r.db.Preload("Creator").First(&expense, id).Error
	return &expense, err
}

func (r *PostgresExpenseRepository) GetByDateRange(from, to time.Time) ([]models.Expense, error) {
	expenses := []models.Expense{}
	query := r.db.Model(&models.Expense{})
	if !from.IsZero() {
		query = query.Where("date >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("date <= ?", to)
	}
	err := query.Order("date DESC").Find(&expenses).Error
	return expenses, err
}

func (r *PostgresExpenseRepository) GetPendingRestockExpensesBySupplier(supplierID uint) ([]models.Expense, error) {
	expenses := []models.Expense{}
	err := r.db.Preload("Creator").Where("category = ?", "Proveedores").Where("supplier_id = ?", supplierID).Where("is_restocked = ?", false).Order("date DESC").Find(&expenses).Error
	return expenses, err
}

func (r *PostgresExpenseRepository) Delete(id uint) error {
	return r.db.Delete(&models.Expense{}, id).Error
}

func (r *PostgresExpenseRepository) Count() (int64, error) {
	var count int64
	err := r.db.Model(&models.Expense{}).Count(&count).Error
	return count, err
}

func (r *PostgresExpenseRepository) Update(id uint, expense *models.Expense) error {
	// Usamos un mapa explícito para que los campos en cero también se actualicen.
	// Con Updates(struct) GORM ignora los campos con valor cero, causando que los
	// canales anteriores (ej. cashAmount) no se limpien al cambiar a otro canal.
	updates := map[string]interface{}{
		"description":   expense.Description,
		"amount":        expense.Amount,
		"tax_amount":    expense.TaxAmount,
		"date":          expense.Date,
		"paymentSource": expense.PaymentSource,
		"category":      expense.Category,
		"status":        expense.Status,
		"supplier_id":   expense.SupplierID,
		"lenderName":    expense.LenderName,
		// Montos por canal — se fuerzan a cero si no aplican
		"cash_amount":      expense.CashAmount,
		"nequi_amount":     expense.NequiAmount,
		"daviplata_amount": expense.DaviplataAmount,
		"fondo_amount":     expense.FondoAmount,
		"coins_amount":     expense.CoinsAmount,
		"paid_amount":      expense.PaidAmount,
		"remaining_amount": expense.RemainingAmount,
	}
	err := r.db.Model(&models.Expense{}).Where("id = ?", id).Updates(updates).Error
	if err == nil {
		r.invalidateDashboardCache()
	}
	return err
}

func (r *PostgresExpenseRepository) Settle(id uint, paymentSource string) error {
	err := r.db.Model(&models.Expense{}).
		Where("id = ?", id).
		Updates(map[string]interface{}{
			"status":        "PAID",
			"paymentSource": paymentSource,
		}).Error
	if err == nil {
		r.invalidateDashboardCache()
	}
	return err
}
func (r *PostgresExpenseRepository) GetMonthlyTotals() (map[string]float64, error) {
	results := make(map[string]float64)
	rows, err := r.db.Table("expenses").
		Select("TO_CHAR(date, 'YYYY-MM') as month, COALESCE(SUM(amount + tax_amount), 0) as total").
		Group("month").
		Rows()
	if err != nil {
		log.Printf("❌ [GetMonthlyTotals Expenses] Error: %v", err)
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var month string
		var total float64
		if err := rows.Scan(&month, &total); err != nil {
			return nil, err
		}
		results[month] = total
	}
	return results, nil
}
func (r *PostgresExpenseRepository) GetPendingDebtsSummary() (float64, int64, error) {
	var result struct {
		Amount float64
		Count  int64
	}
	err := r.db.Model(&models.Expense{}).
		Where("(UPPER(status) = ? OR UPPER(\"paymentSource\") IN ('PRESTAMO', 'PREST.')) AND UPPER(status) NOT IN ('PAID', 'SETTLED')", "PENDING").
		Select("COALESCE(SUM(CASE WHEN remaining_amount > 0 THEN remaining_amount ELSE amount END + tax_amount), 0) as amount, COUNT(*) as count").
		Scan(&result).Error
	return result.Amount, result.Count, err
}

func (r *PostgresExpenseRepository) GetExpensesByStatus(status string) ([]models.Expense, error) {
	expenses := []models.Expense{}
	// If searching for PENDING, also include PRESTAMO/PREST. sources but EXCLUDE already PAID or SETTLED ones
	if strings.ToUpper(status) == "PENDING" {
		err := r.db.Where("(UPPER(status) = ? OR UPPER(\"paymentSource\") IN ('PRESTAMO', 'PREST.')) AND UPPER(status) NOT IN ('PAID', 'SETTLED')", "PENDING").
			Order("date DESC").Find(&expenses).Error
		return expenses, err
	}
	err := r.db.Where("UPPER(status) = ?", strings.ToUpper(status)).Order("date DESC").Find(&expenses).Error
	return expenses, err
}
func (r *PostgresExpenseRepository) GetGlobalTotalPaidExpenses() (float64, error) {
	var total float64
	err := r.db.Model(&models.Expense{}).
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(\"paymentSource\") NOT IN ('PRESTAMO', 'PREST.')").
		Select("COALESCE(SUM(amount + tax_amount), 0)").Scan(&total).Error
	if err != nil {
		log.Printf("❌ [GetGlobalTotalPaidExpenses] Error: %v", err)
		return 0, nil
	}
	return total, nil
}

// addCoinsResidual rescata la parte de un egreso pagada con monedas que quedó
// fuera de las columnas desglosadas.
//
// Hay egresos creados por versiones anteriores que sí tienen cash_amount y
// fondo_amount, pero dejaron coins_amount en cero aunque el texto del canal diga
// "ALCANCIA: $50000". Esas filas entran por la consulta de columnas (tienen
// alguna > 0), así que el fallback por texto no las mira nunca y la parte pagada
// con monedas se perdía: no se descontaba de la alcancía en ningún lado.
//
// Se recupera sólo el resto no cubierto por las columnas y sólo en filas cuyo
// texto menciona monedas. Si las columnas ya están completas, el resto es cero y
// esto no cambia ninguna cifra.
func (r *PostgresExpenseRepository) addCoinsResidual(results map[string]float64, from, to *time.Time) {
	query := r.db.Table("expenses").
		Select(`COALESCE(SUM(
			(amount + COALESCE(tax_amount, 0))
			- (COALESCE(cash_amount,0) + COALESCE(nequi_amount,0)
			   + COALESCE(daviplata_amount,0) + COALESCE(fondo_amount,0)
			   + COALESCE(coins_amount,0))
		), 0)`).
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(COALESCE(\"paymentSource\", '')) NOT IN ('PRESTAMO', 'PREST.')").
		Where("(cash_amount > 0 OR nequi_amount > 0 OR daviplata_amount > 0 OR fondo_amount > 0 OR coins_amount > 0)").
		Where(`(amount + COALESCE(tax_amount,0)) >
			(COALESCE(cash_amount,0) + COALESCE(nequi_amount,0)
			 + COALESCE(daviplata_amount,0) + COALESCE(fondo_amount,0)
			 + COALESCE(coins_amount,0))`).
		Where(`(UPPER(COALESCE("paymentSource", '')) LIKE '%ALCANCIA%'
			OR UPPER(COALESCE("paymentSource", '')) LIKE '%ALCANCÍA%'
			OR UPPER(COALESCE("paymentSource", '')) LIKE '%MONEDA%')`)

	if from != nil && to != nil {
		query = query.Where("date >= ? AND date <= ?", *from, *to)
	}

	var residual float64
	if err := query.Scan(&residual).Error; err != nil {
		return
	}
	if residual > 0 {
		results["MONEDAS"] += residual
	}
}

func (r *PostgresExpenseRepository) GetGlobalPaidExpensesByMethod() (map[string]float64, error) {
	results := make(map[string]float64)

	// Primero: Egresos que tienen columnas desglosadas (cash_amount, nequi_amount, etc.)
	type MethodTotal struct {
		TotalCash      float64
		TotalNequi     float64
		TotalDaviplata float64
		TotalFondo     float64
		TotalCoins     float64
	}
	var mt MethodTotal
	err := r.db.Table("expenses").
		Select(`
			COALESCE(SUM(cash_amount), 0) as total_cash,
			COALESCE(SUM(nequi_amount), 0) as total_nequi,
			COALESCE(SUM(daviplata_amount), 0) as total_daviplata,
			COALESCE(SUM(fondo_amount), 0) as total_fondo,
			COALESCE(SUM(coins_amount), 0) as total_coins
		`).
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(COALESCE(\"paymentSource\", '')) NOT IN ('PRESTAMO', 'PREST.')").
		Where("(cash_amount > 0 OR nequi_amount > 0 OR daviplata_amount > 0 OR fondo_amount > 0 OR coins_amount > 0)").
		Scan(&mt).Error
	if err != nil {
		log.Printf("❌ [GetGlobalPaidExpensesByMethod] Error columnas desglosadas: %v", err)
	} else {
		results["EFECTIVO"] += mt.TotalCash
		results["NEQUI"] += mt.TotalNequi
		results["DAVIPLATA"] += mt.TotalDaviplata
		results["FONDO"] += mt.TotalFondo
		results["MONEDAS"] += mt.TotalCoins
	}

	// Segundo: Egresos legacy que NO tienen columnas desglosadas (usan paymentSource string)
	rows, err := r.db.Table("expenses").
		Select("COALESCE(\"paymentSource\", 'EFECTIVO'), COALESCE(SUM(amount + tax_amount), 0) as total").
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(COALESCE(\"paymentSource\", '')) NOT IN ('PRESTAMO', 'PREST.')").
		Where("cash_amount = 0 AND nequi_amount = 0 AND daviplata_amount = 0 AND fondo_amount = 0 AND coins_amount = 0").
		Group("\"paymentSource\"").
		Rows()
	if err != nil {
		log.Printf("❌ [GetGlobalPaidExpensesByMethod] Error legacy: %v", err)
		return results, nil
	}
	defer rows.Close()

	for rows.Next() {
		var source string
		var total float64
		if err := rows.Scan(&source, &total); err != nil {
			continue
		}
		if source == "" {
			source = "EFECTIVO"
		}
		srcUpper := strings.ToUpper(strings.TrimSpace(source))
		if strings.Contains(srcUpper, "MONEDA") || strings.Contains(srcUpper, "ALCANCIA") || strings.Contains(srcUpper, "ALCANCÍA") {
			results["MONEDAS"] += total
		} else {
			results[srcUpper] += total
		}
	}

	// Agregar impuestos de nequi (4x1000) que se guardan en tax_amount
	var totalNequiTax float64
	r.db.Table("expenses").
		Select("COALESCE(SUM(tax_amount), 0)").
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("nequi_amount > 0 AND tax_amount > 0").
		Scan(&totalNequiTax)
	results["NEQUI"] += totalNequiTax

	r.addCoinsResidual(results, nil, nil)

	return results, nil
}

func (r *PostgresExpenseRepository) GetPaidAmountByRange(from, to time.Time) (float64, error) {
	var total float64
	err := r.db.Model(&models.Expense{}).
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(\"paymentSource\") NOT IN ('PRESTAMO', 'PREST.')").
		Where("date >= ? AND date <= ?", from, to).
		Select("COALESCE(SUM(amount + tax_amount), 0)").Scan(&total).Error
	if err != nil {
		log.Printf("❌ [GetPaidAmountByRange] Error: %v", err)
		return 0, nil // Fallback a 0
	}
	return total, nil
}
func (r *PostgresExpenseRepository) GetTotalAmountByDateRange(from, to time.Time) (float64, error) {
	var total float64
	err := r.db.Model(&models.Expense{}).
		Where("date >= ? AND date <= ?", from, to).
		Select("COALESCE(SUM(amount + tax_amount), 0)").
		Scan(&total).Error
	if err != nil {
		return 0, err
	}
	return total, nil
}

func (r *PostgresExpenseRepository) GetGlobalPaidExpensesByMethodInRange(from, to time.Time) (map[string]float64, error) {
	results := make(map[string]float64)

	// Primero: Egresos con columnas desglosadas (cash_amount, nequi_amount, daviplata_amount, fondo_amount, coins_amount)
	type MethodTotal struct {
		TotalCash      float64
		TotalNequi     float64
		TotalDaviplata float64
		TotalFondo     float64
		TotalCoins     float64
	}
	var mt MethodTotal
	err := r.db.Table("expenses").
		Select(`
			COALESCE(SUM(cash_amount), 0) as total_cash,
			COALESCE(SUM(nequi_amount), 0) as total_nequi,
			COALESCE(SUM(daviplata_amount), 0) as total_daviplata,
			COALESCE(SUM(fondo_amount), 0) as total_fondo,
			COALESCE(SUM(coins_amount), 0) as total_coins
		`).
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(COALESCE(\"paymentSource\", '')) NOT IN ('PRESTAMO', 'PREST.')").
		Where("date >= ? AND date <= ?", from, to).
		Where("(cash_amount > 0 OR nequi_amount > 0 OR daviplata_amount > 0 OR fondo_amount > 0 OR coins_amount > 0)").
		Scan(&mt).Error
	if err == nil {
		results["EFECTIVO"] += mt.TotalCash
		results["NEQUI"] += mt.TotalNequi
		results["DAVIPLATA"] += mt.TotalDaviplata
		results["FONDO"] += mt.TotalFondo
		results["MONEDAS"] += mt.TotalCoins
	}

	// Segundo: Egresos legacy que NO tienen columnas desglosadas (usan paymentSource string)
	rows, err := r.db.Table("expenses").
		Select("COALESCE(\"paymentSource\", 'EFECTIVO'), COALESCE(SUM(amount + tax_amount), 0) as total").
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(COALESCE(\"paymentSource\", '')) NOT IN ('PRESTAMO', 'PREST.')").
		Where("date >= ? AND date <= ?", from, to).
		Where("cash_amount = 0 AND nequi_amount = 0 AND daviplata_amount = 0 AND fondo_amount = 0 AND coins_amount = 0").
		Group("\"paymentSource\"").
		Rows()
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var source string
			var total float64
			if err := rows.Scan(&source, &total); err == nil {
				srcUpper := strings.ToUpper(strings.TrimSpace(source))
				if strings.Contains(srcUpper, "MONEDA") || strings.Contains(srcUpper, "ALCANCIA") || strings.Contains(srcUpper, "ALCANCÍA") {
					results["MONEDAS"] += total
				} else if strings.Contains(srcUpper, "FONDO") || strings.Contains(srcUpper, "BOVEDA") || strings.Contains(srcUpper, "BÓVEDA") {
					results["FONDO"] += total
				} else if strings.Contains(srcUpper, "NEQUI") {
					results["NEQUI"] += total
				} else if strings.Contains(srcUpper, "DAVIPLATA") {
					results["DAVIPLATA"] += total
				} else {
					results[srcUpper] += total
				}
			}
		}
	}

	// Agregar impuestos de nequi (4x1000) que se guardan en tax_amount
	var totalNequiTax float64
	r.db.Table("expenses").
		Select("COALESCE(SUM(tax_amount), 0)").
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("date >= ? AND date <= ?", from, to).
		Where("nequi_amount > 0 AND tax_amount > 0").
		Scan(&totalNequiTax)
	results["NEQUI"] += totalNequiTax

	r.addCoinsResidual(results, &from, &to)

	return results, nil
}
