package handlers

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"backPOS-go/internal/infrastructure/sse"
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
	startDate := c.Query("startDate")
	endDate := c.Query("endDate")
	
	data, err := h.service.GetOverview(c.Request.Context(), startDate, endDate)
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

	// Obtener usuario del contexto de forma segura
	dniStr, nameStr := GetContextUser(c)
	closure.ClosedByDNI = dniStr
	closure.ClosedByName = nameStr

	log.Printf("💾 [SaveClosure] Iniciando persistencia. Cajero: %s (%s)", closure.ClosedByName, closure.ClosedByDNI)

	// Asegurar que la fecha de fin sea la hora actual del servidor (UTC para consistencia)
	closure.EndDate = time.Now()
	closure.Date = time.Now()

	err := h.service.SaveClosure(&closure)
	if err != nil {
		log.Printf("❌ [SaveClosure] Error en servicio SaveClosure: %v", err)
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al guardar cierre de caja en base de datos", err)
		return
	}

	log.Printf("✅ [SaveClosure] Cierre guardado con éxito. ID: %d. Iniciando envío asíncrono de reportes...", closure.ID)

	// Auditoría Forense de Cierre de Caja
	// Nueva política: El cuadre se valida según lo físico. Ya no es crítico si hay diferencia con lo esperado.
	isCritical := false
	expectedCash := closure.ExpectedCash
	if expectedCash == 0 {
		expectedCash = closure.TotalCash - closure.TotalExpenses - closure.TotalReturns
	}
	
	realBalance := closure.PhysicalCash + closure.TotalNequi + closure.TotalDaviplata + closure.TotalCard + closure.TotalBancolombia + closure.TotalOtherTransfer - closure.TotalExpenses

	details := fmt.Sprintf("Cierre de caja ID #%d realizado por %s", closure.ID, closure.ClosedByName)
	human := fmt.Sprintf("El cajero %s realizó el cierre de caja. Balance Real Físico: $%s. (Esperado sistema: $%s)", 
		closure.ClosedByName, fmt.Sprintf("%.2f", realBalance), fmt.Sprintf("%.2f", expectedCash))
	
	changes := fmt.Sprintf(`{"expected": %f, "physical": %f, "realBalance": %f}`, expectedCash, closure.PhysicalCash, realBalance)
	
	h.auditService.Log(dniStr, nameStr, "CASH_CLOSURE", "SALES", details, human, changes, c.ClientIP(), c.Request.UserAgent(), isCritical)

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

	// Notificar a todos los clientes conectados que hubo un cierre (Zero-Reload)
	go sse.GetSSEService().BroadcastDashboardUpdate()

	c.JSON(http.StatusOK, gin.H{
		"message": "Cierre de caja procesado y guardado correctamente", 
		"id": closure.ID,
	})
}

