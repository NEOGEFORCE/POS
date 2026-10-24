package services

import (
	"math"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================================
// B2 — Egresos MIXTOS con BOLD_QR tras la migración 028
//
// Un egreso ya puede pagarse combinando BOLD_QR con otros bolsillos (p. ej.
// $20.000 NEQUI + $10.000 BOLD_QR = $30.000). Esta suite garantiza que:
//
//   1. `parsePaymentSourceAmounts` reconoce el token BOLD_QR dentro del
//      string compuesto "NEQUI: $20000 / BOLD_QR: $10000" y pone cada
//      valor en el bolsillo correcto.
//   2. La columna `BoldQrAmount` enviada por el frontend se respeta
//      (guarda temprana contempla el sexto bolsillo).
//   3. En el flujo del dashboard y del cierre el egreso mixto se cuenta
//      EXACTAMENTE una vez por canal, sin duplicarse en EFECTIVO ni en
//      la rama legacy por texto.
// =============================================================================

// Caso canónico pedido por producto: "NEQUI: $20000 / BOLD_QR: $10000"
// descuenta $20.000 de Nequi y $10.000 de Bold.
func TestParsePaymentSourceAmounts_MixtoNequiBoldQR(t *testing.T) {
	e := &models.Expense{
		Status:        "PAID",
		Amount:        30_000,
		PaymentSource: "NEQUI: $20000 / BOLD_QR: $10000",
	}
	parsePaymentSourceAmounts(e)

	if e.NequiAmount != 20_000 {
		t.Fatalf("NequiAmount = %v; want 20000", e.NequiAmount)
	}
	if e.BoldQrAmount != 10_000 {
		t.Fatalf("BoldQrAmount = %v; want 10000", e.BoldQrAmount)
	}
	if e.CashAmount != 0 || e.DaviplataAmount != 0 || e.FondoAmount != 0 || e.CoinsAmount != 0 {
		t.Fatalf("se contaminó otro bolsillo: %+v", e)
	}
	// El PaymentSource no se normaliza: el string compuesto se conserva
	// como pista de auditoría.
	if e.PaymentSource != "NEQUI: $20000 / BOLD_QR: $10000" {
		t.Fatalf("PaymentSource mutado: %q", e.PaymentSource)
	}
}

// Variantes del token BOLD en el string compuesto.
func TestParsePaymentSourceAmounts_MixtoVariantesBoldQR(t *testing.T) {
	cases := []struct {
		src  string
		want float64
	}{
		{"CAJA: $20000 / BOLD_QR: $30000", 30_000},
		{"CAJA: $20000 / BOLD-QR: $30000", 30_000},
		{"CAJA: $20000 / BOLD QR: $30000", 30_000},
		{"CAJA: $20000 / BOLDQR: $30000", 30_000},
	}
	for _, c := range cases {
		e := &models.Expense{Status: "PAID", Amount: 50_000, PaymentSource: c.src}
		parsePaymentSourceAmounts(e)
		if e.BoldQrAmount != c.want {
			t.Errorf("src=%q: BoldQrAmount=%v want %v", c.src, e.BoldQrAmount, c.want)
		}
		if e.CashAmount != 20_000 {
			t.Errorf("src=%q: CashAmount=%v want 20000", c.src, e.CashAmount)
		}
	}
}

// Si el frontend ya envía desglose explícito con BoldQrAmount>0, la
// guarda temprana debe respetar el reparto sin aplicar el regex.
func TestParsePaymentSourceAmounts_ColumnaBoldQrSetea_GuardaRespeta(t *testing.T) {
	e := &models.Expense{
		Status:        "PAID",
		Amount:        30_000,
		PaymentSource: "MIXTO",
		NequiAmount:   20_000,
		BoldQrAmount:  10_000,
	}
	parsePaymentSourceAmounts(e)
	if e.NequiAmount != 20_000 || e.BoldQrAmount != 10_000 {
		t.Fatalf("desglose explícito pisado: %+v", e)
	}
	if e.CashAmount != 0 || e.DaviplataAmount != 0 || e.FondoAmount != 0 || e.CoinsAmount != 0 {
		t.Fatalf("se asignó otro canal con el desglose explícito presente: %+v", e)
	}
}

// Bold puro: la columna física queda poblada con el total (ya no es
// gorm:"-"), para que SUM(bold_qr_amount) sea la fuente directa.
func TestParsePaymentSourceAmounts_BoldPuroPueblaColumna(t *testing.T) {
	e := &models.Expense{Status: "PAID", Amount: 45_000, PaymentSource: "BOLD_QR"}
	parsePaymentSourceAmounts(e)
	if e.BoldQrAmount != 45_000 {
		t.Fatalf("BoldQrAmount = %v; want 45000", e.BoldQrAmount)
	}
	if e.CashAmount != 0 || e.NequiAmount != 0 || e.DaviplataAmount != 0 ||
		e.FondoAmount != 0 || e.CoinsAmount != 0 {
		t.Fatalf("otro bolsillo contaminado: %+v", e)
	}
}

// El dashboard "Flujo Hoy" cuenta cada canal EXACTAMENTE una vez para un
// egreso mixto Nequi+Bold. Antes del fix, un source compuesto podía caer
// doble (una vez por columna y otra por texto) o caer en EFECTIVO por el
// fallback del parser.
func TestExpenseMixtoNequiBoldQR_NoSeDuplicaEnDashboard(t *testing.T) {
	// Simulación del ciclo: el expense se guarda tras CreateExpense con
	// las columnas ya repartidas por parsePaymentSourceAmounts.
	e := &models.Expense{
		Status:        "PAID",
		Amount:        30_000,
		PaymentSource: "NEQUI: $20000 / BOLD_QR: $10000",
	}
	parsePaymentSourceAmounts(e)

	// Guardado + leído: así lo verá dashboard al pasar por ExpenseChannelBuckets.
	buckets := ExpenseChannelBuckets([]models.Expense{*e})
	if buckets["NEQUI"] != 20_000 {
		t.Fatalf("buckets[NEQUI] = %v; want 20000", buckets["NEQUI"])
	}
	if buckets["BOLD_QR"] != 10_000 {
		t.Fatalf("buckets[BOLD_QR] = %v; want 10000", buckets["BOLD_QR"])
	}
	if buckets["EFECTIVO"] != 0 {
		t.Fatalf("buckets[EFECTIVO] = %v; want 0 (nada debe caer en caja)", buckets["EFECTIVO"])
	}
	// Invariante: suma de buckets == total multicanal del egreso.
	total, _ := ComputeShiftExpenseTotals([]models.Expense{*e})
	sum := buckets["EFECTIVO"] + buckets["NEQUI"] + buckets["DAVIPLATA"] +
		buckets["FONDO"] + buckets["MONEDAS"] + buckets["BOLD_QR"]
	if math.Abs(sum-total) > 0.01 {
		t.Fatalf("suma buckets=%v ≠ total=%v (hay duplicado o se perdió plata)", sum, total)
	}
	if math.Abs(total-30_000) > 0.01 {
		t.Fatalf("total multicanal = %v; want 30000", total)
	}
}

// Cierre + arqueo con un egreso mixto Nequi+Bold: ni se infla la venta
// con la parte Bold, ni se descuenta del efectivo esperado la parte Nequi.
func TestCierreConEgresoMixtoNequiBoldQR_NoDuplicaNiInfla(t *testing.T) {
	c := &models.CashierClosure{
		OpeningCash:    100_000,
		PhysicalCash:   100_000,
		TotalCash:      100_000,
		TotalNequi:     80_000,
		TotalDaviplata: 0,
		Expenses: []models.Expense{{
			Status:        "PAID",
			Amount:        30_000,
			PaymentSource: "NEQUI: $20000 / BOLD_QR: $10000",
			NequiAmount:   20_000,
			BoldQrAmount:  10_000,
		}},
	}
	m := ComputeClosureMetrics(c)

	// Egresos por canal:
	if m.EgresosCaja != 0 {
		t.Fatalf("EgresosCaja = %v; want 0 (el egreso no salió de la gaveta)", m.EgresosCaja)
	}
	if m.EgresosDigital != 20_000 {
		t.Fatalf("EgresosDigital = %v; want 20000 (sólo Nequi, no Bold)", m.EgresosDigital)
	}
	if m.EgresosBoldQr != 10_000 {
		t.Fatalf("EgresosBoldQr = %v; want 10000", m.EgresosBoldQr)
	}
	if math.Abs(m.EgresosTotales-30_000) > 0.01 {
		t.Fatalf("EgresosTotales = %v; want 30000", m.EgresosTotales)
	}

	// VentasCajero NO se infla con la parte Bold ni con la Nequi (sólo
	// EgresosCaja aporta a la venta).
	wantVentas := m.PhysicalCash + m.DigitalIncome + m.EgresosCaja + m.Returns
	if math.Abs(m.VentasCajero-wantVentas) > 0.01 {
		t.Fatalf("VentasCajero = %v; want %v", m.VentasCajero, wantVentas)
	}
	// 100k físico + 80k digital + 0 egresos caja = 180k. El egreso mixto
	// NO infla la venta.
	if m.VentasCajero != 180_000 {
		t.Fatalf("VentasCajero = %v; want 180000", m.VentasCajero)
	}
}
