package services

import (
	"bytes"
	"fmt"
	"strings"
	"time"

	"github.com/jung-kurt/gofpdf"
)

// =============================================================
// pdf_theme.go — Arquitectura visual ejecutiva compartida por TODOS
// los PDFs del sistema (Rentabilidad, Cierres de Caja, Mermas,
// Rotación, etc.).
//
// Objetivo: reportes que cualquier persona entienda, sin lenguaje
// técnico, con tarjetas, tablas de filas alternadas, dinero alineado
// a la derecha y formato de moneda bogotana ($ 1.234.567).
// =============================================================

const pdfBrandName = "SUPERMERCADO SURTIFAMILIAR"

type pdfColor struct{ R, G, B int }

// Paleta ejecutiva unificada
var (
	inkColor   = pdfColor{15, 23, 42}    // #0F172A títulos
	bodyColor  = pdfColor{51, 65, 85}    // #334155 texto
	mutedColor = pdfColor{100, 116, 139} // #64748B texto secundario
	lineColor  = pdfColor{226, 232, 240} // #E2E8F0 bordes suaves
	zebraColor = pdfColor{248, 250, 252} // #F8FAFC filas alternadas
	whiteColor = pdfColor{255, 255, 255}
	slateColor = pdfColor{241, 245, 249} // #F1F5F9 fondo de tarjetas

	mintColor    = pdfColor{209, 250, 229} // #D1FAE5 resultado positivo
	mintInkColor = pdfColor{4, 108, 78}    // #046C4E
	coralColor   = pdfColor{254, 226, 226} // #FEE2E2 resultado negativo
	coralInk     = pdfColor{153, 27, 27}   // #991B1B
	amberColor   = pdfColor{254, 243, 199} // #FEF3C7 por cobrar
	amberInk     = pdfColor{146, 64, 14}   // #92400E
)

// fmtCOP formatea un valor en moneda bogotana: "$ 1.234.567".
func fmtCOP(v float64) string {
	sign := ""
	if v < 0 {
		sign = "-"
		v = -v
	}
	digits := fmt.Sprintf("%.0f", v)
	var out strings.Builder
	for i, c := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			out.WriteByte('.')
		}
		out.WriteRune(c)
	}
	return fmt.Sprintf("%s$ %s", sign, out.String())
}

// fmtCOPNeg formatea un egreso siempre con signo negativo visible.
func fmtCOPNeg(v float64) string {
	if v == 0 {
		return fmtCOP(0)
	}
	if v > 0 {
		return "-" + fmtCOP(v)
	}
	return fmtCOP(v)
}

// fmtCOPSigned formatea una variación mostrando siempre el signo, para
// que se lea si la cuenta subió o bajó en el mes.
func fmtCOPSigned(v float64) string {
	if v > 0 {
		return "+" + fmtCOP(v)
	}
	return fmtCOP(v)
}

// fmtPercent formatea un margen (0.20 -> "20,0%").
func fmtPercent(v float64) string {
	s := fmt.Sprintf("%.1f%%", v*100)
	return strings.Replace(s, ".", ",", 1)
}

// =============================================================
// execPDF — envoltorio del motor gofpdf con el tema ejecutivo
// =============================================================

type execPDF struct {
	pdf    *gofpdf.Fpdf
	tr     func(string) string
	left   float64
	right  float64
	top    float64
	bottom float64
	width  float64
	pageH  float64
	title  string
	nowStr string
}

// newExecPDF crea un documento con encabezado y pie corporativo.
// orientation: "P" (vertical) o "L" (horizontal).
func newExecPDF(orientation, title string) *execPDF {
	pdf := gofpdf.New(orientation, "mm", "A4", "")
	left, top, right, bottom := 12.0, 12.0, 12.0, 16.0
	pdf.SetMargins(left, top, right)
	pdf.SetAutoPageBreak(true, bottom)
	pdf.AliasNbPages("{nb}")

	pageW, pageH := pdf.GetPageSize()

	loc, _ := time.LoadLocation("America/Bogota")
	if loc == nil {
		loc = time.Local
	}

	d := &execPDF{
		pdf:    pdf,
		tr:     pdf.UnicodeTranslatorFromDescriptor("cp1252"),
		left:   left,
		right:  right,
		top:    top,
		bottom: bottom,
		width:  pageW - left - right,
		pageH:  pageH,
		title:  title,
		nowStr: time.Now().In(loc).Format("02/01/2006 03:04 PM"),
	}

	pdf.SetHeaderFunc(func() {
		d.setText(inkColor)
		pdf.SetFont("Arial", "B", 10)
		pdf.SetXY(left, top)
		pdf.CellFormat(d.width/2, 5, d.t(pdfBrandName), "", 0, "L", false, 0, "")
		d.setText(mutedColor)
		pdf.SetFont("Arial", "", 8)
		pdf.CellFormat(d.width/2, 5, d.t(d.title), "", 1, "R", false, 0, "")
		d.setDraw(lineColor)
		pdf.SetLineWidth(0.3)
		y := pdf.GetY() + 1
		pdf.Line(left, y, left+d.width, y)
		pdf.SetY(y + 4)
	})

	pdf.SetFooterFunc(func() {
		pdf.SetY(-12)
		d.setDraw(lineColor)
		pdf.SetLineWidth(0.2)
		pdf.Line(left, pdf.GetY(), left+d.width, pdf.GetY())
		pdf.Ln(1)
		d.setText(mutedColor)
		pdf.SetFont("Arial", "", 7.5)
		pdf.CellFormat(d.width/2, 5, d.t(fmt.Sprintf("%s  ·  Emitido %s", pdfBrandName, d.nowStr)), "", 0, "L", false, 0, "")
		pdf.CellFormat(d.width/2, 5, d.t(fmt.Sprintf("Página %d de {nb}", pdf.PageNo())), "", 0, "R", false, 0, "")
	})

	return d
}

