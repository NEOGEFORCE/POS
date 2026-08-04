package services

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jung-kurt/gofpdf"
	"backPOS-go/internal/core/domain/models"
)

type ClosurePrintData struct {
	Title                string
	SubTitle             string
	Cajero               string
	RangoFechaStr        string
	TurnoStr             string
	IDStr                string
	PhysicalCash         float64
	TotalSales           float64
	TotalCreditCollected float64
	TotalNequi           float64
	TotalDaviplata       float64
	TotalCard            float64
	TotalBancolombia     float64
	TotalOtherTransfer   float64
	TotalCash            float64
	TotalExpenses        float64
	TotalReturns         float64
	ExpectedCash         float64
	CashBills            float64
	Coins1000            float64
	Coins500             float64
	Coins200             float64
	Coins100             float64
	Expenses             []models.Expense
	Payments             []models.CreditPayment
}

var amountRegex = regexp.MustCompile(`\$?([0-9.,]+)`)

func extractAmountFromText(text string) float64 {
	match := amountRegex.FindStringSubmatch(text)
	if len(match) < 2 {
		return 0
	}
	s := match[1]
	if strings.Contains(s, ",") {
		s = strings.ReplaceAll(s, ".", "")
		s = strings.ReplaceAll(s, ",", ".")
	} else if strings.Contains(s, ".") {
		if matched, _ := regexp.MatchString(`\.\d{1,2}$`, s); !matched {
			s = strings.ReplaceAll(s, ".", "")
		}
	}
	val, _ := strconv.ParseFloat(s, 64)
	return val
}

func parseExpenseChannels(e *models.Expense) (finalCash, finalNequi, finalDavi, finalFondo float64) {
	if strings.ToUpper(e.Status) == "PENDING" {
		return 0, 0, 0, 0
	}
	src := strings.ToUpper(e.PaymentSource)
	tax := e.TaxAmount
	base := e.Amount
	total := base + tax

	if strings.Contains(src, "/") {
		parts := strings.Split(src, "/")
		for _, part := range parts {
			p := strings.TrimSpace(part)
			val := extractAmountFromText(p)
			if strings.Contains(p, "NEQUI") || strings.Contains(p, "NEQ") {
				finalNequi += val
			} else if strings.Contains(p, "DAVIPLATA") || strings.Contains(p, "DAVI") {
				finalDavi += val
			} else if strings.Contains(p, "FONDO") || strings.Contains(p, "BOVEDA") || strings.Contains(p, "BÓVEDA") || strings.Contains(p, "FOND") {
				finalFondo += val
			} else if strings.Contains(p, "CAJA") || strings.Contains(p, "EFECTIVO") || strings.Contains(p, "CASH") || strings.Contains(p, "EFEC") {
				finalCash += val
			}
		}
		if finalCash+finalNequi+finalDavi+finalFondo > 0 {
			return finalCash, finalNequi, finalDavi, finalFondo
		}
	}

	if src == "NEQUI" {
		return 0, total, 0, 0
	} else if src == "DAVIPLATA" || src == "DAVI" {
		return 0, 0, total, 0
	} else if src == "FONDO" || src == "BOVEDA" || src == "BÓVEDA" || strings.Contains(src, "FOND") {
		return 0, 0, 0, total
	} else if strings.Contains(src, "PREST") || src == "DEUDA" {
		return 0, 0, 0, 0
	}

	rawCash := e.CashAmount
	rawNequi := e.NequiAmount
	rawDavi := e.DaviplataAmount
	rawFondo := e.FondoAmount
	sum := rawCash + rawNequi + rawDavi + rawFondo

	if sum > 0 {
		finalCash = rawCash
		finalNequi = rawNequi
		finalDavi = rawDavi
		finalFondo = rawFondo
		if tax > 0 && sum == base {
			count := 0
			if rawCash > 0 { count++ }
			if rawNequi > 0 { count++ }
			if rawDavi > 0 { count++ }
			if rawFondo > 0 { count++ }
			if count <= 1 {
				if rawCash > 0 { finalCash += tax }
				if rawNequi > 0 { finalNequi += tax }
				if rawDavi > 0 { finalDavi += tax }
				if rawFondo > 0 { finalFondo += tax }
			} else {
				if rawNequi > 0 { finalNequi += tax } else if rawDavi > 0 { finalDavi += tax } else if rawFondo > 0 { finalFondo += tax } else { finalCash += tax }
			}
		}
		return finalCash, finalNequi, finalDavi, finalFondo
	}

	return total, 0, 0, 0
}

