package ports

import (
	"backPOS-go/internal/core/domain/models"
	"time"
)

// ExpenseDeleteResult describe los efectos de borrar un egreso. Cuando era
// un pago financiado con préstamo, LoanReversed=true implica que la misma
// transacción restauró la deuda original (si existía) y marcó loan_expenses
// como reversado para liberar principal.
type ExpenseDeleteResult struct {
	ExpenseID         uint    `json:"expenseId"`
	LoanReversed      bool    `json:"loanReversed"`
	RestoredDebtID    *uint   `json:"restoredDebtId,omitempty"`
	RestoredAmount    float64 `json:"restoredAmount,omitempty"`
	ReleasedPrincipal float64 `json:"releasedPrincipal,omitempty"`
}

type ExpenseFilter struct {
	Page     int    `json:"page"`
	PageSize int    `json:"pageSize"`
	Supplier string `json:"supplier"`
	Concept  string `json:"concept"`
}

type ExpenseRepository interface {
	Save(expense *models.Expense) error
	SaveWithTx(tx interface{}, expense *models.Expense) error
	GetAll() ([]models.Expense, error)
	GetAllFiltered(supplier, concept string) ([]models.Expense, error)
	GetExpensesPaginated(filter ExpenseFilter) ([]models.Expense, int64, error)
	GetByID(id uint) (*models.Expense, error)
	GetByDateRange(from, to time.Time) ([]models.Expense, error)
	// GetByDateRangeWithTx lee dentro de una transacción abierta, para ver
	// egresos insertados en esa misma tx (p.ej. olvidados al editar un cierre).
	GetByDateRangeWithTx(tx interface{}, from, to time.Time) ([]models.Expense, error)
	// GetByReferenceIDs devuelve los egresos cuyo reference_id esta en el
	// slice (p.ej. recepciones "RECP-..."). Preload de Supplier obligatorio
	// porque el consumidor principal es el historial de recepciones que
	// debe mostrar el nombre del proveedor cuando el metadata del kardex
	// esta vacio (recepciones viejas, pre-metadata).
	GetByReferenceIDs(refs []string) ([]models.Expense, error)
	GetTotalAmountByDateRange(from, to time.Time) (float64, error)
	GetPendingRestockExpensesBySupplier(supplierID uint) ([]models.Expense, error)
	Delete(id uint) error
	Count() (int64, error)
	Update(id uint, expense *models.Expense) error
	Settle(id uint, paymentSource string) error
	GetMonthlyTotals() (map[string]float64, error)
	GetPendingDebtsSummary() (float64, int64, error)
	GetExpensesByStatus(status string) ([]models.Expense, error)
	GetGlobalTotalPaidExpenses() (float64, error)
	GetGlobalPaidExpensesByMethod() (map[string]float64, error)
	GetPaidAmountByRange(from, to time.Time) (float64, error)
	GetGlobalPaidExpensesByMethodInRange(from, to time.Time) (map[string]float64, error)
}
