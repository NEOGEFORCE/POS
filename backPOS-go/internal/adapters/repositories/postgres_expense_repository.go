package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/refresher"
	"backPOS-go/internal/infrastructure/sse"
	"errors"
	"fmt"
	"log"
	"math"
	"sort"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
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
	return expensesByDateRange(r.db, from, to)
}

// GetByDateRangeWithTx es GetByDateRange sobre una tx abierta: ve las filas
// insertadas en esa misma tx antes del COMMIT.
func (r *PostgresExpenseRepository) GetByDateRangeWithTx(tx interface{}, from, to time.Time) ([]models.Expense, error) {
	gormTx, ok := tx.(*gorm.DB)
	if !ok {
		return nil, gorm.ErrInvalidDB
	}
	return expensesByDateRange(gormTx, from, to)
}

func expensesByDateRange(db *gorm.DB, from, to time.Time) ([]models.Expense, error) {
	expenses := []models.Expense{}
	query := db.Model(&models.Expense{})
	if !from.IsZero() {
		query = query.Where("date >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("date <= ?", to)
	}
	err := query.Order("date DESC").Find(&expenses).Error
	return expenses, err
}

// GetByReferenceIDs trae los egresos cuyo reference_id figura en el slice,
// con Preload del proveedor. Se usa como fuente de verdad del nombre del
// proveedor cuando el metadato JSON del kardex esta vacio (recepciones
// viejas) o cuando se quiere auditar que una recepcion genero su egreso.
//
// Retorna [] silenciosamente si el slice viene vacio para evitar un
// "WHERE reference_id IN ()" que algunas versiones de Postgres rechazan.
func (r *PostgresExpenseRepository) GetByReferenceIDs(refs []string) ([]models.Expense, error) {
	expenses := []models.Expense{}
	if len(refs) == 0 {
		return expenses, nil
	}
	err := r.db.
		Preload("Supplier").
		Where("reference_id IN ?", refs).
		Order("date DESC").
		Find(&expenses).Error
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

// DeleteWithLoanReversal elimina lógicamente un egreso y, si ese egreso es
// la contrapartida PAID+PRESTAMO creada por PayExpenseAtomic, revierte en la
// MISMA transacción los demás efectos financieros:
//   - resta amount_used de paid_amount y lo devuelve a remaining_amount;
//   - restaura el status de deuda (normalmente PENDING);
//   - marca loan_expenses.reversed_at para que deje de consumir principal;
//   - soft-delete del expense de pago.
//
// El orden de locks serializa con PayExpenseAtomic: loan -> deuda. El expense
// de pago y la fila loan_expenses se bloquean antes porque identifican cuál
// préstamo/deuda tocar. Un error en cualquier paso hace rollback total.
func (r *PostgresExpenseRepository) DeleteWithLoanReversal(id uint, actorDNI string) (*ports.ExpenseDeleteResult, error) {
	if id == 0 {
		return nil, errors.New("expense id requerido")
	}
	actor := strings.ToUpper(strings.TrimSpace(actorDNI))
	if actor == "" {
		return nil, errors.New("actor requerido para eliminar egreso")
	}

	result := &ports.ExpenseDeleteResult{ExpenseID: id}
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var payment models.Expense
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", id).First(&payment).Error; err != nil {
			return err
		}

		var usage models.LoanExpense
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("expense_id = ? AND reversed_at IS NULL", id).
			First(&usage).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// Egreso normal: conserva el comportamiento histórico.
			return tx.Delete(&payment).Error
		}
		if err != nil {
			return err
		}

		if !models.IsLoanFundedExpense(&payment) {
			return fmt.Errorf("loan_expense %d apunta a un egreso que no es PRESTAMO", usage.ID)
		}

		// Mismo primer lock que PayExpenseAtomic/RegisterLoanExpense: evita que
		// un uso concurrente calcule el disponible mientras reversamos éste.
		var loan models.Loan
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", usage.LoanID).First(&loan).Error; err != nil {
			return fmt.Errorf("lock préstamo %d: %w", usage.LoanID, err)
		}

		amountCents := int64(math.Round(usage.AmountUsed * 100))
		if amountCents <= 0 {
			return fmt.Errorf("loan_expense %d tiene amount_used inválido", usage.ID)
		}

		if usage.SourceExpenseID != nil && *usage.SourceExpenseID > 0 {
			var debt models.Expense
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("id = ?", *usage.SourceExpenseID).First(&debt).Error; err != nil {
				return fmt.Errorf("deuda original %d no disponible: %w", *usage.SourceExpenseID, err)
			}

			paidCents := int64(math.Round(debt.PaidAmount * 100))
			remainingCents := int64(math.Round(debt.RemainingAmount * 100))
			newPaidCents := paidCents - amountCents
			if newPaidCents < 0 {
				newPaidCents = 0
			}
			newRemainingCents := remainingCents + amountCents

			// Si no hubo otro abono posterior, los snapshots permiten volver
			// exactamente al estado anterior, incluso para deuda legacy cuyo
			// remaining_amount era 0 y se derivó de amount-paid.
			status := "PENDING"
			if usage.SourceStatusBefore != nil {
				status = *usage.SourceStatusBefore
			}
			if strings.EqualFold(status, "PAID") || strings.EqualFold(status, "SETTLED") {
				status = "PENDING"
			}
			if usage.SourcePaidBefore != nil && usage.SourceRemainingBefore != nil {
				beforePaid := int64(math.Round(*usage.SourcePaidBefore * 100))
				beforeRemaining := int64(math.Round(*usage.SourceRemainingBefore * 100))
				expectedPaidAfter := beforePaid + amountCents
				expectedRemainingAfter := beforeRemaining - amountCents
				if expectedRemainingAfter < 0 {
					expectedRemainingAfter = 0
				}
				if paidCents == expectedPaidAfter && remainingCents == expectedRemainingAfter {
					newPaidCents = beforePaid
					newRemainingCents = beforeRemaining
				}
			}

			if err := tx.Model(&models.Expense{}).Where("id = ?", debt.ID).Updates(map[string]interface{}{
				"paid_amount":      float64(newPaidCents) / 100.0,
				"remaining_amount": float64(newRemainingCents) / 100.0,
				"status":           status,
			}).Error; err != nil {
				return fmt.Errorf("restaurar deuda original: %w", err)
			}
			result.RestoredDebtID = usage.SourceExpenseID
			result.RestoredAmount = float64(amountCents) / 100.0
		}

		now := time.Now()
		if err := tx.Model(&models.LoanExpense{}).Where("id = ? AND reversed_at IS NULL", usage.ID).Updates(map[string]interface{}{
			"reversed_at":     now,
			"reversed_by_dni": actor,
		}).Error; err != nil {
			return fmt.Errorf("marcar uso de préstamo reversado: %w", err)
		}
		if err := tx.Delete(&payment).Error; err != nil {
			return fmt.Errorf("eliminar egreso de pago: %w", err)
		}

		result.LoanReversed = true
		result.ReleasedPrincipal = float64(amountCents) / 100.0
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
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
		// Migración 028: Bold QR es un bolsillo físico. Si Update no
		// escribiera esta columna, un egreso editado perdería la parte
		// Bold y los agregadores lo contarían bajo EFECTIVO por el
		// fallback.
		"bold_qr_amount":   expense.BoldQrAmount,
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
		// Excluir egresos pagados con PRÉSTAMO (opción "pagar con
		// préstamo"): no son egresos operativos del mes, el gasto real
		// contra caja aparece cuando se paga la cuota. Mantener alineado
		// con el resto de getters (GetGlobalTotalPaidExpenses, etc.) y con
		// el helper único models.LoanFundedExpenseSQLPredicate.
		Where("NOT (" + models.LoanFundedExpenseSQLPredicate + ")").
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
			   + COALESCE(coins_amount,0) + COALESCE(bold_qr_amount,0))
		), 0)`).
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(COALESCE(\"paymentSource\", '')) NOT IN ('PRESTAMO', 'PREST.')").
		Where("(cash_amount > 0 OR nequi_amount > 0 OR daviplata_amount > 0 OR fondo_amount > 0 OR coins_amount > 0 OR bold_qr_amount > 0)").
		Where(`(amount + COALESCE(tax_amount,0)) >
			(COALESCE(cash_amount,0) + COALESCE(nequi_amount,0)
			 + COALESCE(daviplata_amount,0) + COALESCE(fondo_amount,0)
			 + COALESCE(coins_amount,0) + COALESCE(bold_qr_amount,0))`).
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

	// Primero: Egresos que tienen columnas desglosadas (cash_amount, nequi_amount, bold_qr_amount, etc.)
	//
	// Migración 028 agregó `bold_qr_amount` como sexto bolsillo físico.
	// Se incluye en la rama de columnas y en el filtro de "tiene algún
	// desglose"; de lo contrario, un egreso MIXTO con BOLD_QR (p. ej.
	// `NEQUI $20.000 + BOLD_QR $10.000`) caería en la rama legacy y se
	// contaría una segunda vez bajo `UPPER(paymentSource)`.
	type MethodTotal struct {
		TotalCash      float64
		TotalNequi     float64
		TotalDaviplata float64
		TotalFondo     float64
		TotalCoins     float64
		TotalBold      float64
	}
	var mt MethodTotal
	err := r.db.Table("expenses").
		Select(`
			COALESCE(SUM(cash_amount), 0) as total_cash,
			COALESCE(SUM(nequi_amount), 0) as total_nequi,
			COALESCE(SUM(daviplata_amount), 0) as total_daviplata,
			COALESCE(SUM(fondo_amount), 0) as total_fondo,
			COALESCE(SUM(coins_amount), 0) as total_coins,
			COALESCE(SUM(bold_qr_amount), 0) as total_bold
		`).
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(COALESCE(\"paymentSource\", '')) NOT IN ('PRESTAMO', 'PREST.')").
		Where("(cash_amount > 0 OR nequi_amount > 0 OR daviplata_amount > 0 OR fondo_amount > 0 OR coins_amount > 0 OR bold_qr_amount > 0)").
		Scan(&mt).Error
	if err != nil {
		log.Printf("❌ [GetGlobalPaidExpensesByMethod] Error columnas desglosadas: %v", err)
	} else {
		results["EFECTIVO"] += mt.TotalCash
		results["NEQUI"] += mt.TotalNequi
		results["DAVIPLATA"] += mt.TotalDaviplata
		results["FONDO"] += mt.TotalFondo
		results["MONEDAS"] += mt.TotalCoins
		results["BOLD_QR"] += mt.TotalBold
	}

	// Segundo: Egresos legacy que NO tienen columnas desglosadas (usan paymentSource string).
	// Mantiene BOLD_QR en la rama por texto para filas pre-028 que todavía
	// no hayan sido backfilleadas o actualizadas (el filtro
	// `bold_qr_amount = 0` evita doble conteo con el bloque de arriba).
	rows, err := r.db.Table("expenses").
		Select("COALESCE(\"paymentSource\", 'EFECTIVO'), COALESCE(SUM(amount + tax_amount), 0) as total").
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(COALESCE(\"paymentSource\", '')) NOT IN ('PRESTAMO', 'PREST.')").
		Where("cash_amount = 0 AND nequi_amount = 0 AND daviplata_amount = 0 AND fondo_amount = 0 AND coins_amount = 0 AND bold_qr_amount = 0").
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
		// Mantener fuera a los egresos pagados con PRÉSTAMO: la plata no
		// salió aún de ningún canal. Centinela: LoanFundedExpenseSQLPredicate.
		Where("NOT (" + models.LoanFundedExpenseSQLPredicate + ")").
		Select("COALESCE(SUM(amount + tax_amount), 0)").
		Scan(&total).Error
	if err != nil {
		return 0, err
	}
	return total, nil
}

func (r *PostgresExpenseRepository) GetGlobalPaidExpensesByMethodInRange(from, to time.Time) (map[string]float64, error) {
	results := make(map[string]float64)

	// Primero: Egresos con columnas desglosadas (cash_amount, nequi_amount,
	// daviplata_amount, fondo_amount, coins_amount, bold_qr_amount — este
	// último agregado por la migración 028).
	type MethodTotal struct {
		TotalCash      float64
		TotalNequi     float64
		TotalDaviplata float64
		TotalFondo     float64
		TotalCoins     float64
		TotalBold      float64
	}
	var mt MethodTotal
	err := r.db.Table("expenses").
		Select(`
			COALESCE(SUM(cash_amount), 0) as total_cash,
			COALESCE(SUM(nequi_amount), 0) as total_nequi,
			COALESCE(SUM(daviplata_amount), 0) as total_daviplata,
			COALESCE(SUM(fondo_amount), 0) as total_fondo,
			COALESCE(SUM(coins_amount), 0) as total_coins,
			COALESCE(SUM(bold_qr_amount), 0) as total_bold
		`).
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(COALESCE(\"paymentSource\", '')) NOT IN ('PRESTAMO', 'PREST.')").
		Where("date >= ? AND date <= ?", from, to).
		Where("(cash_amount > 0 OR nequi_amount > 0 OR daviplata_amount > 0 OR fondo_amount > 0 OR coins_amount > 0 OR bold_qr_amount > 0)").
		Scan(&mt).Error
	if err == nil {
		results["EFECTIVO"] += mt.TotalCash
		results["NEQUI"] += mt.TotalNequi
		results["DAVIPLATA"] += mt.TotalDaviplata
		results["FONDO"] += mt.TotalFondo
		results["MONEDAS"] += mt.TotalCoins
		results["BOLD_QR"] += mt.TotalBold
	}

	// Segundo: Egresos legacy que NO tienen columnas desglosadas (usan paymentSource string).
	// Mantiene la rama por texto para filas pre-028; `bold_qr_amount = 0`
	// evita doble conteo con el bloque anterior.
	rows, err := r.db.Table("expenses").
		Select("COALESCE(\"paymentSource\", 'EFECTIVO'), COALESCE(SUM(amount + tax_amount), 0) as total").
		Where("deleted_at IS NULL").
		Where("UPPER(status) = 'PAID'").
		Where("UPPER(COALESCE(\"paymentSource\", '')) NOT IN ('PRESTAMO', 'PREST.')").
		Where("date >= ? AND date <= ?", from, to).
		Where("cash_amount = 0 AND nequi_amount = 0 AND daviplata_amount = 0 AND fondo_amount = 0 AND coins_amount = 0 AND bold_qr_amount = 0").
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
