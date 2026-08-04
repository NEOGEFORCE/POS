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
			DNI            string
			Name           string
			CurrentCredit  float64
		}
		var rows []debtRow
		_ = h.db.Table("clients").
			Select(`"dni" AS dni, "name" AS name, COALESCE("currentCredit", 0) AS current_credit`).
			Where(`COALESCE("currentCredit", 0) > 0`).
			Order(`current_credit DESC`).
			Scan(&rows).Error

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
	_ = h.db.Preload("Client").Preload("Employee").Preload("SaleDetails").
		Where(`"saleDate" BETWEEN ? AND ?`, closure.StartDate, closure.EndDate).
		Where(`status IS NULL OR UPPER(status) <> 'CANCELLED'`).
		Order(`"saleDate" ASC`).
		Find(&sales).Error

	// Egresos del turno
	var expenses []models.Expense
	_ = h.db.Preload("Creator").
		Where(`date BETWEEN ? AND ?`, closure.StartDate, closure.EndDate).
		Order(`date ASC`).
		Find(&expenses).Error

	closure.Expenses = expenses

	// Abonos a fiados del turno (necesarios para el desglose por mÃ©todo de pago)
	var payments []models.CreditPayment
	_ = h.db.Where(`"createdAt" BETWEEN ? AND ?`, closure.StartDate, closure.EndDate).
		Find(&payments).Error

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
		"closure":         closure,
		"sales":           sales,
		"expenses":        expenses,
		"paymentSummary":  paymentSummary,

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

// fmtMoney formatea un float a "$1.234.567"
func fmtMoney(v float64) string {
	abs := v
	neg := ""
	if v < 0 {
		abs = -v
		neg = "-"
	}
	intPart := int64(abs)
	str := fmt.Sprintf("%d", intPart)
	// Insertar separadores de miles
	out := ""
	for i, c := range reverse(str) {
		if i > 0 && i%3 == 0 {
			out = "." + out
		}
		out = string(c) + out
	}
	return fmt.Sprintf("%s$%s", neg, out)
}

func reverse(s string) string {
	r := []rune(s)
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	return string(r)
}

