package services

import (
	"fmt"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================
// working_capital.go — Variación Patrimonial del período
// (¿dónde quedó la plata de la ganancia?)
//
// Responde la pregunta del dueño: "si el mes dejó $3.133.025 libres,
// ¿por qué no están todos en efectivo en la caja?".
//
// La ganancia de un mes no se queda solo en efectivo: parte se va a la
// calle en fiados, parte se usa para pagar mercancía que ya estaba en
// el estante y parte sí queda en caja. Este módulo compara la foto del
// día 1 contra la del último día y muestra a dónde se movió.
//
// NOTA SOBRE LA RECONSTRUCCIÓN: la base de datos guarda la cartera
// (clients.currentCredit) y las deudas (expenses.remaining_amount) como
// saldos MUTABLES, sin histórico. Los saldos iniciales no se pueden leer
// directamente: se reconstruyen caminando los movimientos del período
// hacia atrás desde el saldo actual. Los saldos de efectivo sí son
// exactos, porque provienen de los cierres de caja.
// =============================================================

// WorkingCapitalLine es una cuenta del capital de trabajo comparada
// entre el inicio y el final del período.
type WorkingCapitalLine struct {
	Concept string  `json:"concept"`
	Opening float64 `json:"opening"`
	Closing float64 `json:"closing"`
	Delta   float64 `json:"delta"`
	Meaning string  `json:"meaning"`
}

// WorkingCapital es el análisis de distribución de la ganancia del mes.
type WorkingCapital struct {
	// Mercancía en el local (inventario a precio de costo)
	InventoryOpening float64 `json:"inventoryOpening"`
	InventoryClosing float64 `json:"inventoryClosing"`
	InventoryDelta   float64 `json:"inventoryDelta"`

	// Cartera de clientes (fiados)
	ReceivableOpening float64 `json:"receivableOpening"`
	ReceivableClosing float64 `json:"receivableClosing"`
	ReceivableDelta   float64 `json:"receivableDelta"`

	// Deudas a proveedores (Centro de Pagos)
	PayableOpening float64 `json:"payableOpening"`
	PayableClosing float64 `json:"payableClosing"`
	// PayableDelta es cuánto BAJÓ la deuda (inicial - final). Positivo
	// significa que se usó plata para pagar mercancía; negativo, que
	// llegó más mercancía a crédito de la que se pagó.
	PayableDelta float64 `json:"payableDelta"`

	// Plata en mano (caja/fondo + Nequi + Daviplata)
	CashOpening float64 `json:"cashOpening"`
	CashClosing float64 `json:"cashClosing"`
	CashDelta   float64 `json:"cashDelta"`

	// Conciliación contra la ganancia libre
	Explained float64 `json:"explained"` // suma de los cuatro movimientos
	NetProfit float64 `json:"netProfit"`
	// OtherMovements son retiros del dueño, aportes de socios y otros
	// movimientos no operativos que completan la distribución.
	OtherMovements float64 `json:"otherMovements"`

	// Liquidity responde cuánto de la ganancia quedó en dinero disponible
	// ("Libre Libre") y cuánto está atrapado en mercancía.
	Liquidity ProfitLiquidity `json:"liquidity"`

	// Movimientos usados en la reconstrucción (para auditar la cifra)
	CreditSalesInPeriod    float64 `json:"creditSalesInPeriod"`
	CreditPaymentsInPeriod float64 `json:"creditPaymentsInPeriod"`
	NewDebtInPeriod        float64 `json:"newDebtInPeriod"`
	DebtPaidInPeriod       float64 `json:"debtPaidInPeriod"`

	HasData bool `json:"hasData"`
}

// WorkingCapitalInput son las fotografías del inicio y del final del
// período necesarias para distribuir la ganancia.
type WorkingCapitalInput struct {
	InventoryOpening, InventoryClosing   float64
	ReceivableOpening, ReceivableClosing float64
	PayableOpening, PayableClosing       float64
	CashOpening, CashClosing             float64
	NetProfit                            float64
}

// ComputeWorkingCapital distribuye la ganancia del mes entre las cuentas
// del negocio. Función pura.
//
// Identidad contable aplicada:
//
//	Ganancia = ΔInventario + ΔCartera + ΔEfectivo - ΔDeudas
//
// El término de deudas entra como (inicial - final): si la deuda bajó,
// esa plata salió de la ganancia para pagar mercancía; si subió, el
// negocio se financió con el proveedor.
func ComputeWorkingCapital(in WorkingCapitalInput) WorkingCapital {
	w := WorkingCapital{
		InventoryOpening:  in.InventoryOpening,
		InventoryClosing:  in.InventoryClosing,
		ReceivableOpening: in.ReceivableOpening,
		ReceivableClosing: in.ReceivableClosing,
		PayableOpening:    in.PayableOpening,
		PayableClosing:    in.PayableClosing,
		CashOpening:       in.CashOpening,
		CashClosing:       in.CashClosing,
		NetProfit:         in.NetProfit,
		HasData:           true,
	}

	// Mercancía que quedó de más (o de menos) en el local.
	w.InventoryDelta = in.InventoryClosing - in.InventoryOpening
	// Plata que se fue a la calle (o que volvió, si es negativo).
	w.ReceivableDelta = in.ReceivableClosing - in.ReceivableOpening
	// Plata que se usó para bajar la deuda de mercancía.
	w.PayableDelta = in.PayableOpening - in.PayableClosing
	// Efectivo neto que quedó en las cuentas.
	w.CashDelta = in.CashClosing - in.CashOpening

	w.Explained = w.InventoryDelta + w.ReceivableDelta + w.CashDelta + w.PayableDelta
	// Lo que falta para completar la ganancia son movimientos no
	// operativos: retiros del dueño, aportes, compras de contado, etc.
	w.OtherMovements = in.NetProfit - w.Explained
	// Reparto entre mercancía y dinero líquido ("Libre Libre").
	w.Liquidity = ComputeProfitLiquidity(in.NetProfit, w.InventoryDelta)
	return w
}

// Distribution devuelve las filas de la tabla "¿dónde está repartida la
// ganancia del mes?", ya conciliada con la ganancia libre.
func (w WorkingCapital) Distribution() []WorkingCapitalLine {
	lines := []WorkingCapitalLine{
		{
			Concept: "1. En mercancía (variación de inventario)",
			Opening: w.InventoryOpening,
			Closing: w.InventoryClosing,
			Delta:   w.InventoryDelta,
			Meaning: inventoryMeaning(w.InventoryDelta),
		},
		{
			Concept: "2. En la calle (cartera de fiados)",
			Opening: w.ReceivableOpening,
			Closing: w.ReceivableClosing,
			Delta:   w.ReceivableDelta,
			Meaning: receivableMeaning(w.ReceivableDelta),
		},
		{
			Concept: "3. En efectivo y cuentas (caja + Nequi + Daviplata)",
			Opening: w.CashOpening,
			Closing: w.CashClosing,
			Delta:   w.CashDelta,
			Meaning: cashMeaning(w.CashDelta),
		},
		{
			Concept: "4. Variación de deudas a proveedores",
			Opening: w.PayableOpening,
			Closing: w.PayableClosing,
			Delta:   w.PayableDelta,
			Meaning: payableMeaning(w.PayableDelta),
		},
	}

	// La fila de cierre solo aparece si hay movimientos no operativos
	// relevantes, y va con nombre propio: nunca como "sin explicar".
	if absFloat(w.OtherMovements) > 1 {
		lines = append(lines, WorkingCapitalLine{
			Concept: "5. Retiros del dueño, aportes y compras de contado",
			Delta:   w.OtherMovements,
			Meaning: otherMovementsMeaning(w.OtherMovements),
		})
	}
	return lines
}

func absFloat(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

func inventoryMeaning(delta float64) string {
	if delta > 0 {
		return "Mercancía nueva pagada que aumentó el surtido del local"
	}
	if delta < 0 {
		return "Se vendió más mercancía de la que se surtió: el estante bajó"
	}
	return "El surtido del local quedó igual"
}

func otherMovementsMeaning(delta float64) string {
	if delta > 0 {
		return "Plata que entró de aportes o de otras fuentes fuera de la operación"
	}
	return "Plata que salió del negocio en retiros del dueño o compras de contado"
}

// =============================================================
// Ganancia líquida ("Libre Libre") vs. mercancía
// =============================================================

// Escenarios de liquidez de la ganancia.
const (
	LiquidityAllMerchandise = "A" // toda la ganancia se reinvirtió en surtido
	LiquidityMixed          = "B" // parte en surtido, parte líquida
	LiquidityAllLiquid      = "C" // el inventario no absorbió ganancia
	LiquidityLoss           = "D" // el mes cerró en pérdida
)

// ProfitLiquidity responde: ¿cuánto de la ganancia quedó disponible para
// retirar y cuánto está atrapado en mercancía del estante?
type ProfitLiquidity struct {
	NetProfit float64 `json:"netProfit"`

	// InMerchandise es la parte de la ganancia reinvertida en surtido.
	InMerchandise float64 `json:"inMerchandise"`
	// Liquid es la ganancia disponible en dinero ("Libre Libre").
	Liquid float64 `json:"liquid"`

	MerchandisePct float64 `json:"merchandisePct"`
	LiquidPct      float64 `json:"liquidPct"`

	Scenario    string `json:"scenario"`
	Explanation string `json:"explanation"`
}

// ComputeProfitLiquidity reparte la ganancia libre entre mercancía y
// dinero líquido, comparándola contra el crecimiento del inventario.
//
//	inventoryDelta >= netProfit  -> todo se reinvirtió en surtido
//	0 < inventoryDelta < netProfit -> mixto
//	inventoryDelta <= 0          -> toda la ganancia es líquida
func ComputeProfitLiquidity(netProfit, inventoryDelta float64) ProfitLiquidity {
	p := ProfitLiquidity{NetProfit: netProfit}

	switch {
	case netProfit <= 0:
		// Sin ganancia no hay nada que repartir.
		p.Scenario = LiquidityLoss
		p.InMerchandise = 0
		p.Liquid = netProfit
		p.Explanation = fmt.Sprintf(
			"El mes no dejó ganancia libre (%s), así que no hay utilidad que repartir entre mercancía y "+
				"dinero disponible. El surtido del local varió %s en el período.",
			fmtCOP(netProfit), fmtCOPSigned(inventoryDelta))

	case inventoryDelta <= 0:
		p.Scenario = LiquidityAllLiquid
		p.InMerchandise = 0
		p.Liquid = netProfit
		p.Explanation = fmt.Sprintf(
			"El inventario no absorbió ganancia este mes; el 100%% de su utilidad libre (%s) está disponible "+
				"como liquidez.",
			fmtCOP(netProfit))

	case inventoryDelta >= netProfit:
		p.Scenario = LiquidityAllMerchandise
		p.InMerchandise = netProfit
		p.Liquid = 0
		p.Explanation = fmt.Sprintf(
			"Nota del negocio: No confunda el dinero operativo disponible en caja/bancos con la Ganancia 'Libre Libre'. "+
				"En el período, su utilidad libre fue de %s y se reinvirtió al 100%% en mercancía nueva para aumentar el surtido "+
				"(el inventario creció en %s), por lo cual la ganancia extra en dinero líquido para retirar es %s.",
			fmtCOP(netProfit), fmtCOP(inventoryDelta), fmtCOP(0))

	default:
		p.Scenario = LiquidityMixed
		p.InMerchandise = inventoryDelta
		p.Liquid = netProfit - inventoryDelta
		p.Explanation = fmt.Sprintf(
			"De su ganancia libre del mes, %s se reinvirtieron en mercancía para el local y le quedaron %s "+
				"\"Libre Libre\" en dinero líquido disponible para retirar.",
			fmtCOP(p.InMerchandise), fmtCOP(p.Liquid))
	}

	if netProfit > 0 {
		p.MerchandisePct = p.InMerchandise / netProfit
		p.LiquidPct = p.Liquid / netProfit
	}
	return p
}

func receivableMeaning(delta float64) string {
	if delta > 0 {
		return "Plata de la ganancia que quedó en la calle por cobrar"
	}
	if delta < 0 {
		return "Los clientes pagaron cartera vieja: entró plata de meses anteriores"
	}
	return "La cartera quedó igual que al empezar el mes"
}

func payableMeaning(delta float64) string {
	if delta > 0 {
		return "Efectivo de la ganancia destinado a pagar mercancía del estante"
	}
	if delta < 0 {
		return "Se recibió más mercancía a crédito de la que se pagó: la deuda creció"
	}
	return "La deuda con proveedores quedó igual"
}

func cashMeaning(delta float64) string {
	if delta > 0 {
		return "Efectivo real disponible que creció en las cuentas"
	}
	if delta < 0 {
		return "Se gastó más efectivo del que entró: las cuentas bajaron"
	}
	return "El efectivo disponible quedó igual"
}

// =============================================================
// Obtención de datos
// =============================================================

// GetWorkingCapital reconstruye las dos fotografías del período y
// calcula la variación patrimonial.
func (s *ExportService) GetWorkingCapital(
	from, to time.Time,
	payableClosing, netProfit float64,
	closingBalances ClosingBalances,
) (*WorkingCapital, error) {

	// ---------- Cartera de clientes ----------
	// clients.currentCredit es el saldo VIVO (de hoy). Se camina hacia
	// atrás con los movimientos posteriores al período para obtener el
	// saldo al cierre, y luego con los del período para el inicial.
	var liveReceivable float64
	s.db.Model(&models.Client{}).
		Where(`"currentCredit" > 0`).
		Select(`COALESCE(SUM("currentCredit"), 0)`).
		Scan(&liveReceivable)

	creditSalesInPeriod := s.sumCreditSales(&from, &to)
	creditSalesAfter := s.sumCreditSales(&to, nil)
	paymentsInPeriod := s.sumCreditPayments(&from, &to)
	paymentsAfter := s.sumCreditPayments(&to, nil)

	// Saldo al cierre del período = saldo vivo - lo que se fio después
	// + lo que abonaron después.
	receivableClosing := liveReceivable - creditSalesAfter + paymentsAfter
	if receivableClosing < 0 {
		receivableClosing = 0
	}
	// Saldo al inicio = saldo al cierre - lo fiado en el mes + lo abonado.
	receivableOpening := receivableClosing - creditSalesInPeriod + paymentsInPeriod
	if receivableOpening < 0 {
		receivableOpening = 0
	}

	// ---------- Deudas a proveedores ----------
	// Se reconstruye el saldo inicial: deuda final, menos la deuda nueva
	// que nació en el mes, más la que se pagó durante el mes.
	newDebtInPeriod := s.sumNewDebt(from, to)
	debtPaidInPeriod := s.sumMerchandisePaid(from, to)

	payableOpening := payableClosing - newDebtInPeriod + debtPaidInPeriod
	if payableOpening < 0 {
		payableOpening = 0
	}

	// ---------- Plata en mano ----------
	opening, err := s.GetClosingBalancesBefore(from)
	if err != nil {
		return nil, err
	}

	// Si el reporte corresponde a un mes pasado (anterior al mes en curso),
	// se omite el saldo inicial del mes anterior (arranca en $0).
	// Para el mes actual en curso, se mantiene el saldo inicial acumulado.
	loc := time.FixedZone("America/Bogota", -5*60*60)
	nowLocal := time.Now().In(loc)
	currentMonthStart := time.Date(nowLocal.Year(), nowLocal.Month(), 1, 0, 0, 0, 0, loc)

	cashOpening := opening.CashOnHand()
	if to.Before(currentMonthStart) {
		cashOpening = 0
	}

	// ---------- Mercancía en el local ----------
	inv, err := s.GetInventoryValuation(from, to)
	if err != nil {
		return nil, err
	}

	w := ComputeWorkingCapital(WorkingCapitalInput{
		InventoryOpening:  inv.Opening,
		InventoryClosing:  inv.Closing,
		ReceivableOpening: receivableOpening,
		ReceivableClosing: receivableClosing,
		PayableOpening:    payableOpening,
		PayableClosing:    payableClosing,
		CashOpening:       cashOpening,
		CashClosing:       closingBalances.CashOnHand(),
		NetProfit:         netProfit,
	})
	w.CreditSalesInPeriod = creditSalesInPeriod
	w.CreditPaymentsInPeriod = paymentsInPeriod
	w.NewDebtInPeriod = newDebtInPeriod
	w.DebtPaidInPeriod = debtPaidInPeriod
	return &w, nil
}

// sumCreditSales suma los fiados otorgados. Si to es nil suma todo lo
// posterior a from.
func (s *ExportService) sumCreditSales(from, to *time.Time) float64 {
	var total float64
	q := s.db.Model(&models.Sale{}).
		Where(`(status IS NULL OR UPPER(status) <> 'CANCELLED')`).
		Where(`COALESCE("creditAmount", 0) > 0`)
	if from != nil {
		if to != nil {
			q = q.Where(`"saleDate" BETWEEN ? AND ?`, *from, *to)
		} else {
			q = q.Where(`"saleDate" > ?`, *from)
		}
	}
	q.Select(`COALESCE(SUM("creditAmount"), 0)`).Scan(&total)
	return total
}

// sumCreditPayments suma los abonos de cartera recibidos.
func (s *ExportService) sumCreditPayments(from, to *time.Time) float64 {
	var total float64
	q := s.db.Model(&models.CreditPayment{})
	if from != nil {
		if to != nil {
			q = q.Where(`"paymentDate" BETWEEN ? AND ?`, *from, *to)
		} else {
			q = q.Where(`"paymentDate" > ?`, *from)
		}
	}
	q.Select(`COALESCE(SUM("totalPaid"), 0)`).Scan(&total)
	return total
}

// sumNewDebt suma las deudas que nacieron dentro del período y siguen
// activas, con la misma fórmula de saldo del Centro de Pagos.
func (s *ExportService) sumNewDebt(from, to time.Time) float64 {
	var total float64
	s.db.Model(&models.Expense{}).
		Where(`(UPPER(status) = ? OR UPPER("paymentSource") IN ('PRESTAMO', 'PREST.')) AND UPPER(status) NOT IN ('PAID', 'SETTLED')`, "PENDING").
		Where(`date BETWEEN ? AND ?`, from, to).
		Select(`COALESCE(SUM(CASE WHEN remaining_amount > 0 THEN remaining_amount ELSE amount END + tax_amount), 0)`).
		Scan(&total)
	return total
}

// sumMerchandisePaid suma los egresos de mercancía/proveedores pagados
// dentro del período: la plata que salió a saldar el estante.
func (s *ExportService) sumMerchandisePaid(from, to time.Time) float64 {
	var expenses []models.Expense
	s.db.Preload("Supplier").
		Where(`date BETWEEN ? AND ?`, from, to).
		Where(`(status IS NULL OR UPPER(status) IN ('PAID', 'COMPLETED', 'SETTLED', ''))`).
		Find(&expenses)

	var total float64
	for _, e := range expenses {
		hasSupplier := e.SupplierID != nil || (e.Supplier != nil && e.Supplier.ID > 0)
		if IsMerchandiseExpense(e.Category, e.Description, hasSupplier) {
			total += e.Amount + e.TaxAmount
		}
	}
	return total
}
