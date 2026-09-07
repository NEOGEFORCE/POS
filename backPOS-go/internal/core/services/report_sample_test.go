package services

import (
	"os"
	"testing"
	"time"
)

// TestGenerarMuestraReporteDesglosado NO es un test de comportamiento: es un
// generador de muestra para que el dueño revise el formato del reporte antes de
// desplegarlo.
//
// Corre solo cuando se pide explícitamente:
//
//	go test ./internal/core/services/ -run TestGenerarMuestraReporteDesglosado -v
//
// Escribe el PDF en la ruta de POS_SAMPLE_OUT (o en muestra_reporte.pdf).
// Se salta si no se pide la variable, para no dejar basura en cada corrida de
// la suite ni en CI.
func TestGenerarMuestraReporteDesglosado(t *testing.T) {
	dst := os.Getenv("POS_SAMPLE_OUT")
	if dst == "" {
		t.Skip("definí POS_SAMPLE_OUT para generar la muestra del reporte")
	}

	loc := time.FixedZone("America/Bogota", -5*60*60)
	from := time.Date(2026, 8, 29, 0, 0, 0, 0, loc)
	to := time.Date(2026, 8, 31, 23, 59, 59, 0, loc)

	headers := []string{
		"FECHA", "TIPO", "CONCEPTO",
		"EFECTIVO CONTADO", "NEQUI", "DAVIPLATA", "TARJETA/OTROS", "DEVOLUCIONES",
		"VENTA TOTAL",
		"EGRESO CAJA", "EGRESO FONDO", "EGRESO DIGITAL", "EGRESO TOTAL",
		"EFECTIVO ESPERADO", "DIFERENCIA",
	}

	row := func(cells ...string) []string { return cells }

	p := ReportPayload{
		Title:    "FLUJO DE CAJA - DESGLOSADO (DIARIO Y EVENTOS)",
		Subtitle: "VENTA TOTAL = Efectivo Contado + Nequi + Daviplata + Otros + Egresos Caja + Devoluciones",
		From:     from,
		To:       to,
		Headers:  headers,
		Rows: [][]string{
			// --- 29 de agosto ---
			row("2026-08-29", "CIERRE", "Turno #140 - SEBASTIAN (08:00 a 20:00)",
				"1.240.000", "380.000", "150.000", "90.000", "0",
				"2.200.000",
				"340.000", "0", "0", "340.000",
				"1.240.000", "0"),
			row("2026-08-29", "CIERRE", "Turno #141 - SEBASTIAN (22:00 a 01:00)",
				"620.000", "210.000", "80.000", "0", "15.000",
				"1.105.000",
				"180.000", "0", "0", "180.000",
				"605.000", "15.000"),
			row("2026-08-29", "TOTAL DIA", "SUBTOTAL (2 turnos)",
				"1.860.000", "590.000", "230.000", "90.000", "15.000",
				"3.305.000",
				"520.000", "0", "0", "520.000",
				"1.845.000", "15.000"),

			// --- 30 de agosto ---
			row("2026-08-30", "CIERRE", "Turno #142 - FABIAN (08:00 a 20:00)",
				"1.890.000", "540.000", "220.000", "130.000", "0",
				"3.090.000",
				"310.000", "800.000", "120.000", "1.230.000",
				"1.900.000", "-10.000"),
			row("2026-08-30", "TOTAL DIA", "SUBTOTAL (1 turnos)",
				"1.890.000", "540.000", "220.000", "130.000", "0",
				"3.090.000",
				"310.000", "800.000", "120.000", "1.230.000",
				"1.900.000", "-10.000"),
		},
		Totals: []string{
			"GRAN TOTAL", "-", "2 dias",
			"3.750.000", "1.130.000", "450.000", "220.000", "15.000",
			"6.395.000",
			"830.000", "800.000", "120.000", "1.750.000",
			"3.745.000", "5.000",
		},
	}

	svc := &ExportService{}

	pdf, err := svc.RenderPDF(p)
	if err != nil {
		t.Fatalf("RenderPDF: %v", err)
	}
	if err := os.WriteFile(dst+".pdf", pdf, 0o644); err != nil {
		t.Fatalf("escribiendo pdf: %v", err)
	}

	xls, err := svc.RenderExcel(p)
	if err != nil {
		t.Fatalf("RenderExcel: %v", err)
	}
	if err := os.WriteFile(dst+".xlsx", xls, 0o644); err != nil {
		t.Fatalf("escribiendo excel: %v", err)
	}

	csv, err := svc.RenderCSV(p)
	if err != nil {
		t.Fatalf("RenderCSV: %v", err)
	}
	if err := os.WriteFile(dst+".csv", csv, 0o644); err != nil {
		t.Fatalf("escribiendo csv: %v", err)
	}

	t.Logf("muestras: %s.pdf (%d b) / .xlsx (%d b) / .csv (%d b)", dst, len(pdf), len(xls), len(csv))
}
