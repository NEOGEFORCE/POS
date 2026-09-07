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

	"backPOS-go/internal/core/domain/models"
	"github.com/jung-kurt/gofpdf"
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

	// MergeExpensesByKind cambia CÓMO se listan los egresos.
	//
	// false (páginas de cierre individuales): se mantienen las secciones por
	// canal — EGRESOS: EFECTIVO, NEQUI, DAVIPLATA, FONDO, ALCANCIA — porque al
	// auditar un turno puntual hay que saber de qué bolsillo salió cada peso.
	//
	// true (página consolidada del final): UNA sola lista de egresos del
	// período, agrupada por concepto y sumando todos los canales, partida en
	// proveedores y gastos del local. Es lo que el dueño pidió el 2026-09-04:
	// ver en qué se gastó el mes sin tener que sumar cuatro secciones a mano.
	MergeExpensesByKind bool

	// RawExpenses son los egresos SIN consolidar, tal como vienen de la base.
	//
	// Sólo se usa cuando MergeExpensesByKind es true. Hace falta porque
	// ConsolidateExpensesForGeneralReport fabrica egresos sintéticos agrupados
	// por canal+concepto que PIERDEN el estado, la categoría real y el
	// proveedor. Sin esos tres datos es imposible saber si un gasto es de
	// mercancía ni excluir pendientes, préstamos y devoluciones, así que el
	// resumen por tipo saldría en cero.
	RawExpenses []models.Expense

	// VentasCajeroTotal / VentasSistemaTotal son los totales YA SUMADOS del
	// período. Sólo se usan en la página consolidada.
	//
	// POR QUÉ EXISTEN: antes el consolidado metía sumVentasCajero dentro del
	// campo PhysicalCash y el renderizador lo leía desde ahí. Eso rompía la
	// nota al pie, que imprimía "Efectivo Contado ($X) + Digital + Egresos = $X"
	// con el MISMO número a los dos lados de la igualdad, porque el "efectivo
	// contado" que mostraba era en realidad la venta total. Una suma que no
	// cuadra en un reporte de plata destruye la confianza en todo el resto.
	//
	// Con estos campos, PhysicalCash vuelve a significar efectivo contado y la
	// nota al pie muestra una igualdad verdadera.
	VentasCajeroTotal  float64
	VentasSistemaTotal float64
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