func (d *execPDF) t(s string) string { return d.tr(sanitizePDF(s)) }

func (d *execPDF) setText(c pdfColor) { d.pdf.SetTextColor(c.R, c.G, c.B) }
func (d *execPDF) setFill(c pdfColor) { d.pdf.SetFillColor(c.R, c.G, c.B) }
func (d *execPDF) setDraw(c pdfColor) { d.pdf.SetDrawColor(c.R, c.G, c.B) }
func (d *execPDF) y() float64         { return d.pdf.GetY() }
func (d *execPDF) ln(h float64)       { d.pdf.Ln(h) }
func (d *execPDF) addPage()           { d.pdf.AddPage() }
func (d *execPDF) maxY() float64      { return d.pageH - d.bottom }

// ensure garantiza que quedan h milímetros útiles en la página.
func (d *execPDF) ensure(h float64) {
	if d.y()+h > d.maxY() {
		d.pdf.AddPage()
	}
}

// hero dibuja el bloque de título principal de la primera página.
func (d *execPDF) hero(title, subtitle string, from, to time.Time) {
	p := d.pdf
	d.setText(inkColor)
	p.SetFont("Arial", "B", 19)
	p.CellFormat(d.width, 10, d.t(title), "", 1, "L", false, 0, "")

	if subtitle != "" {
		d.setText(bodyColor)
		p.SetFont("Arial", "", 10.5)
		p.CellFormat(d.width, 6, d.t(subtitle), "", 1, "L", false, 0, "")
	}

	d.setText(mutedColor)
	p.SetFont("Arial", "", 9)
	meta := fmt.Sprintf("Generado el %s", d.nowStr)
	if !from.IsZero() && !to.IsZero() {
		meta = fmt.Sprintf("Período: %s al %s   ·   Generado el %s",
			from.Format("02/01/2006"), to.Format("02/01/2006"), d.nowStr)
	}
	p.CellFormat(d.width, 5, d.t(meta), "", 1, "L", false, 0, "")
	p.Ln(4)
}

// sectionTitle dibuja un título de sección con barra de acento.
func (d *execPDF) sectionTitle(text string) {
	d.ensure(16)
	p := d.pdf
	y := d.y()
	d.setFill(inkColor)
	p.Rect(d.left, y+1.2, 1.8, 5.4, "F")
	d.setText(inkColor)
	p.SetFont("Arial", "B", 12)
	p.SetXY(d.left+4, y)
	p.CellFormat(d.width-4, 8, d.t(text), "", 1, "L", false, 0, "")
	p.SetX(d.left)
	p.Ln(1)
}

// hint dibuja una nota aclaratoria en gris.
func (d *execPDF) hint(text string) {
	d.ensure(10)
	d.setText(mutedColor)
	d.pdf.SetFont("Arial", "I", 8.5)
	d.pdf.SetX(d.left)
	d.pdf.MultiCell(d.width, 4.2, d.t(text), "", "L", false)
	d.pdf.Ln(1.5)
}

// =============================================================
// Tarjetas
// =============================================================

type execCard struct {
	Label string
	Value string
	Note  string
	Bg    pdfColor
	Fg    pdfColor
}

