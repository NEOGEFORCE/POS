package services

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"

	"github.com/jung-kurt/gofpdf"
	"github.com/xuri/excelize/v2"
	"gorm.io/gorm"
)

// =============================================================
// ExportService — generación de reportes PDF/Excel + datos para
// los 3 reportes nuevos (rentabilidad, mermas, rotación) y los
// cuadres reales (general + por día).
//
// Diseñado para NO tocar la lógica viva del cierre de caja.
// =============================================================

type ExportService struct {
	db          *gorm.DB
	dashService *DashboardService
}

func NewExportService(db *gorm.DB, dashService *DashboardService) *ExportService {
	return &ExportService{db: db, dashService: dashService}
}

// ReportPayload representa los datos genéricos de un reporte para
// renderizar en PDF/Excel/CSV.
type ReportPayload struct {
	Title    string
	Subtitle string
	From     time.Time
	To       time.Time
	Headers  []string
	// Rows[i] es una fila con n columnas alineadas a Headers
	Rows [][]string
	// Totals opcional al final
	Totals []string
	// Notas/footer
	Footer string
}

// =============================================================
// Reporte: Rentabilidad y Margen Bruto
// =============================================================

type ProfitabilityRow struct {
	ProductName  string
	UnitsSold    float64
	GrossSales   float64
	GrossCost    float64
	GrossProfit  float64
	MarginPct    float64
	MeetsTarget  bool // margen >= TargetMargin
}

type ProfitabilityReport struct {
	From         time.Time
	To           time.Time
	TargetMargin float64 // ej. 0.17 = 17%
	Rows         []ProfitabilityRow

	TotalSales     float64
	TotalCost      float64
	GrossProfit    float64
	OpExpenses     float64
	NetProfit      float64
	OverallMargin  float64 // bruto sobre ventas
	NetMargin      float64 // neto sobre ventas
}

// GetProfitabilityReport retorna análisis de rentabilidad en el rango.
// targetMargin se entrega en fracción (0.17 = 17%).
func (s *ExportService) GetProfitabilityReport(from, to time.Time, targetMargin float64) (*ProfitabilityReport, error) {
	report := &ProfitabilityReport{
		From: from, To: to, TargetMargin: targetMargin,
	}

	// 1. Ventas detalladas (con costo) por producto
	type aggRow struct {
		Barcode    string
		Name       string
		UnitsSold  float64
		GrossSales float64
		GrossCost  float64
	}
	var rows []aggRow

	err := s.db.Table("sale_details AS sd").
		Select(`sd.barcode AS barcode,
				p."productName" AS name,
				COALESCE(SUM(sd.quantity), 0) AS units_sold,
				COALESCE(SUM(sd.subtotal), 0) AS gross_sales,
				COALESCE(SUM(sd.quantity * sd."costPrice"), 0) AS gross_cost`).
		Joins(`JOIN sales s ON s."saleId" = sd."saleId"`).
		Joins(`LEFT JOIN products p ON p.barcode = sd.barcode`).
		Where(`s."saleDate" BETWEEN ? AND ?`, from, to).
		Where(`(s.status IS NULL OR UPPER(s.status) <> 'CANCELLED')`).
		Group(`sd.barcode, p."productName"`).
		Order(`gross_sales DESC`).
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("profitability query: %w", err)
	}

	for _, r := range rows {
		gp := r.GrossSales - r.GrossCost
		var margin float64
		if r.GrossSales > 0 {
			margin = gp / r.GrossSales
		}
		report.Rows = append(report.Rows, ProfitabilityRow{
			ProductName: r.Name,
			UnitsSold:   r.UnitsSold,
			GrossSales:  r.GrossSales,
			GrossCost:   r.GrossCost,
			GrossProfit: gp,
			MarginPct:   margin,
			MeetsTarget: margin >= targetMargin,
		})
		report.TotalSales += r.GrossSales
		report.TotalCost += r.GrossCost
	}
	report.GrossProfit = report.TotalSales - report.TotalCost

	// 2. Egresos operativos (PAID) en el rango
	var opExp float64
	s.db.Model(&models.Expense{}).
		Where(`UPPER(status) = 'PAID'`).
		Where(`UPPER("paymentSource") NOT IN ('PRESTAMO', 'PREST.')`).
		Where(`date BETWEEN ? AND ?`, from, to).
		Select(`COALESCE(SUM(amount + tax_amount), 0)`).
		Scan(&opExp)
	report.OpExpenses = opExp
	report.NetProfit = report.GrossProfit - report.OpExpenses

	if report.TotalSales > 0 {
		report.OverallMargin = report.GrossProfit / report.TotalSales
		report.NetMargin = report.NetProfit / report.TotalSales
	}
	return report, nil
}