func (h *DashboardHandler) AdjustInitialBalance(c *gin.Context) {
	var body struct {
		Cash      float64 `json:"cash"`
		Nequi     float64 `json:"nequi"`
		Daviplata float64 `json:"daviplata"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato inválido", err)
		return
	}

	dniStr, nameStr := GetContextUser(c)
	err := h.service.AdjustInitialBalance(body.Cash, body.Nequi, body.Daviplata, nameStr, dniStr)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al ajustar saldo inicial", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Saldo inicial ajustado correctamente"})

	// AVISO GLOBAL: Ajuste de saldo base de caja
	go sse.GetSSEService().BroadcastDashboardUpdate()
}

func (h *DashboardHandler) SendPartialReport(c *gin.Context) {
	var closure models.CashierClosure
	if err := c.ShouldBindJSON(&closure); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de reporte inválido", err)
		return
	}

	// Asegurar que el reporte parcial refleje la hora exacta del servidor
	loc := time.FixedZone("America/Bogota", -5*60*60)
	closure.EndDate = time.Now().In(loc)

	// Telegram Alert (Partial)
	tgMsg := h.formatTelegramClosureMessage(closure, true)
	h.telegramService.SendMarkdownAlert(tgMsg)

	// PDF Alert (Partial)
	pdfBuf := h.generateClosurePDF(closure, true)
	filename := fmt.Sprintf("PARCIAL_%s_%s.pdf", time.Now().Format("20060102"), closure.ClosedByDNI)
	h.telegramService.SendDocument(pdfBuf, filename, "⏳ Reporte Parcial de Caja (PDF)")

	c.JSON(http.StatusOK, gin.H{"message": "Reporte parcial enviado a Telegram"})
}

func normalizeExpensesForReport(expenses []models.Expense) {
	for i := range expenses {
		e := &expenses[i]
		if e.CashAmount == 0 && e.NequiAmount == 0 && e.DaviplataAmount == 0 && e.FondoAmount == 0 && e.Status != "PENDING" {
			src := strings.ToUpper(e.PaymentSource)
			if strings.Contains(src, "/") && strings.Contains(src, "$") {
				parts := strings.Split(src, "/")
				for _, p := range parts {
					p = strings.TrimSpace(p)
					if strings.Contains(p, ": $") {
						kv := strings.Split(p, ": $")
						if len(kv) == 2 {
							method := strings.TrimSpace(kv[0])
							valStr := strings.ReplaceAll(kv[1], ".", "")
							val, _ := strconv.ParseFloat(valStr, 64)
							switch method {
							case "CAJA", "EFECTIVO":
								e.CashAmount += val
							case "NEQUI":
								e.NequiAmount += val
							case "DAVIPLATA":
								e.DaviplataAmount += val
							case "FONDO":
								e.FondoAmount += val
							}
						}
					}
				}
			} else {
				if src == "" || src == "CAJA" || src == "EFECTIVO" {
					e.CashAmount = e.Amount
				} else if src == "NEQUI" {
					e.NequiAmount = e.Amount
				} else if src == "DAVIPLATA" {
					e.DaviplataAmount = e.Amount
				} else if src == "FONDO" {
					e.FondoAmount = e.Amount
				} else if src == "PREST." || src == "DEUDA" || src == "PRESTAMO" {
					e.Status = "PENDING"
				} else {
					e.CashAmount = e.Amount
				}
			}
		}
	}
}

func (h *DashboardHandler) formatTelegramClosureMessage(closure models.CashierClosure, isPartial bool) string {
	title := "🧾 *REPORTE DE CIERRE PROFESIONAL*"
	if isPartial {
		title = "⏳ *REPORTE DE AVANCE (PARCIAL)*"
	}

	expectedCash := closure.ExpectedCash
	if expectedCash == 0 {
		expectedCash = closure.TotalCash - closure.TotalExpenses - closure.TotalReturns
	}

	// 1. LÓGICA MATEMÁTICA DEL REPORTE
	efectivoContado := closure.PhysicalCash
	ingresosDigitales := closure.TotalNequi + closure.TotalDaviplata + closure.TotalCard + closure.TotalBancolombia + closure.TotalOtherTransfer

	normalizeExpensesForReport(closure.Expenses)

	egresosEfectivoTurno := 0.0
	for _, e := range closure.Expenses {
		egresosEfectivoTurno += e.CashAmount
	}

	ventaReal := efectivoContado + ingresosDigitales + egresosEfectivoTurno
	diferenciaFisica := efectivoContado - expectedCash

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
	
	// 2. CONSTRUCCIÓN DE PLANTILLA
	var msg strings.Builder

	msg.WriteString(fmt.Sprintf("%s\n", title))
	msg.WriteString("━━━━━━━━━━━━━━━━━━━━\n")
	msg.WriteString(fmt.Sprintf("👤 *CAJERO:* %s\n", closure.ClosedByName))
	msg.WriteString(fmt.Sprintf("📅 *INICIO:* `%s`\n", closure.StartDate.In(loc).Format("02/01/2006 15:04")))
	msg.WriteString(fmt.Sprintf("🏁 *FIN:*    `%s`\n", closure.EndDate.In(loc).Format("02/01/2006 15:04")))
	msg.WriteString("━━━━━━━━━━━━━━━━━━━━\n\n")

	msg.WriteString("🧮 *VENTA REAL DEL DÍA (RECONSTRUIDO)*\n")
	msg.WriteString(fmt.Sprintf("💰 *TOTAL VENTAS:* `$%s`\n", formatCOP(ventaReal)))
	msg.WriteString("📋 _(Efectivo Contado + Digital + Egresos Caja)_\n\n")

	msg.WriteString("💵 *1. RESUMEN DE CAJA (ARQUEO FÍSICO)*\n")
	msg.WriteString(fmt.Sprintf("▫️ Efectivo Esperado:  `$%s`\n", formatCOP(expectedCash)))
	msg.WriteString(fmt.Sprintf("▫️ Efectivo Contado:   `$%s`\n", formatCOP(efectivoContado)))
	msg.WriteString("────────────────────\n")
	msg.WriteString(fmt.Sprintf("🚨 *DIFERENCIA FÍSICA:* %s `$%s`\n\n", diferenciaIcon, formatCOP(diferenciaFisicaAbs)))

	msg.WriteString("📱 *2. MEDIOS DIGITALES Y OTROS*\n")
	msg.WriteString(fmt.Sprintf("▫️ Nequi:      `$%s`\n", formatCOP(closure.TotalNequi)))
	msg.WriteString(fmt.Sprintf("▫️ Daviplata:  `$%s`\n", formatCOP(closure.TotalDaviplata)))
	msg.WriteString(fmt.Sprintf("▫️ Tarjeta:    `$%s`\n", formatCOP(closure.TotalCard)))
	if closure.TotalBancolombia+closure.TotalOtherTransfer > 0 {
		msg.WriteString(fmt.Sprintf("▫️ Otros:      `$%s`\n", formatCOP(closure.TotalBancolombia+closure.TotalOtherTransfer)))
	}
	msg.WriteString("────────────────────\n")
	msg.WriteString(fmt.Sprintf("📲 *TOTAL DIGITAL:*  `$%s`\n\n", formatCOP(ingresosDigitales)))

	msg.WriteString("💸 *3. EGRESOS DETALLADOS POR CANAL*\n")
	
	// 3. CONTROL DE EGRESOS POR CANAL
	type splitExpense struct {
		Desc   string
		Amount float64
	}
	egresosAgrupados := make(map[string][]splitExpense)
	
	totalEfectivo := 0.0
	totalFondo := 0.0
	totalPrestamos := 0.0
	
	for _, e := range closure.Expenses {
		if e.CashAmount > 0 {
			egresosAgrupados["EFECTIVO"] = append(egresosAgrupados["EFECTIVO"], splitExpense{Desc: e.Description, Amount: e.CashAmount})
			totalEfectivo += e.CashAmount
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
	msg.WriteString(fmt.Sprintf("▫️ Total gastado de la Venta del día (Efectivo): `$%s`\n", formatCOP(totalEfectivo)))
	msg.WriteString(fmt.Sprintf("▫️ Total gastado del Fondo (Plata de adentro): `$%s`\n", formatCOP(totalFondo)))
	msg.WriteString(fmt.Sprintf("▫️ Total gastado de Préstamos (Plata de afuera): `$%s`\n", formatCOP(totalPrestamos)))
	msg.WriteString("\n")

	msg.WriteString("🤝 *4. CRÉDITOS Y ABONOS*\n")
	totalFiados := 0.0
	for _, s := range closure.CreditsIssued {
		totalFiados += s.CreditAmount
	}
	totalAbonos := 0.0
	for _, p := range closure.CreditPayments {
		totalAbonos += p.TotalPaid
	}

	msg.WriteString(fmt.Sprintf("📍 *FIADOS ENTREGADOS:* `$%s`\n", formatCOP(totalFiados)))
	if len(closure.CreditsIssued) > 0 {
		for _, s := range closure.CreditsIssued {
			name := s.Client.Name
			if name == "" {
				name = s.ClientDNI
			}
			msg.WriteString(fmt.Sprintf("   • %s: `$%s` (Saldo actual: `$%s`)\n", name, formatCOP(s.CreditAmount), formatCOP(s.Client.CurrentCredit)))
		}
	} else {
		msg.WriteString("   _Sin fiados emitidos._\n")
	}

	msg.WriteString(fmt.Sprintf("📍 *ABONOS RECIBIDOS:* `$%s`\n", formatCOP(totalAbonos)))
	if len(closure.CreditPayments) > 0 {
		for _, p := range closure.CreditPayments {
			name := p.Client.Name
			if name == "" {
				name = p.ClientDNI
			}
			msg.WriteString(fmt.Sprintf("   • %s: `$%s` (Saldo actual: `$%s`)\n", name, formatCOP(p.TotalPaid), formatCOP(p.Client.CurrentCredit)))
		}
	} else {
		msg.WriteString("   _Sin abonos recibidos._\n")
	}
	msg.WriteString("\n")

	authName := closure.AuthorizedBy
	if authName == "" {
		authName = closure.ClosedByName
	}
	msg.WriteString(fmt.Sprintf("🚨 *VERIFICADO POR:* %s 🚨\n", authName))
	msg.WriteString("━━━━━━━━━━━━━━━━━━━━\n")
	msg.WriteString("_Generado por POS Pro_")

	return msg.String()
}



func (h *DashboardHandler) GetClosuresHistory(c *gin.Context) {
	data, err := h.service.GetClosuresHistory()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener historial de cierres", err)
		return
	}
	if data == nil {
		data = []models.CashierClosure{}
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) DeleteClosure(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "ID de cierre inválido", err)
		return
	}

	err = h.service.DeleteClosure(uint(id))
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al eliminar cierre de caja", err)
		return
	}

	// Auditoría Forense: Eliminación de cierre es SIEMPRE crítica
	dniStr, nameStr := GetContextUser(c)

	details := fmt.Sprintf("Cierre de caja ID #%d ELIMINADO permanentemente por %s", id, nameStr)
	human := fmt.Sprintf("El administrador %s eliminó el cierre de caja #%d del sistema. Este registro fue borrado permanentemente.", nameStr, id)
	changes := fmt.Sprintf(`{"deletedClosureId": %d, "deletedBy": "%s"}`, id, nameStr)

	h.auditService.Log(dniStr, nameStr, "CLOSURE_DELETE", "SALES", details, human, changes, c.ClientIP(), c.Request.UserAgent(), true)

	log.Printf("🗑️ [DeleteClosure] Admin %s (%s) eliminó cierre ID #%d", nameStr, dniStr, id)

	c.JSON(http.StatusOK, gin.H{
		"message": fmt.Sprintf("Cierre #%d eliminado correctamente", id),
	})

	// AVISO GLOBAL: Cierre eliminado (Actualiza historial)
	go sse.GetSSEService().BroadcastDashboardUpdate()
}

func (h *DashboardHandler) UpdateClosure(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "ID de cierre inválido", err)
		return
	}

	var updates map[string]interface{}
	if err := c.ShouldBindJSON(&updates); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Cuerpo inválido", err)
		return
	}

	err = h.service.UpdateClosure(uint(id), updates)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al actualizar cierre", err)
		return
	}

	// Re-enviar a Telegram tras editar el cierre
	if updatedClosure, err := h.service.GetClosureByID(uint(id)); err == nil && updatedClosure != nil {
		tgMsg := h.formatTelegramClosureMessage(*updatedClosure, false)
		tgMsg = "⚠️ *REPORTE EDITADO MANUALMENTE* ⚠️\n" + tgMsg
		h.telegramService.SendMarkdownAlert(tgMsg)
	} else {
		log.Printf("⚠️ No se pudo obtener el cierre %d para reenviar reporte de Telegram: %v", id, err)
	}

	// Auditoría Forense: Edición de cierre
	dniStr, nameStr := GetContextUser(c)
	details := fmt.Sprintf("Cierre de caja ID #%d EDITADO por %s", id, nameStr)
	human := fmt.Sprintf("El administrador %s editó el cierre de caja #%d.", nameStr, id)
	updatesJSON, _ := json.Marshal(updates)
	changes := fmt.Sprintf(`{"updatedClosureId": %d, "updatedBy": "%s", "changes": %s}`, id, nameStr, string(updatesJSON))

	h.auditService.Log(dniStr, nameStr, "CLOSURE_UPDATE", "SALES", details, human, changes, c.ClientIP(), c.Request.UserAgent(), true)

	c.JSON(http.StatusOK, gin.H{
		"message": fmt.Sprintf("Cierre #%d actualizado correctamente", id),
	})

	go sse.GetSSEService().BroadcastDashboardUpdate()
}

func (h *DashboardHandler) GetDetailedReport(c *gin.Context) {
	employeeDni := c.Query("employeeDni")
	data, err := h.service.GetDetailedShiftReport(employeeDni)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al generar reporte detallado", err)
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
	normalizeExpensesForReport(closure.Expenses)
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
	loc := time.FixedZone("America/Bogota", -5*60*60)
	pdf.CellFormat(50, 7, tr(" "+time.Now().In(loc).Format("02/01/2006 15:04")), "RT", 1, "L", false, 0, "")
	
	pdf.SetFont("Arial", "B", 8)
	pdf.CellFormat(30, 7, tr(" TURNO:"), "LB", 0, "L", false, 0, "")
	pdf.SetFont("Arial", "", 8)
	pdf.CellFormat(65, 7, tr(fmt.Sprintf(" %s a %s", closure.StartDate.In(loc).Format("15:04"), closure.EndDate.In(loc).Format("15:04"))), "B", 0, "L", false, 0, "")
	pdf.SetFont("Arial", "B", 8)
	pdf.CellFormat(45, 7, tr(" ID CIERRE:"), "B", 0, "L", false, 0, "")
	pdf.SetFont("Arial", "", 8)
	pdf.CellFormat(50, 7, tr(fmt.Sprintf(" CC-%d", closure.Date.In(loc).Unix()%1000000)), "RB", 1, "L", false, 0, "")
	
	// Línea Gruesa de Auditoría
	pdf.SetLineWidth(0.6)
	pdf.Line(10, pdf.GetY()+3, 200, pdf.GetY()+3)
	pdf.Ln(8)

	// --- BLOQUES DE RESUMEN (AUDIT BOXES) ---
	expectedCash := closure.ExpectedCash
	if expectedCash == 0 {
		expectedCash = closure.TotalCash - closure.TotalExpenses - closure.TotalReturns
	}

	digitalIncome := closure.TotalNequi + closure.TotalDaviplata + closure.TotalCard + closure.TotalBancolombia + closure.TotalOtherTransfer
	realBalance := closure.PhysicalCash + digitalIncome - closure.TotalExpenses

	boxY := pdf.GetY()
	
	// Efectivo Físico
	pdf.SetFillColor(255, 255, 255)
	pdf.SetDrawColor(0, 0, 0)
	pdf.SetLineWidth(0.2)
	pdf.Rect(10, boxY, 60, 18, "D")
	pdf.SetXY(10, boxY + 2)
	pdf.SetFont("Arial", "B", 7)
	pdf.CellFormat(60, 5, tr("EFECTIVO FÍSICO"), "0", 1, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 12)
	pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(closure.PhysicalCash)), "0", 1, "C", false, 0, "")

	// Digital - Egresos
	pdf.Rect(75, boxY, 60, 18, "D")
	pdf.SetXY(75, boxY + 2)
	pdf.SetFont("Arial", "B", 7)
	pdf.CellFormat(60, 5, tr("DIGITAL - EGRESOS"), "0", 1, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 12)
	netDigital := digitalIncome - closure.TotalExpenses
	pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(netDigital)), "0", 1, "C", false, 0, "")

	// Balance Real
	pdf.SetFillColor(230, 245, 230) // Fondo verde claro
	pdf.Rect(140, boxY, 60, 18, "DF")
	pdf.SetXY(140, boxY + 2)
	pdf.SetFont("Arial", "B", 7)
	pdf.CellFormat(60, 5, tr("BALANCE REAL"), "0", 1, "C", false, 0, "")
	pdf.SetFont("Arial", "B", 12)
	pdf.CellFormat(60, 8, fmt.Sprintf("$%s", formatCOP(realBalance)), "0", 1, "C", false, 0, "")
	
	pdf.SetY(boxY + 25)

	// --- NOTA ESPERADO ---
	pdf.SetFont("Arial", "I", 8)
	pdf.CellFormat(190, 5, tr(fmt.Sprintf("* Efectivo Esperado por Sistema (Informativo): $%s", formatCOP(expectedCash))), "0", 1, "L", false, 0, "")
	pdf.Ln(2)

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
			{"Monedas 1000", fmt.Sprintf("$%s", formatCOP(closure.Coins1000))},
			{"Monedas 500", fmt.Sprintf("$%s", formatCOP(closure.Coins500))},
			{"Monedas 200", fmt.Sprintf("$%s", formatCOP(closure.Coins200))},
			{"Monedas 100", fmt.Sprintf("$%s", formatCOP(closure.Coins100))},
		})

	// 3. Egresos por Canal
	methods := []string{"EFECTIVO", "NEQUI", "DAVIPLATA", "FONDO", "PRESTAMO"}
	for _, m := range methods {
		var rows [][]string
		total := 0.0
		
		for _, e := range closure.Expenses {
			isMixedOrNewSchema := e.CashAmount > 0 || e.NequiAmount > 0 || e.DaviplataAmount > 0 || e.FondoAmount > 0
			
			if isMixedOrNewSchema {
				if m == "EFECTIVO" && e.CashAmount > 0 {
					rows = append(rows, []string{e.Description, fmt.Sprintf("$%s", formatCOP(e.CashAmount))})
					total += e.CashAmount
				}
				if m == "NEQUI" && e.NequiAmount > 0 {
					rows = append(rows, []string{e.Description, fmt.Sprintf("$%s", formatCOP(e.NequiAmount))})
					total += e.NequiAmount
				}
				if m == "DAVIPLATA" && e.DaviplataAmount > 0 {
					rows = append(rows, []string{e.Description, fmt.Sprintf("$%s", formatCOP(e.DaviplataAmount))})
					total += e.DaviplataAmount
				}
				if m == "FONDO" && e.FondoAmount > 0 {
					rows = append(rows, []string{e.Description, fmt.Sprintf("$%s", formatCOP(e.FondoAmount))})
					total += e.FondoAmount
				}
				if m == "PRESTAMO" {
					sumPaid := e.CashAmount + e.NequiAmount + e.DaviplataAmount + e.FondoAmount
					if e.Status == "PENDING" && math.Round(e.Amount-sumPaid) > 0 {
						diff := e.Amount - sumPaid
						rows = append(rows, []string{e.Description, fmt.Sprintf("$%s", formatCOP(diff))})
						total += diff
					}
				}
			} else {
				eMethod := strings.ToUpper(e.PaymentSource)
				if eMethod == "" || eMethod == "CAJA" { eMethod = "EFECTIVO" }
				if eMethod == "PREST." || eMethod == "DEUDA" { eMethod = "PRESTAMO" }
				
				if eMethod == m {
					rows = append(rows, []string{e.Description, fmt.Sprintf("$%s", formatCOP(e.Amount))})
					total += e.Amount
				}
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



