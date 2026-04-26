package handlers

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"bytes"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jung-kurt/gofpdf"
)


func formatCOP(amount float64) string {
	// Manejo de negativos
	isNegative := amount < 0
	if isNegative {
		amount = -amount
	}

	s := fmt.Sprintf("%.0f", amount)
	var res strings.Builder
	
	if isNegative {
		res.WriteRune('-')
	}

	n := len(s)
	for i, r := range s {
		res.WriteRune(r)
		if i < n-1 && (n-i-1)%3 == 0 {
			res.WriteRune('.')
		}
	}
	return res.String()
}


type DashboardHandler struct {
	service         *services.DashboardService
	telegramService *services.TelegramService
	auditService    *services.AuditService
}

func NewDashboardHandler(s *services.DashboardService, tg *services.TelegramService, a *services.AuditService) *DashboardHandler {
	return &DashboardHandler{service: s, telegramService: tg, auditService: a}
}

func (h *DashboardHandler) GetOverview(c *gin.Context) {
	data, err := h.service.GetOverview()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener resumen del dashboard", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) GetCashierClosure(c *gin.Context) {
	data, err := h.service.GetCashierClosure()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener cierre de caja", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) SaveClosure(c *gin.Context) {
	var closure models.CashierClosure
	if err := c.ShouldBindJSON(&closure); err != nil {
		log.Printf("❌ [SaveClosure] Error al bindear JSON: %v", err)
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de cierre inválido", err)
		return
	}

	// Obtener usuario del contexto (AuthMiddleware) - Usar claves consistentes
	dniVal, _ := c.Get("dni")
	if dniVal != nil {
		closure.ClosedByDNI = fmt.Sprintf("%v", dniVal)
	} else {
		closure.ClosedByDNI = "S.N."
	}
	
	nameVal, _ := c.Get("userName")
	if nameVal != nil {
		closure.ClosedByName = fmt.Sprintf("%v", nameVal)
	} else {
		closure.ClosedByName = "USUARIO"
	}

	log.Printf("💾 [SaveClosure] Iniciando persistencia. Cajero: %s (%s)", closure.ClosedByName, closure.ClosedByDNI)

	err := h.service.SaveClosure(&closure)
	if err != nil {
		log.Printf("❌ [SaveClosure] Error en servicio SaveClosure: %v", err)
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al guardar cierre de caja en base de datos", err)
		return
	}

	log.Printf("✅ [SaveClosure] Cierre guardado con éxito. ID: %d. Iniciando envío asíncrono de reportes...", closure.ID)

	// Auditoría Forense de Cierre de Caja
	dni, _ := c.Get("dni")
	name, _ := c.Get("userName")
	isCritical := closure.Difference != 0
	expectedCash := closure.TotalCash - closure.TotalExpenses
	
	details := fmt.Sprintf("Cierre de caja ID #%d realizado por %s", closure.ID, closure.ClosedByName)
	human := fmt.Sprintf("El cajero %s realizó el cierre de caja. Balance: $%s real vs $%s esperado. Diferencia: $%s", 
		closure.ClosedByName, fmt.Sprintf("%.2f", closure.PhysicalCash), fmt.Sprintf("%.2f", expectedCash), fmt.Sprintf("%.2f", closure.Difference))
	
	changes := fmt.Sprintf(`{"expected": %f, "physical": %f, "difference": %f}`, expectedCash, closure.PhysicalCash, closure.Difference)

	h.auditService.Log(dni.(string), name.(string), "CASH_CLOSURE", "SALES", details, human, changes, c.ClientIP(), c.Request.UserAgent(), isCritical)

	// BLINDAJE: El envío de Telegram y PDF se hace en una goroutine para no bloquear la respuesta al cliente
	go func(cl models.CashierClosure) {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("⚠️ [SaveClosure] El proceso de reportes asíncronos entró en PANIC: %v", r)
			}
		}()

		// Telegram Alert
		tgMsg := h.formatTelegramClosureMessage(cl, false)
		h.telegramService.SendMarkdownAlert(tgMsg)

		// PDF Report
		pdfBuf := h.generateClosurePDF(cl, false)
		filename := fmt.Sprintf("CIERRE_%s_%s.pdf", time.Now().Format("20060102"), cl.ClosedByDNI)
		_ = h.telegramService.SendDocument(pdfBuf, filename, "📄 Reporte de Cierre Profesional (PDF)")
		
		log.Printf("📤 [SaveClosure] Reportes asíncronos enviados para cierre ID: %d", cl.ID)
	}(closure)

	c.JSON(http.StatusOK, gin.H{
		"message": "Cierre de caja procesado y guardado correctamente", 
		"id": closure.ID,
	})
}