// =============================================================
// Reporte: Mermas y Averías
// =============================================================

type ShrinkageRow struct {
	Date        time.Time
	ProductName string
	Reason      string
	Quantity    float64
	CostAtTime  float64
	TotalLoss   float64 // quantity * cost
	UserDNI     string
	Notes       string
}

type ShrinkageReport struct {
	From          time.Time
	To            time.Time
	Rows          []ShrinkageRow
	TotalUnits    float64
	TotalLoss     float64
	ByReason      map[string]float64 // reason -> totalLoss
}

func (s *ExportService) GetShrinkageReport(from, to time.Time) (*ShrinkageReport, error) {
	rep := &ShrinkageReport{From: from, To: to, ByReason: map[string]float64{}}

	type sRow struct {
		Date        time.Time
		ProductName string
		Reason      string
		Quantity    float64
		CostAtTime  float64
		UserID      string
		Notes       string
	}
	var rows []sRow

	err := s.db.Table("shrinkages AS sh").
		Select(`sh.date,
				COALESCE(p."productName", '(producto eliminado)') AS product_name,
				sh.reason,
				sh.quantity,
				sh.cost_at_time,
				sh.user_id,
				sh.notes`).
		Joins(`LEFT JOIN products p ON p.barcode = sh.product_id`).
		Where(`sh.date BETWEEN ? AND ?`, from, to).
		Where(`sh.deleted_at IS NULL`).
		Order(`sh.date DESC`).
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("shrinkage query: %w", err)
	}

	for _, r := range rows {
		loss := r.Quantity * r.CostAtTime
		rep.Rows = append(rep.Rows, ShrinkageRow{
			Date:        r.Date,
			ProductName: r.ProductName,
			Reason:      r.Reason,
			Quantity:    r.Quantity,
			CostAtTime:  r.CostAtTime,
			TotalLoss:   loss,
			UserDNI:     r.UserID,
			Notes:       r.Notes,
		})
		rep.TotalUnits += r.Quantity
		rep.TotalLoss += loss
		rep.ByReason[r.Reason] += loss
	}
	return rep, nil
}

// =============================================================
// Reporte: Rotación de Inventario
// =============================================================

type RotationRow struct {
	Barcode       string
	ProductName   string
	CurrentStock  float64
	UnitsSold     float64 // en el rango
	SalesValue    float64
	DaysCovered   float64 // ventas/día * stock = días de cobertura
	AvgSalesPerDay float64
	Classification string // HIGH | MEDIUM | LOW | STAGNANT (sin ventas en N días)
	LastSaleDate  *time.Time
}

type RotationReport struct {
	From            time.Time
	To              time.Time
	Rows            []RotationRow
	StagnantCount   int
	HighRotationCount int
	TotalProducts   int
}