// parseExpenseChannels reparte el monto de un egreso entre los canales de pago.
//
// ALCANCIA (agregado 2026-08-31): antes esta funcion solo conocia cuatro
// canales (efectivo, Nequi, Daviplata, fondo). Un egreso pagado con monedas
// llega con CoinsAmount cargado y los otros cuatro en cero, asi que la suma
// daba cero, caia al return final y se clasificaba como EFECTIVO DE CAJA.
//
// Eso inflaba la venta del mes, porque el arqueo suma los egresos en efectivo
// a la venta del cajero:
//
//	VentasCajero = EfectivoFisico + Digital + EgresosEnEfectivo + Devoluciones
//
// La logica de ese termino es que la plata que salio de la gaveta entro antes
// por una venta. Pero la alcancia NO es la gaveta: es un tarro aparte. Cada
// egreso pagado con monedas subia la venta del mes sin que hubiera venta.
// Ahora la alcancia es un canal propio y no se mezcla con el efectivo.
func parseExpenseChannels(e *models.Expense) (finalCash, finalNequi, finalDavi, finalFondo, finalCoins float64) {
	if strings.ToUpper(e.Status) == "PENDING" {
		return 0, 0, 0, 0, 0
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
			} else if strings.Contains(p, "FONDO") || strings.Contains(p, "BOVEDA") || strings.Contains(p, "BÃ“VEDA") || strings.Contains(p, "FOND") {
				finalFondo += val
			} else if strings.Contains(p, "MONEDA") || strings.Contains(p, "ALCANC") {
				finalCoins += val
			} else if strings.Contains(p, "CAJA") || strings.Contains(p, "EFECTIVO") || strings.Contains(p, "CASH") || strings.Contains(p, "EFEC") {
				finalCash += val
			}
		}
		if finalCash+finalNequi+finalDavi+finalFondo+finalCoins > 0 {
			return finalCash, finalNequi, finalDavi, finalFondo, finalCoins
		}
	}

	// PRIORIDAD: las columnas por canal son dato duro y se normalizan al
	// guardar/editar el cierre; el texto de PaymentSource es solo el respaldo
	// para egresos legacy que nunca tuvieron columnas.
	//
	// Este orden (mixto -> columnas -> texto) es el MISMO que usa el frontend en
	// reports/components/ClosuresHistory.tsx. No invertirlo: si el texto gana
	// sobre las columnas, un egreso con PaymentSource='FONDO' y CashAmount=50.000
	// se clasifica distinto en el dashboard que en el historial de cierres.
	rawCash := e.CashAmount
	rawNequi := e.NequiAmount
	rawDavi := e.DaviplataAmount
	rawFondo := e.FondoAmount
	rawCoins := e.CoinsAmount
	sum := rawCash + rawNequi + rawDavi + rawFondo + rawCoins

	if sum == 0 {
		// La alcancia se evalua primero: sus palabras no colisionan con los
		// otros canales y antes caia al return final, que la contaba como
		// efectivo de caja e inflaba la venta del mes.
		if strings.Contains(src, "MONEDA") || strings.Contains(src, "ALCANC") {
			return 0, 0, 0, 0, total
		}
		if strings.Contains(src, "NEQUI") || strings.Contains(src, "NEQ") {
			return 0, total, 0, 0, 0
		} else if strings.Contains(src, "DAVIPLATA") || strings.Contains(src, "DAVI") {
			return 0, 0, total, 0, 0
		} else if src == "BOVEDA" || src == "BÃ“VEDA" || strings.Contains(src, "FOND") {
			return 0, 0, 0, total, 0
		} else if strings.Contains(src, "PREST") || strings.Contains(src, "DEUDA") {
			// Deuda a proveedor: no mueve caja ni bancos todavÃ­a.
			return 0, 0, 0, 0, 0
		}
	}

	if sum > 0 {
		finalCash = rawCash
		finalNequi = rawNequi
		finalDavi = rawDavi
		finalFondo = rawFondo
		finalCoins = rawCoins
		if tax > 0 && sum == base {
			count := 0
			if rawCash > 0 {
				count++
			}
			if rawNequi > 0 {
				count++
			}
			if rawDavi > 0 {
				count++
			}
			if rawFondo > 0 {
				count++
			}
			if rawCoins > 0 {
				count++
			}
			if count <= 1 {
				if rawCash > 0 {
					finalCash += tax
				}
				if rawNequi > 0 {
					finalNequi += tax
				}
				if rawDavi > 0 {
					finalDavi += tax
				}
				if rawFondo > 0 {
					finalFondo += tax
				}
				if rawCoins > 0 {
					finalCoins += tax
				}
			} else {
				if rawNequi > 0 {
					finalNequi += tax
				} else if rawDavi > 0 {
					finalDavi += tax
				} else if rawFondo > 0 {
					finalFondo += tax
				} else if rawCoins > 0 {
					finalCoins += tax
				} else {
					finalCash += tax
				}
			}
		}
		return finalCash, finalNequi, finalDavi, finalFondo, finalCoins
	}

	return total, 0, 0, 0, 0
}

