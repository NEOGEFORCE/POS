package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/core/services"
	"backPOS-go/internal/infrastructure/cache"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// =============================================================
// DashboardExportHandler â€” endpoint unificado /dashboard/reports/export
// que genera PDF/Excel/CSV de todos los tipos de reportes y los envÃ­a
// opcionalmente por Telegram. TambiÃ©n expone:
//   - /dashboard/reports/cuadre-real?from&to (cuadre general)
//   - /dashboard/reports/cuadre-real-day?date (cuadre dÃ­a especÃ­fico)
//   - /dashboard/cashier-history/:id/full-detail (detalle ampliado de cierre)
//   - /dashboard/reports/profitability?from&to&target
//   - /dashboard/reports/shrinkage?from&to
//   - /dashboard/reports/rotation?from&to
// =============================================================

type DashboardExportHandler struct {
	db              *gorm.DB
	exportService   *services.ExportService
	dashService     *services.DashboardService
	telegramService *services.TelegramService
	auditService    *services.AuditService
}

func NewDashboardExportHandler(
	db *gorm.DB,
	exp *services.ExportService,
	dash *services.DashboardService,
	tg *services.TelegramService,
	audit *services.AuditService,
) *DashboardExportHandler {
	return &DashboardExportHandler{
		db:              db,
		exportService:   exp,
		dashService:     dash,
		telegramService: tg,
		auditService:    audit,
	}
}

// =============================================================
// Endpoint principal: /dashboard/reports/export
// Query params:
//   type     = box-closure | payments | inventory | pnl | cashflow | ranking
//              | savings | vault-audit | global-credit | voids-audit
//              | profitability | shrinkage | rotation | cuadre-real | cuadre-real-day
//   from     = YYYY-MM-DD
//   to       = YYYY-MM-DD
//   format   = PDF | EXCEL | CSV (default PDF)
//   telegram = true | false
//   target   = decimal margin (only for profitability) e.g. 0.17
//   day      = YYYY-MM-DD (only for cuadre-real-day)
// =============================================================

func (h *DashboardExportHandler) ExportReport(c *gin.Context) {
	reportType := strings.ToLower(strings.TrimSpace(c.Query("type")))
	if reportType == "" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Falta query 'type'", nil)
		return
	}

	format := strings.ToUpper(strings.TrimSpace(c.DefaultQuery("format", "PDF")))
	telegramFlag := strings.EqualFold(c.Query("telegram"), "true")

	from, to, err := parseDateRange(c)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato 'from'/'to' invÃ¡lido (YYYY-MM-DD)", err)
		return
	}

	filename := fmt.Sprintf("%s_%s.%s",
		strings.ReplaceAll(reportType, "-", "_"),
		time.Now().Format("20060102_150405"),
		strings.ToLower(format),
	)

	// INTERCEPT single-closure or box-closure with ID for custom PDF template
	if (reportType == "single-closure" || reportType == "box-closure") && (c.Query("closure_id") != "" || c.Query("id") != "") && format == "PDF" {
		closureIDStr := c.Query("closure_id")
		if closureIDStr == "" {
			closureIDStr = c.Query("id")
		}
		closureID, err := strconv.ParseUint(closureIDStr, 10, 64)
		if err == nil && closureID > 0 {
			var closure models.CashierClosure
			if err := h.db.First(&closure, closureID).Error; err == nil {
				if closure.ExpensesDetail != "" {
					var snapshotExps []models.Expense
					if err := json.Unmarshal([]byte(closure.ExpensesDetail), &snapshotExps); err == nil && len(snapshotExps) > 0 {
						closure.Expenses = snapshotExps
					}
				}
				pdfBuf := GenerateClosurePDF(closure, false)

				if telegramFlag {
					tgMsg := FormatTelegramClosureMessage(closure, false)
					go h.telegramService.SendMarkdownAlert(tgMsg)
					_ = h.telegramService.SendDocument(pdfBuf, filename, fmt.Sprintf("📄 Reporte Cierre #%d (PDF)", closure.ID))
				}

				c.Header("Content-Description", "File Transfer")
				c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
				c.Header("Content-Type", "application/pdf")
				c.Header("Cache-Control", "no-store")
				c.Data(http.StatusOK, "application/pdf", pdfBuf.Bytes())
				return
			}
		}
	}

	// INTERCEPT cashflow-detailed for custom PDF template
	if reportType == "cashflow-detailed" && format == "PDF" {
		closures, expenses, payments, err := h.dashService.GetCashFlowDetailedRaw(from, to)
		if err != nil {
			SendError(c, http.StatusInternalServerError, ErrInternalServer, "Error obteniendo datos detallados", err)
			return
		}
		normalizeExpensesForReport(expenses)
		pdfBuf, err := h.exportService.GenerateConsolidatedClosurePDF(closures, expenses, payments, from, to)
		if err != nil {
			SendError(c, http.StatusInternalServerError, ErrInternalServer, "Error construyendo PDF", err)
			return
		}

		if telegramFlag {
			msgStr := h.formatAggregatedClosureReport(closures, expenses, payments, from, to)
			go h.telegramService.SendMarkdownAlert(msgStr)

			_ = h.telegramService.SendDocument(pdfBuf, filename, fmt.Sprintf("📊 Reporte Consolidado\n📅 %s - %s", from.Format("02/01/2006"), to.Format("02/01/2006")))
		}

		c.Header("Content-Description", "File Transfer")
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
		c.Header("Content-Type", "application/pdf")
		c.Header("Cache-Control", "no-store")
		c.Data(http.StatusOK, "application/pdf", pdfBuf.Bytes())
		return
	}

	// INTERCEPT profitability for custom PDF template
	if reportType == "profitability" && format == "PDF" {
		target := 0.17
		if t := c.Query("target"); t != "" {
			if v, err := strconv.ParseFloat(t, 64); err == nil {
				target = v
			}
		}
		rep, err := h.exportService.GetProfitabilityReport(from, to, target)
		if err != nil {
			SendError(c, http.StatusInternalServerError, ErrInternalServer, "Error obteniendo datos de rentabilidad", err)
			return
		}
		pdfBuf, err := h.exportService.GenerateProfitabilityPDF(rep)
		if err != nil {
			SendError(c, http.StatusInternalServerError, ErrInternalServer, "Error construyendo PDF de rentabilidad", err)
			return
		}

		if telegramFlag {
			_ = h.telegramService.SendDocument(pdfBuf, filename, fmt.Sprintf("📊 Reporte de Rentabilidad\n📅 %s - %s", from.Format("02/01/2006"), to.Format("02/01/2006")))
		}

		c.Header("Content-Description", "File Transfer")
		c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
		c.Header("Content-Type", "application/pdf")
		c.Header("Cache-Control", "no-store")
		c.Data(http.StatusOK, "application/pdf", pdfBuf.Bytes())
		return
	}

	payload, err := h.buildPayload(reportType, c, from, to)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al preparar reporte", err)
		return
	}

	// Renderizar al formato elegido
	bytes, contentType, ext, err := h.render(payload, format)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al renderizar reporte", err)
		return
	}

	filename = fmt.Sprintf("%s_%s.%s",
		strings.ReplaceAll(reportType, "-", "_"),
		time.Now().Format("20060102_150405"),
		ext,
	)

	// Telegram (asÃ­ncrono pero esperando confirmaciÃ³n rÃ¡pida si es posible)
	if telegramFlag {
		go func(b []byte, name, title string) {
			caption := fmt.Sprintf("ðŸ“‘ %s â€” %s", title, time.Now().Format("02/01/2006 15:04"))
			if err := h.telegramService.SendDocument(services.BytesReader(b), name, caption); err != nil {
				// Loggear pero no romper la descarga del usuario
				fmt.Printf("[Telegram] SendDocument failed: %v\n", err)
			}
		}(bytes, filename, payload.Title)
	}

	// AuditorÃ­a
	dni, _ := c.Get("dni")
	name, _ := c.Get("userName")
	h.auditService.Log(
		fmt.Sprintf("%v", dni), fmt.Sprintf("%v", name),
		"EXPORT_REPORT", "REPORTS",
		fmt.Sprintf("Exporta %s en %s (telegram=%v)", reportType, format, telegramFlag),
		fmt.Sprintf("Reporte generado: %s", filename),
		"", c.ClientIP(), c.Request.UserAgent(), true,
	)

	c.Header("Content-Description", "File Transfer")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	c.Header("Content-Type", contentType)
	c.Header("Cache-Control", "no-store")
	c.Data(http.StatusOK, contentType, bytes)
}