// GetRotationReport calcula la rotación en el rango especificado.
// Clasifica:
//   - STAGNANT: sin ventas en el rango
//   - LOW: <= 1 venta/día promedio o cobertura > 60 días
//   - MEDIUM: cobertura 15-60 días
//   - HIGH: cobertura < 15 días
func (s *ExportService) GetRotationReport(from, to time.Time) (*RotationReport, error) {
	rep := &RotationReport{From: from, To: to}

	days := to.Sub(from).Hours() / 24
	if days < 1 {
		days = 1
	}

	type rRow struct {
		Barcode      string
		ProductName  string
		CurrentStock float64
		UnitsSold    float64
		SalesValue   float64
		LastSaleDate *time.Time
	}
	var rows []rRow

	// LEFT JOIN para incluir productos sin ventas (stagnant)
	err := s.db.Table("products AS p").
		Select(`p.barcode,
				p."productName" AS product_name,
				p.quantity AS current_stock,
				COALESCE(sales_agg.units, 0) AS units_sold,
				COALESCE(sales_agg.value, 0) AS sales_value,
				sales_agg.last_sale AS last_sale_date`).
		Joins(`LEFT JOIN (
			SELECT sd.barcode,
				   SUM(sd.quantity) AS units,
				   SUM(sd.subtotal) AS value,
				   MAX(s."saleDate") AS last_sale
			  FROM sale_details sd
			  JOIN sales s ON s."saleId" = sd."saleId"
			 WHERE s."saleDate" BETWEEN ? AND ?
			   AND (s.status IS NULL OR UPPER(s.status) <> 'CANCELLED')
			 GROUP BY sd.barcode
		) AS sales_agg ON sales_agg.barcode = p.barcode`, from, to).
		Where(`p."isActive" = true`).
		Where(`p.deleted_at IS NULL`).
		Order(`COALESCE(sales_agg.units, 0) DESC, p."productName" ASC`).
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("rotation query: %w", err)
	}

	for _, r := range rows {
		avg := r.UnitsSold / days
		var coverage float64
		if avg > 0 {
			coverage = r.CurrentStock / avg
		} else {
			coverage = 9999 // sin ventas → infinito
		}

		var class string
		switch {
		case r.UnitsSold == 0:
			class = "STAGNANT"
			rep.StagnantCount++
		case coverage < 15:
			class = "HIGH"
			rep.HighRotationCount++
		case coverage <= 60:
			class = "MEDIUM"
		default:
			class = "LOW"
		}

		rep.Rows = append(rep.Rows, RotationRow{
			Barcode:        r.Barcode,
			ProductName:    r.ProductName,
			CurrentStock:   r.CurrentStock,
			UnitsSold:      r.UnitsSold,
			SalesValue:     r.SalesValue,
			DaysCovered:    coverage,
			AvgSalesPerDay: avg,
			Classification: class,
			LastSaleDate:   r.LastSaleDate,
		})
	}
	rep.TotalProducts = len(rep.Rows)
	return rep, nil
}

// =============================================================
// Reporte: Cuadre Real (General y por Día)
// Fórmula: Balance Real = Efectivo Real + Transferencias - Egresos
// =============================================================

type RealCashCutRow struct {
	Date           time.Time
	StartDate      time.Time
	EndDate        time.Time
	ClosureID      uint
	ClosedByName   string
	PhysicalCash   float64 // Efectivo real
	NequiReal      float64
	DaviplataReal  float64
	TotalTransfer  float64 // suma digital
	Expenses       float64
	BalanceReal    float64 // = PhysicalCash + TotalTransfer - Expenses
	Difference     float64 // diferencia teórica registrada
}

type RealCashReport struct {
	From            time.Time
	To              time.Time
	Rows            []RealCashCutRow
	TotalPhysical   float64
	TotalTransfer   float64
	TotalExpenses   float64
	TotalBalanceReal float64
}

