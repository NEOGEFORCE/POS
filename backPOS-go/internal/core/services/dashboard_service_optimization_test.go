package services

import (
	"math"
	"testing"
	"time"
)

func TestBuildPnLReportUsesAggregatedCOGS(t *testing.T) {
	from := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 8, 31, 23, 59, 59, 0, time.UTC)
	report := buildPnLReport(from, to, 1100, 400, 200)

	if report.TotalRevenue != 1100 || report.TotalCOGS != 400 || report.TotalExpenses != 200 {
		t.Fatalf("totales P&L inesperados: %+v", report)
	}
	if report.GrossProfit != 700 || report.NetProfit != 500 {
		t.Fatalf("utilidades P&L inesperadas: %+v", report)
	}
	wantMargin := 500.0 / 1100.0 * 100
	if math.Abs(report.MarginPercentage-wantMargin) > 0.000001 {
		t.Fatalf("margen = %f, want %f", report.MarginPercentage, wantMargin)
	}
}

func TestBuildPnLReportAvoidsDivisionByZero(t *testing.T) {
	report := buildPnLReport(time.Time{}, time.Time{}, 0, 25, 10)
	if report.MarginPercentage != 0 {
		t.Fatalf("margen sin ingresos = %f, want 0", report.MarginPercentage)
	}
	if report.GrossProfit != -25 || report.NetProfit != -35 {
		t.Fatalf("pérdidas P&L inesperadas: %+v", report)
	}
}