// cards dibuja una fila de tarjetas de igual ancho.
func (d *execPDF) cards(items []execCard) {
	if len(items) == 0 {
		return
	}
	const gap = 3.0
	h := 19.0
	d.ensure(h + 4)
	p := d.pdf
	cw := (d.width - gap*float64(len(items)-1)) / float64(len(items))
	y := d.y()

	for i, c := range items {
		x := d.left + float64(i)*(cw+gap)
		bg := c.Bg
		if bg == (pdfColor{}) {
			bg = slateColor
		}
		fg := c.Fg
		if fg == (pdfColor{}) {
			fg = inkColor
		}
		d.setFill(bg)
		d.setDraw(lineColor)
		p.SetLineWidth(0.2)
		p.Rect(x, y, cw, h, "FD")

		d.setText(mutedColor)
		p.SetFont("Arial", "", 7.5)
		p.SetXY(x+2, y+2)
		p.CellFormat(cw-4, 4, d.t(c.Label), "", 0, "L", false, 0, "")

		d.setText(fg)
		p.SetFont("Arial", "B", 13)
		p.SetXY(x+2, y+7)
		p.CellFormat(cw-4, 7, d.t(c.Value), "", 0, "L", false, 0, "")

		if c.Note != "" {
			d.setText(mutedColor)
			p.SetFont("Arial", "", 7)
			p.SetXY(x+2, y+14)
			p.CellFormat(cw-4, 4, d.t(c.Note), "", 0, "L", false, 0, "")
		}
	}
	p.SetXY(d.left, y+h+4)
}

// =============================================================
// Pasos del resumen humano
// =============================================================

// step dibuja una fila "Paso N — descripción ............ $ valor".
func (d *execPDF) step(number int, label, value string, tone pdfColor) {
	h := 10.0
	d.ensure(h + 2)
	p := d.pdf
	y := d.y()

	d.setFill(zebraColor)
	d.setDraw(lineColor)
	p.SetLineWidth(0.2)
	p.Rect(d.left, y, d.width, h, "FD")

	// Insignia del paso
	d.setFill(inkColor)
	p.Rect(d.left, y, 22, h, "F")
	d.setText(whiteColor)
	p.SetFont("Arial", "B", 8.5)
	p.SetXY(d.left, y+3)
	p.CellFormat(22, 4, d.t(fmt.Sprintf("PASO %d", number)), "", 0, "C", false, 0, "")

	d.setText(bodyColor)
	p.SetFont("Arial", "", 9.5)
	p.SetXY(d.left+25, y+3)
	p.CellFormat(d.width-25-52, 4, d.t(label), "", 0, "L", false, 0, "")

	fg := tone
	if fg == (pdfColor{}) {
		fg = inkColor
	}
	d.setText(fg)
	p.SetFont("Arial", "B", 11)
	p.SetXY(d.left+d.width-52, y+2.5)
	p.CellFormat(50, 5, d.t(value), "", 0, "R", false, 0, "")

	p.SetXY(d.left, y+h+1.5)
}

// resultBox dibuja el recuadro grande del resultado final.
func (d *execPDF) resultBox(step int, label, value, note string, positive bool) {
	h := 30.0
	d.ensure(h + 4)
	p := d.pdf
	y := d.y()

	bg, fg := mintColor, mintInkColor
	if !positive {
		bg, fg = coralColor, coralInk
	}
	d.setFill(bg)
	d.setDraw(fg)
	p.SetLineWidth(0.5)
	p.Rect(d.left, y, d.width, h, "FD")

	d.setText(fg)
	p.SetFont("Arial", "B", 9.5)
	p.SetXY(d.left, y+3.5)
	p.CellFormat(d.width, 5, d.t(fmt.Sprintf("PASO %d  ·  %s", step, strings.ToUpper(label))), "", 0, "C", false, 0, "")

	p.SetFont("Arial", "B", 24)
	p.SetXY(d.left, y+10)
	p.CellFormat(d.width, 12, d.t(value), "", 0, "C", false, 0, "")

	if note != "" {
		p.SetFont("Arial", "", 8.5)
		p.SetXY(d.left, y+22)
		p.CellFormat(d.width, 5, d.t(note), "", 0, "C", false, 0, "")
	}
	p.SetXY(d.left, y+h+4)
}

// strip dibuja una franja destacada de total (etiqueta izquierda, monto derecha).
func (d *execPDF) strip(label, value string, bg, fg pdfColor) {
	h := 9.0
	d.ensure(h + 2)
	p := d.pdf
	y := d.y()
	d.setFill(bg)
	d.setDraw(lineColor)
	p.SetLineWidth(0.2)
	p.Rect(d.left, y, d.width, h, "FD")

	d.setText(fg)
	p.SetFont("Arial", "B", 9.5)
	p.SetXY(d.left+3, y+2.5)
	p.CellFormat(d.width*0.6, 4, d.t(label), "", 0, "L", false, 0, "")
	p.SetFont("Arial", "B", 11)
	p.SetXY(d.left+d.width-63, y+2)
	p.CellFormat(60, 5, d.t(value), "", 0, "R", false, 0, "")

	p.SetXY(d.left, y+h+2)
}

// =============================================================
// Tablas con filas alternadas
// =============================================================