// GetRealCashReportByRange consolida los cierres en el rango aplicando
// la fórmula Balance Real = Efectivo Real + Transferencias - Egresos.
func (s *ExportService) GetRealCashReportByRange(from, to time.Time) (*RealCashReport, error) {
	rep := &RealCashReport{From: from, To: to}

	var closures []models.CashierClosure
	if err := s.db.
		Where(`date BETWEEN ? AND ?`, from, to).
		Order(`date ASC, id ASC`).
		Find(&closures).Error; err != nil {
		return nil, fmt.Errorf("closures query: %w", err)
	}

	for _, c := range closures {
		transfer := c.TotalNequiReal + c.TotalDaviplataReal
		balance := c.PhysicalCash + transfer - c.TotalExpenses

		rep.Rows = append(rep.Rows, RealCashCutRow{
			Date:           c.Date,
			StartDate:      c.StartDate,
			EndDate:        c.EndDate,
			ClosureID:      c.ID,
			ClosedByName:   c.ClosedByName,
			PhysicalCash:   c.PhysicalCash,
			NequiReal:      c.TotalNequiReal,
			DaviplataReal:  c.TotalDaviplataReal,
			TotalTransfer:  transfer,
			Expenses:       c.TotalExpenses,
			BalanceReal:    balance,
			Difference:     c.Difference,
		})
		rep.TotalPhysical += c.PhysicalCash
		rep.TotalTransfer += transfer
		rep.TotalExpenses += c.TotalExpenses
		rep.TotalBalanceReal += balance
	}
	return rep, nil
}

// GetRealCashReportByDay devuelve el cuadre real consolidado de UN solo día,
// agrupando todos los cierres de ese día y los egresos pagados en él.
func (s *ExportService) GetRealCashReportByDay(day time.Time) (*RealCashReport, error) {
	loc := day.Location()
	start := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, loc)
	end := start.Add(24*time.Hour - time.Nanosecond)
	return s.GetRealCashReportByRange(start, end)
}

// =============================================================
// Renderizadores PDF / Excel / CSV
// =============================================================

