package handlers

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"bytes"
	"encoding/json"
	"fmt"
	"log"
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
	
	// Asignar la Fecha del cierre al momento exacto de su cierre (EndDate)
	if closure.ID == 0 {
		closure.Date = closure.EndDate
		
		// Obtener la fecha de inicio correcta (desde el último cierre o inicio de turno)
		// Llamamos al servicio GetCashierClosure que tiene toda esa lógica.
		activeData, err := h.service.GetCashierClosure()
		if err == nil && activeData != nil && !activeData.StartDate.IsZero() {
			closure.StartDate = activeData.StartDate
		} else {
			// Fallback si no hay data
			loc := time.FixedZone("America/Bogota", -5*60*60)
			nowLocal := time.Now().In(loc)
			closure.StartDate = time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 0, 0, 1, 0, loc)
		}
	} else {
		// En modo edición, respetamos la fecha que envíe el cliente
		// si viene vacía, retrocedemos al comportamiento por defecto (EndDate)
		if closure.Date.IsZero() {
			closure.Date = closure.EndDate
		}
	}

	// Keep closure.TotalSales calculated from real sales & credit payments in GetCashierClosure()
	if closure.TotalSales == 0 {
		closure.TotalSales = closure.TotalCash + closure.TotalTransfer
	}
	// ---------------------------------------------------------

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
		if e.Status == "PENDING" {
			e.CashAmount = 0
			e.NequiAmount = 0
			e.DaviplataAmount = 0
			e.FondoAmount = 0
			continue
		}
		
		src := strings.ToUpper(e.PaymentSource)
		total := e.Amount + e.TaxAmount

		if src == "NEQUI" {
			e.NequiAmount = total
			e.CashAmount = 0
			e.DaviplataAmount = 0
			e.FondoAmount = 0
			continue
		} else if src == "DAVIPLATA" || src == "DAVI" {
			e.DaviplataAmount = total
			e.CashAmount = 0
			e.NequiAmount = 0
			e.FondoAmount = 0
			continue
		} else if src == "FONDO" || src == "BOVEDA" || src == "BÓVEDA" || strings.Contains(src, "FOND") {
			e.FondoAmount = total
			e.CashAmount = 0
			e.NequiAmount = 0
			e.DaviplataAmount = 0
			e.PaymentSource = "FONDO"
			continue
		} else if src == "PREST." || src == "DEUDA" || src == "PRESTAMO" {
			e.CashAmount = 0
			e.NequiAmount = 0
			e.DaviplataAmount = 0
			e.FondoAmount = 0
			continue
		}

		rawCash := e.CashAmount
		rawNequi := e.NequiAmount
		rawDavi := e.DaviplataAmount
		rawFondo := e.FondoAmount
		tax := e.TaxAmount
		base := e.Amount
		
		finalCash := rawCash
		finalNequi := rawNequi
		finalDavi := rawDavi
		finalFondo := rawFondo
		
		sum := rawCash + rawNequi + rawDavi + rawFondo
		if sum == 0 {
			if src == "NEQUI" {
				finalNequi = base + tax
			} else if src == "DAVIPLATA" {
				finalDavi = base + tax
			} else if src != "PREST." && src != "DEUDA" && src != "PRESTAMO" {
				finalCash = base + tax
			}
		} else if tax > 0 && sum == base {
			isSingle := 0
			if rawCash > 0 { isSingle++ }
			if rawNequi > 0 { isSingle++ }
			if rawDavi > 0 { isSingle++ }
			if rawFondo > 0 { isSingle++ }
			
			if isSingle <= 1 {
				if rawCash > 0 { finalCash += tax }
				if rawNequi > 0 { finalNequi += tax }
				if rawDavi > 0 { finalDavi += tax }
				if rawFondo > 0 { finalFondo += tax }
			} else {
				if rawNequi > 0 {
					finalNequi += tax
				} else if rawDavi > 0 {
					finalDavi += tax
				} else if rawFondo > 0 {
					finalFondo += tax
				} else {
					finalCash += tax
				}
			}
		}
		
		e.CashAmount = finalCash
		e.NequiAmount = finalNequi
		e.DaviplataAmount = finalDavi
		e.FondoAmount = finalFondo
	}
}

func (h *DashboardHandler) formatTelegramClosureMessage(closure models.CashierClosure, isPartial bool) string {
	return FormatTelegramClosureMessage(closure, isPartial)
}