// RenderClosurePDFData dibuja una página completa de auditoría de cierre en el PDF
func RenderClosurePDFData(pdf *gofpdf.Fpdf, tr func(string) string, loc *time.Location, data ClosurePrintData) {
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
		amountRegex := regexp.MustCompile(`\$?([0-9.,]+)`)

		for i := range data.Expenses {
			e := &data.Expenses[i]
			if strings.ToUpper(e.Status) == "PENDING" {
				e.CashAmount = 0
				e.NequiAmount = 0
				e.DaviplataAmount = 0
				e.FondoAmount = 0
				continue
			}
			src := strings.ToUpper(e.PaymentSource)
			tax := e.TaxAmount
			base := e.Amount
			total := base + tax

			finalCash := 0.0
			finalNequi := 0.0
			finalDavi := 0.0
			finalFondo := 0.0

			if strings.Contains(src, "/") {
				parts := strings.Split(src, "/")
				for _, part := range parts {
					p := strings.TrimSpace(part)
					match := amountRegex.FindStringSubmatch(p)
					val := 0.0
					if len(match) >= 2 {
						s := match[1]
						if strings.Contains(s, ",") {
							s = strings.ReplaceAll(s, ".", "")
							s = strings.ReplaceAll(s, ",", ".")
						} else if strings.Contains(s, ".") {
							if matched, _ := regexp.MatchString(`\.\d{1,2}$`, s); !matched {
								s = strings.ReplaceAll(s, ".", "")
							}
						}
						val, _ = strconv.ParseFloat(s, 64)
					}
					if strings.Contains(p, "NEQUI") || strings.Contains(p, "NEQ") {
						finalNequi += val
					} else if strings.Contains(p, "DAVIPLATA") || strings.Contains(p, "DAVI") {
						finalDavi += val
					} else if strings.Contains(p, "FONDO") || strings.Contains(p, "BOVEDA") || strings.Contains(p, "BÓVEDA") || strings.Contains(p, "FOND") {
						finalFondo += val
					} else if strings.Contains(p, "CAJA") || strings.Contains(p, "EFECTIVO") || strings.Contains(p, "CASH") || strings.Contains(p, "EFEC") {
						finalCash += val
					}
				}
				if finalCash+finalNequi+finalDavi+finalFondo == 0 {
					finalCash = total
				}
			} else if src == "NEQUI" {
				finalNequi = total
			} else if src == "DAVIPLATA" || src == "DAVI" {
				finalDavi = total
			} else if src == "FONDO" || src == "BOVEDA" || src == "BÓVEDA" || strings.Contains(src, "FOND") {
				finalFondo = total
			} else if strings.Contains(src, "PREST") || src == "DEUDA" {
				// 0
			} else {
				rawCash := e.CashAmount
				rawNequi := e.NequiAmount
				rawDavi := e.DaviplataAmount
				rawFondo := e.FondoAmount
				sum := rawCash + rawNequi + rawDavi + rawFondo

				if sum > 0 {
					finalCash = rawCash
					finalNequi = rawNequi
					finalDavi = rawDavi
					finalFondo = rawFondo
					if tax > 0 && sum == base {
						count := 0
						if rawCash > 0 { count++ }
						if rawNequi > 0 { count++ }
						if rawDavi > 0 { count++ }
						if rawFondo > 0 { count++ }
						if count <= 1 {
							if rawCash > 0 { finalCash += tax }
							if rawNequi > 0 { finalNequi += tax }
							if rawDavi > 0 { finalDavi += tax }
							if rawFondo > 0 { finalFondo += tax }
						} else {
							if rawNequi > 0 { finalNequi += tax } else if rawDavi > 0 { finalDavi += tax } else if rawFondo > 0 { finalFondo += tax } else { finalCash += tax }
						}
					}
				} else {
					finalCash = total
				}
			}

			e.CashAmount = finalCash
			e.NequiAmount = finalNequi
			e.DaviplataAmount = finalDavi
			e.FondoAmount = finalFondo
		}

		egresosCaja := 0.0
		egresosGlobales := 0.0
		for _, e := range data.Expenses {
			if strings.ToUpper(e.Status) != "PENDING" {
				egresosCaja += e.CashAmount
				egresosGlobales += e.CashAmount + e.NequiAmount + e.DaviplataAmount + e.FondoAmount
			}
		}

		digitalIncome := data.TotalNequi + data.TotalDaviplata + data.TotalCard + data.TotalBancolombia + data.TotalOtherTransfer
		cashIngresos := data.TotalCash + data.TotalCreditCollected

		expectedCashFinal := data.ExpectedCash
		if expectedCashFinal == 0 {
			expectedCashFinal = cashIngresos - egresosCaja - data.TotalReturns
		}

		ventasCajero := data.PhysicalCash + digitalIncome + egresosCaja + data.TotalReturns
		ventasSistema := expectedCashFinal + digitalIncome + egresosCaja
		if data.Cajero == "MULTIPLE (SISTEMA)" {
			ventasCajero = data.PhysicalCash
			ventasSistema = data.TotalSales
		}
		realBalance := ventasCajero - ventasSistema

		ingresosReales := data.TotalSales
		if ingresosReales == 0 {
			if (data.TotalCash + digitalIncome) > 0 {
				ingresosReales = data.TotalCash + digitalIncome
			} else {
				ingresosReales = ventasSistema
			}
		}
		balanceNetoReal := ingresosReales - egresosGlobales - data.TotalReturns

		boxY := pdf.GetY()
		
		// Ventas Cajero
		pdf.SetFillColor(255, 255, 255)
		pdf.SetDrawColor(0, 0, 0)
		pdf.SetLineWidth(0.2)
		pdf.Rect(10, boxY, 60, 18, "D")
		pdf.SetXY(10, boxY + 2)
		pdf.SetFont("Arial", "B", 7)
		pdf.CellFormat(60, 5, tr("VENTAS TOTALES (CAJERO)"), "0", 2, "C", false, 0, "")
		pdf.SetFont("Arial", "B", 12)
		pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(ventasCajero)), "0", 0, "C", false, 0, "")

		// Ventas Sistema
		pdf.Rect(75, boxY, 60, 18, "D")
		pdf.SetXY(75, boxY + 2)
		pdf.SetFont("Arial", "B", 7)
		pdf.CellFormat(60, 5, tr("VENTAS TOTALES (SIST.)"), "0", 2, "C", false, 0, "")
		pdf.SetFont("Arial", "B", 12)
		pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(ventasSistema)), "0", 0, "C", false, 0, "")

		// Balance Real
		pdf.SetFillColor(230, 245, 230)
		pdf.Rect(140, boxY, 60, 18, "DF")
		pdf.SetXY(140, boxY + 2)
		pdf.SetFont("Arial", "B", 7)
		pdf.CellFormat(60, 5, tr("BALANCE REAL"), "0", 2, "C", false, 0, "")
		pdf.SetFont("Arial", "B", 12)
		pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(realBalance)), "0", 0, "C", false, 0, "")
		
		pdf.SetY(boxY + 22)

		pdf.SetFont("Arial", "I", 7)
		pdf.CellFormat(190, 4, tr("* Ventas Cajero = Efectivo Contado + Digital + Egresos Caja"), "0", 1, "L", false, 0, "")
		pdf.CellFormat(190, 4, tr("* Ventas Sistema = Efectivo Esperado + Digital + Egresos Caja"), "0", 1, "L", false, 0, "")
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

		drawTable("RESUMEN FINANCIERO GLOBAL", 
			[]string{"Concepto", "Monto"}, 
			[]float64{130, 60}, 
			[][]string{
				{"(+) Ingresos Totales (Efectivo + Digital)", fmt.Sprintf("$%s", formatCOP(ingresosReales))},
				{"(-) Egresos Totales (Todos los canales)", fmt.Sprintf("$%s", formatCOP(egresosGlobales))},
				{"(-) Devoluciones Totales", fmt.Sprintf("$%s", formatCOP(data.TotalReturns))},
				{"(=) BALANCE NETO DEL TURNO", fmt.Sprintf("$%s", formatCOP(balanceNetoReal))},
			})

		drawTable("CUADRE DE CAJA FISICA", 
			[]string{"Concepto", "Monto"}, 
			[]float64{130, 60}, 
			[][]string{
				{"(+) Ingresos en Efectivo (Ventas + Recaudos)", fmt.Sprintf("$%s", formatCOP(cashIngresos))},
				{"(-) Salidas de Efectivo (Egresos de Caja)", fmt.Sprintf("$%s", formatCOP(egresosCaja))},
				{"(-) Devoluciones de Mercancia en Efectivo", fmt.Sprintf("$%s", formatCOP(0.0))},
				{"(=) EFECTIVO ESPERADO EN CAJA", fmt.Sprintf("$%s", formatCOP(expectedCashFinal))},
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
				desc := e.Description
				if !e.Date.IsZero() {
					desc = fmt.Sprintf("%s - %s", e.Date.In(loc).Format("02/01"), e.Description)
				}
				isMixedOrNewSchema := e.CashAmount > 0 || e.NequiAmount > 0 || e.DaviplataAmount > 0 || e.FondoAmount > 0
				
				if isMixedOrNewSchema {
					if m == "EFECTIVO" && e.CashAmount > 0 {
						rows = append(rows, []string{desc, fmt.Sprintf("$%s", formatCOP(e.CashAmount))})
						total += e.CashAmount
					}
					if m == "NEQUI" && e.NequiAmount > 0 {
						rows = append(rows, []string{desc, fmt.Sprintf("$%s", formatCOP(e.NequiAmount))})
						total += e.NequiAmount
					}
					if m == "DAVIPLATA" && e.DaviplataAmount > 0 {
						rows = append(rows, []string{desc, fmt.Sprintf("$%s", formatCOP(e.DaviplataAmount))})
						total += e.DaviplataAmount
					}
					if m == "FONDO" && e.FondoAmount > 0 {
						rows = append(rows, []string{desc, fmt.Sprintf("$%s", formatCOP(e.FondoAmount))})
						total += e.FondoAmount
					}
					if m == "PRESTAMO" {
						sumPaid := e.CashAmount + e.NequiAmount + e.DaviplataAmount + e.FondoAmount
						if e.Status == "PENDING" && math.Round(e.Amount-sumPaid) > 0 {
							diff := e.Amount - sumPaid
							rows = append(rows, []string{desc, fmt.Sprintf("$%s", formatCOP(diff))})
							total += diff
						}
					}
				} else {
					eMethod := strings.ToUpper(e.PaymentSource)
					if eMethod == "" || eMethod == "CAJA" { eMethod = "EFECTIVO" }
					if eMethod == "PREST." || eMethod == "DEUDA" { eMethod = "PRESTAMO" }
					
					if eMethod == m {
						rows = append(rows, []string{desc, fmt.Sprintf("$%s", formatCOP(e.Amount))})
						total += e.Amount
					}
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
				desc := name
				if !p.PaymentDate.IsZero() {
					desc = fmt.Sprintf("%s - %s", p.PaymentDate.In(loc).Format("02/01"), name)
				}
				rows = append(rows, []string{desc, fmt.Sprintf("$%s", formatCOP(p.TotalPaid))})
				totalAbonos += p.TotalPaid
			}
			rows = append(rows, []string{"TOTAL ABONOS RECIBIDOS", fmt.Sprintf("$%s", formatCOP(totalAbonos))})
			drawTable("ABONOS RECIBIDOS", []string{"Fecha/Cliente", "Monto Abono"}, []float64{140, 50}, rows)
		}
	}