// RenderPDF dibuja un PDF tabular profesional con título, subtítulo,
// tabla, totales y footer. Retorna los bytes listos para enviar.
func (s *ExportService) RenderPDF(p ReportPayload) ([]byte, error) {
	pdf := gofpdf.New("L", "mm", "A4", "")
	pdf.SetMargins(12, 14, 12)
	pdf.SetAutoPageBreak(true, 16)

	// Translator UTF-8 a cp1252 (latin-1).
	tr := pdf.UnicodeTranslatorFromDescriptor("cp1252")
	prep := func(s string) string { return tr(sanitizePDF(s)) }

	// Configurar footer automtico para evitar pginas en blanco extra
	pdf.SetFooterFunc(func() {
		pdf.SetY(-12)
		pdf.SetFont("Arial", "I", 7)
		pdf.SetTextColor(150, 150, 150)
		pdf.CellFormat(0, 5,
			prep(fmt.Sprintf("POS PRO - Generado: %s - Página %d",
				time.Now().Format("02/01/2006 15:04"), pdf.PageNo())),
			"", 0, "C", false, 0, "")
	})

	pdf.AddPage()

	// Header
	pdf.SetFillColor(16, 185, 129) // emerald
	pdf.Rect(0, 0, 297, 8, "F")

	pdf.SetY(12)
	pdf.SetFont("Arial", "B", 18)
	pdf.SetTextColor(20, 30, 25)
	pdf.Cell(0, 8, prep(p.Title))
	pdf.Ln(8)

	pdf.SetFont("Arial", "", 10)
	pdf.SetTextColor(100, 100, 100)
	pdf.Cell(0, 5, prep(p.Subtitle))
	pdf.Ln(6)

	if !p.From.IsZero() && !p.To.IsZero() {
		pdf.SetFont("Arial", "I", 9)
		pdf.Cell(0, 5, prep(fmt.Sprintf("Rango: %s — %s",
			p.From.Format("02/01/2006"), p.To.Format("02/01/2006"))))
		pdf.Ln(8)
	}

	// Tabla
	if len(p.Headers) > 0 {
		colCount := len(p.Headers)
		availableWidth := 273.0 // A4 horizontal con márgenes
		colWidth := availableWidth / float64(colCount)

		// Header de tabla
		pdf.SetFillColor(28, 46, 41)
		pdf.SetTextColor(255, 255, 255)
		pdf.SetFont("Arial", "B", 9)
		for _, h := range p.Headers {
			pdf.CellFormat(colWidth, 8, prep(h), "1", 0, "C", true, 0, "")
		}
		pdf.Ln(-1)

		// Filas
		pdf.SetFont("Arial", "", 8)
		pdf.SetTextColor(40, 40, 40)
		fill := false
		for _, row := range p.Rows {
			if fill {
				pdf.SetFillColor(245, 250, 248)
			} else {
				pdf.SetFillColor(255, 255, 255)
			}
			
			// Calcular altura maxima de la fila
			maxLines := 1
			for i, cell := range row {
				if i >= colCount {
					break
				}
				lines := pdf.SplitLines([]byte(prep(cell)), colWidth-2)
				if len(lines) > maxLines {
					maxLines = len(lines)
				}
			}
			
			lineHeight := 4.5
			rowHeight := float64(maxLines) * lineHeight
			if rowHeight < 7.0 {
				rowHeight = 7.0
			}

			// Salto de pagina
			if pdf.GetY()+rowHeight > 190.0 {
				pdf.AddPage()
				// Redibujar cabeceras
				pdf.SetFillColor(28, 46, 41)
				pdf.SetTextColor(255, 255, 255)
				pdf.SetFont("Arial", "B", 9)
				for _, h := range p.Headers {
					pdf.CellFormat(colWidth, 8, prep(h), "1", 0, "C", true, 0, "")
				}
				pdf.Ln(-1)
				
				// Restaurar fuente de fila
				pdf.SetFont("Arial", "", 8)
				pdf.SetTextColor(40, 40, 40)
				if fill {
					pdf.SetFillColor(245, 250, 248)
				} else {
					pdf.SetFillColor(255, 255, 255)
				}
			}

			x := pdf.GetX()
			y := pdf.GetY()

			for i, cell := range row {
				if i >= colCount {
					break
				}
				
				// Fondo
				pdf.Rect(x, y, colWidth, rowHeight, "F")
				
				// Bordes "LR"
				pdf.Line(x, y, x, y+rowHeight)
				pdf.Line(x+colWidth, y, x+colWidth, y+rowHeight)
				
				// Centrado vertical
				lines := pdf.SplitLines([]byte(prep(cell)), colWidth-2)
				textY := y + (rowHeight - (float64(len(lines)) * lineHeight)) / 2.0
				
				pdf.SetXY(x+1, textY)
				pdf.MultiCell(colWidth-2, lineHeight, prep(cell), "", "L", false)
				
				x += colWidth
			}
			pdf.SetXY(12, y+rowHeight)
			fill = !fill
		}
		// Bottom border
		pdf.CellFormat(availableWidth, 0, "", "T", 0, "", false, 0, "")
		pdf.Ln(-1)

		// Totales
		if len(p.Totals) > 0 {
			pdf.SetFont("Arial", "B", 9)
			pdf.SetFillColor(16, 185, 129)
			pdf.SetTextColor(255, 255, 255)
			for i, t := range p.Totals {
				if i >= colCount {
					break
				}
				pdf.CellFormat(colWidth, 8, prep(t), "1", 0, "L", true, 0, "")
			}
			pdf.Ln(-1)
		}
	}

	if p.Footer != "" {
		pdf.Ln(4)
		pdf.SetFont("Arial", "I", 8)
		pdf.SetTextColor(120, 120, 120)
		pdf.MultiCell(0, 4, prep(p.Footer), "", "L", false)
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("pdf output: %w", err)
	}
	return buf.Bytes(), nil
}