func (h *DashboardHandler) SendPartialReport(c *gin.Context) {
	var closure models.CashierClosure
	if err := c.ShouldBindJSON(&closure); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de reporte inválido", err)
		return
	}

	// Telegram Alert (Partial)
	tgMsg := h.formatTelegramClosureMessage(closure, true)
	h.telegramService.SendMarkdownAlert(tgMsg)

	// PDF Alert (Partial)
	pdfBuf := h.generateClosurePDF(closure, true)
	filename := fmt.Sprintf("PARCIAL_%s_%s.pdf", time.Now().Format("20060102"), closure.ClosedByDNI)
	h.telegramService.SendDocument(pdfBuf, filename, "⏳ Reporte Parcial de Caja (PDF)")

	c.JSON(http.StatusOK, gin.H{"message": "Reporte parcial enviado a Telegram"})
}

func (h *DashboardHandler) formatTelegramClosureMessage(closure models.CashierClosure, isPartial bool) string {

	title := "🧾 *REPORTE DE CIERRE PROFESIONAL*"
	if isPartial {
		title = "⏳ *REPORTE DE AVANCE (PARCIAL)*"
	}

	statusIcon := "✅"
	statusText := "BALANCE PERFECTO"
	if closure.Difference < 0 {
		statusIcon = "🚨"
		statusText = "FALTANTE"
	} else if closure.Difference > 0 {
		statusIcon = "⚠️"
		statusText = "SOBRANTE"
	}

	expectedCash := closure.TotalCash - closure.TotalExpenses

	// 1. INFO GENERAL
	header := fmt.Sprintf("%s\n━━━━━━━━━━━━━━━━━━━━\n"+
		"👤 *CAJERO:* %s\n"+
		"📅 *INICIO:* `%s`\n"+
		"🏁 *FIN:*    `%s`\n"+
		"━━━━━━━━━━━━━━━━━━━━\n\n",
		title,
		closure.ClosedByName,
		closure.StartDate.Format("02/01 15:04"),
		closure.EndDate.Format("02/01 15:04"))

	// 2. RESUMEN FINANCIERO
	core := fmt.Sprintf("💰 *RESUMEN DE CAJA*\n"+
		"🔹 Ventas Brutas:  `$%s`\n"+
		"🔹 Entradas Efec:  `+$%s`\n"+
		"🔹 Salidas Efec:   `-$%s`\n"+
		"────────────────────\n"+
		"📥 *ESPERADO:*      `$%s`\n"+
		"💵 *REAL:*          `$%s`\n\n"+
		"%s *DIFERENCIA:*   `$%s` (%s)\n\n",
		formatCOP(closure.TotalSales),
		formatCOP(closure.TotalCash),
		formatCOP(closure.TotalExpenses),
		formatCOP(expectedCash),
		formatCOP(closure.PhysicalCash),
		statusIcon, formatCOP(closure.Difference), statusText)

	// 3. DESGLOSE FÍSICO
	physical := fmt.Sprintf("🪙 *DESGLOSE DE EFECTIVO*\n"+
		"▫️ Billetes:        `$%s`\n"+
		"▫️ Mon. 500/1000:   `$%s`\n"+
		"▫️ Mon. 200:        `$%s`\n"+
		"▫️ Mon. 100:        `$%s`\n\n",
		formatCOP(closure.CashBills),
		formatCOP(closure.Coins500_1000),
		formatCOP(closure.Coins200),
		formatCOP(closure.Coins100))

	// 4. EGRESOS
	expensesText := "💸 *EGRESOS DETALLADOS*\n"
	methods := []string{"EFECTIVO", "NEQUI", "DAVIPLATA", "FONDO"}
	hasExpenses := false
	for _, m := range methods {
		methodTotal := 0.0
		methodText := ""
		for _, e := range closure.Expenses {
			eMethod := e.PaymentSource
			if eMethod == "" { eMethod = "EFECTIVO" }
			if eMethod == m {
				methodText += fmt.Sprintf("   • %s: `$%s`\n", e.Description, formatCOP(e.Amount))
				methodTotal += e.Amount
			}
		}
		if methodTotal > 0 {
			hasExpenses = true
			expensesText += fmt.Sprintf("📍 *%s:* `$%s`\n%s", m, formatCOP(methodTotal), methodText)
		}
	}
	if !hasExpenses {
		expensesText += "_Sin egresos registrados._\n"
	}
	expensesText += "\n"

	creditsText := "🤝 *CRÉDITOS (FIADOS)*\n"
	if len(closure.CreditsIssued) > 0 {
		for _, s := range closure.CreditsIssued {
			clientName := s.ClientDNI
			if clientName == "" { clientName = "Consumidor Final" }
			// Defensa contra punteros nulos en asociaciones no cargadas
			if s.Client.Name != "" { 
				clientName = s.Client.Name 
			}
			creditsText += fmt.Sprintf("▫️ %s: `$%s` (Debe: `$%s`)\n", clientName, formatCOP(s.CreditAmount), formatCOP(s.Client.CurrentCredit))
		}
	} else {
		creditsText += "_Sin fiados hoy._\n"
	}
	creditsText += "\n"

	paymentsText := "💰 *ABONOS (RECAUDO)*\n"
	if len(closure.CreditPayments) > 0 {
		for _, p := range closure.CreditPayments {
			clientName := p.ClientDNI
			if clientName == "" { clientName = "Cliente Desconocido" }
			if p.Client.Name != "" { 
				clientName = p.Client.Name 
			}
			paymentsText += fmt.Sprintf("▫️ %s: `$%s` (Saldo: `$%s`)\n", clientName, formatCOP(p.TotalPaid), formatCOP(p.Client.CurrentCredit))
		}
	} else {
		paymentsText += "_Sin abonos hoy._\n"
	}
	paymentsText += "\n"

	// 6. CANALES DIGITALES Y OTROS
	digital := fmt.Sprintf("📱 *MEDIOS DIGITALES Y OTROS*\n"+
		"▫️ Nequi:      `$%s`\n"+
		"▫️ Daviplata:   `$%s`\n"+
		"▫️ Tarjeta:     `$%s`\n"+
		"▫️ Otros:       `$%s`\n\n",
		formatCOP(closure.TotalNequi),
		formatCOP(closure.TotalDaviplata),
		formatCOP(closure.TotalCard),
		formatCOP(closure.TotalBancolombia+closure.TotalOtherTransfer))

	msg := header + core + physical + expensesText + creditsText + paymentsText + digital

	if !isPartial && closure.AuthorizedBy != "" {
		msg += fmt.Sprintf("🚨 *VERIFICADO POR: %s* 🚨\n\n", closure.AuthorizedBy)
	}

	msg += "━━━━━━━━━━━━━━━━━━━━\n"
	msg += "_Generado por Cerberus POS_"
	return msg
}



