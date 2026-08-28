package services

import (
	"bytes"
	"fmt"
)

// =============================================================
// pdf_profitability.go — Auditoría Integral del negocio en lenguaje
// humano.
//
// Estructura:
//   1. El mes en 5 pasos (Paso 1 = 100% de ingresos auditados en caja)
//   2. De dónde salió la ganancia (margen real medido y extrapolado)
//   3. Gastos del local (sin pagos a proveedores) + desglose
//   4. Movimiento del dinero
//   5. Saldos al cierre del mes -> base del mes siguiente
//   6. Balance patrimonial: deudas activas vs. cartera por cobrar
//   7. Ganancia por producto
// =============================================================

const profitPDFMaxDetailRows = 60

// GenerateProfitabilityPDF construye el PDF ejecutivo de rentabilidad.
func (s *ExportService) GenerateProfitabilityPDF(r *ProfitabilityReport) (*bytes.Buffer, error) {
	d := newExecPDF("P", "Auditoría Integral del Negocio")
	d.addPage()

	d.hero(
		"Auditoría Integral del Negocio",
		"Todo lo que entró, lo que costó la mercancía, los gastos y la plata que quedó",
		r.From, r.To,
	)

	// -----------------------------------------------------------
	// 1. Resumen del mes en 5 pasos
	// -----------------------------------------------------------
	d.sectionTitle("1. El mes explicado en 5 pasos")

	d.step(1, "Todo el dinero que entró al negocio en el mes", fmtCOP(r.TotalSales), inkColor)
	d.step(2, "Lo que costó la mercancía de esos ingresos", fmtCOPNeg(r.TotalCost), coralInk)
	d.step(3, "Ganancia bruta del negocio", fmtCOP(r.GrossProfit), mintInkColor)
	d.step(4, "Gastos del local (nómina, arriendo, servicios, banco)", fmtCOPNeg(r.TotalOpExpenses), coralInk)

	positive := r.NetProfit >= 0
	resultNote := fmt.Sprintf("Ganancia bruta %s menos gastos del local %s",
		fmtCOP(r.GrossProfit), fmtCOP(r.TotalOpExpenses))
	if !positive {
		resultNote = "El mes cerró en pérdida: los gastos del local superaron la ganancia del negocio"
	}
	d.resultBox(5, "Ganancia libre real del mes", fmtCOP(r.NetProfit), resultNote, positive)

	d.hint(fmt.Sprintf(
		"Cómo se calculó, sin porcentajes inventados: el Paso 1 audita el 100%% de los ingresos consolidados "+
			"de los cierres de caja del mes (%s), la misma cifra del reporte de Cierres de Caja. "+
			"Para el costo, se midió el margen REAL del negocio en los productos que tienen costo de compra "+
			"registrado (%s de ganancia sobre %s vendidos) y ese mismo margen se aplicó al resto de los ingresos. "+
			"En los gastos del local NO se incluyen los pagos a proveedores ni los abonos de mercancía, porque ese "+
			"costo ya se descontó en el Paso 2.",
		fmtCOP(r.TotalSales), fmtPercent(r.KnownMargin), fmtCOP(r.KnownSales)))

	// -----------------------------------------------------------
	// 2. De dónde salió la ganancia
	// -----------------------------------------------------------
	d.sectionTitle("2. De dónde salió la ganancia")

	d.cards([]execCard{
		{Label: "Margen real del negocio", Value: fmtPercent(r.KnownMargin), Note: "medido con costos reales"},
		{Label: "Margen general del mes", Value: fmtPercent(r.OverallMargin), Note: "de cada $100 que entraron"},
		{Label: "Ganancia bruta", Value: fmtCOP(r.GrossProfit), Bg: mintColor, Fg: mintInkColor},
	})

	uncostedLabel := "Resto de ingresos auditados (ventas rápidas y caja)"
	if r.QuickSales > 0 {
		uncostedLabel = fmt.Sprintf("Resto de ingresos auditados (incluye %s de ventas rápidas)", fmtCOP(r.QuickSales))
	}

	d.table(execTable{
		Headers: []string{"Origen del ingreso", "Entró", "Costó la mercancía", "Ganancia", "Margen"},
		Weights: []float64{2.6, 1.3, 1.4, 1.3, 0.9},
		Aligns:  []string{"L", "R", "R", "R", "R"},
		Rows: [][]string{
			{
				"Productos con código y costo real registrado",
				fmtCOP(r.KnownSales), fmtCOP(r.KnownCost), fmtCOP(r.KnownProfit),
				fmtPercent(safeDiv(r.KnownProfit, r.KnownSales)),
			},
			{
				uncostedLabel,
				fmtCOP(r.UncostedSales), fmtCOP(r.UncostedCost), fmtCOP(r.UncostedProfit),
				fmtPercent(safeDiv(r.UncostedProfit, r.UncostedSales)),
			},
		},
		Total: []string{
			"TOTAL AUDITADO DEL MES",
			fmtCOP(r.TotalSales), fmtCOP(r.TotalCost), fmtCOP(r.GrossProfit),
			fmtPercent(r.OverallMargin),
		},
	})

	if a := r.Audited; a != nil && a.ClosureCount > 0 {
		d.hint(fmt.Sprintf(
			"Composición de los %s auditados en %d cierres de caja: efectivo contado %s  ·  canales digitales %s  ·  "+
				"egresos pagados en efectivo %s  ·  devoluciones %s. Como referencia, el sistema registró %s en ventas "+
				"y el detalle por producto suma %s.",
			fmtCOP(a.Total), a.ClosureCount, fmtCOP(a.PhysicalCash), fmtCOP(a.Digital),
			fmtCOP(a.CashExpenses), fmtCOP(a.Returns),
			fmtCOP(r.SalesFromRegister), fmtCOP(r.SalesFromDetails)))
	}

	// -----------------------------------------------------------
	// 3. Gastos del local
	// -----------------------------------------------------------
	d.sectionTitle("3. Gastos del local (no incluye proveedores)")

	d.table(execTable{
		Headers: []string{"Concepto", "Monto del mes"},
		Weights: []float64{3, 1.2},
		Aligns:  []string{"L", "R"},
		Rows: [][]string{
			{"Sueldos y nómina del personal", fmtCOP(r.PayrollExp)},
			{"Arriendo del local", fmtCOP(r.RentExp)},
			{"Servicios públicos (luz, agua, gas, internet)", fmtCOP(r.PublicServicesExp)},
			{"Imprevistos, aseo, arreglos y daños", fmtCOP(r.MaintenanceExp)},
			{"Obligaciones y gastos bancarios (cuotas, intereses)", fmtCOP(r.FinancialExp)},
			{"Otros gastos del local", fmtCOP(r.OtherOpExp)},
		},
	})
	d.strip("Total de gastos del local", fmtCOP(r.TotalOpExpenses), coralColor, coralInk)
	d.ln(2)

	if len(r.OpExpenseItems) > 0 {
		d.sectionTitle("3.1 Detalle de cada gasto del local")
		rows := make([][]string, 0, len(r.OpExpenseItems))
		limit := len(r.OpExpenseItems)
		if limit > profitPDFMaxDetailRows {
			limit = profitPDFMaxDetailRows
		}
		for i := 0; i < limit; i++ {
			it := r.OpExpenseItems[i]
			source := it.PaymentSource
			if source == "" {
				source = "FONDO"
			}
			rows = append(rows, []string{
				it.Date.Format("02/01/2006"),
				it.Category,
				it.Description,
				source,
				fmtCOP(it.Amount),
			})
		}
		d.table(execTable{
			Headers:  []string{"Fecha", "Categoría", "Detalle del gasto", "Pagado con", "Monto"},
			Weights:  []float64{1, 1.3, 3, 1.1, 1.2},
			Aligns:   []string{"C", "L", "L", "L", "R"},
			Rows:     rows,
			FontSize: 8,
		})
		if len(r.OpExpenseItems) > limit {
			d.hint(fmt.Sprintf("Se muestran los primeros %d gastos de %d registrados en el período.", limit, len(r.OpExpenseItems)))
		}
	}

	// -----------------------------------------------------------
	// 4. Movimiento del efectivo
	// -----------------------------------------------------------
	d.sectionTitle("4. Movimiento del dinero")
	d.cards([]execCard{
		{Label: "Efectivo que entró a caja", Value: fmtCOP(r.TotalCashInflows)},
		{Label: "Efectivo gastado en el local", Value: fmtCOP(r.CashExpenses), Bg: coralColor, Fg: coralInk},
		{Label: "Ventas por transferencia", Value: fmtCOP(r.TransferSales)},
		{Label: "Ventas fiadas del mes", Value: fmtCOP(r.CreditSales), Bg: amberColor, Fg: amberInk},
	})
	d.hint(fmt.Sprintf(
		"Ventas en efectivo %s  ·  abonos de clientes recibidos en efectivo %s  ·  saldo de caja del período %s.",
		fmtCOP(r.CashSales), fmtCOP(r.CreditPaymentsCash), fmtCOP(r.NetCashBalance)))

	// -----------------------------------------------------------
	// 5. Saldos al cierre -> base del mes siguiente
	// -----------------------------------------------------------
	d.sectionTitle("5. Disponibilidad de dinero al cierre del mes")

	if a := r.Audited; a != nil && a.Closing.HasData {
		c := a.Closing
		d.table(execTable{
			Headers: []string{"Dónde está el dinero guardado", "Saldo al cierre"},
			Weights: []float64{3, 1.2},
			Aligns:  []string{"L", "R"},
			Rows: [][]string{
				{"Efectivo real en mano (caja / fondo)", fmtCOP(c.Cash)},
				{"Nequi (billetera digital)", fmtCOP(c.Nequi)},
				{"Daviplata (billetera digital)", fmtCOP(c.Daviplata)},
			},
		})
		d.strip("(=) TOTAL GENERAL GUARDADO (CAJA + DIGITAL)", fmtCOP(c.Total), mintColor, mintInkColor)
		d.ln(2)
		d.hint(closingBalanceNote(c, r.TotalSales))
		d.hint("Estas cifras son las mismas que muestra la tarjeta \"TOTAL GENERAL GUARDADO\" del Centro de " +
			"Control: la fotografía del saldo real acumulado disponible al corte del período, no la sumatoria de los ingresos del mes.")
	} else {
		d.hint("No hay cierres de caja registrados en el período, por lo que no se puede fotografiar el saldo final del mes.")
	}

	// -----------------------------------------------------------
	// 6. Balance patrimonial: deudas activas vs. cartera
	// -----------------------------------------------------------
	d.sectionTitle("6. Balance: lo que el negocio debe y lo que le deben")

	d.cards([]execCard{
		{Label: "Deudas activas por pagar", Value: fmtCOP(r.TotalDebtsPayable), Bg: coralColor, Fg: coralInk,
			Note: fmt.Sprintf("%d cuentas pendientes", len(r.DebtsPayable))},
		{Label: "Cartera por cobrar (fiados)", Value: fmtCOP(r.TotalCreditReceivable), Bg: amberColor, Fg: amberInk,
			Note: fmt.Sprintf("%d clientes", len(r.CreditReceivables))},
		{Label: "Balance neto", Value: fmtCOP(r.TotalCreditReceivable - r.TotalDebtsPayable),
			Note: "por cobrar menos por pagar"},
	})

	// 6.1 Deudas activas (Centro de Pagos)
	d.sectionTitle("6.1 Deudas activas del negocio (Centro de Pagos)")
	d.strip(fmt.Sprintf("TOTAL POR PAGAR  ·  %d deudas activas", len(r.DebtsPayable)),
		fmtCOP(r.TotalDebtsPayable), coralColor, coralInk)
	d.ln(2)
	d.hint("Mercancía e insumos que ya están operando en el supermercado pero se encuentran pendientes de pago " +
		"a proveedores. Estas deudas NO se restan de la ganancia libre: el costo de esa mercancía ya está " +
		"contado en el Paso 2.")

	if len(r.DebtsPayable) > 0 {
		rows := make([][]string, 0, len(r.DebtsPayable))
		for _, p := range r.DebtsPayable {
			creditor := p.ProviderName
			if creditor == "" {
				creditor = "Acreedor varios"
			}
			concept := p.Concept
			if concept == "" {
				concept = "Deuda pendiente"
			}
			rows = append(rows, []string{creditor, concept, fmtCOP(p.Balance)})
		}
		d.table(execTable{
			Headers: []string{"A quién se le debe", "Concepto / Detalle", "Monto pendiente"},
			Weights: []float64{2.2, 3, 1.4},
			Aligns:  []string{"L", "L", "R"},
			Rows:    rows,
			Total:   []string{"TOTAL POR PAGAR", "", fmtCOP(r.TotalDebtsPayable)},
		})
	} else {
		d.hint("El negocio no tiene deudas activas registradas en el Centro de Pagos.")
	}

	// 6.2 Cartera por cobrar
	d.sectionTitle("6.2 Plata que los clientes le deben al supermercado (fiado)")
	d.strip(fmt.Sprintf("TOTAL POR COBRAR  ·  %d clientes", len(r.CreditReceivables)),
		fmtCOP(r.TotalCreditReceivable), amberColor, amberInk)
	d.ln(2)

	if len(r.CreditReceivables) > 0 {
		rows := make([][]string, 0, len(r.CreditReceivables))
		for _, c := range r.CreditReceivables {
			dni := c.ClientDNI
			if dni == "" {
				dni = "Sin cédula"
			}
			phone := c.Phone
			if phone == "" {
				phone = "Sin teléfono"
			}
			rows = append(rows, []string{c.ClientName, dni, phone, fmtCOP(c.Balance)})
		}
		d.table(execTable{
			Headers: []string{"Cliente", "Cédula", "Teléfono", "Saldo que debe"},
			Weights: []float64{2.6, 1.3, 1.3, 1.4},
			Aligns:  []string{"L", "L", "L", "R"},
			Rows:    rows,
			Total:   []string{"TOTAL POR COBRAR", "", "", fmtCOP(r.TotalCreditReceivable)},
		})
	} else {
		d.hint("Ningún cliente tiene saldo pendiente de fiado.")
	}

	// -----------------------------------------------------------
	// 7. ¿Dónde está repartida la ganancia del mes?
	// -----------------------------------------------------------
	if w := r.WorkingCapital; w != nil && w.HasData {
		d.sectionTitle("7. ¿Dónde está repartida la ganancia del mes?")

		// 7.1 Mercancía en el local: 1 vs. último día del mes
		d.cards([]execCard{
			{Label: "Mercancía al iniciar el mes", Value: fmtCOP(w.InventoryOpening)},
			{Label: "Mercancía al cerrar el mes", Value: fmtCOP(w.InventoryClosing)},
			{Label: "Variación del surtido", Value: fmtCOPSigned(w.InventoryDelta),
				Bg: inventoryTone(w.InventoryDelta), Fg: inventoryInk(w.InventoryDelta)},
		})
		d.hint(InventoryNarrative(r.From, r.To, w.InventoryOpening, w.InventoryClosing))

		// 7.2 Distribución de la ganancia
		rows := make([][]string, 0, 5)
		for _, l := range w.Distribution() {
			rows = append(rows, []string{
				l.Concept,
				fmtCOPSigned(l.Delta),
				l.Meaning,
			})
		}
		d.table(execTable{
			Headers:  []string{"¿Dónde está la ganancia?", "Monto del mes", "Qué significa para el negocio"},
			Weights:  []float64{2.2, 1.2, 3},
			Aligns:   []string{"L", "R", "L"},
			Rows:     rows,
			FontSize: 8.5,
			Total: []string{
				"(=) TOTAL GANANCIA LIBRE REAL", fmtCOP(w.NetProfit), "Utilidad del mes distribuida y auditada",
			},
		})

		d.resultBox(0, "Ganancia libre real del mes, distribuida",
			fmtCOP(w.NetProfit), "Suma exacta de las filas de arriba", w.NetProfit >= 0)

		d.hint(fmt.Sprintf(
			"Resumen de auditoría: la ganancia libre del mes (%s) no se encuentra toda en dinero físico en la caja "+
				"porque el negocio funciona con un capital rotativo. Al comparar el inicio contra el cierre del mes se "+
				"evidencia que una parte de la ganancia está reflejada en mayor cantidad de mercancía surtida en el local "+
				"(inventario), otra parte se encuentra en facturas por cobrar a clientes (fiados) y el resto corresponde al "+
				"efectivo y saldo en cuentas con el que cerró el mes.",
			fmtCOP(w.NetProfit)))

		d.hint(fmt.Sprintf(
			"Trazabilidad de las cifras: el efectivo inicial y final salen del acumulado de cierres de caja "+
				"(la misma fuente de la tarjeta \"TOTAL GENERAL GUARDADO\" del Centro de Control). La mercancía se "+
				"valoró al costo de compra actual usando el libro de movimientos de inventario. La cartera y las "+
				"deudas se reconstruyeron con los movimientos del mes: se fiaron %s y los clientes abonaron %s; "+
				"nació deuda nueva por %s y se pagó mercancía por %s.",
			fmtCOP(w.CreditSalesInPeriod), fmtCOP(w.CreditPaymentsInPeriod),
			fmtCOP(w.NewDebtInPeriod), fmtCOP(w.DebtPaidInPeriod)))

		// -----------------------------------------------------------
		// 7.1 Dinero líquido ("Libre Libre") vs. mercancía
		// -----------------------------------------------------------
		liq := w.Liquidity
		d.sectionTitle("7.1. ¿Cuánto quedó en dinero \"Libre Libre\" vs. invertido en mercancía?")

		d.cards([]execCard{
			{
				Label: "Atrapado en mercancía (surtido)",
				Value: fmtCOP(liq.InMerchandise),
				Note:  fmtPercent(liq.MerchandisePct) + " de la ganancia",
				Bg:    amberColor, Fg: amberInk,
			},
			{
				Label: "Dinero líquido (\"Libre Libre\")",
				Value: fmtCOP(liq.Liquid),
				Note:  fmtPercent(liq.LiquidPct) + " de la ganancia",
				Bg:    liquidityTone(liq.Liquid), Fg: liquidityInk(liq.Liquid),
			},
			{
				Label: "Ganancia libre del mes",
				Value: fmtCOP(liq.NetProfit),
				Note:  "100% de la utilidad",
			},
		})

		d.hint(liq.Explanation)
	}

	return d.buffer()
}