// RenderExcel genera un .xlsx con header + filas + fila de totales.
func (s *ExportService) RenderExcel(p ReportPayload) ([]byte, error) {
	f := excelize.NewFile()
	defer f.Close()

	sheet := "Reporte"
	idx, _ := f.NewSheet(sheet)
	f.SetActiveSheet(idx)
	_ = f.DeleteSheet("Sheet1")

	// colName convierte un índice (0-based) a letra de columna Excel.
	// 0=A, 25=Z, 26=AA, 27=AB, 51=AZ, 52=BA, etc.
	colName := func(i int) string {
		name := ""
		i = i + 1 // pasar a 1-indexed para el algoritmo Excel
		for i > 0 {
			i--
			name = string(rune('A'+(i%26))) + name
			i /= 26
		}
		return name
	}

	lastCol := colName(len(p.Headers) - 1)

	// Título
	f.SetCellValue(sheet, "A1", p.Title)
	f.MergeCell(sheet, "A1", lastCol+"1")

	titleStyle, _ := f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Size: 16, Color: "0F1F1A"},
		Alignment: &excelize.Alignment{Horizontal: "left", Vertical: "center"},
	})
	f.SetCellStyle(sheet, "A1", "A1", titleStyle)
	f.SetRowHeight(sheet, 1, 28)

	// Subtítulo
	if p.Subtitle != "" {
		f.SetCellValue(sheet, "A2", p.Subtitle)
		f.MergeCell(sheet, "A2", lastCol+"2")
		subtitleStyle, _ := f.NewStyle(&excelize.Style{
			Font:      &excelize.Font{Italic: true, Size: 10, Color: "646464"},
			Alignment: &excelize.Alignment{Horizontal: "left"},
		})
		f.SetCellStyle(sheet, "A2", "A2", subtitleStyle)
	}

	headerRow := 4
	if !p.From.IsZero() && !p.To.IsZero() {
		f.SetCellValue(sheet, "A3", fmt.Sprintf("Rango: %s a %s",
			p.From.Format("02/01/2006"), p.To.Format("02/01/2006")))
		f.MergeCell(sheet, "A3", lastCol+"3")
		headerRow = 4
	}

	// Headers
	headerStyle, _ := f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Color: "FFFFFF", Size: 11},
		Fill:      excelize.Fill{Type: "pattern", Color: []string{"10B981"}, Pattern: 1},
		Alignment: &excelize.Alignment{Horizontal: "center", Vertical: "center"},
		Border: []excelize.Border{
			{Type: "left", Color: "0A0F0D", Style: 1},
			{Type: "right", Color: "0A0F0D", Style: 1},
			{Type: "top", Color: "0A0F0D", Style: 1},
			{Type: "bottom", Color: "0A0F0D", Style: 1},
		},
	})

	for i, h := range p.Headers {
		col := colName(i)
		cell := fmt.Sprintf("%s%d", col, headerRow)
		f.SetCellValue(sheet, cell, h)
		f.SetCellStyle(sheet, cell, cell, headerStyle)
	}
	f.SetRowHeight(sheet, headerRow, 22)

	// Filas
	rowStyle, _ := f.NewStyle(&excelize.Style{
		Border: []excelize.Border{
			{Type: "left", Color: "DCDCDC", Style: 1},
			{Type: "right", Color: "DCDCDC", Style: 1},
			{Type: "bottom", Color: "DCDCDC", Style: 1},
		},
	})
	for ri, row := range p.Rows {
		for ci, cell := range row {
			col := colName(ci)
			pos := fmt.Sprintf("%s%d", col, headerRow+1+ri)
			f.SetCellValue(sheet, pos, cell)
			f.SetCellStyle(sheet, pos, pos, rowStyle)
		}
	}

	// Totales
	if len(p.Totals) > 0 {
		totalRow := headerRow + 1 + len(p.Rows)
		totalStyle, _ := f.NewStyle(&excelize.Style{
			Font: &excelize.Font{Bold: true, Color: "FFFFFF"},
			Fill: excelize.Fill{Type: "pattern", Color: []string{"059669"}, Pattern: 1},
		})
		for i, t := range p.Totals {
			col := colName(i)
			pos := fmt.Sprintf("%s%d", col, totalRow)
			f.SetCellValue(sheet, pos, t)
			f.SetCellStyle(sheet, pos, pos, totalStyle)
		}
	}

	// Auto width aproximado
	for i := range p.Headers {
		col := colName(i)
		f.SetColWidth(sheet, col, col, 22)
	}

	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		return nil, fmt.Errorf("xlsx write: %w", err)
	}
	return buf.Bytes(), nil
}

