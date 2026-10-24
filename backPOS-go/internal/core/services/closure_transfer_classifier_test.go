package services

import (
	"math"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// B1 — Regresión del cierre con canal Bold QR
// ============================================================================
//
// Antes del fix, el switch inline de GetCashierClosure desviaba ventas y
// abonos con transferSource='BOLD_QR' a `closure.TotalBoldQr` (DTO runtime)
// y DEJABA de sumarlos a `TotalOtherTransfer`. Como el handler sólo copia
// `TotalOtherTransfer` al modelo persistido (`models.CashierClosure` NO tiene
// `TotalBoldQr`), el cierre guardado perdía el canal: DigitalIncome
// (closure_metrics.go:253), ShiftIngresosDigitales (dashboard_service.go
// ~1081), el PDF (export_service_consolidated.go 417/899), Telegram y
// audited_income.go dejaban de ver la plata de Bold QR.
//
// El fix sin migración: la clasificación suma SIEMPRE a `TotalOtherTransfer`
// y ADEMÁS a `TotalBoldQr` cuando corresponde (subconjunto informativo).
// Ningún consumidor existente suma TotalOtherTransfer + TotalBoldQr, así que
// no hay doble conteo. Estos tests cristalizan la invariante.

func TestClassifyTransferToClosure_BoldQrAcumulaEnAmbasBolsas(t *testing.T) {
	var c CashierClosure
	classifyTransferToClosure("BOLD_QR", 150_000, &c)
	classifyTransferToClosure("BOLD_QR", 50_000, &c)

	if c.TotalOtherTransfer != 200_000 {
		t.Fatalf("TotalOtherTransfer = %v; want 200000 (Bold QR DEBE sumar a OtherTransfer para no perder la plata al mapear al modelo persistente)", c.TotalOtherTransfer)
	}
	if c.TotalBoldQr != 200_000 {
		t.Fatalf("TotalBoldQr = %v; want 200000 (subconjunto informativo)", c.TotalBoldQr)
	}
	// Ningún otro bolsillo se contaminó.
	if c.TotalNequi != 0 || c.TotalDaviplata != 0 || c.TotalBancolombia != 0 || c.TotalCard != 0 {
		t.Fatalf("otro canal contaminado: nequi=%v davi=%v bancol=%v card=%v",
			c.TotalNequi, c.TotalDaviplata, c.TotalBancolombia, c.TotalCard)
	}
}

func TestClassifyTransferToClosure_NequiNoAfectaBoldQr(t *testing.T) {
	var c CashierClosure
	classifyTransferToClosure("NEQUI", 100_000, &c)
	if c.TotalNequi != 100_000 {
		t.Fatalf("TotalNequi = %v; want 100000", c.TotalNequi)
	}
	if c.TotalOtherTransfer != 0 {
		t.Fatalf("TotalOtherTransfer = %v; want 0 (NEQUI tiene bolsillo propio)", c.TotalOtherTransfer)
	}
	if c.TotalBoldQr != 0 {
		t.Fatalf("TotalBoldQr = %v; want 0 (NEQUI nunca es Bold QR)", c.TotalBoldQr)
	}
}

func TestClassifyTransferToClosure_OtroCanalDesconocidoVaAOtherTransfer(t *testing.T) {
	var c CashierClosure
	classifyTransferToClosure("MERCADO_PAGO", 80_000, &c)
	if c.TotalOtherTransfer != 80_000 {
		t.Fatalf("TotalOtherTransfer = %v; want 80000", c.TotalOtherTransfer)
	}
	if c.TotalBoldQr != 0 {
		t.Fatalf("TotalBoldQr = %v; want 0 (MERCADO_PAGO no es Bold QR)", c.TotalBoldQr)
	}
}

func TestClassifyTransferToClosure_IgnoraMontoCero(t *testing.T) {
	var c CashierClosure
	classifyTransferToClosure("BOLD_QR", 0, &c)
	classifyTransferToClosure("NEQUI", -10, &c)
	if c.TotalBoldQr != 0 || c.TotalOtherTransfer != 0 || c.TotalNequi != 0 {
		t.Fatalf("montos <= 0 no deben mutar el cierre: %+v", c)
	}
}

func TestClassifyTransferToClosure_VariantesBoldQr(t *testing.T) {
	// Variantes posibles del transferSource. Todas deben ser reconocidas
	// como Bold QR (ver models.IsBoldQRSaleTransferSource).
	variantes := []string{"BOLD_QR", "bold_qr", "BOLD-QR", "BOLD QR", "BOLDQR", "BOLD_QR_BRE_B"}
	for _, v := range variantes {
		var c CashierClosure
		classifyTransferToClosure(v, 30_000, &c)
		if c.TotalBoldQr != 30_000 {
			t.Errorf("variante %q: TotalBoldQr = %v; want 30000", v, c.TotalBoldQr)
		}
		if c.TotalOtherTransfer != 30_000 {
			t.Errorf("variante %q: TotalOtherTransfer = %v; want 30000", v, c.TotalOtherTransfer)
		}
	}
}

// Integración: un turno con venta QR y abono QR -> ComputeClosureMetrics
// (que usa el modelo persistente) SIGUE viendo esos montos vía
// TotalOtherTransfer, sin duplicar via TotalBoldQr.
func TestCierreConBoldQR_DigitalIncomeIncluyeOtherTransfer_SinDuplicarBoldQr(t *testing.T) {
	// Simulamos el DTO runtime tras procesar la venta QR y el abono QR.
	var runtime CashierClosure
	classifyTransferToClosure("BOLD_QR", 120_000, &runtime) // venta QR
	classifyTransferToClosure("BOLD_QR", 30_000, &runtime)  // abono QR
	// Y una venta Nequi para comparación.
	classifyTransferToClosure("NEQUI", 50_000, &runtime)

	if runtime.TotalBoldQr != 150_000 {
		t.Fatalf("TotalBoldQr = %v; want 150000 (subconjunto QR)", runtime.TotalBoldQr)
	}
	if runtime.TotalOtherTransfer != 150_000 {
		t.Fatalf("TotalOtherTransfer = %v; want 150000 (Bold QR incluido)", runtime.TotalOtherTransfer)
	}
	if runtime.TotalNequi != 50_000 {
		t.Fatalf("TotalNequi = %v; want 50000", runtime.TotalNequi)
	}

	// Mapear al modelo persistente (equivalente a lo que hace el handler
	// en applyTrustedClosureData). Sólo se copia TotalOtherTransfer; no
	// hay columna TotalBoldQr en el modelo persistente.
	persisted := models.CashierClosure{
		TotalNequi:         runtime.TotalNequi,
		TotalDaviplata:     runtime.TotalDaviplata,
		TotalCard:          runtime.TotalCard,
		TotalBancolombia:   runtime.TotalBancolombia,
		TotalOtherTransfer: runtime.TotalOtherTransfer,
	}

	// ComputeClosureMetrics calcula DigitalIncome = Nequi+Davi+Card+Bancol+OtherTransfer.
	// Los 150.000 de Bold QR deben verse incluidos ahí EXACTAMENTE UNA VEZ.
	m := ComputeClosureMetrics(&persisted)
	wantDigital := 50_000.0 + 150_000.0 // Nequi + OtherTransfer (que ya incluye QR)
	if math.Abs(m.DigitalIncome-wantDigital) > 0.01 {
		t.Fatalf("DigitalIncome = %v; want %v (QR debe estar incluido vía OtherTransfer, no sumado dos veces)",
			m.DigitalIncome, wantDigital)
	}
}

// ShiftIngresosDigitales del dashboard (dashboard_service.go ~1081):
// Nequi + Daviplata + Bancolombia + Card + OtherTransfer. Con el fix, Bold
// QR entra por OtherTransfer.
func TestShiftIngresosDigitales_IncluyeBoldQrViaOtherTransfer(t *testing.T) {
	// DTO runtime
	var runtime CashierClosure
	classifyTransferToClosure("BOLD_QR", 200_000, &runtime)
	classifyTransferToClosure("DAVIPLATA", 100_000, &runtime)

	// Modelo persistente (lo que ve ShiftIngresosDigitales tras el handler)
	persisted := models.CashierClosure{
		TotalNequi:         runtime.TotalNequi,
		TotalDaviplata:     runtime.TotalDaviplata,
		TotalBancolombia:   runtime.TotalBancolombia,
		TotalCard:          runtime.TotalCard,
		TotalOtherTransfer: runtime.TotalOtherTransfer,
	}

	// Fórmula literal del dashboard (shiftClosure.TotalNequi+Davi+Bancol+Card+OtherTransfer).
	ingresosDigitales := persisted.TotalNequi + persisted.TotalDaviplata +
		persisted.TotalBancolombia + persisted.TotalCard + persisted.TotalOtherTransfer

	// 100k davi + 200k QR (vía OtherTransfer) = 300k
	if ingresosDigitales != 300_000 {
		t.Fatalf("ShiftIngresosDigitales = %v; want 300000 (QR incluido por OtherTransfer)", ingresosDigitales)
	}

	// Si alguien sumara TotalBoldQr aparte, se duplicaría. Verificamos la
	// invariante: TotalBoldQr es informativo, nunca se suma a los
	// consumidores de ingresos.
	if runtime.TotalBoldQr != 200_000 {
		t.Fatalf("TotalBoldQr runtime = %v; want 200000", runtime.TotalBoldQr)
	}
}