// RenderClosurePDFData dibuja una pÃ¡gina completa de auditorÃ­a de cierre en el PDF
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
	pdf.CellFormat(35, 7, tr(" "+data.RangoFechaStr), "LB", 0, "L", false, 0, "")
	pdf.SetFont("Arial", "", 8)
	pdf.CellFormat(60, 7, tr(" "+data.TurnoStr), "B", 0, "L", false, 0, "")
	pdf.SetFont("Arial", "B", 8)
	pdf.CellFormat(45, 7, tr(" ID / REF:"), "B", 0, "L", false, 0, "")
	pdf.SetFont("Arial", "", 8)
	pdf.CellFormat(50, 7, tr(" "+data.IDStr), "RB", 1, "L", false, 0, "")

	pdf.SetLineWidth(0.6)
	pdf.Line(10, pdf.GetY()+3, 200, pdf.GetY()+3)
	pdf.Ln(8)

	expectedCash := data.ExpectedCash
	if expectedCash == 0 {
		expectedCash = data.TotalCash - data.TotalExpenses - data.TotalReturns
	}
	// FUENTE UNICA de clasificacion por canal: parseExpenseChannels.
	// Antes habia aqui una copia inline con reglas distintas (el texto de
	// PaymentSource ganaba sobre las columnas con la plata), y por eso el PDF
	// no coincidia con el detalle del cierre en pantalla.
	for i := range data.Expenses {
		e := &data.Expenses[i]
		cash, nequi, davi, fondo, coins := parseExpenseChannels(e)
		e.CashAmount = cash
		e.NequiAmount = nequi
		e.DaviplataAmount = davi
		e.FondoAmount = fondo
		e.CoinsAmount = coins
	}

	egresosCaja := 0.0
	egresosGlobales := 0.0
	for _, e := range data.Expenses {
		if strings.ToUpper(e.Status) == "PENDING" {
			continue
		}
		// Las devoluciones ya entran por TotalReturns. Contarlas tambiÃ©n
		// aquÃ­ las restarÃ­a dos veces, y el detalle del cierre en pantalla
		// tampoco las cuenta acÃ¡.
		if !strings.EqualFold(strings.TrimSpace(e.Category), "DEVOLUCIONES") {
			egresosCaja += e.CashAmount
		}
		egresosGlobales += e.CashAmount + e.NequiAmount + e.DaviplataAmount + e.FondoAmount + e.CoinsAmount
	}

	digitalIncome := data.TotalNequi + data.TotalDaviplata + data.TotalCard + data.TotalBancolombia + data.TotalOtherTransfer

	// TotalCash YA incluye el efectivo de los abonos (GetCashierClosure hace
	// closure.TotalCash += p.AmountCash), asÃ­ que sumarle TotalCreditCollected
	// contaba la recuperaciÃ³n de cartera dos veces. El detalle del cierre en
	// pantalla usa solo totalCash.
	cashIngresos := data.TotalCash

	expectedCashFinal := data.ExpectedCash
	if expectedCashFinal == 0 {
		expectedCashFinal = cashIngresos - egresosCaja - data.TotalReturns
	}

	// Efectivo fÃ­sico REAL, sin sobrescrituras. Se prefiere el desglose de
	// billetes y monedas porque es lo que el cajero digitÃ³.
	physicalCash := data.CashBills + data.Coins1000 + data.Coins500 + data.Coins200 + data.Coins100
	if physicalCash <= 0 {
		physicalCash = data.PhysicalCash
	}

	ventasCajero := physicalCash + digitalIncome + egresosCaja + data.TotalReturns
	ventasSistema := cashIngresos + digitalIncome

	// En la página consolidada los totales vienen ya sumados de los cierres, así
	// que se usan tal cual en vez de recomponerlos. Se leen de campos propios
	// (no de PhysicalCash) para que la nota al pie siga cuadrando.
	isConsolidatedPage := data.VentasCajeroTotal > 0 || data.VentasSistemaTotal > 0
	if isConsolidatedPage {
		ventasCajero = data.VentasCajeroTotal
		ventasSistema = data.VentasSistemaTotal
	}
	realBalance := physicalCash - expectedCashFinal
	balanceNetoReal := ventasSistema - egresosGlobales - data.TotalReturns

	boxY := pdf.GetY()

	// Ventas Cajero
	pdf.SetFillColor(255, 255, 255)
	pdf.SetDrawColor(0, 0, 0)
	pdf.SetLineWidth(0.2)
	pdf.Rect(10, boxY, 60, 18, "D")
	pdf.SetXY(10, boxY+2)
	pdf.SetFont("Arial", "B", 7)
	pdf.CellFormat(60, 5, tr("VENTAS TOTALES (CAJERO)"), "0", 2, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 12)
	pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(ventasCajero)), "0", 0, "C", false, 0, "")

	// Ventas Sistema
	pdf.Rect(75, boxY, 60, 18, "D")
	pdf.SetXY(75, boxY+2)
	pdf.SetFont("Arial", "B", 7)
	pdf.CellFormat(60, 5, tr("VENTAS TOTALES (SIST.)"), "0", 2, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 12)
	pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(ventasSistema)), "0", 0, "C", false, 0, "")

	// Sobrante / Faltante
	balanceLabel := "SOBRANTE CAJA"
	diffSign := ""
	if realBalance < 0 {
		balanceLabel = "FALTANTE CAJA"
	} else if realBalance == 0 {
		balanceLabel = "CAJA CUADRADA"
	} else {
		diffSign = "+"
	}
	pdf.SetFillColor(230, 245, 230)
	if realBalance < 0 {
		pdf.SetFillColor(254, 226, 226)
	}
	pdf.Rect(140, boxY, 60, 18, "DF")
	pdf.SetXY(140, boxY+2)
	pdf.SetFont("Arial", "B", 7)
	pdf.CellFormat(60, 5, tr(balanceLabel), "0", 2, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 12)
	pdf.CellFormat(60, 8, fmt.Sprintf("%s$%s", diffSign, formatCOP(realBalance)), "0", 0, "C", false, 0, "")

	pdf.SetY(boxY + 22)

	pdf.SetFont("Arial", "I", 7)

	// NOTA AL PIE: tiene que ser una igualdad VERDADERA.
	//
	// Antes decía "Efectivo Contado + Digital + Egresos Caja = X" omitiendo las
	// devoluciones, y en la página consolidada además imprimía la venta total
	// disfrazada de efectivo contado, así que el mismo número aparecía a los dos
	// lados del igual. El dueño lo detectó: "esta suma no tiene sentido".
	sumaComponentes := physicalCash + digitalIncome + egresosCaja + data.TotalReturns
	formula := fmt.Sprintf("* Ventas Cajero = Efectivo Contado ($%s) + Digital ($%s) + Egresos Caja ($%s)",
		formatCOP(physicalCash), formatCOP(digitalIncome), formatCOP(egresosCaja))
	if data.TotalReturns > 0 {
		formula += fmt.Sprintf(" + Devoluciones ($%s)", formatCOP(data.TotalReturns))
	}
	formula += fmt.Sprintf(" = $%s", formatCOP(sumaComponentes))
	pdf.CellFormat(190, 4, tr(formula), "0", 1, "L", false, 0, "")

	// Si el total mostrado arriba no coincide con la suma de sus partes, se dice
	// en el reporte en vez de esconderlo: un descuadre silencioso en un reporte
	// de plata es peor que un descuadre avisado.
	if diferencia := ventasCajero - sumaComponentes; math.Abs(diferencia) > 1 {
		pdf.CellFormat(190, 4, tr(fmt.Sprintf(
			"  (!) El total mostrado ($%s) difiere de la suma de sus partes en $%s. Revisar los cierres del periodo.",
			formatCOP(ventasCajero), formatCOP(math.Abs(diferencia)))), "0", 1, "L", false, 0, "")
	}

	pdf.CellFormat(190, 4, tr(fmt.Sprintf("* Ventas Sistema = Ventas registradas en el POS (Efectivo $%s + Digital $%s) = $%s", formatCOP(cashIngresos), formatCOP(digitalIncome), formatCOP(cashIngresos+digitalIncome))), "0", 1, "L", false, 0, "")
	pdf.CellFormat(190, 4, tr(fmt.Sprintf("* %s = Efectivo Fisico ($%s) - Efectivo Esperado ($%s) = %s$%s", balanceLabel, formatCOP(physicalCash), formatCOP(expectedCashFinal), diffSign, formatCOP(realBalance))), "0", 1, "L", false, 0, "")
	pdf.Ln(2)

	drawTable := func(title string, headers []string, widths []float64, rows [][]string) {
		if pdf.GetY() > 250 {
			pdf.AddPage()
		}
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
				if lines > maxLines {
					maxLines = lines
				}
			}
			rowHeight := float64(maxLines) * 5.0
			if rowHeight < 7 {
				rowHeight = 7
			}

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
				if i == len(row)-1 {
					align = "R"
				}

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
			{"(+) Ingresos Totales (Efectivo + Digital)", fmt.Sprintf("$%s", formatCOP(ventasSistema))},
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

	cashBillsVal := data.CashBills
	if cashBillsVal == 0 && physicalCash > 0 {
		coinsSum := data.Coins1000 + data.Coins500 + data.Coins200 + data.Coins100
		if physicalCash > coinsSum {
			cashBillsVal = physicalCash - coinsSum
		}
	}

	drawTable("DESGLOSE DE EFECTIVO REPORTADO",
		[]string{"Denominacion", "Monto"},
		[]float64{130, 60},
		[][]string{
			{"Billetes", fmt.Sprintf("$%s", formatCOP(cashBillsVal))},
			{"Monedas 1000", fmt.Sprintf("$%s", formatCOP(data.Coins1000))},
			{"Monedas 500", fmt.Sprintf("$%s", formatCOP(data.Coins500))},
			{"Monedas 200", fmt.Sprintf("$%s", formatCOP(data.Coins200))},
			{"Monedas 100", fmt.Sprintf("$%s", formatCOP(data.Coins100))},
		})

	if data.MergeExpensesByKind {
		// ---- CONSOLIDADO: UNA sola lista, todos los canales sumados ----
		//
		// Cada concepto aparece UNA vez con su total del período. Un gasto que
		// se pagó mitad en efectivo y mitad en Nequi ya no sale dos veces en dos
		// secciones distintas: sale una vez por la suma.
		//
		// Se separa en dos bloques con la misma regla que usa el reporte de
		// rentabilidad (IsMerchandiseExpense), así "proveedores" significa lo
		// mismo en todos los reportes del sistema.
		type kindRow struct {
			desc  string
			total float64
		}
		supplierByDesc := map[string]float64{}
		otherByDesc := map[string]float64{}
		var supplierTotal, otherTotal float64

		for i := range data.RawExpenses {
			e := &data.RawExpenses[i]
			if !isOperationalExpense(e) {
				continue
			}
			cash, nequi, davi, fondo, coins := parseExpenseChannels(e)
			lineTotal := cash + nequi + davi + fondo + coins
			if lineTotal <= 0 {
				continue
			}
			// Mismo concepto legible que usa el resto del consolidado, para que
			// las descripciones se vean iguales en todo el reporte.
			desc := strings.TrimSpace(extractConsolidatedConcept(e.Description, e.Category))
			if desc == "" {
				desc = "SIN DESCRIPCION"
			}
			hasSupplier := e.SupplierID != nil && *e.SupplierID > 0
			if IsMerchandiseExpense(e.Category, e.Description, hasSupplier) {
				supplierByDesc[desc] += lineTotal
				supplierTotal += lineTotal
				continue
			}
			otherByDesc[desc] += lineTotal
			otherTotal += lineTotal
		}

		// De mayor a menor: lo que más plata se llevó, primero.
		sortedRows := func(m map[string]float64) []kindRow {
			out := make([]kindRow, 0, len(m))
			for d, v := range m {
				out = append(out, kindRow{desc: d, total: v})
			}
			sort.Slice(out, func(a, b int) bool {
				if out[a].total != out[b].total {
					return out[a].total > out[b].total
				}
				return out[a].desc < out[b].desc
			})
			return out
		}

		if len(supplierByDesc) > 0 {
			var rows [][]string
			for _, r := range sortedRows(supplierByDesc) {
				rows = append(rows, []string{r.desc, fmt.Sprintf("$%s", formatCOP(r.total))})
			}
			rows = append(rows, []string{"TOTAL PAGADO A PROVEEDORES", fmt.Sprintf("$%s", formatCOP(supplierTotal))})
			drawTable("PAGOS A PROVEEDORES Y MERCANCIA",
				[]string{"Descripcion", "Monto"}, []float64{140, 50}, rows)
		}

		if len(otherByDesc) > 0 {
			var rows [][]string
			for _, r := range sortedRows(otherByDesc) {
				rows = append(rows, []string{r.desc, fmt.Sprintf("$%s", formatCOP(r.total))})
			}
			rows = append(rows, []string{"TOTAL GASTOS DEL NEGOCIO", fmt.Sprintf("$%s", formatCOP(otherTotal))})
			drawTable("GASTOS DEL NEGOCIO (NO SON PROVEEDORES)",
				[]string{"Descripcion", "Monto"}, []float64{140, 50}, rows)
		}

		// Cierre: las dos bolsas y su suma, para poder cuadrar de un vistazo.
		drawTable("EN QUE SE GASTO LA PLATA",
			[]string{"Concepto", "Monto"}, []float64{140, 50},
			[][]string{
				{"Pagos a proveedores y mercancia", fmt.Sprintf("$%s", formatCOP(supplierTotal))},
				{"Gastos del negocio", fmt.Sprintf("$%s", formatCOP(otherTotal))},
				{"TOTAL QUE SALIO (SUMANDO TODAS LAS FORMAS DE PAGO)", fmt.Sprintf("$%s", formatCOP(supplierTotal+otherTotal))},
			})
	} else {
		// ---- CIERRE INDIVIDUAL: se conservan las secciones por canal ----
		methods := []string{"EFECTIVO", "NEQUI", "DAVIPLATA", "FONDO", "ALCANCIA"}
		for _, m := range methods {
			var rows [][]string
			total := 0.0

			for _, e := range data.Expenses {
				desc := e.Description
				if !e.Date.IsZero() {
					desc = fmt.Sprintf("%s - %s", e.Date.In(loc).Format("02/01"), e.Description)
				}
				isMixedOrNewSchema := e.CashAmount > 0 || e.NequiAmount > 0 || e.DaviplataAmount > 0 || e.FondoAmount > 0 || e.CoinsAmount > 0

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
					if m == "ALCANCIA" && e.CoinsAmount > 0 {
						rows = append(rows, []string{desc, fmt.Sprintf("$%s", formatCOP(e.CoinsAmount))})
						total += e.CoinsAmount
					}
					if m == "PRESTAMO" {
						sumPaid := e.CashAmount + e.NequiAmount + e.DaviplataAmount + e.FondoAmount + e.CoinsAmount
						if e.Status == "PENDING" && math.Round(e.Amount-sumPaid) > 0 {
							diff := e.Amount - sumPaid
							rows = append(rows, []string{desc, fmt.Sprintf("$%s", formatCOP(diff))})
							total += diff
						}
					}
				} else {
					eMethod := strings.ToUpper(e.PaymentSource)
					if eMethod == "" || eMethod == "CAJA" {
						eMethod = "EFECTIVO"
					}
					if eMethod == "PREST." || eMethod == "DEUDA" {
						eMethod = "PRESTAMO"
					}

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
			if name == "" {
				name = p.ClientDNI
			}
			if name == "" {
				name = "Cliente"
			}
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

	// Las páginas salen en orden cronológico por el DIA DEL NEGOCIO (c.Date), el
	// mismo campo que se imprime en cada hoja y con el que agrupa la pantalla.
	// Antes se dibujaban en el orden que devolvía la consulta.
	// Se ordena una COPIA para no alterar el slice del llamador.
	ordered := make([]models.CashierClosure, len(closures))
	copy(ordered, closures)
	closureDay := func(c models.CashierClosure) time.Time {
		if !c.Date.IsZero() {
			return c.Date
		}
		return c.EndDate
	}
	sort.SliceStable(ordered, func(a, b int) bool {
		return closureDay(ordered[a]).Before(closureDay(ordered[b]))
	})

	for _, c := range ordered {
		totalExpectedCash += c.ExpectedCash
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
		// TotalCash ya incluye el efectivo de los abonos; no sumar
		// TotalCreditCollected o se cuenta la cartera dos veces.
		cCashIn := c.TotalCash

		// FUENTE ÃšNICA: el mismo cÃ¡lculo que el detalle del cierre en pantalla
		// y que las tablas del dashboard. Sin valores sobrescritos.
		cc := c
		if len(cc.Expenses) == 0 && len(cExp) > 0 {
			cc.Expenses = cExp
		}
		m := ComputeClosureMetrics(&cc)

		cEgCaja := m.EgresosCaja
		cPhys := m.PhysicalCash
		// El total consolidado debe sumar el MISMO efectivo que imprime cada
		// hoja individual, así que se acumula el valor canónico.
		totalPhysicalCash += cPhys

		cExpCash := c.ExpectedCash
		if cExpCash == 0 {
			cExpCash = cCashIn - cEgCaja - c.TotalReturns
		}

		cVentasCajero := m.VentasCajero
		cVentasSistema := cCashIn + cDigital

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

		// FECHA DEL CIERRE = EL DIA DEL NEGOCIO, NO LA HORA EN QUE SE CERRO.
		//
		// Se usa c.Date porque es el campo con el que el historial visual de
		// /reports agrupa los cierres (ClosuresHistory.tsx: c.date || c.startDate),
		// y el dueño pidió explícitamente que el PDF diga lo mismo que la pantalla.
		//
		// EJEMPLO REAL que lo motivó (cierre CC-166): el turno cerró el 29/08 a
		// las 07:38 a.m., pero la mayoría de sus ventas son del 28. La pantalla lo
		// muestra bajo el viernes 28 y el PDF tiene que decir 28.
		//
		// OJO: NO cambiar esto a c.EndDate. Se intentó el 2026-09-04 asumiendo que
		// la pantalla agrupaba por fecha de cierre y quedó al revés: los turnos que
		// pasan la medianoche se corrían al día siguiente. EndDate queda sólo como
		// respaldo para cierres históricos sin Date.
		turnoRef := c.Date
		if turnoRef.IsZero() {
			turnoRef = c.EndDate
		}
		turnoStr := turnoRef.In(loc).Format("02/01/2006")

		drawClosureData(ClosurePrintData{
			Title:                "SUPERMERCADO SURTIFAMILIAR",
			SubTitle:             "AUDITORIA OFICIAL DE CIERRE DE CAJA",
			Cajero:               c.ClosedByName,
			RangoFechaStr:        "FECHA DEL CIERRE:",
			TurnoStr:             turnoStr,
			IDStr:                fmt.Sprintf("CC-%d", c.ID),
			PhysicalCash:         cPhys,
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
		Title:         "SUPERMERCADO SURTIFAMILIAR",
		SubTitle:      "REPORTE CONSOLIDADO DE CIERRES",
		Cajero:        "MULTIPLE (SISTEMA)",
		RangoFechaStr: "RANGO DE FECHAS:",
		TurnoStr:      fmt.Sprintf("%s al %s", from.In(loc).Format("02/01/2006"), to.In(loc).Format("02/01/2006")),
		IDStr:         fmt.Sprintf("%d TURNOS", len(closures)),
		// PhysicalCash es el EFECTIVO CONTADO real del período. Antes acá se
		// pasaba sumVentasCajero, que rompía la nota al pie.
		PhysicalCash:         totalPhysicalCash,
		TotalSales:           totalSales,
		VentasCajeroTotal:    sumVentasCajero,
		VentasSistemaTotal:   sumVentasSistema,
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
		// SÓLO acá: los egresos del período van en una lista única, partida en
		// proveedores y gastos del local. Las páginas de cierre individuales de
		// arriba conservan sus secciones por canal.
		MergeExpensesByKind: true,
		// Los originales, con estado/categoria/proveedor intactos, que es lo que
		// el resumen por tipo necesita para clasificar y excluir bien.
		RawExpenses: expenses,
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

	// 1. Nomina
	//
	// OJO CON LOS ACENTOS: este PDF se genera con gofpdf sobre una fuente
	// latin-1, y el resto del reporte ya está escrito sin tildes a propósito
	// ("Descripcion", "Denominacion", "AUDITORIA"). Además el archivo llegó a
	// tener sus literales doble-codificados, y esta línea devolvía
	// "PAGO DE N?MINA" con la Ó rota, que es lo que el dueño vio impreso.
	//
	// La comparación SÍ conserva la variante con la tilde mal codificada,
	// porque puede haber descripciones así guardadas en la base y hay que
	// seguir reconociéndolas.
	if strings.Contains(cleanUpper, "NOMINA") || strings.Contains(cleanUpper, "NÃ“MINA") || catUpper == "NOMINA" {
		return "PAGO DE NOMINA"
	}

	// 2. Proveedores y RecepciÃ³n de MercancÃ­a
	isSupplier := strings.Contains(cleanUpper, "PAGO DE PROVEEDOR") ||
		strings.Contains(cleanUpper, "PAGO PROVEEDOR") ||
		strings.Contains(cleanUpper, "RECEPCIÃ“N DE MERCANCÃA") ||
		strings.Contains(cleanUpper, "RECEPCION DE MERCANCIA") ||
		strings.Contains(cleanUpper, "RECEPCION MERCANCIA") ||
		strings.Contains(cleanUpper, "ABONO A DEUDA") ||
		strings.Contains(cleanUpper, "PAGO A DEUDA") ||
		catUpper == "PROVEEDORES" || catUpper == "PROVEEDOR"

	if isSupplier {
		providerName := clean
		prefixes := []string{
			"RECEPCIÃ“N DE MERCANCÃA -", "RECEPCION DE MERCANCIA -", "RECEPCION MERCANCIA -",
			"RECEPCIÃ“N DE MERCANCÃA", "RECEPCION DE MERCANCIA", "RECEPCION MERCANCIA",
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

	// 4. Arriendo
	//
	// Sólo "ARRIENDO": el dueño pidió quitarle "Y ALQUILERES" porque acá es lo
	// mismo y el texto largo no aporta.
	if strings.Contains(cleanUpper, "ARRIENDO") || strings.Contains(cleanUpper, "ALQUILER") {
		return "ARRIENDO"
	}

	// 5. Servicios DESGLOSADOS por tipo.
	//
	// Antes todo caía en un único "PAGO DE SERVICIOS" que sumaba luz, agua,
	// internet y gas en una sola fila. El dueño escribe QUÉ servicio paga, así
	// que esa información existe y se estaba tirando: ahora cada servicio es su
	// propia fila y se puede ver en qué se va la plata.
	//
	// El orden importa: se evalúa de lo más específico a lo más general, y
	// "SERVICIOS" genérico queda al final como bolsa para los que no se
	// identifican.
	servicios := []struct {
		claves   []string
		etiqueta string
	}{
		{[]string{"LUZ", "ENERGIA", "ELECTRIC", "CODENSA", "ENEL"}, "SERVICIO - LUZ"},
		{[]string{"AGUA", "ACUEDUCTO", "ALCANTARILLADO"}, "SERVICIO - AGUA"},
		{[]string{"INTERNET", "WIFI", "FIBRA", "CLARO", "MOVISTAR", "TIGO"}, "SERVICIO - INTERNET"},
		{[]string{"GAS"}, "SERVICIO - GAS"},
		{[]string{"TELEFON", "CELULAR", "RECARGA"}, "SERVICIO - TELEFONO"},
		{[]string{"BASURA", "ASEO PUBLICO"}, "SERVICIO - BASURAS"},
	}
	for _, s := range servicios {
		for _, k := range s.claves {
			if strings.Contains(cleanUpper, k) {
				return s.etiqueta
			}
		}
	}
	// Servicio sin identificar: se agrupa aparte para que se note que falta
	// detallarlo, en vez de esconderlo entre los identificados.
	if strings.Contains(cleanUpper, "SERVICIOS") || strings.Contains(cleanUpper, "SERVICIO") || catUpper == "SERVICIOS" {
		return "SERVICIO - SIN DETALLAR"
	}

	// 6. Almuerzos: TODAS las variantes van a la MISMA fila.
	//
	// El dueño lo pidió explícitamente: "los almuerzos o almuerzo ponlos unidos
	// porque es lo mismo". Antes cada texto distinto abría su propia fila y
	// aparecían "OTROS GASTOS (ALMUERZOS AGOSTO 16-31)" y
	// "OTROS GASTOS (ALMUERZO (20,21,24,25,26,27))" por separado, cuando es el
	// mismo gasto. Se ignoran las fechas y los rangos que traiga el texto.
	if strings.Contains(cleanUpper, "ALMUERZ") {
		return "ALMUERZOS"
	}

	// 7. Otros Gastos
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
		cash, nequi, davi, fondo, coins := parseExpenseChannels(&e)

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
				} else if channel == "ALCANCIA" {
					existing.CoinsAmount += amount
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
				} else if channel == "ALCANCIA" {
					item.CoinsAmount = amount
					item.PaymentSource = "ALCANCIA"
				}
				groupedMap[key] = item
				orderedKeys = append(orderedKeys, key)
			}
		}

		addAmount("EFECTIVO", cash)
		addAmount("NEQUI", nequi)
		addAmount("DAVIPLATA", davi)
		addAmount("FONDO", fondo)
		addAmount("ALCANCIA", coins)
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