// liquidityTone / liquidityInk colorean la tarjeta de dinero líquido:
// verde si quedó plata disponible, coral si no.
func liquidityTone(liquid float64) pdfColor {
	if liquid <= 0 {
		return coralColor
	}
	return mintColor
}

func liquidityInk(liquid float64) pdfColor {
	if liquid <= 0 {
		return coralInk
	}
	return mintInkColor
}

// inventoryTone / inventoryInk colorean la variación de inventario según
// si el surtido creció o bajó.
func inventoryTone(delta float64) pdfColor {
	if delta < 0 {
		return coralColor
	}
	return mintColor
}

func inventoryInk(delta float64) pdfColor {
	if delta < 0 {
		return coralInk
	}
	return mintInkColor
}

func safeDiv(a, b float64) float64 {
	if b == 0 {
		return 0
	}
	return a / b
}

func closingBalanceNote(c ClosingBalances, auditedTotal float64) string {
	if c.ClosureID == 0 {
		return "Para este período histórico pasado, la disponibilidad al cierre se omite ($ 0) por configuración del reporte."
	}
	return fmt.Sprintf(
		"Este dinero es el saldo que quedó en los bolsillos y cuentas del supermercado al cierre del %s "+
			"(turno #%d, cerrado por %s), proveniente de los %s que ingresaron en el mes menos todas las salidas. "+
			"Este monto constituye la BASE O SALDO INICIAL con el que arranca el mes siguiente.",
		c.ClosedAt.Format("02/01/2006 03:04 PM"), c.ClosureID, c.ClosedByName, fmtCOP(auditedTotal))
}
