package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================
// audited_income.go — Ingresos auditados del período (PASO 1) y
// fotografía de saldos al cierre del último turno del mes.
//
// El PASO 1 del reporte de rentabilidad audita el 100% de los ingresos
// consolidados de los cierres de caja, usando EXACTAMENTE la misma
// fórmula que el PDF "Reporte Consolidado de Cierres" para su casilla
// VENTAS TOTALES (CAJERO):
//
//	ingresos auditados = efectivo contado
//	                   + canales digitales (Nequi, Daviplata, tarjeta,
//	                     Bancolombia, otras transferencias)
//	                   + egresos pagados en efectivo (esa plata salió del
//	                     cajón, pero entró por la operación)
//	                   + devoluciones
//
// Ambos reportes deben arrojar la misma cifra para el mismo mes.
// =============================================================

// AuditedIncome son los ingresos consolidados del período con su
// desglose y la fotografía de saldos al cierre.
type AuditedIncome struct {
	// Total es el PASO 1 del reporte (VENTAS TOTALES CAJERO).
	Total float64 `json:"total"`

	// Componentes del total
	PhysicalCash float64 `json:"physicalCash"`
	Digital      float64 `json:"digital"`
	CashExpenses float64 `json:"cashExpenses"`
	Returns      float64 `json:"returns"`

	// Referencia del sistema (VENTAS TOTALES SIST.)
	ExpectedCash float64 `json:"expectedCash"`
	SystemTotal  float64 `json:"systemTotal"`

	// Descuadre acumulado = efectivo contado - efectivo esperado
	CashDifference float64 `json:"cashDifference"`

	ClosureCount int `json:"closureCount"`

	// Closing es la disponibilidad de dinero al cierre del último turno.
	Closing ClosingBalances `json:"closing"`
}

// ClosingBalances es la fotografía de dinero disponible guardado hasta el
// cierre del período: la base con la que arranca el mes siguiente.
//
// IMPORTANTE — misma fuente que el Dashboard: los montos representan el SALDO REAL
// DISPONIBLE (fotografía acumulada) al corte del período, NUNCA la sumatoria (SUM)
// de las ventas o entradas del mes.
type ClosingBalances struct {
	HasData      bool      `json:"hasData"`
	ClosureID    uint      `json:"closureId"`    // último cierre del corte
	ClosedAt     time.Time `json:"closedAt"`     // fecha de ese cierre
	ClosedByName string    `json:"closedByName"` // quién lo cerró

	Cash      float64 `json:"cash"`      // efectivo real en mano (saldo disponible)
	Nequi     float64 `json:"nequi"`     // Nequi (saldo disponible)
	Daviplata float64 `json:"daviplata"` // Daviplata (saldo disponible)

	// Total es el TOTAL GENERAL GUARDADO (CAJA + DIGITAL).
	Total float64 `json:"total"`
}

// CashOnHand es la "plata en mano": el total guardado entre caja, Nequi y
// Daviplata. Coincide con Total; se mantiene como nombre explícito para
// el análisis de capital de trabajo.
func (b ClosingBalances) CashOnHand() float64 { return b.Total }

// GetSavedBalances devuelve el TOTAL GENERAL GUARDADO (fotografía del saldo real disponible)
// hasta la fecha indicada (inclusive), sin realizar sumatorias (SUM) de flujos.
func (s *ExportService) GetSavedBalances(at time.Time) (ClosingBalances, error) {
	loc := time.FixedZone("America/Bogota", -5*60*60)
	nowLocal := time.Now().In(loc)
	currentMonthStart := time.Date(nowLocal.Year(), nowLocal.Month(), 1, 0, 0, 0, 0, loc)

	// Para meses pasados (anteriores al mes en curso), omitimos los saldos ($0).
	if at.Before(currentMonthStart) {
		return ClosingBalances{
			HasData:   true,
			Cash:      0,
			Nequi:     0,
			Daviplata: 0,
			Total:     0,
		}, nil
	}

	var last models.CashierClosure
	err := s.db.Where(`date <= ?`, at).Order(`date DESC, id DESC`).First(&last).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ClosingBalances{HasData: false}, nil
		}
		return ClosingBalances{}, fmt.Errorf("saved balances: %w", err)
	}

	closedAt := last.EndDate
	if closedAt.IsZero() {
		closedAt = last.Date
	}

	cash := last.PhysicalCash
	if cash == 0 && last.TotalCashReal > 0 {
		cash = last.TotalCashReal
	}

	nequi := 0.0
	davi := 0.0

	if s.dashService != nil {
		overview, err := s.dashService.GetOverview(context.Background(), "", "")
		if err == nil && overview != nil {
			nequi = overview.RealCashFlow.Nequi
			davi = overview.RealCashFlow.Daviplata
		}
	}
	if nequi == 0 && davi == 0 {
		nequi = last.TotalNequiReal
		if nequi == 0 {
			nequi = last.TotalNequi
		}
		davi = last.TotalDaviplataReal
		if davi == 0 {
			davi = last.TotalDaviplata
		}
	}

	b := ClosingBalances{
		HasData:      true,
		ClosureID:    last.ID,
		ClosedAt:     closedAt,
		ClosedByName: last.ClosedByName,
		Cash:         cash,
		Nequi:        nequi,
		Daviplata:    davi,
	}
	b.Total = b.Cash + b.Nequi + b.Daviplata
	return b, nil
}