// GenerateConsolidatedClosurePDF genera el PDF consolidado estilo "Cierre Profesional"
func (s *ExportService) GenerateConsolidatedClosurePDF(closures []models.CashierClosure, expenses []models.Expense, payments []models.CreditPayment, from, to time.Time) (*bytes.Buffer, error) {
	pdf := gofpdf.New("P", "mm", "A4", "")
	tr := pdf.UnicodeTranslatorFromDescriptor("")
	loc := time.FixedZone("America/Bogota", -5*60*60)

	drawClosureData := func(data ClosurePrintData) {
		RenderClosurePDFData(pdf, tr, loc, data)
	}

	// 1. DIBUJAR LOS CIERRES INDIVIDUALES
	var totalExpectedCash, totalPhysicalCash, totalNequi, totalDaviplata, totalCard, totalBancolombia, totalOtherTransfer float64
	var totalCash, totalExpenses, totalReturns, totalCreditCollected, totalSales float64
	var totalCashBills, totalCoins1000, totalCoins500, totalCoins200, totalCoins100 float64
	var sumVentasCajero, sumVentasSistema float64

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
		totalCreditCollected += c.TotalCreditCollected
		totalSales += c.TotalSales
		totalCashBills += c.CashBills
		totalCoins1000 += c.Coins1000
		totalCoins500 += c.Coins500
		totalCoins200 += c.Coins200
		totalCoins100 += c.Coins100

		var cExp []models.Expense
		if len(c.Expenses) > 0 {
			cExp = c.Expenses
		} else if c.ExpensesDetail != "" {
			_ = json.Unmarshal([]byte(c.ExpensesDetail), &cExp)
		} else {
			for _, e := range expenses {
				if !e.Date.Before(c.StartDate) && (c.EndDate.IsZero() || !e.Date.After(c.EndDate)) {
					cExp = append(cExp, e)
				}
			}
		}

		cDigital := c.TotalNequi + c.TotalDaviplata + c.TotalCard + c.TotalBancolombia + c.TotalOtherTransfer
		cCashIn := c.TotalCash + c.TotalCreditCollected

		cEgCaja := 0.0
		for _, e := range cExp {
			cash, _, _, _ := parseExpenseChannels(&e)
			cEgCaja += cash
		}

		cExpCash := c.ExpectedCash
		if cExpCash == 0 {
			cExpCash = cCashIn - cEgCaja - c.TotalReturns
		}

		cVentasCajero := c.PhysicalCash + cDigital + cEgCaja + c.TotalReturns
		cVentasSistema := cExpCash + cDigital + cEgCaja

		sumVentasCajero += cVentasCajero
		sumVentasSistema += cVentasSistema

		var cPay []models.CreditPayment
		if len(c.CreditPayments) > 0 {
			cPay = c.CreditPayments
		} else {
			for _, p := range payments {
				if !p.PaymentDate.Before(c.StartDate) && (c.EndDate.IsZero() || !p.PaymentDate.After(c.EndDate)) {
					cPay = append(cPay, p)
				}
			}
		}

		drawClosureData(ClosurePrintData{
			Title:                "SUPERMERCADO SURTIFAMILIAR",
			SubTitle:             "AUDITORIA OFICIAL DE CIERRE DE CAJA",
			Cajero:               c.ClosedByName,
			RangoFechaStr:        "TURNO:",
			TurnoStr:             fmt.Sprintf("%s a %s", c.StartDate.In(loc).Format("02/01/06 15:04"), c.EndDate.In(loc).Format("02/01/06 15:04")),
			IDStr:                fmt.Sprintf("CC-%d", c.ID),
			PhysicalCash:         c.PhysicalCash,
			TotalSales:           c.TotalSales,
			TotalCreditCollected: c.TotalCreditCollected,
			TotalNequi:           c.TotalNequi,
			TotalDaviplata:       c.TotalDaviplata,
			TotalCard:            c.TotalCard,
			TotalBancolombia:     c.TotalBancolombia,
			TotalOtherTransfer:   c.TotalOtherTransfer,
			TotalCash:            c.TotalCash,
			TotalExpenses:        c.TotalExpenses,
			TotalReturns:         c.TotalReturns,
			ExpectedCash:         c.ExpectedCash,
			CashBills:            c.CashBills,
			Coins1000:            c.Coins1000,
			Coins500:             c.Coins500,
			Coins200:             c.Coins200,
			Coins100:             c.Coins100,
			Expenses:             cExp,
			Payments:             cPay,
		})
	}

	// 2. DIBUJAR EL REPORTE CONSOLIDADO AL FINAL
	drawClosureData(ClosurePrintData{
		Title:                "SUPERMERCADO SURTIFAMILIAR",
		SubTitle:             "REPORTE CONSOLIDADO DE CIERRES",
		Cajero:               "MULTIPLE (SISTEMA)",
		RangoFechaStr:        "RANGO DE FECHAS:",
		TurnoStr:             fmt.Sprintf("%s al %s", from.In(loc).Format("02/01/2006"), to.In(loc).Format("02/01/2006")),
		IDStr:                fmt.Sprintf("%d TURNOS", len(closures)),
		PhysicalCash:         sumVentasCajero,
		TotalSales:           sumVentasSistema,
		TotalCreditCollected: totalCreditCollected,
		TotalNequi:           totalNequi,
		TotalDaviplata:       totalDaviplata,
		TotalCard:            totalCard,
		TotalBancolombia:     totalBancolombia,
		TotalOtherTransfer:   totalOtherTransfer,
		TotalCash:            totalCash,
		TotalExpenses:        totalExpenses,
		TotalReturns:         totalReturns,
		ExpectedCash:         totalExpectedCash,
		CashBills:            totalCashBills,
		Coins1000:            totalCoins1000,
		Coins500:             totalCoins500,
		Coins200:             totalCoins200,
		Coins100:             totalCoins100,
		Expenses:             ConsolidateExpensesForGeneralReport(expenses),
		Payments:             ConsolidatePaymentsForGeneralReport(payments),
	})

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("error generating consolidated pdf: %w", err)
	}
	return &buf, nil
}

