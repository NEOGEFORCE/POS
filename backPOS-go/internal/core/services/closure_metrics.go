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
	// EgresosAlcancia son los egresos pagados con las monedas de la alcancía.
	// Van aparte a propósito: la alcancía NO es la gaveta, así que no afectan
	// el arqueo del efectivo ni pueden sumarse a la venta del cajero.
	EgresosAlcancia float64
	EgresosTotales  float64

	// Returns es el dinero devuelto a clientes.
	Returns float64

	// VentasCajero es la VENTA TOTAL auditada del turno.
	VentasCajero float64
}

// ComputeShiftExpenseTotals calcula el UNIVERSO CANÓNICO de egresos operativos
// de un turno: total multicanal (efectivo + Nequi + Daviplata + fondo +
// alcancía) y cuenta de líneas que aportaron a ese total.
//
// EXCLUSIONES (idénticas a las que aplica ComputeClosureMetrics al alimentar
// el arqueo del cierre):
//   - Egresos con status distinto de PAID (los PENDING todavía no salieron).
//   - PaymentSource con PREST/DEUDA (préstamos/deudas no mueven caja aún).
//   - Categoría DEVOLUCIONES (se contabilizan aparte vía TotalReturns).
//
// La clasificación por canal delega en parseExpenseChannels (SSOT). El count
// se calcula sobre el MISMO universo que aportó al total, para preservar la
// invariante amount ↔ count que consume el dashboard.
func ComputeShiftExpenseTotals(expenses []models.Expense) (total float64, count int) {
	for i := range expenses {
		e := &expenses[i]
		if !isOperationalExpense(e) {
			continue
		}
		cash, nequi, davi, fondo, coins := parseExpenseChannels(e)
		lineTotal := cash + nequi + davi + fondo + coins
		if lineTotal <= 0 {
			continue
		}
		total += lineTotal
		count++
	}
	return
}

// ExpenseChannelBuckets agrupa un lote de egresos por canal canónico usando
// parseExpenseChannels (SSOT). Excluye PENDING, PRESTAMOS/DEUDAS y
// DEVOLUCIONES, igual que ComputeShiftExpenseTotals, para mantener alineado
// el flujo de caja del dashboard con el arqueo del cierre.
//
// Devuelve un mapa con las llaves EFECTIVO, NEQUI, DAVIPLATA, FONDO, MONEDAS
// (siempre presentes, aun con valor 0 para simplificar el consumo).
func ExpenseChannelBuckets(expenses []models.Expense) map[string]float64 {
	buckets := map[string]float64{
		"EFECTIVO":  0,
		"NEQUI":     0,
		"DAVIPLATA": 0,
		"FONDO":     0,
		"MONEDAS":   0,
	}
	for i := range expenses {
		e := &expenses[i]
		if !isOperationalExpense(e) {
			continue
		}
		cash, nequi, davi, fondo, coins := parseExpenseChannels(e)
		buckets["EFECTIVO"] += cash
		buckets["NEQUI"] += nequi
		buckets["DAVIPLATA"] += davi
		buckets["FONDO"] += fondo
		buckets["MONEDAS"] += coins
	}
	return buckets
}

// SplitExpensesByKind parte los egresos operativos de un turno en dos bolsas
// por TIPO DE GASTO, sumando TODOS los canales de cada una:
//
//	suppliers = mercancía, proveedores, insumos para la venta
//	others    = el resto (nómina, arriendo, servicios, aseo, imprevistos…)
//
// POR QUÉ EXISTE (pedido del dueño, 2026-09-04): el reporte desglosado ya
// mostraba el egreso repartido por CANAL (caja / fondo / digital), que responde
// "por dónde salió la plata". Pero para decidir, el dueño necesita la otra
// lectura: "en QUÉ se gastó". Ver un renglón de proveedores y otro de gastos del
// local le dice de un vistazo cuánto se fue en mercancía y cuánto en operación.
//
// INVARIANTE QUE NO SE PUEDE ROMPER: suppliers + others == EgresosTotales del
// mismo lote. Por eso reutiliza isOperationalExpense (mismas exclusiones de
// pendientes, préstamos y devoluciones) y parseExpenseChannels (mismo reparto de
// canales, alcancía incluida) que ComputeShiftExpenseTotals. Si se clasificara
// con criterios propios, las dos filas dejarían de cuadrar con el total y el
// reporte no se podría verificar a mano.
//
// La clasificación delega en IsMerchandiseExpense, que ya es la regla del
// proyecto para separar mercancía de gasto del local (la misma que usa el
// reporte de rentabilidad para no restar la mercancía dos veces).
func SplitExpensesByKind(expenses []models.Expense) (suppliers, others float64) {
	for i := range expenses {
		e := &expenses[i]
		if !isOperationalExpense(e) {
			continue
		}
		cash, nequi, davi, fondo, coins := parseExpenseChannels(e)
		lineTotal := cash + nequi + davi + fondo + coins
		if lineTotal <= 0 {
			continue
		}
		hasSupplier := e.SupplierID != nil && *e.SupplierID > 0
		if IsMerchandiseExpense(e.Category, e.Description, hasSupplier) {
			suppliers += lineTotal
			continue
		}
		others += lineTotal
	}
	return suppliers, others
}

// isOperationalExpense define el universo canónico de egresos que realmente
// afectan la caja del turno.
func isOperationalExpense(e *models.Expense) bool {
	if e == nil {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(e.Status), "PAID") {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(e.Category), "DEVOLUCIONES") {
		return false
	}
	src := strings.ToUpper(strings.TrimSpace(e.PaymentSource))
	if strings.Contains(src, "PREST") || strings.Contains(src, "DEUDA") {
		return false
	}
	return true
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
	Coins         float64
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
		cash, nequi, davi, fondo, coins := parseExpenseChannels(e)

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
			Coins:         coins,
			Total:         cash + nequi + davi + fondo + coins,
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
		m.EgresosAlcancia += l.Coins
	}
	m.EgresosTotales = m.EgresosCaja + m.EgresosDigital + m.EgresosFondo + m.EgresosAlcancia

	// VENTA TOTAL DEL CAJERO.
	//
	// Se suman los egresos pagados EN EFECTIVO porque esa plata salio de la
	// gaveta, y para estar en la gaveta tuvo que entrar antes por una venta.
	//
	// La ALCANCIA queda FUERA a proposito (arreglo 2026-08-31): es un tarro
	// aparte, no la gaveta. Antes los egresos pagados con monedas caian en el
	// bucket de efectivo y se sumaban aca, inflando la venta del mes sin que
	// hubiera existido ninguna venta. Ese era el hueco entre la linea de
	// "Ventas" del dashboard y el donut de metodos de pago.
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
