package services

import (
	"math"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// El egreso real a ALTIPAL de $89.599 pagado por Bold: Bold descuenta
// además $358,40 de 4×1000.
func TestBoldGMF_CasoAltipal(t *testing.T) {
	if got := BoldGMF(89599); got != 358.4 {
		t.Fatalf("GMF = %v, want 358.4", got)
	}
	if got := WithBoldGMF(89599); got != 89957.4 {
		t.Fatalf("salida Bold = %v, want 89957.4", got)
	}
}

func TestBoldGMF_SinMontoNoCobra(t *testing.T) {
	for _, v := range []float64{0, -100} {
		if got := BoldGMF(v); got != 0 {
			t.Errorf("BoldGMF(%v) = %v, want 0", v, got)
		}
	}
}

func TestWithBoldGMFBucket_SoloBoldYNoMutaOriginal(t *testing.T) {
	in := map[string]float64{"EFECTIVO": 10000, "NEQUI": 5000, "BOLD_QR": 100000}
	out := withBoldGMFBucket(in, 400)
	if out["BOLD_QR"] != 100400 {
		t.Errorf("BOLD_QR = %v, want 100400", out["BOLD_QR"])
	}
	if out["EFECTIVO"] != 10000 || out["NEQUI"] != 5000 {
		t.Errorf("otros canales alterados: %+v", out)
	}
	if in["BOLD_QR"] != 100000 {
		t.Errorf("el mapa original no debe mutarse: %+v", in)
	}
}

// Egreso nuevo (2026-10-25+): el modal guarda el 4×1000 de Bold en TaxAmount
// y ExpenseChannelBuckets ya lo suma a BOLD_QR. Egreso viejo sin TaxAmount:
// boldGMFNotRecorded completa el 4×1000. Ninguno lo paga dos veces.
func TestBoldGMF_EgresoNuevoConImpuestoYViejoSinImpuesto(t *testing.T) {
	nuevo := models.Expense{Amount: 200000, TaxAmount: 800, BoldQrAmount: 200000, PaymentSource: "BOLD_QR", Status: "PAID", Category: "Proveedores"}
	viejo := models.Expense{Amount: 89599, BoldQrAmount: 89599, PaymentSource: "BOLD_QR", Status: "PAID", Category: "Proveedores"}
	exps := []models.Expense{nuevo, viejo}

	buckets := ExpenseChannelBuckets(exps)
	missing := boldGMFNotRecorded(exps)
	got := buckets["BOLD_QR"] + missing
	want := 200000 + 800 + 89599 + 358.4
	if math.Abs(got-want) > 0.01 {
		t.Fatalf("salida Bold = %v (buckets %v + faltante %v), want %v", got, buckets["BOLD_QR"], missing, want)
	}
}

// Mixto Nequi + Bold: cada canal carga su propio 4×1000.
func TestParseExpenseChannels_MixtoNequiBoldReparteImpuesto(t *testing.T) {
	e := models.Expense{Amount: 30000, TaxAmount: 120, NequiAmount: 10000, BoldQrAmount: 20000,
		PaymentSource: "NEQUI: $10000 / BOLD_QR: $20000", Status: "PAID", Category: "Proveedores"}
	ch := parseExpenseChannelsFull(&e)
	if ch.Nequi != 10040 || ch.BoldQR != 20080 {
		t.Fatalf("nequi=%v bold=%v, want 10040 / 20080", ch.Nequi, ch.BoldQR)
	}
}
