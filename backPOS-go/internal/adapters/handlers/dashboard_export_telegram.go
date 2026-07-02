package handlers

import (
	"fmt"
	"math"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
)

func (h *DashboardExportHandler) formatAggregatedClosureReport(closures []models.CashierClosure, expenses []models.Expense, payments []models.CreditPayment, from, to time.Time) string {
	title := "🧾 *REPORTE MENSUAL CONSOLIDADO*"

	var totalExpectedCash, totalPhysicalCash, totalNequi, totalDaviplata, totalCard, totalBancolombia, totalOtherTransfer float64
	var totalCash, totalExpenses, totalReturns float64

	for _, c := range closures {
		totalPhysicalCash += c.PhysicalCash
		totalNequi += c.TotalNequi
		totalDaviplata += c.TotalDaviplata
		totalCard += c.TotalCard
		totalBancolombia += c.TotalBancolombia
		totalOtherTransfer += c.TotalOtherTransfer
		totalCash += c.TotalCash
		totalExpenses += c.TotalExpenses
		totalReturns += c.TotalReturns
		
		expectedCash := c.ExpectedCash
		if expectedCash == 0 {
			expectedCash = c.TotalCash - c.TotalExpenses - c.TotalReturns
		}
		totalExpectedCash += expectedCash
	}

	normalizeExpensesForReport(expenses)

	egresosEfectivoTotal := 0.0
	for _, e := range expenses {
		egresosEfectivoTotal += e.CashAmount
	}

	ingresosDigitales := totalNequi + totalDaviplata + totalCard + totalBancolombia + totalOtherTransfer
	ventaReal := totalExpectedCash + ingresosDigitales + egresosEfectivoTotal
	diferenciaFisica := totalPhysicalCash - totalExpectedCash

	// Variables auxiliares para la vista
	diferenciaFisicaAbs := diferenciaFisica
	if diferenciaFisicaAbs < 0 {
		diferenciaFisicaAbs = -diferenciaFisicaAbs
	}
	diferenciaIcon := "🟢 SOBRANTE"
	if diferenciaFisica < 0 {
		diferenciaIcon = "🔴 FALTANTE"
	}

	loc := time.FixedZone("America/Bogota", -5*60*60)
	
	var msg strings.Builder

	msg.WriteString(fmt.Sprintf("%s\n", title))
	msg.WriteString("━━━━━━━━━━━━━━━━━━━━\n")
	msg.WriteString(fmt.Sprintf("📅 *RANGO:* `%s` a `%s`\n", from.In(loc).Format("02/01/2006"), to.In(loc).Format("02/01/2006")))
	msg.WriteString("━━━━━━━━━━━━━━━━━━━━\n\n")

	msg.WriteString("🧮 *VENTA REAL DEL PERIODO*\n")
	msg.WriteString(fmt.Sprintf("💰 *TOTAL VENTAS:* `$%s`\n", formatCOP(ventaReal)))
	msg.WriteString("📋 _(Efectivo Esperado + Digital + Egresos Caja)_\n\n")

	msg.WriteString("💵 *1. RESUMEN DE CAJA (ARQUEO FÍSICO)*\n")
	msg.WriteString(fmt.Sprintf("▫️ Efectivo Esperado:  `$%s`\n", formatCOP(totalExpectedCash)))
	msg.WriteString(fmt.Sprintf("▫️ Efectivo Contado:   `$%s`\n", formatCOP(totalPhysicalCash)))
	msg.WriteString("────────────────────\n")
	msg.WriteString(fmt.Sprintf("🚨 *DIFERENCIA FÍSICA:* %s `$%s`\n\n", diferenciaIcon, formatCOP(diferenciaFisicaAbs)))

	msg.WriteString("📱 *2. MEDIOS DIGITALES Y OTROS*\n")
	msg.WriteString(fmt.Sprintf("▫️ Nequi:      `$%s`\n", formatCOP(totalNequi)))
	msg.WriteString(fmt.Sprintf("▫️ Daviplata:  `$%s`\n", formatCOP(totalDaviplata)))
	msg.WriteString(fmt.Sprintf("▫️ Tarjeta:    `$%s`\n", formatCOP(totalCard)))
	if totalBancolombia+totalOtherTransfer > 0 {
		msg.WriteString(fmt.Sprintf("▫️ Otros:      `$%s`\n", formatCOP(totalBancolombia+totalOtherTransfer)))
	}
	msg.WriteString("────────────────────\n")
	msg.WriteString(fmt.Sprintf("📲 *TOTAL DIGITAL:*  `$%s`\n\n", formatCOP(ingresosDigitales)))

	msg.WriteString("💸 *3. EGRESOS DETALLADOS POR CANAL*\n")
	
	type splitExpense struct {
		Desc   string
		Amount float64
	}
	egresosAgrupados := make(map[string][]splitExpense)
	
	totalEfectivoCanal := 0.0
	totalFondo := 0.0
	totalPrestamos := 0.0
	
	for _, e := range expenses {
		if e.CashAmount > 0 {
			egresosAgrupados["EFECTIVO"] = append(egresosAgrupados["EFECTIVO"], splitExpense{Desc: e.Description, Amount: e.CashAmount})
			totalEfectivoCanal += e.CashAmount
		}
		if e.NequiAmount > 0 {
			egresosAgrupados["NEQUI"] = append(egresosAgrupados["NEQUI"], splitExpense{Desc: e.Description, Amount: e.NequiAmount})
		}
		if e.DaviplataAmount > 0 {
			egresosAgrupados["DAVIPLATA"] = append(egresosAgrupados["DAVIPLATA"], splitExpense{Desc: e.Description, Amount: e.DaviplataAmount})
		}
		if e.FondoAmount > 0 {
			egresosAgrupados["FONDO"] = append(egresosAgrupados["FONDO"], splitExpense{Desc: e.Description, Amount: e.FondoAmount})
			totalFondo += e.FondoAmount
		}
		
		sumPaid := e.CashAmount + e.NequiAmount + e.DaviplataAmount + e.FondoAmount
		if e.Status == "PENDING" && math.Round(e.Amount-sumPaid) > 0 {
			diff := e.Amount - sumPaid
			egresosAgrupados["PRESTAMO"] = append(egresosAgrupados["PRESTAMO"], splitExpense{Desc: e.Description, Amount: diff})
			totalPrestamos += diff
		}
	}

	canalesOrder := []string{"EFECTIVO", "NEQUI", "DAVIPLATA", "FONDO", "PRESTAMO"}
	for k := range egresosAgrupados {
		found := false
		for _, c := range canalesOrder {
			if c == k {
				found = true
				break
			}
		}
		if !found {
			canalesOrder = append(canalesOrder, k)
		}
	}

	hayEgresos := false
	for _, canal := range canalesOrder {
		egresosCanal := egresosAgrupados[canal]
		if len(egresosCanal) > 0 {
			hayEgresos = true
			totalCanal := 0.0
			for _, e := range egresosCanal {
				totalCanal += e.Amount
			}
			msg.WriteString(fmt.Sprintf("📍 *%s:* `$%s`\n", canal, formatCOP(totalCanal)))
			for _, e := range egresosCanal {
				msg.WriteString(fmt.Sprintf("   • %s: `$%s`\n", e.Desc, formatCOP(e.Amount)))
			}
		}
	}
	if !hayEgresos {
		msg.WriteString("_Sin egresos registrados._\n")
	}

	msg.WriteString("────────────────────\n")
	msg.WriteString(fmt.Sprintf("▫️ Total gastado de la Venta del periodo (Efectivo): `$%s`\n", formatCOP(totalEfectivoCanal)))
	msg.WriteString(fmt.Sprintf("▫️ Total gastado del Fondo (Plata de adentro): `$%s`\n", formatCOP(totalFondo)))
	msg.WriteString(fmt.Sprintf("▫️ Total gastado de Préstamos (Plata de afuera): `$%s`\n", formatCOP(totalPrestamos)))
	msg.WriteString("\n")

	msg.WriteString("🤝 *4. ABONOS RECIBIDOS*\n")
	totalAbonos := 0.0
	for _, p := range payments {
		totalAbonos += p.TotalPaid
	}

	msg.WriteString(fmt.Sprintf("📍 *ABONOS RECIBIDOS:* `$%s`\n", formatCOP(totalAbonos)))
	if len(payments) > 0 {
		for _, p := range payments {
			name := p.Client.Name
			if name == "" {
				name = p.ClientDNI
			}
			msg.WriteString(fmt.Sprintf("   • %s: `$%s`\n", name, formatCOP(p.TotalPaid)))
		}
	} else {
		msg.WriteString("   _Sin abonos recibidos._\n")
	}
	msg.WriteString("\n")

	msg.WriteString("━━━━━━━━━━━━━━━━━━━━\n")
	msg.WriteString("_Generado por POS Pro_")

	return msg.String()
}