func fmtPct(v float64) string {
	return fmt.Sprintf("%.2f%%", v*100)
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
	p.Rows = append(p.Rows, []string{"VENTAS TOTALES", "-", fmtMoney(r.TotalSales), "-", "-", "-", "INGRESOS"})
	p.Rows = append(p.Rows, []string{"COSTO DE MERCANCÍA (COGS)", "-", "-", fmtMoney(r.TotalCost), "-", "-", "COSTOS"})
	p.Rows = append(p.Rows, []string{"UTILIDAD BRUTA (Ventas - Costo)", "-", "-", "-", fmtMoney(r.GrossProfit), fmtPct(r.OverallMargin), "GANANCIA BRUTA"})
	p.Rows = append(p.Rows, []string{"GASTOS OPERATIVOS DEL LOCAL", "-", "-", "-", fmtMoney(r.TotalOpExpenses), "-", "GASTOS LOCAL"})
	p.Rows = append(p.Rows, []string{"GANANCIA LIBRE FINAL (Utilidad Neta)", "-", "-", "-", fmtMoney(r.NetProfit), fmtPct(r.NetMargin), "GANANCIA LIBRE"})

	// 2. Desglose de Gastos Operativos (Sin Proveedores)
	p.Rows = append(p.Rows, []string{"=== GASTOS DEL LOCAL (SIN PROVEEDORES) ===", "", "", "", "", "", ""})
	p.Rows = append(p.Rows, []string{"Servicios Públicos (Luz/Agua/Gas/Internet)", "-", "-", "-", fmtMoney(r.PublicServicesExp), "-", "SERVICIOS"})
	p.Rows = append(p.Rows, []string{"Arriendo de Local", "-", "-", "-", fmtMoney(r.RentExp), "-", "ARRIENDO"})
	p.Rows = append(p.Rows, []string{"Imprevistos, Arreglos y Daños", "-", "-", "-", fmtMoney(r.MaintenanceExp), "-", "REPARACIONES"})
	p.Rows = append(p.Rows, []string{"Sueldos y Nómina", "-", "-", "-", fmtMoney(r.PayrollExp), "-", "SUELDOS"})
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
		p.Rows = append(p.Rows, []string{
			row.ProductName,
			fmt.Sprintf("%.2f", row.UnitsSold),
			fmtMoney(row.GrossSales),
			fmtMoney(row.GrossCost),
			fmtMoney(row.GrossProfit),
			fmtPct(row.MarginPct),
			check,
		})
	}

	p.Totals = []string{
		"TOTALES VENTAS",
		"",
		fmtMoney(r.TotalSales),
		fmtMoney(r.TotalCost),
		fmtMoney(r.GrossProfit),
		fmtPct(r.OverallMargin),
		"",
	}

	p.Footer = fmt.Sprintf(
		"Efectivo Entrado: %s | Gastos Local: %s | Cartera por Cobrar: %s | GANANCIA LIBRE FINAL: %s",
		fmtMoney(r.TotalCashInflows), fmtMoney(r.TotalOpExpenses), fmtMoney(r.TotalCreditReceivable), fmtMoney(r.NetProfit),
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
		dateDisplay := row.StartDate.Format("02/01/06 15:04") + " a " + row.EndDate.Format("02/01/06 15:04")
		if row.StartDate.IsZero() || row.EndDate.IsZero() {
			dateDisplay = row.Date.Format("02/01/2006")
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
		Subtitle: "Reporte consolidado de cierres en el rango",
		From:     from, To: to,
		Headers: []string{"ID", "Fecha", "Cajero", "Ventas", "Efectivo Real", "Egresos", "Diferencia"},
	}
	var totalSales, totalReal, totalExpenses float64
	for _, c := range closures {
		dateDisplay := c.StartDate.Format("02/01/06 15:04") + " a " + c.EndDate.Format("02/01/06 15:04")
		if c.StartDate.IsZero() || c.EndDate.IsZero() {
			dateDisplay = c.Date.Format("02/01/2006")
		}
		p.Rows = append(p.Rows, []string{
			fmt.Sprintf("#%d", c.ID),
			dateDisplay,
			c.ClosedByName,
			fmtMoney(c.TotalSales),
			fmtMoney(c.PhysicalCash),
			fmtMoney(c.TotalExpenses),
			fmtMoney(c.Difference),
		})
		totalSales += c.TotalSales
		totalReal += c.PhysicalCash
		totalExpenses += c.TotalExpenses
	}
	p.Totals = []string{
		"TOTAL", "", "",
		fmtMoney(totalSales),
		fmtMoney(totalReal),
		fmtMoney(totalExpenses),
		"",
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
		Title:   "Inventario Actual",
		Subtitle: "Snapshot del stock activo",
		Headers: []string{"CÃ³digo", "Producto", "Stock", "Costo", "Venta", "Margen"},
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
		Subtitle: "Detalle de ingresos físicos y digitales, y salidas de dinero.",
		From:     from,
		To:       to,
		Headers:  []string{"FECHA", "TIPO", "CONCEPTO", "EFECTIVO", "NEQUI", "DAVI.", "OTROS", "EGRESO"},
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
				formatCOP(ev.ExpenseTotal),
			})
		}
		// Subtotal
		p.Rows = append(p.Rows, []string{
			day.Date,
			"TOTAL DIA",
			"SUBTOTAL DIARIO",
			formatCOP(day.TotalIncome),
			"-",
			"-",
			"-",
			formatCOP(day.TotalExpense),
		})
	}

	p.Totals = []string{
		"GRAN TOTAL",
		"-",
		"-",
		formatCOP(r.TotalIncome),
		"-",
		"-",
		"-",
		formatCOP(r.TotalExpense),
	}

	return p
}