type execTable struct {
	Headers  []string
	Weights  []float64 // pesos relativos de cada columna (opcional)
	Aligns   []string  // "L" | "C" | "R" por columna (opcional)
	Rows     [][]string
	Total    []string // fila de total opcional
	FontSize float64
	// BandRows marca filas de banda/sección (se pintan como separador).
	BandRows map[int]bool
}

func (d *execPDF) resolveWidths(weights []float64, n int) []float64 {
	if n == 0 {
		return nil
	}
	w := make([]float64, n)
	sum := 0.0
	for i := 0; i < n; i++ {
		if i < len(weights) && weights[i] > 0 {
			w[i] = weights[i]
		} else {
			w[i] = 1
		}
		sum += w[i]
	}
	for i := range w {
		w[i] = d.width * w[i] / sum
	}
	return w
}

func (d *execPDF) table(t execTable) {
	n := len(t.Headers)
	if n == 0 {
		return
	}
	widths := d.resolveWidths(t.Weights, n)
	aligns := make([]string, n)
	for i := 0; i < n; i++ {
		if i < len(t.Aligns) && t.Aligns[i] != "" {
			aligns[i] = t.Aligns[i]
		} else {
			aligns[i] = "L"
		}
	}
	fs := t.FontSize
	if fs == 0 {
		fs = 8.5
	}
	lineH := 4.3
	p := d.pdf

	drawHead := func() {
		d.ensure(9 + lineH)
		d.setFill(inkColor)
		d.setText(whiteColor)
		p.SetFont("Arial", "B", fs)
		p.SetX(d.left)
		for i, h := range t.Headers {
			al := aligns[i]
			p.CellFormat(widths[i], 8, d.t(h), "", 0, al, true, 0, "")
		}
		p.Ln(-1)
		p.SetX(d.left)
	}
	drawHead()

	fill := false
	for ri, row := range t.Rows {
		p.SetFont("Arial", "", fs)

		// Fila de banda (separador de bloque)
		if t.BandRows != nil && t.BandRows[ri] {
			label := ""
			for _, c := range row {
				if strings.TrimSpace(c) != "" {
					label = c
					break
				}
			}
			d.ensure(9)
			y := d.y()
			d.setFill(slateColor)
			p.Rect(d.left, y, d.width, 7, "F")
			d.setText(inkColor)
			p.SetFont("Arial", "B", fs)
			p.SetXY(d.left+2, y+1.5)
			p.CellFormat(d.width-4, 4, d.t(label), "", 0, "L", false, 0, "")
			p.SetXY(d.left, y+7)
			fill = false
			continue
		}

		// Alto de la fila según el texto más largo
		maxLines := 1
		for i := 0; i < n && i < len(row); i++ {
			lines := p.SplitLines([]byte(d.t(row[i])), widths[i]-3)
			if len(lines) > maxLines {
				maxLines = len(lines)
			}
		}
		rowH := float64(maxLines)*lineH + 2.4
		if rowH < 7 {
			rowH = 7
		}

		if d.y()+rowH > d.maxY() {
			p.AddPage()
			drawHead()
			fill = false
		}

		y := d.y()
		if fill {
			d.setFill(zebraColor)
		} else {
			d.setFill(whiteColor)
		}
		p.Rect(d.left, y, d.width, rowH, "F")

		d.setText(bodyColor)
		x := d.left
		for i := 0; i < n; i++ {
			cell := ""
			if i < len(row) {
				cell = row[i]
			}
			lines := p.SplitLines([]byte(d.t(cell)), widths[i]-3)
			textY := y + (rowH-float64(len(lines))*lineH)/2
			p.SetXY(x+1.5, textY)
			p.MultiCell(widths[i]-3, lineH, d.t(cell), "", aligns[i], false)
			x += widths[i]
		}

		d.setDraw(lineColor)
		p.SetLineWidth(0.15)
		p.Line(d.left, y+rowH, d.left+d.width, y+rowH)
		p.SetXY(d.left, y+rowH)
		fill = !fill
	}

	if len(t.Total) > 0 {
		d.ensure(10)
		y := d.y()
		d.setFill(slateColor)
		p.Rect(d.left, y, d.width, 8.5, "F")
		d.setText(inkColor)
		p.SetFont("Arial", "B", fs)
		x := d.left
		for i := 0; i < n; i++ {
			cell := ""
			if i < len(t.Total) {
				cell = t.Total[i]
			}
			p.SetXY(x+1.5, y+2.2)
			p.CellFormat(widths[i]-3, 4.5, d.t(cell), "", 0, aligns[i], false, 0, "")
			x += widths[i]
		}
		p.SetXY(d.left, y+8.5)
	}
	p.Ln(3)
}

func (d *execPDF) buffer() (*bytes.Buffer, error) {
	var buf bytes.Buffer
	if err := d.pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("pdf output: %w", err)
	}
	return &buf, nil
}