// buildPayload arma los datos del reporte segÃºn el type
func (h *DashboardExportHandler) buildPayload(reportType string, c *gin.Context, from, to time.Time) (services.ReportPayload, error) {
	switch reportType {
	case "profitability":
		target := 0.17
		if t := c.Query("target"); t != "" {
			if v, err := strconv.ParseFloat(t, 64); err == nil {
				target = v
			}
		}
		rep, err := h.exportService.GetProfitabilityReport(from, to, target)
		if err != nil {
			return services.ReportPayload{}, err
		}
		return profitabilityToPayload(rep), nil

	case "shrinkage", "mermas":
		rep, err := h.exportService.GetShrinkageReport(from, to)
		if err != nil {
			return services.ReportPayload{}, err
		}
		return shrinkageToPayload(rep), nil

	case "rotation", "rotacion":
		rep, err := h.exportService.GetRotationReport(from, to)
		if err != nil {
			return services.ReportPayload{}, err
		}
		return rotationToPayload(rep), nil

	case "cuadre-real":
		rep, err := h.exportService.GetRealCashReportByRange(from, to)
		if err != nil {
			return services.ReportPayload{}, err
		}
		return realCashToPayload(rep, "Cuadre Real (Rango)"), nil

	case "cuadre-real-day":
		dayStr := c.Query("day")
		if dayStr == "" {
			dayStr = from.Format("2006-01-02")
		}
		loc, _ := time.LoadLocation("America/Bogota")
		if loc == nil {
			loc = time.UTC
		}
		day, err := time.ParseInLocation("2006-01-02", dayStr, loc)
		if err != nil {
			return services.ReportPayload{}, fmt.Errorf("day invÃ¡lido: %w", err)
		}
		rep, err := h.exportService.GetRealCashReportByDay(day)
		if err != nil {
			return services.ReportPayload{}, err
		}
		return realCashToPayload(rep, fmt.Sprintf("Cuadre Real DÃ­a %s", day.Format("02/01/2006"))), nil

	case "box-closure":
		// Reporte de cierres de caja del rango (consolidado)
		var closures []models.CashierClosure
		if err := h.db.Where(`date BETWEEN ? AND ?`, from, to).
			Order(`date DESC, id DESC`).Find(&closures).Error; err != nil {
			return services.ReportPayload{}, err
		}
		return boxClosureToPayload(closures, from, to), nil

	case "ranking":
		data, err := h.dashService.GetRankingReport(from, to)
		if err != nil {
			return services.ReportPayload{}, err
		}
		return rankingToPayload(data, from, to), nil

	case "pnl":
		data, err := h.dashService.GetPnLReport(from, to)
		if err != nil {
			return services.ReportPayload{}, err
		}
		return pnlToPayload(data, from, to), nil

	case "cashflow":
		data, err := h.dashService.GetCashFlowReport(from, to)
		if err != nil {
			return services.ReportPayload{}, err
		}
		return cashflowToPayload(data, from, to), nil

	case "cashflow-detailed":
		data, err := h.dashService.GetCashFlowDetailedReport(from, to)
		if err != nil {
			return services.ReportPayload{}, err
		}
		return cashflowDetailedToPayload(data, from, to), nil

	case "voids", "voids-audit":
		data, err := h.dashService.GetVoidsReport(from, to)
		if err != nil {
			return services.ReportPayload{}, err
		}
		return voidsToPayload(data, from, to), nil

	case "payments":
		// Listado de ventas en el rango
		var sales []models.Sale
		if err := h.db.
			Where(`"saleDate" BETWEEN ? AND ?`, from, to).
			Where(`status IS NULL OR UPPER(status) <> 'CANCELLED'`).
			Order(`"saleDate" DESC`).
			Limit(2000).
			Find(&sales).Error; err != nil {
			return services.ReportPayload{}, err
		}
		return paymentsToPayload(sales, from, to), nil

	case "inventory":
		// Snapshot del inventario actual
		var products []models.Product
		if err := h.db.Where(`"isActive" = true`).Order(`"productName" ASC`).Find(&products).Error; err != nil {
			return services.ReportPayload{}, err
		}
		return inventoryToPayload(products), nil

	case "expenses":
		concept := c.Query("concept")
		expenses, err := h.exportService.GetExpensesReport(from, to, concept)
		if err != nil {
			return services.ReportPayload{}, err
		}
		return expensesToPayload(expenses, from, to, concept), nil

	case "global-credit":
		// Cartera Global (clientes con deuda)
		type debtRow struct {
			DNI           string
			Name          string
			CurrentCredit float64
		}
		var rows []debtRow
		if err := h.db.Table("clients").
			Select(`"dni" AS dni, "name" AS name, COALESCE("currentCredit", 0) AS current_credit`).
			Where(`COALESCE("currentCredit", 0) > 0`).
			Order(`current_credit DESC`).
			Scan(&rows).Error; err != nil {
			return services.ReportPayload{}, fmt.Errorf("consultando cartera global: %w", err)
		}

		p := services.ReportPayload{
			Title:    "Cartera Global (Fiados)",
			Subtitle: "Saldo deudor por cliente",
			From:     from, To: to,
			Headers: []string{"DNI", "Cliente", "Saldo Deudor"},
		}
		var total float64
		for _, r := range rows {
			p.Rows = append(p.Rows, []string{r.DNI, r.Name, fmtMoney(r.CurrentCredit)})
			total += r.CurrentCredit
		}
		p.Totals = []string{"TOTAL", "", fmtMoney(total)}
		return p, nil

	default:
		return services.ReportPayload{}, fmt.Errorf("tipo de reporte no soportado: %s", reportType)
	}
}