var datePrefixRegex = regexp.MustCompile(`^\d{1,2}/\d{1,2}\s*-\s*`)

func extractConsolidatedConcept(desc string, category string) string {
	clean := datePrefixRegex.ReplaceAllString(strings.TrimSpace(desc), "")
	cleanUpper := strings.ToUpper(strings.TrimSpace(clean))
	catUpper := strings.ToUpper(strings.TrimSpace(category))

	// 1. Nómina
	if strings.Contains(cleanUpper, "NOMINA") || strings.Contains(cleanUpper, "NÓMINA") || catUpper == "NOMINA" {
		return "PAGO DE NÓMINA"
	}

	// 2. Proveedores y Recepción de Mercancía
	isSupplier := strings.Contains(cleanUpper, "PAGO DE PROVEEDOR") ||
		strings.Contains(cleanUpper, "PAGO PROVEEDOR") ||
		strings.Contains(cleanUpper, "RECEPCIÓN DE MERCANCÍA") ||
		strings.Contains(cleanUpper, "RECEPCION DE MERCANCIA") ||
		strings.Contains(cleanUpper, "RECEPCION MERCANCIA") ||
		strings.Contains(cleanUpper, "ABONO A DEUDA") ||
		strings.Contains(cleanUpper, "PAGO A DEUDA") ||
		catUpper == "PROVEEDORES" || catUpper == "PROVEEDOR"

	if isSupplier {
		providerName := clean
		prefixes := []string{
			"RECEPCIÓN DE MERCANCÍA -", "RECEPCION DE MERCANCIA -", "RECEPCION MERCANCIA -",
			"RECEPCIÓN DE MERCANCÍA", "RECEPCION DE MERCANCIA", "RECEPCION MERCANCIA",
			"ABONO A DEUDA:", "ABONO A DEUDA -", "ABONO A DEUDA",
			"PAGO DE PROVEEDOR -", "PAGO PROVEEDOR -",
		}
		for _, p := range prefixes {
			re := regexp.MustCompile("(?i)^" + regexp.QuoteMeta(p) + `\s*`)
			providerName = re.ReplaceAllString(providerName, "")
		}

		suffixes := []string{
			"- PAGO DE PROVEEDOR", "- PAGO PROVEEDOR",
			"PAGO DE PROVEEDOR", "PAGO PROVEEDOR",
		}
		for _, s := range suffixes {
			re := regexp.MustCompile("(?i)\\s*" + regexp.QuoteMeta(s) + "$")
			providerName = re.ReplaceAllString(providerName, "")
		}

		providerName = strings.TrimSpace(providerName)
		providerName = strings.Trim(providerName, "- ")

		if providerName != "" {
			return fmt.Sprintf("PAGO PROVEEDOR - %s", strings.ToUpper(providerName))
		}
		return "PAGO PROVEEDORES"
	}

	// 3. Banco / Obligaciones
	if strings.Contains(cleanUpper, "BANCO") || strings.Contains(cleanUpper, "CUOTA") {
		return "CUOTA BANCO / OBLIGACIONES"
	}

	// 4. Servicios y Arriendos
	if strings.Contains(cleanUpper, "ARRIENDO") || strings.Contains(cleanUpper, "ALQUILER") {
		return "ARRIENDO Y ALQUILERES"
	}
	if strings.Contains(cleanUpper, "INTERNET") || strings.Contains(cleanUpper, "LUZ") ||
		strings.Contains(cleanUpper, "AGUA") || strings.Contains(cleanUpper, "SERVICIOS") ||
		strings.Contains(cleanUpper, "GAS") || catUpper == "SERVICIOS" {
		return "PAGO DE SERVICIOS"
	}

	// 5. Otros Gastos
	if cleanUpper != "" {
		return fmt.Sprintf("OTROS GASTOS (%s)", cleanUpper)
	}

	return "OTROS GASTOS"
}