func (h *DashboardHandler) GetClosuresHistory(c *gin.Context) {
	data, err := h.service.GetClosuresHistory()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener historial de cierres", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) GetVaultAudit(c *gin.Context) {
	data, err := h.service.GetVaultAudit()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener arqueo de bóveda", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) GetGlobalDebt(c *gin.Context) {
	debt, err := h.service.GetGlobalDebt()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener cartera global", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"totalDebt": debt})
}


func (h *DashboardHandler) generateClosurePDF(closure models.CashierClosure, isPartial bool) *bytes.Buffer {
	pdf := gofpdf.New("P", "mm", "A4", "")
	tr := pdf.UnicodeTranslatorFromDescriptor("")

	mainTitle := "SUPERMERCADO SURTIFAMILIAR"
	subTitle := "AUDITORÍA OFICIAL DE CIERRE DE CAJA"
	if isPartial {
		subTitle = "REPORTE PARCIAL DE CAJA (CORTE)"
	}

	pdf.AddPage()
	
	// --- CABECERA EMPRESARIAL (B&W) ---
	pdf.SetFont("Arial", "B", 20)
	pdf.SetTextColor(0, 0, 0)
	pdf.CellFormat(190, 15, tr(mainTitle), "0", 1, "L", false, 0, "")
	
	pdf.SetFont("Arial", "B", 11)
	pdf.SetTextColor(50, 50, 50)
	pdf.CellFormat(190, 6, tr(subTitle), "0", 1, "L", false, 0, "")

	// Metadatos en Grid
	pdf.SetDrawColor(0, 0, 0)
	pdf.SetLineWidth(0.1)
	pdf.SetFont("Arial", "B", 8)
	pdf.SetTextColor(0, 0, 0)
	
	currY := pdf.GetY() + 5
	pdf.SetY(currY)
	pdf.CellFormat(30, 7, tr(" CAJERO:"), "LT", 0, "L", false, 0, "")
	pdf.SetFont("Arial", "", 8)
	pdf.CellFormat(65, 7, tr(" "+closure.ClosedByName), "T", 0, "L", false, 0, "")
	pdf.SetFont("Arial", "B", 8)
	pdf.CellFormat(45, 7, tr(" FECHA IMPRESIÓN:"), "T", 0, "L", false, 0, "")
	pdf.SetFont("Arial", "", 8)
	pdf.CellFormat(50, 7, tr(" "+time.Now().Format("02/01/2006 15:04")), "RT", 1, "L", false, 0, "")
	
	pdf.SetFont("Arial", "B", 8)
	pdf.CellFormat(30, 7, tr(" TURNO:"), "LB", 0, "L", false, 0, "")
	pdf.SetFont("Arial", "", 8)
	pdf.CellFormat(65, 7, tr(fmt.Sprintf(" %s a %s", closure.StartDate.Format("15:04"), closure.EndDate.Format("15:04"))), "B", 0, "L", false, 0, "")
	pdf.SetFont("Arial", "B", 8)
	pdf.CellFormat(45, 7, tr(" ID CIERRE:"), "B", 0, "L", false, 0, "")
	pdf.SetFont("Arial", "", 8)
	pdf.CellFormat(50, 7, tr(fmt.Sprintf(" CC-%d", closure.Date.Unix()%1000000)), "RB", 1, "L", false, 0, "")
	
	// Línea Gruesa de Auditoría
	pdf.SetLineWidth(0.6)
	pdf.Line(10, pdf.GetY()+3, 200, pdf.GetY()+3)
	pdf.Ln(8)

	// --- BLOQUES DE RESUMEN (AUDIT BOXES) ---
	expectedCash := closure.TotalCash - closure.TotalExpenses
	boxY := pdf.GetY()
	
	// Caja Esperada
	pdf.SetFillColor(255, 255, 255)
	pdf.SetDrawColor(0, 0, 0)
	pdf.SetLineWidth(0.2)
	pdf.Rect(10, boxY, 60, 18, "D")
	pdf.SetXY(10, boxY + 2)
	pdf.SetFont("Arial", "B", 7)
	pdf.CellFormat(60, 5, tr("CAJA ESPERADA"), "0", 1, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 12)
	pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(expectedCash)), "0", 1, "C", false, 0, "")

	// Arqueo Físico
	pdf.Rect(75, boxY, 60, 18, "D")
	pdf.SetXY(75, boxY + 2)
	pdf.SetFont("Arial", "B", 7)
	pdf.CellFormat(60, 5, tr("ARQUEO FÍSICO"), "0", 1, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 12)
	pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(closure.PhysicalCash)), "0", 1, "C", false, 0, "")

	// Diferencia
	pdf.Rect(140, boxY, 60, 18, "D")
	pdf.SetXY(140, boxY + 2)
	pdf.SetFont("Arial", "B", 7)
	pdf.CellFormat(60, 5, tr("DIFERENCIA"), "0", 1, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 12)
	pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(closure.Difference)), "0", 1, "C", false, 0, "")
	
	pdf.SetY(boxY + 25)

	// --- TABLAS DE AUDITORÍA ---
	// Estilo de tabla Enterprise
	drawTable := func(title string, headers []string, widths []float64, rows [][]string) {
		pdf.SetFont("Arial", "B", 10)
		pdf.CellFormat(190, 8, tr(title), "0", 1, "L", false, 0, "")
		
		pdf.SetFillColor(229, 231, 235) // Gris Enterprise
		pdf.SetFont("Arial", "B", 8)
		for i, h := range headers {
			pdf.CellFormat(widths[i], 7, tr(h), "1", 0, "C", true, 0, "")
		}
		pdf.Ln(-1)
		
		pdf.SetFont("Arial", "", 8)
		for _, row := range rows {
			for i, val := range row {
				align := "L"
				if i == len(row)-1 { align = "R" }
				pdf.CellFormat(widths[i], 7, tr(val), "1", 0, align, false, 0, "")
			}
			pdf.Ln(-1)
		}
		pdf.Ln(5)
	}

	// 1. Resumen Operativo
	drawTable("DETALLE OPERATIVO DE CAJA", 
		[]string{"Concepto", "Monto"}, 
		[]float64{130, 60}, 
		[][]string{
			{"(+) Ingresos en Efectivo (Ventas + Recaudos)", fmt.Sprintf("$%s", formatCOP(closure.TotalCash))},
			{"(-) Gastos y Egresos Operativos", fmt.Sprintf("$%s", formatCOP(closure.TotalExpenses))},
			{"(-) Devoluciones de Mercancía", fmt.Sprintf("$%s", formatCOP(closure.TotalReturns))},
			{"(=) BALANCE TEÓRICO EN CAJA", fmt.Sprintf("$%s", formatCOP(expectedCash))},
		})

	// 2. Desglose de Efectivo
	drawTable("DESGLOSE DE EFECTIVO REPORTADO", 
		[]string{"Denominación", "Monto"}, 
		[]float64{130, 60}, 
		[][]string{
			{"Billetes", fmt.Sprintf("$%s", formatCOP(closure.CashBills))},
			{"Monedas 500 / 1000", fmt.Sprintf("$%s", formatCOP(closure.Coins500_1000))},
			{"Monedas 200", fmt.Sprintf("$%s", formatCOP(closure.Coins200))},
			{"Monedas 100", fmt.Sprintf("$%s", formatCOP(closure.Coins100))},
		})

	// 3. Egresos por Canal
	methods := []string{"EFECTIVO", "NEQUI", "DAVIPLATA", "FONDO"}
	for _, m := range methods {
		var rows [][]string
		total := 0.0
		for _, e := range closure.Expenses {
			eMethod := e.PaymentSource
			if eMethod == "" { eMethod = "EFECTIVO" }
			if eMethod == m {
				rows = append(rows, []string{e.Description, fmt.Sprintf("$%s", formatCOP(e.Amount))})
				total += e.Amount
			}
		}
		if len(rows) > 0 {
			rows = append(rows, []string{fmt.Sprintf("TOTAL EGRESOS %s", m), fmt.Sprintf("$%s", formatCOP(total))})
			drawTable(fmt.Sprintf("EGRESOS: %s", m), []string{"Descripción", "Monto"}, []float64{140, 50}, rows)
		}
	}

	// 4. Canales Digitales
	drawTable("CANALES DIGITALES (TRANSFERENCIAS)", 
		[]string{"Nequi", "Daviplata", "Tarjeta", "Otros"}, 
		[]float64{47.5, 47.5, 47.5, 47.5}, 
		[][]string{
			{fmt.Sprintf("$%s", formatCOP(closure.TotalNequi)), fmt.Sprintf("$%s", formatCOP(closure.TotalDaviplata)), fmt.Sprintf("$%s", formatCOP(closure.TotalCard)), fmt.Sprintf("$%s", formatCOP(closure.TotalBancolombia+closure.TotalOtherTransfer))},
		})

	// 5. Fiados
	if len(closure.CreditsIssued) > 0 {
		var rows [][]string
		for _, s := range closure.CreditsIssued {
			name := s.Client.Name
			if name == "" { name = s.ClientDNI }
			rows = append(rows, []string{name, fmt.Sprintf("$%s", formatCOP(s.CreditAmount)), fmt.Sprintf("$%s", formatCOP(s.Client.CurrentCredit))})
		}
		drawTable("DETALLE DE FIADOS EMITIDOS", []string{"Cliente", "Monto Fiado", "Deuda Total"}, []float64{100, 45, 45}, rows)
	}

	// --- BLOQUE DE FIRMAS ---
	pdf.Ln(10)
	if pdf.GetY() > 240 { pdf.AddPage() }
	
	sigY := pdf.GetY() + 20
	pdf.SetDrawColor(0, 0, 0)
	pdf.SetLineWidth(0.4)
	pdf.Line(20, sigY, 80, sigY)
	pdf.SetXY(20, sigY + 2)
	pdf.SetFont("Arial", "B", 8)
	pdf.CellFormat(60, 5, tr("FIRMA RESPONSABLE"), "0", 0, "C", false, 0, "")
	
	pdf.Line(130, sigY, 190, sigY)
	pdf.SetXY(130, sigY + 2)
	pdf.CellFormat(60, 5, tr("FIRMA GERENCIA"), "0", 1, "C", false, 0, "")

	if !isPartial && closure.AuthorizedBy != "" {
		pdf.Ln(15)
		pdf.SetFillColor(240, 240, 240)
		pdf.SetTextColor(0, 0, 0)
		pdf.SetFont("Arial", "B", 9)
		pdf.CellFormat(190, 10, tr(fmt.Sprintf("DESCUADRE AUTORIZADO POR: %s", closure.AuthorizedBy)), "1", 1, "C", true, 0, "")
	}

	var buf bytes.Buffer
	pdf.Output(&buf)
	return &buf
}