// render despacha al motor adecuado
func (h *DashboardExportHandler) render(p services.ReportPayload, format string) ([]byte, string, string, error) {
	switch format {
	case "EXCEL", "XLSX":
		b, err := h.exportService.RenderExcel(p)
		return b, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx", err
	case "CSV":
		b, err := h.exportService.RenderCSV(p)
		return b, "text/csv; charset=utf-8", "csv", err
	default:
		b, err := h.exportService.RenderPDF(p)
		return b, "application/pdf", "pdf", err
	}
}

// =============================================================
// Endpoints especÃ­ficos (devuelven JSON para uso en UI)
// =============================================================

// SendTicketToTelegram envía el comprobante de una venta al canal de
// Telegram configurado. Recibe el ticket ya formateado por el POS para
// que lo que llega al celular sea idéntico a lo que se imprime.
func (h *DashboardExportHandler) SendTicketToTelegram(c *gin.Context) {
	var body struct {
		Text string `json:"text"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.Text) == "" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Falta el texto del comprobante", err)
		return
	}
	if h.telegramService == nil {
		SendError(c, http.StatusServiceUnavailable, ErrInternalServer, "Telegram no está configurado", nil)
		return
	}

	// Se envía como bloque monoespaciado para que la alineación del ticket
	// se conserve en el chat. SendMarkdownAlert no retorna error: publica
	// de forma best-effort, así que se responde OK si el envío se despachó.
	msg := "```\n" + body.Text + "\n```"
	h.telegramService.SendMarkdownAlert(msg)
	c.JSON(http.StatusOK, gin.H{"sent": true})
}

// GetCuadreRealRange JSON
func (h *DashboardExportHandler) GetCuadreRealRange(c *gin.Context) {
	from, to, err := parseDateRange(c)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Fechas invÃ¡lidas", err)
		return
	}
	rep, err := h.exportService.GetRealCashReportByRange(from, to)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al calcular cuadre real", err)
		return
	}
	c.JSON(http.StatusOK, rep)
}

// GetCuadreRealDay JSON
func (h *DashboardExportHandler) GetCuadreRealDay(c *gin.Context) {
	dayStr := c.Query("day")
	if dayStr == "" {
		dayStr = time.Now().Format("2006-01-02")
	}
	loc, _ := time.LoadLocation("America/Bogota")
	if loc == nil {
		loc = time.UTC
	}
	day, err := time.ParseInLocation("2006-01-02", dayStr, loc)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Fecha invÃ¡lida", err)
		return
	}
	rep, err := h.exportService.GetRealCashReportByDay(day)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al calcular cuadre real del dÃ­a", err)
		return
	}
	c.JSON(http.StatusOK, rep)
}

// GetProfitability JSON
func (h *DashboardExportHandler) GetProfitability(c *gin.Context) {
	from, to, err := parseDateRange(c)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Fechas invÃ¡lidas", err)
		return
	}
	target := 0.17
	if t := c.Query("target"); t != "" {
		if v, e := strconv.ParseFloat(t, 64); e == nil {
			target = v
		}
	}
	rep, err := h.exportService.GetProfitabilityReport(from, to, target)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo en reporte de rentabilidad", err)
		return
	}
	c.JSON(http.StatusOK, rep)
}

// GetShrinkage JSON
func (h *DashboardExportHandler) GetShrinkage(c *gin.Context) {
	from, to, err := parseDateRange(c)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Fechas invÃ¡lidas", err)
		return
	}
	rep, err := h.exportService.GetShrinkageReport(from, to)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo en reporte de mermas", err)
		return
	}
	c.JSON(http.StatusOK, rep)
}

// GetRotation JSON
func (h *DashboardExportHandler) GetRotation(c *gin.Context) {
	from, to, err := parseDateRange(c)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Fechas invÃ¡lidas", err)
		return
	}
	rep, err := h.exportService.GetRotationReport(from, to)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo en reporte de rotaciÃ³n", err)
		return
	}
	c.JSON(http.StatusOK, rep)
}

// GetClosureFullDetail trae un cierre con sus ventas + egresos del rango
func (h *DashboardExportHandler) GetClosureFullDetail(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "ID invÃ¡lido", err)
		return
	}

	var closure models.CashierClosure
	if err := h.db.First(&closure, id).Error; err != nil {
		SendError(c, http.StatusNotFound, ErrBadRequest, "Cierre no encontrado", err)
		return
	}

	// Ventas del turno
	var sales []models.Sale
	if err := h.db.Preload("Client").Preload("Employee").Preload("SaleDetails").
		Where(`"saleDate" BETWEEN ? AND ?`, closure.StartDate, closure.EndDate).
		Where(`status IS NULL OR UPPER(status) <> 'CANCELLED'`).
		Order(`"saleDate" ASC`).
		Find(&sales).Error; err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudieron consultar las ventas del cierre", err)
		return
	}

	// Egresos del turno
	var expenses []models.Expense
	if err := h.db.Preload("Creator").
		Where(`date BETWEEN ? AND ?`, closure.StartDate, closure.EndDate).
		Order(`date ASC`).
		Find(&expenses).Error; err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudieron consultar los egresos del cierre", err)
		return
	}

	closure.Expenses = expenses

	// Abonos a fiados del turno (necesarios para el desglose por mÃ©todo de pago)
	var payments []models.CreditPayment
	if err := h.db.Where(`"paymentDate" BETWEEN ? AND ?`, closure.StartDate, closure.EndDate).
		Find(&payments).Error; err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudieron consultar los abonos del cierre", err)
		return
	}

	// Desglose dinÃ¡mico por mÃ©todo de pago (BANCOLOMBIA, MASTERCARD, etc.)
	closure.PaymentMethodsBreakdown = services.CalculatePaymentMethodsBreakdown(sales, payments)

	// Resumen rÃ¡pido por mÃ©todo de pago
	paymentSummary := map[string]float64{}
	for _, s := range sales {
		paymentSummary["EFECTIVO"] += s.CashAmount
		paymentSummary["NEQUI"] += s.TransferNequi
		paymentSummary["DAVIPLATA"] += s.TransferDaviplata
		paymentSummary["FIADO"] += s.CreditAmount
		// transferAmount sin destino: sumar a "OTROS"
		other := s.TransferAmount - s.TransferNequi - s.TransferDaviplata
		if other > 0 {
			paymentSummary["OTROS"] += other
		}
	}

	// Cuadre real para este cierre especÃ­fico

	c.JSON(http.StatusOK, gin.H{
		"closure":        closure,
		"sales":          sales,
		"expenses":       expenses,
		"paymentSummary": paymentSummary,

		"counts": gin.H{
			"salesCount":    len(sales),
			"expensesCount": len(expenses),
		},
	})
}

// =============================================================
// Helpers de fecha + transformaciÃ³n a payload
// =============================================================

func parseDateRange(c *gin.Context) (time.Time, time.Time, error) {
	from := strings.TrimSpace(c.Query("from"))
	to := strings.TrimSpace(c.Query("to"))
	if from == "" || to == "" {
		return time.Time{}, time.Time{}, fmt.Errorf("from/to son obligatorios")
	}
	loc, _ := time.LoadLocation("America/Bogota")
	if loc == nil {
		loc = time.UTC
	}

	// Aceptar tanto "2006-01-02" como "2006-01-02T15:04"
	parseFlexible := func(s string) (time.Time, error) {
		if t, err := time.ParseInLocation("2006-01-02T15:04", s, loc); err == nil {
			return t, nil
		}
		if t, err := time.ParseInLocation("2006-01-02", s, loc); err == nil {
			return t, nil
		}
		return time.Time{}, fmt.Errorf("formato invÃ¡lido: %s", s)
	}

	fromDate, err := parseFlexible(from)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	toDate, err := parseFlexible(to)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	// Si 'to' es solo fecha, extender al final del dÃ­a
	if !strings.Contains(to, "T") {
		toDate = toDate.Add(24*time.Hour - time.Nanosecond)
	}
	return fromDate, toDate, nil
}

// fmtMoney formatea un float a "$ 1.234.567" (moneda bogotana)
func fmtMoney(v float64) string {
	sign := ""
	if v < 0 {
		sign = "-"
		v = -v
	}
	digits := fmt.Sprintf("%.0f", v)
	out := ""
	for i, c := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			out += "."
		}
		out += string(c)
	}
	return fmt.Sprintf("%s$ %s", sign, out)
}

func reverse(s string) string {
	r := []rune(s)
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	return string(r)
}

func fmtPct(v float64) string {
	return strings.Replace(fmt.Sprintf("%.1f%%", v*100), ".", ",", 1)
}

// safeRatio evita divisiones por cero al calcular márgenes.
func safeRatio(a, b float64) float64 {
	if b == 0 {
		return 0
	}
	return a / b
}

// =============================================================
// Transformadores de cada reporte â†’ ReportPayload
// =============================================================

func profitabilityToPayload(r *services.ProfitabilityReport) services.ReportPayload {
	p := services.ReportPayload{
		Title:    "REPORTE GENERAL DE RENTABILIDAD Y FINANZAS",
		Subtitle: fmt.Sprintf("Análisis Financiero Completo (%s al %s)", r.From.Format("02/01/2006"), r.To.Format("02/01/2006")),
		From:     r.From, To: r.To,
		Headers: []string{"Concepto / Producto", "Detalle / Cant.", "Ventas / Ingreso", "Costo", "Ganancia / Saldo", "Margen", "Estado"},
	}

	// 1. Resumen Financiero Ejecutivo
	p.Rows = append(p.Rows, []string{"=== RESUMEN EJECUTIVO FINANCIERO ===", "", "", "", "", "", ""})
	p.Rows = append(p.Rows, []string{"PASO 1: TODO EL DINERO QUE ENTRÓ (AUDITADO EN CAJA)", "-", fmtMoney(r.TotalSales), "-", "-", "-", "INGRESOS"})
	p.Rows = append(p.Rows, []string{"PASO 2: COSTO DE LA MERCANCÍA", "-", "-", fmtMoney(r.TotalCost), "-", "-", "COSTOS"})
	p.Rows = append(p.Rows, []string{"PASO 3: GANANCIA BRUTA DEL NEGOCIO", "-", "-", "-", fmtMoney(r.GrossProfit), fmtPct(r.OverallMargin), "GANANCIA BRUTA"})
	p.Rows = append(p.Rows, []string{"PASO 4: GASTOS DEL LOCAL (SIN PROVEEDORES)", "-", "-", "-", fmtMoney(-r.TotalOpExpenses), "-", "GASTOS LOCAL"})
	p.Rows = append(p.Rows, []string{"PASO 5: GANANCIA LIBRE REAL DEL MES", "-", "-", "-", fmtMoney(r.NetProfit), fmtPct(r.NetMargin), "GANANCIA LIBRE"})

	// 1.1 De dónde salió la ganancia (margen real medido y extrapolado)
	p.Rows = append(p.Rows, []string{"=== DE DÓNDE SALIÓ LA GANANCIA ===", "", "", "", "", "", ""})
	p.Rows = append(p.Rows, []string{
		"Productos con código y costo real registrado", "-",
		fmtMoney(r.KnownSales), fmtMoney(r.KnownCost), fmtMoney(r.KnownProfit),
		fmtPct(safeRatio(r.KnownProfit, r.KnownSales)), "COSTO REAL",
	})
	p.Rows = append(p.Rows, []string{
		fmt.Sprintf("Resto de ingresos auditados (incluye %s de ventas rápidas)", fmtMoney(r.QuickSales)), "-",
		fmtMoney(r.UncostedSales), fmtMoney(r.UncostedCost), fmtMoney(r.UncostedProfit),
		fmtPct(safeRatio(r.UncostedProfit, r.UncostedSales)), "MARGEN REAL MEDIDO",
	})
	p.Rows = append(p.Rows, []string{
		"MARGEN REAL DEL NEGOCIO (medido con costos reales)", "-", "-", "-", "-",
		fmtPct(r.KnownMargin), "MARGEN BASE",
	})

	// 1.2 Composición de los ingresos auditados
	if a := r.Audited; a != nil && a.ClosureCount > 0 {
		p.Rows = append(p.Rows, []string{"=== COMPOSICIÓN DE LOS INGRESOS AUDITADOS ===", "", "", "", "", "", ""})
		p.Rows = append(p.Rows, []string{"Efectivo contado en los cierres", fmt.Sprintf("%d cierres", a.ClosureCount), fmtMoney(a.PhysicalCash), "-", "-", "-", "EFECTIVO"})
		p.Rows = append(p.Rows, []string{"Canales digitales (Nequi/Daviplata/Tarjeta/Bancos)", "-", fmtMoney(a.Digital), "-", "-", "-", "DIGITAL"})
		p.Rows = append(p.Rows, []string{"Egresos pagados en efectivo (se devuelven al total)", "-", fmtMoney(a.CashExpenses), "-", "-", "-", "EGRESOS CAJA"})
		p.Rows = append(p.Rows, []string{"Devoluciones", "-", fmtMoney(a.Returns), "-", "-", "-", "DEVOLUCIONES"})
		p.Rows = append(p.Rows, []string{"TOTAL AUDITADO (PASO 1)", "-", fmtMoney(a.Total), "-", "-", "-", "TOTAL CAJA"})
		p.Rows = append(p.Rows, []string{"Referencia: ventas del sistema / detalle de productos",
			fmt.Sprintf("Sistema %s | Detalle %s", fmtMoney(r.SalesFromRegister), fmtMoney(r.SalesFromDetails)),
			"-", "-", "-", "-", "REFERENCIA"})
	}

	// 2. Desglose de Gastos Operativos (Sin Proveedores)
	p.Rows = append(p.Rows, []string{"=== GASTOS DEL LOCAL (SIN PROVEEDORES) ===", "", "", "", "", "", ""})
	p.Rows = append(p.Rows, []string{"Servicios Públicos (Luz/Agua/Gas/Internet)", "-", "-", "-", fmtMoney(r.PublicServicesExp), "-", "SERVICIOS"})
	p.Rows = append(p.Rows, []string{"Arriendo de Local", "-", "-", "-", fmtMoney(r.RentExp), "-", "ARRIENDO"})
	p.Rows = append(p.Rows, []string{"Imprevistos, Arreglos y Daños", "-", "-", "-", fmtMoney(r.MaintenanceExp), "-", "REPARACIONES"})
	p.Rows = append(p.Rows, []string{"Sueldos y Nómina", "-", "-", "-", fmtMoney(r.PayrollExp), "-", "SUELDOS"})
	if r.FinancialExp > 0 {
		p.Rows = append(p.Rows, []string{"Obligaciones y Gastos Bancarios (cuotas, intereses)", "-", "-", "-", fmtMoney(r.FinancialExp), "-", "BANCARIOS"})
	}
	if r.OtherOpExp > 0 {
		p.Rows = append(p.Rows, []string{"Otros Gastos Varios", "-", "-", "-", fmtMoney(r.OtherOpExp), "-", "OTROS GASTOS"})
	}

	// 3. Entradas de Dinero y Dinero Prestado (Fiados)
	p.Rows = append(p.Rows, []string{"=== FLUJO DE CAJA Y DINERO PRESTADO ===", "", "", "", "", "", ""})
	p.Rows = append(p.Rows, []string{"Ventas en Efectivo", "-", fmtMoney(r.CashSales), "-", "-", "-", "EFECTIVO"})
	p.Rows = append(p.Rows, []string{"Abonos en Efectivo de Clientes", "-", fmtMoney(r.CreditPaymentsCash), "-", "-", "-", "ABONOS CAJA"})
	p.Rows = append(p.Rows, []string{"TOTAL EFECTIVO QUE ENTRÓ A CAJA", "-", fmtMoney(r.TotalCashInflows), "-", "-", "-", "EFECTIVO TOTAL"})
	p.Rows = append(p.Rows, []string{"Nequi / Daviplata / Transferencias", "-", fmtMoney(r.TransferSales), "-", "-", "-", "TRANSFERENCIAS"})
	p.Rows = append(p.Rows, []string{"Ventas Fiadas a Crédito (En el mes)", "-", fmtMoney(r.CreditSales), "-", "-", "-", "FIADOS MES"})
	p.Rows = append(p.Rows, []string{"TOTAL CARTERA PENDIENTE POR COBRAR", fmt.Sprintf("%d clientes", len(r.CreditReceivables)), fmtMoney(r.TotalCreditReceivable), "-", "-", "-", "POR COBRAR"})
	p.Rows = append(p.Rows, []string{"TOTAL DEUDAS DEL NEGOCIO POR PAGAR", fmt.Sprintf("%d deudas", len(r.DebtsPayable)), fmtMoney(r.TotalDebtsPayable), "-", "-", "-", "POR PAGAR"})

	// 3.1 Saldos guardados al cierre del mes (base del mes siguiente)
	if a := r.Audited; a != nil && a.Closing.HasData {
		c := a.Closing
		p.Rows = append(p.Rows, []string{"=== TOTAL GENERAL GUARDADO AL CIERRE (BASE DEL MES SIGUIENTE) ===", "", "", "", "", "", ""})
		p.Rows = append(p.Rows, []string{"Efectivo Real en Mano (Caja / Fondo)", c.ClosedAt.Format("02/01/2006 03:04 PM"), fmtMoney(c.Cash), "-", "-", "-", "EFECTIVO"})
		p.Rows = append(p.Rows, []string{"Nequi (Billetera Digital)", "-", fmtMoney(c.Nequi), "-", "-", "-", "NEQUI"})
		p.Rows = append(p.Rows, []string{"Daviplata (Billetera Digital)", "-", fmtMoney(c.Daviplata), "-", "-", "-", "DAVIPLATA"})
		p.Rows = append(p.Rows, []string{
			"(=) TOTAL GENERAL GUARDADO (CAJA + DIGITAL)",
			fmt.Sprintf("Último cierre #%d por %s", c.ClosureID, c.ClosedByName),
			fmtMoney(c.Total), "-", "-", "-", "SALDO INICIAL",
		})
	}

	// 3.2 Distribución de la ganancia: dónde quedó repartida
	if w := r.WorkingCapital; w != nil && w.HasData {
		p.Rows = append(p.Rows, []string{"=== DÓNDE ESTÁ REPARTIDA LA GANANCIA DEL MES ===", "", "", "", "", "", ""})
		p.Rows = append(p.Rows, []string{
			"Mercancía en el local (inventario al costo)",
			fmt.Sprintf("Inicio %s", fmtMoney(w.InventoryOpening)),
			fmtMoney(w.InventoryClosing), "-", fmtMoney(w.InventoryDelta), "-", "INVENTARIO",
		})
		for _, l := range w.Distribution() {
			p.Rows = append(p.Rows, []string{
				l.Concept,
				fmt.Sprintf("Inicio %s", fmtMoney(l.Opening)),
				fmtMoney(l.Closing),
				"-",
				fmtMoney(l.Delta),
				"-",
				l.Meaning,
			})
		}
		p.Rows = append(p.Rows, []string{"(=) TOTAL GANANCIA LIBRE REAL", "-", "-", "-", fmtMoney(w.NetProfit), "-", "DISTRIBUIDA"})

		// Liquidez: cuánto quedó "Libre Libre" vs atrapado en mercancía
		liq := w.Liquidity
		p.Rows = append(p.Rows, []string{"=== DINERO 'LIBRE LIBRE' VS INVERTIDO EN MERCANCIA ===", "", "", "", "", "", ""})
		p.Rows = append(p.Rows, []string{
			"Atrapado en Mercancía (Surtido)", fmtPct(liq.MerchandisePct), "-", "-",
			fmtMoney(liq.InMerchandise), "-", "EN MERCANCIA",
		})
		p.Rows = append(p.Rows, []string{
			"Dinero Líquido ('Libre Libre')", fmtPct(liq.LiquidPct), "-", "-",
			fmtMoney(liq.Liquid), "-", "LIQUIDO",
		})
		p.Rows = append(p.Rows, []string{liq.Explanation, "-", "-", "-", "-", "-", "ESCENARIO " + liq.Scenario})
	}

	// 4. Detalle de Clientes Deudores (Fiados Pendientes)
	if len(r.CreditReceivables) > 0 {
		p.Rows = append(p.Rows, []string{"=== DETALLE DE QUIÉN DEBE (FIADOS PENDIENTES) ===", "", "", "", "", "", ""})
		for _, cr := range r.CreditReceivables {
			p.Rows = append(p.Rows, []string{
				cr.ClientName,
				fmt.Sprintf("DNI: %s | Tel: %s", cr.ClientDNI, cr.Phone),
				"-", "-", fmtMoney(cr.Balance), "-", "DEBE FIADO",
			})
		}
	}

	// 5. Detalle de Deudas del Negocio
	if len(r.DebtsPayable) > 0 {
		p.Rows = append(p.Rows, []string{"=== DETALLE DE A QUIÉN SE LE DEBE (DEUDAS NEGOCIO) ===", "", "", "", "", "", ""})
		for _, db := range r.DebtsPayable {
			p.Rows = append(p.Rows, []string{
				db.Concept,
				db.ProviderName,
				"-", "-", fmtMoney(db.Balance), "-", db.Status,
			})
		}
	}

	// 6. Productos Vendidos
	p.Rows = append(p.Rows, []string{"=== VENTAS Y GANANCIA POR PRODUCTO ===", "", "", "", "", "", ""})
	for _, row := range r.Rows {
		check := "OK"
		if !row.MeetsTarget {
			check = "BAJO"
		}
		name := row.ProductName
		detail := fmt.Sprintf("%.2f", row.UnitsSold)
		if row.IsQuickSale {
			detail += " (margen estimado 20%)"
		}
		p.Rows = append(p.Rows, []string{
			name,
			detail,
			fmtMoney(row.GrossSales),
			fmtMoney(row.GrossCost),
			fmtMoney(row.GrossProfit),
			fmtPct(row.MarginPct),
			check,
		})
	}

	p.Totals = []string{
		"TOTAL AUDITADO",
		"",
		fmtMoney(r.TotalSales),
		fmtMoney(r.TotalCost),
		fmtMoney(r.GrossProfit),
		fmtPct(r.OverallMargin),
		"",
	}

	p.Footer = fmt.Sprintf(
		"Paso 1 (auditado en caja): %s | Costo: %s | Ganancia bruta: %s (margen real medido %s) | "+
			"Gastos del local: %s | GANANCIA LIBRE: %s | Por cobrar: %s | Por pagar: %s",
		fmtMoney(r.TotalSales), fmtMoney(r.TotalCost), fmtMoney(r.GrossProfit), fmtPct(r.KnownMargin),
		fmtMoney(r.TotalOpExpenses), fmtMoney(r.NetProfit),
		fmtMoney(r.TotalCreditReceivable), fmtMoney(r.TotalDebtsPayable),
	)
	return p
}

func shrinkageToPayload(r *services.ShrinkageReport) services.ReportPayload {
	p := services.ReportPayload{
		Title:    "Mermas y AverÃ­as",
		Subtitle: "Productos dados de baja, vencidos o daÃ±ados",
		From:     r.From, To: r.To,
		Headers: []string{"Fecha", "Producto", "Motivo", "Cantidad", "Costo Unit.", "PÃ©rdida"},
	}
	for _, row := range r.Rows {
		p.Rows = append(p.Rows, []string{
			row.Date.Format("02/01/2006 15:04"),
			row.ProductName,
			row.Reason,
			fmt.Sprintf("%.2f", row.Quantity),
			fmtMoney(row.CostAtTime),
			fmtMoney(row.TotalLoss),
		})
	}
	p.Totals = []string{
		"TOTAL", "", "",
		fmt.Sprintf("%.2f", r.TotalUnits),
		"",
		fmtMoney(r.TotalLoss),
	}
	footer := []string{}
	for k, v := range r.ByReason {
		footer = append(footer, fmt.Sprintf("%s: %s", k, fmtMoney(v)))
	}
	p.Footer = "Desglose por motivo: " + strings.Join(footer, " â€¢ ")
	return p
}

func rotationToPayload(r *services.RotationReport) services.ReportPayload {
	p := services.ReportPayload{
		Title:    "RotaciÃ³n de Inventario",
		Subtitle: "ClasificaciÃ³n de productos segÃºn velocidad de rotaciÃ³n",
		From:     r.From, To: r.To,
		Headers: []string{"Producto", "Stock Actual", "Vendidos", "Valor Vta", "Vta/DÃ­a", "Cobertura (dÃ­as)", "Clasif."},
	}
	for _, row := range r.Rows {
		coverage := fmt.Sprintf("%.1f", row.DaysCovered)
		if row.DaysCovered >= 9000 {
			coverage = "â€”"
		}
		p.Rows = append(p.Rows, []string{
			row.ProductName,
			fmt.Sprintf("%.2f", row.CurrentStock),
			fmt.Sprintf("%.2f", row.UnitsSold),
			fmtMoney(row.SalesValue),
			fmt.Sprintf("%.2f", row.AvgSalesPerDay),
			coverage,
			row.Classification,
		})
	}
	p.Footer = fmt.Sprintf(
		"Total productos: %d â€¢ Estancados: %d â€¢ Alta rotaciÃ³n: %d",
		r.TotalProducts, r.StagnantCount, r.HighRotationCount,
	)
	return p
}

func realCashToPayload(r *services.RealCashReport, title string) services.ReportPayload {
	p := services.ReportPayload{
		Title:    title,
		Subtitle: "Balance Real = Efectivo Real + Transferencias - Egresos",
		From:     r.From, To: r.To,
		Headers: []string{"Fecha", "ID", "Cajero", "Efectivo Real", "Nequi", "Daviplata", "Egresos", "Balance Real"},
	}
	for _, row := range r.Rows {
		locBog := time.FixedZone("America/Bogota", -5*60*60)
		dateDisplay := row.StartDate.In(locBog).Format("02/01/06 15:04") + " a " + row.EndDate.In(locBog).Format("02/01/06 15:04")
		if row.StartDate.IsZero() || row.EndDate.IsZero() {
			dateDisplay = row.Date.In(locBog).Format("02/01/2006")
		}
		p.Rows = append(p.Rows, []string{
			dateDisplay,
			fmt.Sprintf("#%d", row.ClosureID),
			row.ClosedByName,
			fmtMoney(row.PhysicalCash),
			fmtMoney(row.NequiReal),
			fmtMoney(row.DaviplataReal),
			fmtMoney(row.Expenses),
			fmtMoney(row.BalanceReal),
		})
	}
	p.Totals = []string{
		"TOTAL", "", "",
		fmtMoney(r.TotalPhysical),
		"",
		"",
		fmtMoney(r.TotalExpenses),
		fmtMoney(r.TotalBalanceReal),
	}
	return p
}

func boxClosureToPayload(closures []models.CashierClosure, from, to time.Time) services.ReportPayload {
	p := services.ReportPayload{
		Title:    "Cierres de Caja",
		Subtitle: "Mismas cifras que el historial de cierres en pantalla",
		From:     from, To: to,
		Headers: []string{"ID", "Fecha", "Cajero", "Ventas Totales", "Efectivo Real", "Egreso Caja", "Egreso Fondo", "Egreso Digital", "Egresos Total", "Diferencia"},
	}

	// Hora Colombia: el historial en pantalla muestra las fechas en hora local.
	loc := time.FixedZone("America/Bogota", -5*60*60)

	var totalSales, totalReal, totalEgCaja, totalEgFondo, totalEgDigital, totalExpenses, totalDiff float64
	for i := range closures {
		c := &closures[i]

		dateDisplay := c.StartDate.In(loc).Format("02/01/06 15:04") + " a " + c.EndDate.In(loc).Format("02/01/06 15:04")
		if c.StartDate.IsZero() || c.EndDate.IsZero() {
			dateDisplay = c.Date.In(loc).Format("02/01/2006")
		}

		// FUENTE ÚNICA: idéntico a la tarjeta del historial y al dashboard.
		// Antes esta fila usaba c.TotalSales como "Ventas" y la columna cruda
		// c.PhysicalCash como "Efectivo Real", que no es lo que ve en pantalla.
		m := services.ComputeClosureMetrics(c)

		p.Rows = append(p.Rows, []string{
			fmt.Sprintf("#%d", c.ID),
			dateDisplay,
			c.ClosedByName,
			fmtMoney(m.VentasCajero),
			fmtMoney(m.PhysicalCash),
			fmtMoney(m.EgresosCaja),
			fmtMoney(m.EgresosFondo),
			fmtMoney(m.EgresosDigital),
			fmtMoney(m.EgresosTotales),
			fmtMoney(c.Difference),
		})
		totalSales += m.VentasCajero
		totalReal += m.PhysicalCash
		totalEgCaja += m.EgresosCaja
		totalEgFondo += m.EgresosFondo
		totalEgDigital += m.EgresosDigital
		totalExpenses += m.EgresosTotales
		totalDiff += c.Difference
	}
	p.Totals = []string{
		"TOTAL", "", fmt.Sprintf("%d cierres", len(closures)),
		fmtMoney(totalSales),
		fmtMoney(totalReal),
		fmtMoney(totalEgCaja),
		fmtMoney(totalEgFondo),
		fmtMoney(totalEgDigital),
		fmtMoney(totalExpenses),
		fmtMoney(totalDiff),
	}
	return p
}

func paymentsToPayload(sales []models.Sale, from, to time.Time) services.ReportPayload {
	p := services.ReportPayload{
		Title:    "Ventas y Pagos",
		Subtitle: "Listado detallado de transacciones",
		From:     from, To: to,
		Headers: []string{"Fecha", "ID", "Cliente", "Cajero", "Total", "Efectivo", "Transferencia", "Fiado"},
	}
	var t, tc, tt, tcr float64
	for _, s := range sales {
		p.Rows = append(p.Rows, []string{
			s.SaleDate.Format("02/01/2006 15:04"),
			fmt.Sprintf("#%d", s.SaleID),
			s.Client.Name,
			s.EmployeeDNI,
			fmtMoney(s.TotalAmount),
			fmtMoney(s.CashAmount),
			fmtMoney(s.TransferAmount),
			fmtMoney(s.CreditAmount),
		})
		t += s.TotalAmount
		tc += s.CashAmount
		tt += s.TransferAmount
		tcr += s.CreditAmount
	}
	p.Totals = []string{
		"TOTAL", "", "", "",
		fmtMoney(t), fmtMoney(tc), fmtMoney(tt), fmtMoney(tcr),
	}
	return p
}

func inventoryToPayload(products []models.Product) services.ReportPayload {
	p := services.ReportPayload{
		Title:    "Inventario Actual",
		Subtitle: "Snapshot del stock activo",
		Headers:  []string{"CÃ³digo", "Producto", "Stock", "Costo", "Venta", "Margen"},
	}
	for _, pr := range products {
		margin := 0.0
		if pr.SalePrice > 0 {
			margin = (pr.SalePrice - pr.PurchasePrice) / pr.SalePrice
		}
		p.Rows = append(p.Rows, []string{
			pr.Barcode,
			pr.ProductName,
			fmt.Sprintf("%.2f", pr.Quantity),
			fmtMoney(pr.PurchasePrice),
			fmtMoney(pr.SalePrice),
			fmtPct(margin),
		})
	}
	return p
}

func rankingToPayload(items []ports.ProductRankingItem, from, to time.Time) services.ReportPayload {
	p := services.ReportPayload{
		Title:    "Ranking de Productos",
		Subtitle: "Productos mÃ¡s vendidos en el rango",
		From:     from, To: to,
		Headers: []string{"PosiciÃ³n", "CÃ³digo", "Producto", "Cantidad", "Total"},
	}
	var total float64
	for i, r := range items {
		p.Rows = append(p.Rows, []string{
			fmt.Sprintf("#%d", i+1),
			r.Barcode,
			r.Name,
			fmt.Sprintf("%.2f", r.Quantity),
			fmtMoney(r.Total),
		})
		total += r.Total
	}
	p.Totals = []string{"TOTAL", "", "", "", fmtMoney(total)}
	return p
}

func pnlToPayload(r *services.PnLReport, from, to time.Time) services.ReportPayload {
	p := services.ReportPayload{
		Title:    "Estado de Resultados (P&L)",
		Subtitle: "Resumen de ingresos, costos y gastos",
		From:     from, To: to,
		Headers: []string{"Concepto", "Monto"},
	}
	if r != nil {
		p.Rows = [][]string{
			{"Ingresos Totales", fmtMoney(r.TotalRevenue)},
			{"Costo de Ventas (COGS)", fmtMoney(r.TotalCOGS)},
			{"Utilidad Bruta", fmtMoney(r.GrossProfit)},
			{"Egresos Operativos", fmtMoney(r.TotalExpenses)},
			{"Utilidad Neta", fmtMoney(r.NetProfit)},
			{"Margen", fmtPct(r.MarginPercentage / 100)},
		}
	}
	return p
}

func expensesToPayload(expenses []models.Expense, from, to time.Time, concept string) services.ReportPayload {
	subtitle := "Reporte detallado de egresos operativos"
	if concept != "" {
		subtitle = fmt.Sprintf("Reporte de egresos filtrados por concepto: '%s'", concept)
	}

	p := services.ReportPayload{
		Title:    "Reporte de Egresos",
		Subtitle: subtitle,
		From:     from, To: to,
		Headers: []string{"Fecha", "Concepto", "CategorÃ­a", "MÃ©todo", "Monto"},
	}
	var total float64
	for _, e := range expenses {
		paymentSource := e.PaymentSource
		if paymentSource == "" {
			paymentSource = "FONDO"
		}
		p.Rows = append(p.Rows, []string{
			e.Date.Format("02/01/2006 15:04"),
			e.Description,
			e.Category,
			paymentSource,
			fmtMoney(e.Amount),
		})
		total += e.Amount
	}
	p.Totals = []string{"TOTAL", "", "", "", fmtMoney(total)}
	return p
}

func cashflowToPayload(r *services.CashFlowReport, from, to time.Time) services.ReportPayload {
	p := services.ReportPayload{
		Title:    "Flujo de Caja",
		Subtitle: "Ingresos vs Egresos por dÃ­a",
		From:     from, To: to,
		Headers: []string{"Fecha", "Ingresos", "Egresos", "Balance"},
	}
	if r != nil {
		// Ordenar daily details por fecha ascendente para el PDF
		details := make([]services.CashFlowDailyDetail, len(r.DailyDetails))
		copy(details, r.DailyDetails)
		// Sort por fecha
		for i := 0; i < len(details); i++ {
			for j := i + 1; j < len(details); j++ {
				if details[i].Date > details[j].Date {
					details[i], details[j] = details[j], details[i]
				}
			}
		}

		for _, d := range details {
			p.Rows = append(p.Rows, []string{
				d.Date,
				fmtMoney(d.Income),
				fmtMoney(d.Expense),
				fmtMoney(d.Balance),
			})
		}
		p.Totals = []string{
			"TOTAL",
			fmtMoney(r.TotalIncome),
			fmtMoney(r.TotalExpense),
			fmtMoney(r.TotalBalance),
		}
	}
	if len(p.Rows) == 0 {
		p.Footer = "Sin movimientos en el rango seleccionado"
	}
	return p
}

func voidsToPayload(items []services.VoidReportItem, from, to time.Time) services.ReportPayload {
	p := services.ReportPayload{
		Title:    "AuditorÃ­a de Anulaciones",
		Subtitle: "Ventas anuladas en el rango",
		From:     from, To: to,
		Headers: []string{"Fecha", "ID", "Empleado", "Total", "Anulado en"},
	}
	var total float64
	for _, v := range items {
		p.Rows = append(p.Rows, []string{
			v.Date.Format("02/01/2006 15:04"),
			fmt.Sprintf("#%d", v.SaleID),
			v.Employee,
			fmtMoney(v.Total),
			v.VoidedAt.Format("02/01/2006 15:04"),
		})
		total += v.Total
	}
	p.Totals = []string{"TOTAL", "", "", fmtMoney(total), ""}
	return p
}

// Avoid unused import
var _ = cache.CacheKeyDashboardOverview

func cashflowDetailedToPayload(r *services.CashFlowDetailedReport, from, to time.Time) services.ReportPayload {
	p := services.ReportPayload{
		Title:    "FLUJO DE CAJA - DESGLOSADO (DIARIO Y EVENTOS)",
		Subtitle: "VENTA TOTAL = Efectivo Contado + Nequi + Daviplata + Otros + Egresos Caja + Devoluciones",
		From:     from,
		To:       to,
		Headers: []string{
			"FECHA", "TIPO", "CONCEPTO",
			"EFECTIVO CONTADO", "NEQUI", "DAVIPLATA", "TARJETA/OTROS", "DEVOLUCIONES",
			"VENTA TOTAL",
			"EGRESO CAJA", "EGRESO FONDO", "EGRESO DIGITAL", "EGRESO TOTAL",
			"EFECTIVO ESPERADO", "DIFERENCIA",
		},
	}

	for _, day := range r.Days {
		for _, ev := range day.Events {
			p.Rows = append(p.Rows, []string{
				day.Date,
				ev.Type,
				ev.Concept,
				formatCOP(ev.IncomeCash),
				formatCOP(ev.IncomeNequi),
				formatCOP(ev.IncomeDavi),
				formatCOP(ev.IncomeOther),
				formatCOP(ev.Returns),
				formatCOP(ev.IncomeTotal),
				formatCOP(ev.ExpenseCash),
				formatCOP(ev.ExpenseFondo),
				formatCOP(ev.ExpenseDigital),
				formatCOP(ev.ExpenseTotal),
				formatCOP(ev.ExpectedCash),
				formatCOP(ev.Difference),
			})
		}
		// Subtotal del día: cada columna suma su propia columna, para que el
		// reporte se pueda verificar a mano sin adivinar qué hay en cada celda.
		p.Rows = append(p.Rows, []string{
			day.Date,
			"TOTAL DIA",
			fmt.Sprintf("SUBTOTAL (%d turnos)", day.ClosureCount),
			formatCOP(day.IncomeCash),
			formatCOP(day.IncomeNequi),
			formatCOP(day.IncomeDavi),
			formatCOP(day.IncomeOther),
			formatCOP(day.Returns),
			formatCOP(day.TotalIncome),
			formatCOP(day.ExpenseCash),
			formatCOP(day.ExpenseFondo),
			formatCOP(day.ExpenseDigital),
			formatCOP(day.TotalExpense),
			formatCOP(day.ExpectedCash),
			formatCOP(day.Difference),
		})
	}

	// Gran total: se acumula por columna en vez de dejar guiones, que era lo
	// que impedía cuadrar el mes contra los cierres.
	var gCash, gNequi, gDavi, gOther, gRet, gEgCaja, gEgFondo, gEgDigital, gExp, gDiff float64
	for _, day := range r.Days {
		gCash += day.IncomeCash
		gNequi += day.IncomeNequi
		gDavi += day.IncomeDavi
		gOther += day.IncomeOther
		gRet += day.Returns
		gEgCaja += day.ExpenseCash
		gEgFondo += day.ExpenseFondo
		gEgDigital += day.ExpenseDigital
		gExp += day.ExpectedCash
		gDiff += day.Difference
	}

	p.Totals = []string{
		"GRAN TOTAL",
		"-",
		fmt.Sprintf("%d dias", len(r.Days)),
		formatCOP(gCash),
		formatCOP(gNequi),
		formatCOP(gDavi),
		formatCOP(gOther),
		formatCOP(gRet),
		formatCOP(r.TotalIncome),
		formatCOP(gEgCaja),
		formatCOP(gEgFondo),
		formatCOP(gEgDigital),
		formatCOP(r.TotalExpense),
		formatCOP(gExp),
		formatCOP(gDiff),
	}

	return p
}
