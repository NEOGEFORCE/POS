package services

import (
	"bytes"
	"fmt"
	"strings"
	"time"

	"github.com/jung-kurt/gofpdf"
	"backPOS-go/internal/core/domain/models"
)

type ClosurePrintData struct {
	Title              string
	SubTitle           string
	Cajero             string
	RangoFechaStr      string
	TurnoStr           string
	IDStr              string
	PhysicalCash       float64
	TotalNequi         float64
	TotalDaviplata     float64
	TotalCard          float64
	TotalBancolombia   float64
	TotalOtherTransfer float64
	TotalCash          float64
	TotalExpenses      float64
	TotalReturns       float64
	ExpectedCash       float64
	CashBills          float64
	Coins1000          float64
	Coins500           float64
	Coins200           float64
	Coins100           float64
	Expenses           []models.Expense
	Payments           []models.CreditPayment
}

// GenerateConsolidatedClosurePDF genera el PDF consolidado estilo "Cierre Profesional"
func (s *ExportService) GenerateConsolidatedClosurePDF(closures []models.CashierClosure, expenses []models.Expense, payments []models.CreditPayment, from, to time.Time) (*bytes.Buffer, error) {
	pdf := gofpdf.New("P", "mm", "A4", "")
	tr := pdf.UnicodeTranslatorFromDescriptor("")
	loc := time.FixedZone("America/Bogota", -5*60*60)

	drawClosureData := func(data ClosurePrintData) {
		pdf.AddPage()
		
		// --- CABECERA EMPRESARIAL (B&W) ---
		pdf.SetFont("Arial", "B", 20)
		pdf.SetTextColor(0, 0, 0)
		pdf.CellFormat(190, 15, tr(data.Title), "0", 1, "C", false, 0, "")
		
		pdf.SetFont("Arial", "B", 11)
		pdf.SetTextColor(50, 50, 50)
		pdf.CellFormat(190, 6, tr(data.SubTitle), "0", 1, "C", false, 0, "")

		// Metadatos en Grid
		pdf.SetDrawColor(0, 0, 0)
		pdf.SetLineWidth(0.1)
		pdf.SetFont("Arial", "B", 8)
		pdf.SetTextColor(0, 0, 0)
		
		currY := pdf.GetY() + 5
		pdf.SetY(currY)
		pdf.CellFormat(35, 7, tr(" CAJERO / AUTOR:"), "LT", 0, "L", false, 0, "")
		pdf.SetFont("Arial", "", 8)
		pdf.CellFormat(60, 7, tr(" "+data.Cajero), "T", 0, "L", false, 0, "")
		pdf.SetFont("Arial", "B", 8)
		pdf.CellFormat(45, 7, tr(" FECHA IMPRESION:"), "T", 0, "L", false, 0, "")
		pdf.SetFont("Arial", "", 8)
		pdf.CellFormat(50, 7, tr(" "+time.Now().In(loc).Format("02/01/2006 15:04")), "RT", 1, "L", false, 0, "")
		
		pdf.SetFont("Arial", "B", 8)
		pdf.CellFormat(35, 7, tr(" " + data.RangoFechaStr), "LB", 0, "L", false, 0, "")
		pdf.SetFont("Arial", "", 8)
		pdf.CellFormat(60, 7, tr(" " + data.TurnoStr), "B", 0, "L", false, 0, "")
		pdf.SetFont("Arial", "B", 8)
		pdf.CellFormat(45, 7, tr(" ID / REF:"), "B", 0, "L", false, 0, "")
		pdf.SetFont("Arial", "", 8)
		pdf.CellFormat(50, 7, tr(" " + data.IDStr), "RB", 1, "L", false, 0, "")
		
		pdf.SetLineWidth(0.6)
		pdf.Line(10, pdf.GetY()+3, 200, pdf.GetY()+3)
		pdf.Ln(8)

		expectedCash := data.ExpectedCash
		if expectedCash == 0 {
			expectedCash = data.TotalCash - data.TotalExpenses - data.TotalReturns
		}

		digitalIncome := data.TotalNequi + data.TotalDaviplata + data.TotalCard + data.TotalBancolombia + data.TotalOtherTransfer
		realBalance := data.PhysicalCash + digitalIncome - data.TotalExpenses

		boxY := pdf.GetY()
		
		// Efectivo Fisico
		pdf.SetFillColor(255, 255, 255)
		pdf.SetDrawColor(0, 0, 0)
		pdf.SetLineWidth(0.2)
		pdf.Rect(10, boxY, 60, 18, "D")
		pdf.SetXY(10, boxY + 2)
		pdf.SetFont("Arial", "B", 7)
		pdf.CellFormat(60, 5, tr("EFECTIVO FISICO"), "0", 1, "C", false, 0, "")
		pdf.SetFont("Arial", "B", 12)
		pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(data.PhysicalCash)), "0", 1, "C", false, 0, "")

		// Digital - Egresos
		pdf.Rect(75, boxY, 60, 18, "D")
		pdf.SetXY(75, boxY + 2)
		pdf.SetFont("Arial", "B", 7)
		pdf.CellFormat(60, 5, tr("DIGITAL - EGRESOS"), "0", 1, "C", false, 0, "")
		pdf.SetFont("Arial", "B", 12)
		netDigital := digitalIncome - data.TotalExpenses
		pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(netDigital)), "0", 1, "C", false, 0, "")

		// Balance Real
		pdf.SetFillColor(230, 245, 230)
		pdf.Rect(140, boxY, 60, 18, "DF")
		pdf.SetXY(140, boxY + 2)
		pdf.SetFont("Arial", "B", 7)
		pdf.CellFormat(60, 5, tr("BALANCE REAL"), "0", 1, "C", false, 0, "")
		pdf.SetFont("Arial", "B", 12)
		pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(realBalance)), "0", 1, "C", false, 0, "")
		
		pdf.SetY(boxY + 25)

		pdf.SetFont("Arial", "I", 8)
		pdf.CellFormat(190, 5, tr(fmt.Sprintf("* Efectivo Esperado por Sistema (Informativo): $%s", formatCOP(expectedCash))), "0", 1, "L", false, 0, "")
		pdf.Ln(2)

		drawTable := func(title string, headers []string, widths []float64, rows [][]string) {
			if pdf.GetY() > 250 { pdf.AddPage() }
			pdf.SetFont("Arial", "B", 10)
			pdf.CellFormat(190, 8, tr(title), "0", 1, "L", false, 0, "")
			
			pdf.SetFillColor(229, 231, 235)
			pdf.SetFont("Arial", "B", 8)
			for i, h := range headers {
				pdf.CellFormat(widths[i], 7, tr(h), "1", 0, "C", true, 0, "")
			}
			pdf.Ln(-1)
			
			pdf.SetFont("Arial", "", 8)
			for _, row := range rows {
				if pdf.GetY() > 270 {
					pdf.AddPage()
					pdf.SetFillColor(229, 231, 235)
					pdf.SetFont("Arial", "B", 8)
					for i, h := range headers {
						pdf.CellFormat(widths[i], 7, tr(h), "1", 0, "C", true, 0, "")
					}
					pdf.Ln(-1)
					pdf.SetFont("Arial", "", 8)
				}
				maxLines := 1
				for i, val := range row {
					lines := len(pdf.SplitLines([]byte(tr(val)), widths[i]-2))
					if lines > maxLines { maxLines = lines }
				}
				rowHeight := float64(maxLines) * 5.0
				if rowHeight < 7 { rowHeight = 7 }
				
				if pdf.GetY()+rowHeight > 270 {
					pdf.AddPage()
					pdf.SetFillColor(229, 231, 235)
					pdf.SetFont("Arial", "B", 8)
					for i, h := range headers {
						pdf.CellFormat(widths[i], 7, tr(h), "1", 0, "C", true, 0, "")
					}
					pdf.Ln(-1)
					pdf.SetFont("Arial", "", 8)
				}

				currX, currYTable := pdf.GetX(), pdf.GetY()
				for i, val := range row {
					align := "L"
					if i == len(row)-1 { align = "R" }
					
					pdf.Rect(currX, currYTable, widths[i], rowHeight, "D")
					pdf.SetXY(currX, currYTable)
					
					if maxLines > 1 && i == 0 {
						pdf.MultiCell(widths[i], 5, tr(val), "", align, false)
					} else {
						yOffset := (rowHeight - 5) / 2
						pdf.SetXY(currX, currYTable+yOffset)
						pdf.CellFormat(widths[i], 5, tr(val), "", 0, align, false, 0, "")
					}
					currX += widths[i]
				}
				pdf.SetXY(10, currYTable+rowHeight)
			}
			pdf.Ln(5)
		}

		drawTable("DETALLE OPERATIVO DE CAJA", 
			[]string{"Concepto", "Monto"}, 
			[]float64{130, 60}, 
			[][]string{
				{"(+) Ingresos en Efectivo (Ventas + Recaudos)", fmt.Sprintf("$%s", formatCOP(data.TotalCash))},
				{"(-) Gastos y Egresos Operativos", fmt.Sprintf("$%s", formatCOP(data.TotalExpenses))},
				{"(-) Devoluciones de Mercancia", fmt.Sprintf("$%s", formatCOP(data.TotalReturns))},
				{"(=) BALANCE TEORICO EN CAJA", fmt.Sprintf("$%s", formatCOP(expectedCash))},
			})

		drawTable("DESGLOSE DE EFECTIVO REPORTADO", 
			[]string{"Denominacion", "Monto"}, 
			[]float64{130, 60}, 
			[][]string{
				{"Billetes", fmt.Sprintf("$%s", formatCOP(data.CashBills))},
				{"Monedas 1000", fmt.Sprintf("$%s", formatCOP(data.Coins1000))},
				{"Monedas 500", fmt.Sprintf("$%s", formatCOP(data.Coins500))},
				{"Monedas 200", fmt.Sprintf("$%s", formatCOP(data.Coins200))},
				{"Monedas 100", fmt.Sprintf("$%s", formatCOP(data.Coins100))},
			})

		methods := []string{"EFECTIVO", "NEQUI", "DAVIPLATA", "FONDO"}
		for _, m := range methods {
			var rows [][]string
			total := 0.0
			for _, e := range data.Expenses {
				eMethod := strings.ToUpper(e.PaymentSource)
				if eMethod == "" || eMethod == "CAJA" { eMethod = "EFECTIVO" }
				if eMethod == m {
					desc := fmt.Sprintf("%s - %s", e.Date.In(loc).Format("02/01"), e.Description)
					rows = append(rows, []string{desc, fmt.Sprintf("$%s", formatCOP(e.Amount))})
					total += e.Amount
				}
			}
			if len(rows) > 0 {
				rows = append(rows, []string{fmt.Sprintf("TOTAL EGRESOS %s", m), fmt.Sprintf("$%s", formatCOP(total))})
				drawTable(fmt.Sprintf("EGRESOS: %s", m), []string{"Descripcion", "Monto"}, []float64{140, 50}, rows)
			}
		}

		drawTable("CANALES DIGITALES (TRANSFERENCIAS)", 
			[]string{"Nequi", "Daviplata", "Tarjeta", "Otros"}, 
			[]float64{47.5, 47.5, 47.5, 47.5}, 
			[][]string{
				{fmt.Sprintf("$%s", formatCOP(data.TotalNequi)), fmt.Sprintf("$%s", formatCOP(data.TotalDaviplata)), fmt.Sprintf("$%s", formatCOP(data.TotalCard)), fmt.Sprintf("$%s", formatCOP(data.TotalBancolombia+data.TotalOtherTransfer))},
			})

		if len(data.Payments) > 0 {
			var rows [][]string
			totalAbonos := 0.0
			for _, p := range data.Payments {
				name := p.Client.Name
				if name == "" { name = p.ClientDNI }
				if name == "" { name = "Cliente" }
				desc := fmt.Sprintf("%s - %s", p.PaymentDate.In(loc).Format("02/01"), name)
				rows = append(rows, []string{desc, fmt.Sprintf("$%s", formatCOP(p.TotalPaid))})
				totalAbonos += p.TotalPaid
			}
			rows = append(rows, []string{"TOTAL ABONOS RECIBIDOS", fmt.Sprintf("$%s", formatCOP(totalAbonos))})
			drawTable("ABONOS RECIBIDOS", []string{"Fecha/Cliente", "Monto Abono"}, []float64{140, 50}, rows)
		}
	}

	// 1. DIBUJAR LOS CIERRES INDIVIDUALES
	var totalExpectedCash, totalPhysicalCash, totalNequi, totalDaviplata, totalCard, totalBancolombia, totalOtherTransfer float64
	var totalCash, totalExpenses, totalReturns float64
	var totalCashBills, totalCoins1000, totalCoins500, totalCoins200, totalCoins100 float64

	for _, c := range closures {
		totalExpectedCash += c.ExpectedCash
		totalPhysicalCash += c.PhysicalCash
		totalNequi += c.TotalNequi
		totalDaviplata += c.TotalDaviplata
		totalCard += c.TotalCard
		totalBancolombia += c.TotalBancolombia
		totalOtherTransfer += c.TotalOtherTransfer
		totalCash += c.TotalCash
		totalExpenses += c.TotalExpenses
		totalReturns += c.TotalReturns
		totalCashBills += c.CashBills
		totalCoins1000 += c.Coins1000
		totalCoins500 += c.Coins500
		totalCoins200 += c.Coins200
		totalCoins100 += c.Coins100

		var cExp []models.Expense
		for _, e := range expenses {
			if !e.Date.Before(c.StartDate) && (c.EndDate.IsZero() || !e.Date.After(c.EndDate)) {
				cExp = append(cExp, e)
			}
		}
		var cPay []models.CreditPayment
		for _, p := range payments {
			if !p.PaymentDate.Before(c.StartDate) && (c.EndDate.IsZero() || !p.PaymentDate.After(c.EndDate)) {
				cPay = append(cPay, p)
			}
		}

		drawClosureData(ClosurePrintData{
			Title:              "SUPERMERCADO SURTIFAMILIAR",
			SubTitle:           "AUDITORIA OFICIAL DE CIERRE DE CAJA",
			Cajero:             c.ClosedByName,
			RangoFechaStr:      "FECHA:",
			TurnoStr:           c.StartDate.In(loc).Format("02/01/2006 15:04"),
			IDStr:              fmt.Sprintf("CC-%d", c.ID),
			PhysicalCash:       c.PhysicalCash,
			TotalNequi:         c.TotalNequi,
			TotalDaviplata:     c.TotalDaviplata,
			TotalCard:          c.TotalCard,
			TotalBancolombia:   c.TotalBancolombia,
			TotalOtherTransfer: c.TotalOtherTransfer,
			TotalCash:          c.TotalCash,
			TotalExpenses:      c.TotalExpenses,
			TotalReturns:       c.TotalReturns,
			ExpectedCash:       c.ExpectedCash,
			CashBills:          c.CashBills,
			Coins1000:          c.Coins1000,
			Coins500:           c.Coins500,
			Coins200:           c.Coins200,
			Coins100:           c.Coins100,
			Expenses:           cExp,
			Payments:           cPay,
		})
	}

	// 2. DIBUJAR EL REPORTE CONSOLIDADO AL FINAL
	drawClosureData(ClosurePrintData{
		Title:              "SUPERMERCADO SURTIFAMILIAR",
		SubTitle:           "REPORTE CONSOLIDADO DE CIERRES",
		Cajero:             "MULTIPLE (SISTEMA)",
		RangoFechaStr:      "RANGO DE FECHAS:",
		TurnoStr:           fmt.Sprintf("%s al %s", from.In(loc).Format("02/01/2006"), to.In(loc).Format("02/01/2006")),
		IDStr:              fmt.Sprintf("%d TURNOS", len(closures)),
		PhysicalCash:       totalPhysicalCash,
		TotalNequi:         totalNequi,
		TotalDaviplata:     totalDaviplata,
		TotalCard:          totalCard,
		TotalBancolombia:   totalBancolombia,
		TotalOtherTransfer: totalOtherTransfer,
		TotalCash:          totalCash,
		TotalExpenses:      totalExpenses,
		TotalReturns:       totalReturns,
		ExpectedCash:       totalExpectedCash,
		CashBills:          totalCashBills,
		Coins1000:          totalCoins1000,
		Coins500:           totalCoins500,
		Coins200:           totalCoins200,
		Coins100:           totalCoins100,
		Expenses:           expenses,
		Payments:           payments,
	})

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("error generating consolidated pdf: %w", err)
	}
	return &buf, nil
}