func ConsolidateExpensesForGeneralReport(rawExpenses []models.Expense) []models.Expense {
	groupedMap := make(map[string]*models.Expense)
	var orderedKeys []string

	for _, e := range rawExpenses {
		concept := extractConsolidatedConcept(e.Description, e.Category)
		cash, nequi, davi, fondo := parseExpenseChannels(&e)

		addAmount := func(channel string, amount float64) {
			if amount <= 0 {
				return
			}
			key := channel + "|" + concept
			if existing, found := groupedMap[key]; found {
				if channel == "EFECTIVO" {
					existing.CashAmount += amount
				} else if channel == "NEQUI" {
					existing.NequiAmount += amount
				} else if channel == "DAVIPLATA" {
					existing.DaviplataAmount += amount
				} else if channel == "FONDO" {
					existing.FondoAmount += amount
				}
				existing.Amount += amount
			} else {
				item := &models.Expense{
					Description: concept,
					Amount:      amount,
					Category:    e.Category,
				}
				if channel == "EFECTIVO" {
					item.CashAmount = amount
					item.PaymentSource = "EFECTIVO"
				} else if channel == "NEQUI" {
					item.NequiAmount = amount
					item.PaymentSource = "NEQUI"
				} else if channel == "DAVIPLATA" {
					item.DaviplataAmount = amount
					item.PaymentSource = "DAVIPLATA"
				} else if channel == "FONDO" {
					item.FondoAmount = amount
					item.PaymentSource = "FONDO"
				}
				groupedMap[key] = item
				orderedKeys = append(orderedKeys, key)
			}
		}

		addAmount("EFECTIVO", cash)
		addAmount("NEQUI", nequi)
		addAmount("DAVIPLATA", davi)
		addAmount("FONDO", fondo)
	}

	sort.Strings(orderedKeys)

	var result []models.Expense
	for _, k := range orderedKeys {
		if exp, ok := groupedMap[k]; ok {
			result = append(result, *exp)
		}
	}

	return result
}

func ConsolidatePaymentsForGeneralReport(rawPayments []models.CreditPayment) []models.CreditPayment {
	grouped := make(map[string]float64)
	var clientNames []string

	for _, p := range rawPayments {
		name := p.Client.Name
		if name == "" {
			name = p.ClientDNI
		}
		if name == "" {
			name = "CLIENTE GENERAL"
		}
		name = strings.ToUpper(strings.TrimSpace(name))

		if _, exists := grouped[name]; !exists {
			clientNames = append(clientNames, name)
		}
		grouped[name] += p.TotalPaid
	}

	sort.Strings(clientNames)

	var result []models.CreditPayment
	for _, name := range clientNames {
		result = append(result, models.CreditPayment{
			TotalPaid: grouped[name],
			Client:    models.Client{Name: name},
		})
	}
	return result
}