// RenderCSV genera CSV sencillo para descargas livianas.
func (s *ExportService) RenderCSV(p ReportPayload) ([]byte, error) {
	var b strings.Builder
	b.WriteString(p.Title + "\n")
	if p.Subtitle != "" {
		b.WriteString(p.Subtitle + "\n")
	}
	if !p.From.IsZero() && !p.To.IsZero() {
		b.WriteString(fmt.Sprintf("Rango,%s,%s\n",
			p.From.Format("2006-01-02"), p.To.Format("2006-01-02")))
	}
	b.WriteString("\n")
	b.WriteString(strings.Join(escapeCSVRow(p.Headers), ",") + "\n")
	for _, r := range p.Rows {
		b.WriteString(strings.Join(escapeCSVRow(r), ",") + "\n")
	}
	if len(p.Totals) > 0 {
		b.WriteString(strings.Join(escapeCSVRow(p.Totals), ",") + "\n")
	}
	if p.Footer != "" {
		b.WriteString("\n" + p.Footer + "\n")
	}
	return []byte(b.String()), nil
}

// GetExpensesReport retorna los egresos filtrados por rango de fechas y opcionalmente por concepto
func (s *ExportService) GetExpensesReport(from, to time.Time, concept string) ([]models.Expense, error) {
	var expenses []models.Expense
	query := s.db.Preload("Creator").
		Where(`date BETWEEN ? AND ?`, from, to)

	if concept != "" {
		query = query.Where(`description ILIKE ?`, "%"+concept+"%")
	}

	err := query.Order(`date ASC`).Find(&expenses).Error
	return expenses, err
}

// =============================================================
// Helpers
// =============================================================

func escapeCSVRow(row []string) []string {
	out := make([]string, len(row))
	for i, c := range row {
		if strings.ContainsAny(c, ",\"\n") {
			c = `"` + strings.ReplaceAll(c, `"`, `""`) + `"`
		}
		out[i] = c
	}
	return out
}

// sanitizePDF reemplaza símbolos no soportados por cp1252 (em-dash, emojis,
// etc.) por equivalentes ASCII. Las tildes y eñe se preservan tal cual; el
// `UnicodeTranslator` de gofpdf se encarga de mapearlos a Latin-1.
func sanitizePDF(s string) string {
	repl := strings.NewReplacer(
		"—", "-",
		"–", "-",
		"…", "...",
		"•", "*",
		"⚠️", "[!]",
		"⚠", "[!]",
		"✅", "[OK]",
		"❌", "[X]",
		"€", "EUR",
		"\u00a0", " ", // nbsp
	)
	out := repl.Replace(s)
	// Filtrar emojis y caracteres > U+FFFF (BMP astral) que cp1252 no cubre.
	// Latin-1 (cp1252) llega hasta U+00FF; sin embargo el UnicodeTranslator
	// también soporta algunos extras como "™", €, etc.
	var b strings.Builder
	for _, r := range out {
		if r > 0x017F && (r < 0x2018 || r > 0x201D) {
			// Fuera del rango Latin Extended-A y de las comillas tipográficas
			// que cp1252 sí mapea: sustituir por '?'.
			b.WriteRune('?')
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// IOReader returns an io.Reader from bytes (for telegram).
func BytesReader(b []byte) io.Reader { return bytes.NewReader(b) }
