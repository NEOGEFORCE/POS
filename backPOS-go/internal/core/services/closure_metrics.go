package services

import (
	"encoding/json"
	"strconv"
	"strings"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// FUENTE ÚNICA DE VERDAD DEL ARQUEO DE CAJA
// ============================================================================
//
// Este archivo es la ÚNICA implementación autorizada de la "VENTA TOTAL DEL
// CAJERO" y del desglose de egresos por canal de un cierre.
//
// Regla acordada con el dueño (2026-08-25):
//
//	VENTA TOTAL = Efectivo Físico Contado
//	            + Ingresos Digitales (Nequi + Daviplata + Tarjeta + Bancolombia + Otros)
//	            + Egresos pagados en EFECTIVO desde la caja
//	            + Devoluciones de dinero
//
// La lógica es: la plata que el cajero tiene en la mano, más la que entró por
// canales digitales, más la que salió de la gaveta (porque esa plata SÍ entró
// por una venta antes de salir), más lo que se devolvió a clientes.
//
// DEVOLUCIONES: cuando se devuelve dinero, el sistema lo registra
// automáticamente como un egreso de categoría "DEVOLUCIONES". Para no contarlo
// dos veces se EXCLUYE de los egresos por canal y se suma una sola vez a través
// de la columna TotalReturns del cierre.
//
// PROHIBIDO reimplementar este cálculo en otro lugar (ni en Go, ni en
// TypeScript). El frontend debe consumir los campos calculados que el backend
// expone en el JSON del cierre.
// ============================================================================

// ClosureMetrics es el resultado canónico del arqueo de un cierre de caja.
type ClosureMetrics struct {
	// PhysicalCash es el efectivo realmente contado por el cajero. Se
	// reconstruye desde el desglose de billetes/monedas cuando existe, porque
	// es el dato que el cajero digitó a mano.
	PhysicalCash float64

	// DigitalIncome son los ingresos que no pasaron por la gaveta.
	DigitalIncome float64

	// Egresos separados por canal. Solo EgresosCaja afecta el arqueo físico.
	EgresosCaja    float64
	EgresosFondo   float64
	EgresosDigital float64
	EgresosTotales float64

	// Returns es el dinero devuelto a clientes.
	Returns float64

	// VentasCajero es la VENTA TOTAL auditada del turno.
	VentasCajero float64
}

// ClosureExpenseLine es un egreso del turno con su plata ya repartida por canal.
// Se usa para IMPRIMIR el detalle en los reportes, igual que el modal de
// auditoría en pantalla, para que ningún monto quede escondido dentro de un total.
type ClosureExpenseLine struct {
	ID            uint
	Description   string
	Category      string
	PaymentSource string
	Status        string
	Cash          float64
	Nequi         float64
	Davi          float64
	Fondo         float64
	Total         float64
	IsReturn      bool
}

// ResolveClosureExpenses devuelve los egresos del cierre con su clasificación
// canónica por canal. Es la lista que alimenta tanto los totales
// (ComputeClosureMetrics) como el detalle impreso en los reportes.
func ResolveClosureExpenses(c *models.CashierClosure) []ClosureExpenseLine {
	expenses := c.Expenses
	if len(expenses) == 0 && strings.TrimSpace(c.ExpensesDetail) != "" && c.ExpensesDetail != "[]" {
		_ = json.Unmarshal([]byte(c.ExpensesDetail), &expenses)
	}

	lines := make([]ClosureExpenseLine, 0, len(expenses))
	for i := range expenses {
		e := &expenses[i]
		cash, nequi, davi, fondo := parseExpenseChannels(e)

		lines = append(lines, ClosureExpenseLine{
			ID:            e.ID,
			Description:   e.Description,
			Category:      e.Category,
			PaymentSource: e.PaymentSource,
			Status:        e.Status,
			Cash:          cash,
			Nequi:         nequi,
			Davi:          davi,
			Fondo:         fondo,
			Total:         cash + nequi + davi + fondo,
			IsReturn:      strings.EqualFold(strings.TrimSpace(e.Category), "DEVOLUCIONES"),
		})
	}
	return lines
}

// ComputeClosureMetrics calcula el arqueo canónico de un cierre.
//
// Acepta el cierre tal como sale del repositorio. Si Expenses viene vacío, cae
// en el snapshot ExpensesDetail para poder auditar cierres históricos.
func ComputeClosureMetrics(c *models.CashierClosure) ClosureMetrics {
	var m ClosureMetrics

	m.PhysicalCash = resolvePhysicalCash(c)
	m.DigitalIncome = c.TotalNequi + c.TotalDaviplata + c.TotalCard + c.TotalBancolombia + c.TotalOtherTransfer
	m.Returns = c.TotalReturns

	for _, l := range ResolveClosureExpenses(c) {
		// Las devoluciones ya se contabilizan vía TotalReturns. Contarlas aquí
		// también las restaría dos veces del efectivo esperado.
		if l.IsReturn {
			continue
		}
		m.EgresosCaja += l.Cash
		m.EgresosDigital += l.Nequi + l.Davi
		m.EgresosFondo += l.Fondo
	}
	m.EgresosTotales = m.EgresosCaja + m.EgresosDigital + m.EgresosFondo

	m.VentasCajero = m.PhysicalCash + m.DigitalIncome + m.EgresosCaja + m.Returns

	return m
}

// resolvePhysicalCash determina el efectivo físico contado.
//
// Prioridad:
//  1. La columna PhysicalCash. Es el dato AUTORITATIVO: es lo que el cajero
//     digitó como total y lo único que se actualiza al editar un cierre.
//  2. El desglose de billetes y monedas, solo si la columna está en cero.
//  3. Las columnas CashBills + monedas.
//
// OJO: la prioridad es esta y no la inversa. SaveClosure trata la columna como
// principal y el desglose como respaldo:
//
//	if closureDTO.PhysicalCash == 0 && (CashBills > 0 || coinsTotal > 0) { ... }
//
// Si se prefiere el desglose, en un cierre editado se lee la grilla vieja (que
// no se actualiza) en vez del monto corregido, y el reporte queda desfasado.
//
// IMPORTANTE: las monedas se guardan como VALOR EN PESOS, no como cantidad de
// piezas. Nunca multiplicar por la denominación.
func resolvePhysicalCash(c *models.CashierClosure) float64 {
	if c.PhysicalCash > 0 {
		return c.PhysicalCash
	}

	bills := c.CashBills
	coins := c.Coins1000 + c.Coins500 + c.Coins200 + c.Coins100

	if strings.TrimSpace(c.CashBreakdown) != "" {
		var bd struct {
			Bills map[string]interface{} `json:"bills"`
			Coins map[string]interface{} `json:"coins"`
		}
		if err := json.Unmarshal([]byte(c.CashBreakdown), &bd); err == nil {
			// Billetes: denominación × cantidad de piezas.
			sumBills := 0.0
			for denomStr, qtyRaw := range bd.Bills {
				denom, errD := strconv.ParseFloat(denomStr, 64)
				qty := toFloat(qtyRaw)
				if errD == nil {
					sumBills += denom * qty
				}
			}
			if sumBills > 0 {
				bills = sumBills
			}

			// Monedas: el valor ya viene en pesos.
			sumCoins := 0.0
			for _, v := range bd.Coins {
				sumCoins += toFloat(v)
			}
			if sumCoins > 0 {
				coins = sumCoins
			}
		}
	}

	if bills+coins > 0 {
		return bills + coins
	}
	return c.ExpectedCash + c.Difference
}

// toFloat convierte los valores del desglose, que llegan como número o como
// string según cómo los serializó el frontend.
func toFloat(v interface{}) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case string:
		clean := strings.ReplaceAll(strings.TrimSpace(t), ".", "")
		clean = strings.ReplaceAll(clean, ",", ".")
		f, _ := strconv.ParseFloat(clean, 64)
		return f
	}
	return 0
}