func (s *ExportService) GenerateProfitabilityPDF(r *ProfitabilityReport) (*bytes.Buffer, error) {
	pdf := gofpdf.New("P", "mm", "A4", "")
	tr := pdf.UnicodeTranslatorFromDescriptor("")
	pdf.SetMargins(10, 10, 10)
	pdf.SetAutoPageBreak(true, 15)
	pdf.AddPage()

	// Header
	pdf.SetFont("Arial", "B", 18)
	pdf.SetTextColor(44, 44, 42)
	pdf.CellFormat(190, 10, tr("SUPERMERCADO SURTIFAMILIAR"), "0", 1, "L", false, 0, "")

	pdf.SetFont("Arial", "B", 14)
	pdf.SetTextColor(60, 60, 60)
	pdf.CellFormat(120, 7, tr("Reporte de Rentabilidad"), "0", 0, "L", false, 0, "")

	pdf.SetFont("Arial", "", 10)
	pdf.SetFillColor(241, 239, 232)
	pdf.SetTextColor(95, 94, 90)
	pdf.CellFormat(70, 7, tr("Mes / Período Auditado"), "1", 1, "C", true, 0, "")

	pdf.SetFont("Arial", "", 10)
	loc, _ := time.LoadLocation("America/Bogota")
	if loc == nil { loc = time.Local }
	nowStr := time.Now().In(loc).Format("02/01/2006 03:04:05 PM")
	periodStr := fmt.Sprintf("Período: %s al %s  |  Generado: %s", r.From.Format("02/01/2006"), r.To.Format("02/01/2006"), nowStr)
	pdf.CellFormat(190, 6, tr(periodStr), "0", 1, "L", false, 0, "")
	pdf.Ln(4)

	// Section 1: GANANCIA DE TODO LO VENDIDO
	pdf.SetFont("Arial", "B", 11)
	pdf.SetTextColor(44, 44, 42)
	pdf.CellFormat(190, 7, tr("1. Ganancia de todo lo vendido"), "0", 1, "L", false, 0, "")

	y1 := pdf.GetY()
	// Card 1: Ventas totales
	pdf.SetFillColor(241, 239, 232)
	pdf.SetDrawColor(211, 209, 199)
	pdf.Rect(10, y1, 60, 18, "DF")
	pdf.SetXY(10, y1+2)
	pdf.SetFont("Arial", "", 8)
	pdf.SetTextColor(95, 94, 90)
	pdf.CellFormat(60, 4, tr("Ventas totales"), "0", 2, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 12)
	pdf.SetTextColor(44, 44, 42)
	pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(r.TotalSales)), "0", 0, "C", false, 0, "")

	// Card 2: Costo de la mercancía
	pdf.Rect(75, y1, 60, 18, "DF")
	pdf.SetXY(75, y1+2)
	pdf.SetFont("Arial", "", 8)
	pdf.SetTextColor(95, 94, 90)
	pdf.CellFormat(60, 4, tr("Costo de la mercancía"), "0", 2, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 12)
	pdf.SetTextColor(44, 44, 42)
	pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(r.TotalCost)), "0", 0, "C", false, 0, "")

	// Card 3: Ganancia bruta (Verde)
	pdf.SetFillColor(234, 243, 222)
	pdf.Rect(140, y1, 60, 18, "DF")
	pdf.SetXY(140, y1+2)
	pdf.SetFont("Arial", "", 8)
	pdf.SetTextColor(39, 80, 10)
	pdf.CellFormat(60, 4, tr("Ganancia bruta"), "0", 2, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 12)
	pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(r.GrossProfit)), "0", 0, "C", false, 0, "")

	pdf.SetY(y1 + 24)

	// Section 2: GASTOS DEL NEGOCIO (SIN PROVEEDORES)
	pdf.SetFont("Arial", "B", 11)
	pdf.SetTextColor(44, 44, 42)
	pdf.CellFormat(190, 7, tr("2. Gastos del negocio (sin proveedores)"), "0", 1, "L", false, 0, "")

	opRows := [][]string{
		{"Servicios públicos (Luz, Agua, Gas, Internet)", fmt.Sprintf("$%s", formatCOP(r.PublicServicesExp))},
		{"Arriendo del local", fmt.Sprintf("$%s", formatCOP(r.RentExp))},
		{"Imprevistos, arreglos y daños del local", fmt.Sprintf("$%s", formatCOP(r.MaintenanceExp))},
		{"Sueldos y nómina", fmt.Sprintf("$%s", formatCOP(r.PayrollExp))},
		{"Otros gastos varios del local", fmt.Sprintf("$%s", formatCOP(r.OtherOpExp))},
	}

	pdf.SetFont("Arial", "", 9)
	pdf.SetDrawColor(211, 209, 199)
	for _, row := range opRows {
		pdf.CellFormat(130, 7, tr(row[0]), "1", 0, "L", false, 0, "")
		pdf.SetFont("Arial", "B", 9)
		pdf.CellFormat(60, 7, tr(row[1]), "1", 1, "R", false, 0, "")
		pdf.SetFont("Arial", "", 9)
	}

	// Total Egresos Destacado (Rojo)
	pdf.SetFillColor(252, 235, 235)
	pdf.SetTextColor(121, 31, 31)
	pdf.SetFont("Arial", "B", 10)
	pdf.CellFormat(130, 8, tr("Total de gastos del negocio"), "1", 0, "L", true, 0, "")
	pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(r.TotalOpExpenses)), "1", 1, "R", true, 0, "")
	pdf.Ln(4)

	// Desglose Detallado por Servicio y Rubro
	if len(r.OpExpenseItems) > 0 {
		if pdf.GetY() > 220 { pdf.AddPage() }
		pdf.SetFont("Arial", "B", 9)
		pdf.SetTextColor(60, 60, 60)
		pdf.CellFormat(190, 6, tr("Desglose Detallado por Servicio y Rubro del Local:"), "0", 1, "L", false, 0, "")

		pdf.SetFillColor(241, 239, 232)
		pdf.SetTextColor(95, 94, 90)
		pdf.SetFont("Arial", "B", 8)
		pdf.CellFormat(25, 6, tr("Fecha"), "1", 0, "C", true, 0, "")
		pdf.CellFormat(55, 6, tr("Servicio / Categoría"), "1", 0, "L", true, 0, "")
		pdf.CellFormat(70, 6, tr("Detalle del Gasto"), "1", 0, "L", true, 0, "")
		pdf.CellFormat(40, 6, tr("Monto"), "1", 1, "R", true, 0, "")

		pdf.SetFont("Arial", "", 8)
		pdf.SetTextColor(44, 44, 42)
		limitExp := len(r.OpExpenseItems)
		if limitExp > 30 { limitExp = 30 }
		for i := 0; i < limitExp; i++ {
			if pdf.GetY() > 270 { pdf.AddPage() }
			item := r.OpExpenseItems[i]
			dateStr := item.Date.Format("02/01/2006")
			pdf.CellFormat(25, 6, tr(dateStr), "1", 0, "C", false, 0, "")
			pdf.CellFormat(55, 6, tr(item.Category), "1", 0, "L", false, 0, "")
			pdf.CellFormat(70, 6, tr(item.Description), "1", 0, "L", false, 0, "")
			pdf.CellFormat(40, 6, fmt.Sprintf("$%s", formatCOP(item.Amount)), "1", 1, "R", false, 0, "")
		}
	}
	pdf.Ln(6)

	// Section 3: MOVIMIENTO DE EFECTIVO (CAJA)
	if pdf.GetY() > 220 { pdf.AddPage() }
	pdf.SetFont("Arial", "B", 11)
	pdf.SetTextColor(44, 44, 42)
	pdf.CellFormat(190, 7, tr("3. Movimiento del efectivo (caja)"), "0", 1, "L", false, 0, "")

	y3 := pdf.GetY()
	cWidth := 44.0
	gap := 4.0

	// Card 1
	pdf.SetFillColor(241, 239, 232)
	pdf.Rect(10, y3, cWidth, 16, "DF")
	pdf.SetXY(10, y3+1)
	pdf.SetFont("Arial", "", 7)
	pdf.SetTextColor(95, 94, 90)
	pdf.CellFormat(cWidth, 4, tr("Efectivo que entró"), "0", 2, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 10)
	pdf.SetTextColor(44, 44, 42)
	pdf.CellFormat(cWidth, 7, fmt.Sprintf("$%s", formatCOP(r.TotalCashInflows)), "0", 0, "C", false, 0, "")

	// Card 2
	x2 := 10 + cWidth + gap
	pdf.Rect(x2, y3, cWidth, 16, "DF")
	pdf.SetXY(x2, y3+1)
	pdf.SetFont("Arial", "", 7)
	pdf.SetTextColor(95, 94, 90)
	pdf.CellFormat(cWidth, 4, tr("Efectivo gastado local"), "0", 2, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 10)
	pdf.SetTextColor(44, 44, 42)
	pdf.CellFormat(cWidth, 7, fmt.Sprintf("$%s", formatCOP(r.CashExpenses)), "0", 0, "C", false, 0, "")

	// Card 3
	x3 := x2 + cWidth + gap
	pdf.Rect(x3, y3, cWidth, 16, "DF")
	pdf.SetXY(x3, y3+1)
	pdf.SetFont("Arial", "", 7)
	pdf.SetTextColor(95, 94, 90)
	pdf.CellFormat(cWidth, 4, tr("Prestado a clientes"), "0", 2, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 10)
	pdf.SetTextColor(44, 44, 42)
	pdf.CellFormat(cWidth, 7, fmt.Sprintf("$%s", formatCOP(r.CreditSales)), "0", 0, "C", false, 0, "")

	// Card 4
	x4 := x3 + cWidth + gap
	pdf.Rect(x4, y3, cWidth, 16, "DF")
	pdf.SetXY(x4, y3+1)
	pdf.SetFont("Arial", "", 7)
	pdf.SetTextColor(95, 94, 90)
	pdf.CellFormat(cWidth, 4, tr("Ventas transferencia"), "0", 2, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 10)
	pdf.SetTextColor(44, 44, 42)
	pdf.CellFormat(cWidth, 7, fmt.Sprintf("$%s", formatCOP(r.TransferSales)), "0", 0, "C", false, 0, "")

	pdf.SetY(y3 + 22)

	// Section 4: CARTERA Y DEUDAS
	if pdf.GetY() > 210 { pdf.AddPage() }
	pdf.SetFont("Arial", "B", 11)
	pdf.SetTextColor(44, 44, 42)
	pdf.CellFormat(190, 7, tr("4. A quién se le debe y quién debe"), "0", 1, "L", false, 0, "")

	// 4.1 Cartera Por Cobrar (Fiados)
	pdf.SetFont("Arial", "", 9)
	pdf.SetTextColor(95, 94, 90)
	pdf.CellFormat(190, 5, tr("Plata que los clientes le deben a usted (fiado)"), "0", 1, "L", false, 0, "")

	pdf.SetFillColor(250, 238, 218)
	pdf.SetTextColor(99, 56, 6)
	pdf.SetFont("Arial", "B", 9)
	pdf.CellFormat(130, 7, tr("Total por cobrar"), "1", 0, "L", true, 0, "")
	pdf.CellFormat(60, 7, fmt.Sprintf("$%s", formatCOP(r.TotalCreditReceivable)), "1", 1, "R", true, 0, "")

	if len(r.CreditReceivables) > 0 {
		pdf.SetFillColor(241, 239, 232)
		pdf.SetTextColor(95, 94, 90)
		pdf.SetFont("Arial", "B", 8)
		pdf.CellFormat(60, 6, tr("Cliente"), "1", 0, "L", true, 0, "")
		pdf.CellFormat(40, 6, tr("Cédula"), "1", 0, "L", true, 0, "")
		pdf.CellFormat(40, 6, tr("Teléfono"), "1", 0, "L", true, 0, "")
		pdf.CellFormat(50, 6, tr("Debe"), "1", 1, "R", true, 0, "")

		pdf.SetFont("Arial", "", 8)
		pdf.SetTextColor(44, 44, 42)
		limit := len(r.CreditReceivables)
		if limit > 20 { limit = 20 }
		for i := 0; i < limit; i++ {
			if pdf.GetY() > 270 { pdf.AddPage() }
			c := r.CreditReceivables[i]
			pdf.CellFormat(60, 6, tr(c.ClientName), "1", 0, "L", false, 0, "")
			pdf.CellFormat(40, 6, tr(c.ClientDNI), "1", 0, "L", false, 0, "")
			pdf.CellFormat(40, 6, tr(c.Phone), "1", 0, "L", false, 0, "")
			pdf.CellFormat(50, 6, fmt.Sprintf("$%s", formatCOP(c.Balance)), "1", 1, "R", false, 0, "")
		}
	}
	pdf.Ln(4)

	// 4.2 Deudas Por Pagar (A quién se le debe)
	if pdf.GetY() > 220 { pdf.AddPage() }
	pdf.SetFont("Arial", "", 9)
	pdf.SetTextColor(95, 94, 90)
	pdf.CellFormat(190, 5, tr("Plata que el negocio debe (proveedores o préstamos)"), "0", 1, "L", false, 0, "")

	pdf.SetFillColor(241, 239, 232)
	pdf.SetTextColor(44, 44, 42)
	pdf.SetFont("Arial", "B", 9)
	pdf.CellFormat(130, 7, tr("Total por pagar"), "1", 0, "L", true, 0, "")
	pdf.CellFormat(60, 7, fmt.Sprintf("$%s", formatCOP(r.TotalDebtsPayable)), "1", 1, "R", true, 0, "")

	if len(r.DebtsPayable) > 0 {
		pdf.SetFillColor(241, 239, 232)
		pdf.SetTextColor(95, 94, 90)
		pdf.SetFont("Arial", "B", 8)
		pdf.CellFormat(75, 6, tr("A quién se le debe"), "1", 0, "L", true, 0, "")
		pdf.CellFormat(65, 6, tr("Concepto / Detalle"), "1", 0, "L", true, 0, "")
		pdf.CellFormat(50, 6, tr("Monto"), "1", 1, "R", true, 0, "")

		pdf.SetFont("Arial", "", 8)
		pdf.SetTextColor(44, 44, 42)
		limit := len(r.DebtsPayable)
		if limit > 20 { limit = 20 }
		for i := 0; i < limit; i++ {
			if pdf.GetY() > 270 { pdf.AddPage() }
			d := r.DebtsPayable[i]
			creditor := d.ProviderName
			if creditor == "" {
				creditor = "Acreedor Varios"
			}

			concept := d.Concept
			if concept == "" {
				concept = "Deuda pendiente"
			}

			pdf.CellFormat(75, 6, tr(creditor), "1", 0, "L", false, 0, "")
			pdf.CellFormat(65, 6, tr(concept), "1", 0, "L", false, 0, "")
			pdf.CellFormat(50, 6, fmt.Sprintf("$%s", formatCOP(d.Balance)), "1", 1, "R", false, 0, "")
		}
	}
	pdf.Ln(6)

	// Section 5: RESULTADO FINAL
	if pdf.GetY() > 220 { pdf.AddPage() }
	pdf.SetFont("Arial", "B", 11)
	pdf.SetTextColor(44, 44, 42)
	pdf.CellFormat(190, 7, tr("5. Con lo pagado, esto quedó"), "0", 1, "L", false, 0, "")

	y5 := pdf.GetY()
	pdf.SetFillColor(234, 243, 222)
	pdf.SetDrawColor(39, 80, 10)
	pdf.Rect(10, y5, 190, 26, "DF")
	pdf.SetXY(10, y5+2)

	pdf.SetFont("Arial", "", 9)
	pdf.SetTextColor(39, 80, 10)
	calcText := fmt.Sprintf("Ganancia bruta ($%s) menos gastos del negocio ($%s)", formatCOP(r.GrossProfit), formatCOP(r.TotalOpExpenses))
	pdf.CellFormat(190, 4, tr(calcText), "0", 2, "C", false, 0, "")

	pdf.SetFont("Arial", "B", 18)
	pdf.CellFormat(190, 9, fmt.Sprintf("$%s", formatCOP(r.NetProfit)), "0", 2, "C", false, 0, "")

	pdf.SetFont("Arial", "B", 9)
	pdf.CellFormat(190, 4, tr("Ganancia libre del período"), "0", 0, "C", false, 0, "")

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("error building profitability pdf: %w", err)
	}
	return &buf, nil
}
