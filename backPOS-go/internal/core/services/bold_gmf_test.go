package services

import "testing"

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
	out := withBoldGMFBucket(in)
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