func FormatTelegramClosureMessage(closure models.CashierClosure, isPartial bool) string {
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

	if len(closure.Expenses) == 0 && closure.ExpensesDetail != "" {
		json.Unmarshal([]byte(closure.ExpensesDetail), &closure.Expenses)
	}

	normalizeExpensesForReport(closure.Expenses)

	egresosEfectivoTurno := 0.0
	for _, e := range closure.Expenses {
		if strings.ToUpper(e.Category) != "DEVOLUCIONES" && e.Status != "PENDING" {
			egresosEfectivoTurno += e.CashAmount
		}
	}

	efectivoParaVentaReal := efectivoContado
	if isPartial {
		efectivoParaVentaReal = expectedCash
	}
	ventaReal := efectivoParaVentaReal + ingresosDigitales + egresosEfectivoTurno
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
	}

	canalesOrder := []string{"EFECTIVO", "NEQUI", "DAVIPLATA", "FONDO"}
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


	if startDateStr, ok := updates["start_date"].(string); ok && startDateStr != "" {
		if parsedStart, err := time.ParseInLocation("2006-01-02T15:04", startDateStr, time.Local); err == nil {
			updates["start_date"] = parsedStart
		} else {
			delete(updates, "start_date")
		}
	}
	if endDateStr, ok := updates["end_date"].(string); ok && endDateStr != "" {
		if parsedEnd, err := time.ParseInLocation("2006-01-02T15:04", endDateStr, time.Local); err == nil {
			updates["end_date"] = parsedEnd
		} else {
			delete(updates, "end_date")
		}
	}

	if dateStr, ok := updates["date"].(string); ok && dateStr != "" {
		if parsedDate, err := time.ParseInLocation("2006-01-02", dateStr, time.Local); err == nil {
			now := time.Now()
			newDate := time.Date(parsedDate.Year(), parsedDate.Month(), parsedDate.Day(),
				now.Hour(), now.Minute(), now.Second(), 0, time.Local)
			updates["date"] = newDate
		} else if parsedDate, err := time.ParseInLocation("2006-01-02T15:04", dateStr, time.Local); err == nil {
			updates["date"] = parsedDate
		} else {
			delete(updates, "date")
		}
	}

	// ----------------------------------------------------------------------

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
	return GenerateClosurePDF(closure, isPartial)
}

func GenerateClosurePDF(closure models.CashierClosure, isPartial bool) *bytes.Buffer {
	if len(closure.Expenses) == 0 && closure.ExpensesDetail != "" {
		var snapshotExps []models.Expense
		if err := json.Unmarshal([]byte(closure.ExpensesDetail), &snapshotExps); err == nil && len(snapshotExps) > 0 {
			closure.Expenses = snapshotExps
		}
	}
	normalizeExpensesForReport(closure.Expenses)

	pdf := gofpdf.New("P", "mm", "A4", "")
	tr := pdf.UnicodeTranslatorFromDescriptor("")
	loc := time.FixedZone("America/Bogota", -5*60*60)

	subTitle := "AUDITORÍA OFICIAL DE CIERRE DE CAJA"
	if isPartial {
		subTitle = "REPORTE PARCIAL DE CAJA (CORTE)"
	}

	printData := services.ClosurePrintData{
		Title:                "SUPERMERCADO SURTIFAMILIAR",
		SubTitle:             subTitle,
		Cajero:               closure.ClosedByName,
		IDStr:                fmt.Sprintf("CC-%d", closure.ID),
		RangoFechaStr:        "TURNO:",
		TurnoStr:             fmt.Sprintf("%s a %s", closure.StartDate.In(loc).Format("02/01/06 15:04"), closure.EndDate.In(loc).Format("02/01/06 15:04")),
		PhysicalCash:         closure.PhysicalCash,
		TotalSales:           closure.TotalSales,
		TotalCreditCollected: closure.TotalCreditCollected,
		TotalNequi:           closure.TotalNequi,
		TotalDaviplata:       closure.TotalDaviplata,
		TotalCard:            closure.TotalCard,
		TotalBancolombia:     closure.TotalBancolombia,
		TotalOtherTransfer:   closure.TotalOtherTransfer,
		TotalCash:            closure.TotalCash,
		TotalExpenses:        closure.TotalExpenses,
		TotalReturns:         closure.TotalReturns,
		ExpectedCash:         closure.ExpectedCash,
		CashBills:            closure.CashBills,
		Coins1000:            closure.Coins1000,
		Coins500:             closure.Coins500,
		Coins200:             closure.Coins200,
		Coins100:             closure.Coins100,
		Expenses:             closure.Expenses,
		Payments:             closure.CreditPayments,
	}

	services.RenderClosurePDFData(pdf, tr, loc, printData)

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		log.Printf("[GenerateClosurePDF] Error generating pdf: %v", err)
		return nil
	}
	return &buf
}