// GetClosingBalancesBefore devuelve el TOTAL GENERAL GUARDADO (fotografía del saldo real)
// ANTES de la fecha indicada: el punto de partida del período.
func (s *ExportService) GetClosingBalancesBefore(at time.Time) (ClosingBalances, error) {
	// Se resta un instante para excluir la fecha de corte.
	return s.GetSavedBalances(at.Add(-time.Nanosecond))
}

// GetAuditedIncome consolida los cierres de caja del período.
func (s *ExportService) GetAuditedIncome(from, to time.Time) (*AuditedIncome, error) {
	result := &AuditedIncome{}

	// Mismo filtro que usa el reporte consolidado de cierres
	// (closure_repository.GetByDateRange) para que las cifras coincidan.
	var closures []models.CashierClosure
	if err := s.db.
		Where(`date >= ? AND date <= ?`, from, to).
		Order(`date ASC, id ASC`).
		Find(&closures).Error; err != nil {
		return nil, fmt.Errorf("audited income closures: %w", err)
	}
	result.ClosureCount = len(closures)
	if len(closures) == 0 {
		return result, nil
	}

	// Egresos del período: se usan como respaldo cuando el cierre no
	// guardó su propio snapshot de egresos.
	var expenses []models.Expense
	if err := s.db.Where(`date >= ? AND date <= ?`, from, to).Find(&expenses).Error; err != nil {
		return nil, fmt.Errorf("audited income expenses: %w", err)
	}

	var lastClosure *models.CashierClosure
	var lastAt time.Time

	for i := range closures {
		c := &closures[i]

		digital := c.TotalNequi + c.TotalDaviplata + c.TotalCard +
			c.TotalBancolombia + c.TotalOtherTransfer

		// Egresos pagados en efectivo dentro del turno.
		cashExpenses := 0.0
		for _, e := range closureExpenses(c, expenses) {
			cash, _, _, _ := parseExpenseChannels(&e)
			cashExpenses += cash
		}

		expectedCash := c.ExpectedCash
		if expectedCash == 0 {
			expectedCash = (c.TotalCash + c.TotalCreditCollected) - cashExpenses - c.TotalReturns
		}

		result.PhysicalCash += c.PhysicalCash
		result.Digital += digital
		result.CashExpenses += cashExpenses
		result.Returns += c.TotalReturns
		result.ExpectedCash += expectedCash

		// VENTAS TOTALES (CAJERO) y (SIST.) del PDF consolidado
		result.Total += c.PhysicalCash + digital + cashExpenses + c.TotalReturns
		result.SystemTotal += expectedCash + digital + cashExpenses

		// Último turno del período (para los saldos al cierre)
		at := c.EndDate
		if at.IsZero() {
			at = c.Date
		}
		if lastClosure == nil || !at.Before(lastAt) {
			lastClosure = c
			lastAt = at
		}
	}

	result.CashDifference = result.PhysicalCash - result.ExpectedCash

	// Saldos guardados al corte del período: misma fuente que la tarjeta
	// "TOTAL GENERAL GUARDADO" del Dashboard, no los inputs de un turno.
	if saved, err := s.GetSavedBalances(to); err == nil {
		result.Closing = saved
	}

	return result, nil
}

// closureExpenses devuelve los egresos de un cierre: primero el snapshot
// guardado en el propio cierre y, si no existe, los egresos del período
// que caen dentro de la ventana del turno.
func closureExpenses(c *models.CashierClosure, periodExpenses []models.Expense) []models.Expense {
	if len(c.Expenses) > 0 {
		return c.Expenses
	}
	if c.ExpensesDetail != "" {
		var snapshot []models.Expense
		if err := json.Unmarshal([]byte(c.ExpensesDetail), &snapshot); err == nil && len(snapshot) > 0 {
			return snapshot
		}
	}
	var out []models.Expense
	for _, e := range periodExpenses {
		if e.Date.Before(c.StartDate) {
			continue
		}
		if !c.EndDate.IsZero() && e.Date.After(c.EndDate) {
			continue
		}
		out = append(out, e)
	}
	return out
}
