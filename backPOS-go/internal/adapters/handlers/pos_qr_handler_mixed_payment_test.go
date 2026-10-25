// Pruebas de la validación B (pago mixto QR + canales en el handler).
//
// `validateQRPaymentBreakdown` chequea tres reglas antes de persistir
// el snapshot del QR:
//
//  1. suma de details.subtotal == totals.totalAmount (±1 COP).
//  2. nequi + daviplata no excede transferAmount.
//  3. cash + nequi + daviplata + credit + qrAmount == totalAmount (±1 COP).
//
// Caso central del sprint: carrito $16.000, parte QR $6.000, resto en
// efectivo $10.000. Hoy el snapshot sólo persiste "totalAmount = QR =
// transferAmount" y se pierde la parte en efectivo; el dispatcher
// falla con "pago insuficiente". La validación atrapa el bug ANTES
// de persistir.

package handlers

import (
	"strings"
	"testing"
)

func TestValidateQRPaymentBreakdown_MixtoQR6kEfectivo10kSobre16k(t *testing.T) {
	// Carrito: 1 producto × $16.000.
	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":16000,"subtotal":16000}]`)
	// Totals: carrito 16k, cash 10k, QR 6k (transferAmount = parte QR).
	totals := []byte(`{
		"totalAmount": 16000,
		"amountPaid": 16000,
		"cashAmount": 10000,
		"transferAmount": 6000,
		"transferNequi": 0,
		"transferDaviplata": 0,
		"creditAmount": 0,
		"transferSource": "BOLD_QR",
		"paymentMethod": "BOLD_QR + EFECTIVO"
	}`)
	// qrAmount = 6000 (lo que se cobra por QR).
	if err := validateQRPaymentBreakdown(totals, cart, 6000); err != nil {
		t.Fatalf("se esperaba OK para mixto 6k+10k=16k, got %v", err)
	}
}

func TestValidateQRPaymentBreakdown_SumaNoCuadra_400(t *testing.T) {
	// Caso del bug original: cart 16k, pero el snapshot sólo trae QR 6k.
	// Después de la validación, debe fallar con mensaje claro.
	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":16000,"subtotal":16000}]`)
	// Totals bug: totalAmount = QR = 6k; cash en 0.
	totals := []byte(`{
		"totalAmount": 6000,
		"cashAmount": 0,
		"transferAmount": 6000,
		"transferNequi": 0,
		"transferDaviplata": 0,
		"creditAmount": 0
	}`)
	err := validateQRPaymentBreakdown(totals, cart, 6000)
	if err == nil {
		t.Fatal("se esperaba error cuando totalAmount no cuadra con details")
	}
	// Primero cae el chequeo (1): suma de details != totalAmount.
	if !strings.Contains(err.Error(), "detalles") {
		t.Errorf("mensaje debe mencionar 'detalles': %v", err)
	}
}

func TestValidateQRPaymentBreakdown_CanalesNoCubrenTotal_400(t *testing.T) {
	// Carrito y totalAmount coherentes, pero canales + QR < total.
	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":16000,"subtotal":16000}]`)
	totals := []byte(`{
		"totalAmount": 16000,
		"cashAmount": 5000,
		"transferAmount": 6000,
		"transferNequi": 0,
		"transferDaviplata": 0,
		"creditAmount": 0
	}`)
	// Suma canales + QR = 5000 + 6000 = 11.000 ≠ 16.000.
	err := validateQRPaymentBreakdown(totals, cart, 6000)
	if err == nil {
		t.Fatal("se esperaba error cuando los canales no cubren el total")
	}
	if !strings.Contains(err.Error(), "pagos no cuadran") {
		t.Errorf("mensaje debe mencionar 'pagos no cuadran': %v", err)
	}
}

func TestValidateQRPaymentBreakdown_NequiMasDaviExcedeTransfer_400(t *testing.T) {
	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":20000,"subtotal":20000}]`)
	// transferAmount declarado 10k pero Nequi+Daviplata suma 15k.
	totals := []byte(`{
		"totalAmount": 20000,
		"cashAmount": 10000,
		"transferAmount": 10000,
		"transferNequi": 8000,
		"transferDaviplata": 7000,
		"creditAmount": 0
	}`)
	err := validateQRPaymentBreakdown(totals, cart, 0)
	if err == nil {
		t.Fatal("se esperaba error cuando Nequi+Daviplata exceden transferAmount")
	}
	if !strings.Contains(err.Error(), "exceden transferAmount") {
		t.Errorf("mensaje debe mencionar 'exceden transferAmount': %v", err)
	}
}

func TestValidateQRPaymentBreakdown_SoloQR_SinDesglose(t *testing.T) {
	// Caso simple: la factura entera se paga por QR.
	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":45800,"subtotal":45800}]`)
	totals := []byte(`{
		"totalAmount": 45800,
		"cashAmount": 0,
		"transferAmount": 45800,
		"transferNequi": 0,
		"transferDaviplata": 0,
		"creditAmount": 0
	}`)
	if err := validateQRPaymentBreakdown(totals, cart, 45800); err != nil {
		t.Fatalf("se esperaba OK para QR puro de 45.800, got %v", err)
	}
}

func TestValidateQRPaymentBreakdown_ToleranciaCentavos(t *testing.T) {
	// Centavos de ruido (0.75 COP de diferencia) → aceptado (±1 COP).
	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":10000.25,"subtotal":10000.25}]`)
	totals := []byte(`{
		"totalAmount": 10000,
		"cashAmount": 10000,
		"transferAmount": 0,
		"transferNequi": 0,
		"transferDaviplata": 0,
		"creditAmount": 0
	}`)
	if err := validateQRPaymentBreakdown(totals, cart, 0); err != nil {
		t.Fatalf("se esperaba tolerancia de 1 COP, got %v", err)
	}
}

func TestValidateQRPaymentBreakdown_TotalsVacio_Error(t *testing.T) {
	if err := validateQRPaymentBreakdown(nil, nil, 1000); err == nil {
		t.Error("totals vacío debe fallar")
	}
	if err := validateQRPaymentBreakdown([]byte("   "), nil, 1000); err == nil {
		t.Error("totals en blanco debe fallar")
	}
}

func TestValidateQRPaymentBreakdown_TotalsInvalido_Error(t *testing.T) {
	if err := validateQRPaymentBreakdown([]byte("x"), nil, 1000); err == nil {
		t.Error("totals no-JSON debe fallar")
	}
}

func TestValidateQRPaymentBreakdown_FiadoMasQR(t *testing.T) {
	// Mitad por QR, mitad al fiado.
	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":20000,"subtotal":20000}]`)
	totals := []byte(`{
		"totalAmount": 20000,
		"cashAmount": 0,
		"transferAmount": 10000,
		"transferNequi": 0,
		"transferDaviplata": 0,
		"creditAmount": 10000
	}`)
	if err := validateQRPaymentBreakdown(totals, cart, 10000); err != nil {
		t.Fatalf("se esperaba OK para 10k QR + 10k fiado = 20k, got %v", err)
	}
}

func TestValidateQRPaymentBreakdown_QRNequiDavi_ConMixtoTransfer(t *testing.T) {
	// Caso compuesto: QR 5k + Nequi 3k + Davi 2k + cash 10k = 20k.
	// transferAmount = Nequi + Daviplata + parte QR = 10k.
	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":20000,"subtotal":20000}]`)
	totals := []byte(`{
		"totalAmount": 20000,
		"cashAmount": 10000,
		"transferAmount": 10000,
		"transferNequi": 3000,
		"transferDaviplata": 2000,
		"creditAmount": 0
	}`)
	if err := validateQRPaymentBreakdown(totals, cart, 5000); err != nil {
		t.Fatalf("se esperaba OK para cash 10k + Nequi 3k + Davi 2k + QR 5k = 20k, got %v", err)
	}
}

// La parte QR declarada (transferAmount - nequi - davi) debe ser el monto
// de la intención: el emparejamiento por monto usa `monto`.
func TestValidateQRPaymentBreakdown_ParteQRDistintaDelMonto_400(t *testing.T) {
	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":16000,"subtotal":16000}]`)
	// Canales suman 16k, pero la parte QR del snapshot es 6k y el cobro
	// QR se abrió por 16k.
	totals := []byte(`{"totalAmount":16000,"cashAmount":0,"transferAmount":6000,"creditAmount":10000}`)
	err := validateQRPaymentBreakdown(totals, cart, 16000)
	if err == nil {
		t.Fatal("se esperaba error: la parte QR no coincide con el monto")
	}
}

func TestValidateQRPaymentBreakdown_MontosNegativos_400(t *testing.T) {
	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":6000,"subtotal":6000}]`)
	totals := []byte(`{"totalAmount":6000,"cashAmount":-1000,"transferAmount":7000}`)
	if err := validateQRPaymentBreakdown(totals, cart, 7000); err == nil || !strings.Contains(err.Error(), "negativos") {
		t.Fatalf("se esperaba rechazo por negativos, got %v", err)
	}
}

// Caso real 30.600 por QR + 200 en efectivo sobre factura de 30.800.
func TestValidateQRPaymentBreakdown_Caso30600QRMas200Efectivo(t *testing.T) {
	cart := []byte(`[{"barcode":"A","quantity":1,"unitPrice":30800,"subtotal":30800}]`)
	totals := []byte(`{"totalAmount":30800,"cashAmount":200,"transferAmount":30600,"transferSource":"BOLD_QR"}`)
	if err := validateQRPaymentBreakdown(totals, cart, 30600); err != nil {
		t.Fatalf("30.600 QR + 200 efectivo = 30.800 debe aceptarse: %v", err)
	}
}

func TestExtractEditSaleIDFromTotals(t *testing.T) {
	cases := []struct {
		in      string
		want    uint64
		wantErr bool
	}{
		{``, 0, false},
		{`{"totalAmount":1}`, 0, false},
		{`{"editSaleId":500}`, 500, false},
		{`{"editSaleId":0}`, 0, true},
		{`{"editSaleId":-3}`, 0, true},
		{`{"editSaleId":1.5}`, 0, true},
		{`{"editSaleId":"abc"}`, 0, true},
	}
	for _, c := range cases {
		got, err := extractEditSaleIDFromTotals([]byte(c.in))
		if (err != nil) != c.wantErr || got != c.want {
			t.Errorf("in=%s → (%d, %v), want (%d, err=%v)", c.in, got, err, c.want, c.wantErr)
		}
	}
}

// El frontend manda el sale_payload PLANO; editSaleId debe sobrevivir al
// armado del totals snapshot que lee el dispatcher.
func TestExtractQRSnapshotsFromPayload_ConservaEditSaleIdPlano(t *testing.T) {
	raw := []byte(`{"details":[{"barcode":"A","quantity":1,"unitPrice":16000,"subtotal":16000}],
		"totalAmount":16000,"cashAmount":10000,"transferAmount":6000,"transferNequi":0,
		"transferDaviplata":0,"creditAmount":0,"transferSource":"BOLD_QR","editSaleId":500}`)
	snaps, err := extractQRSnapshotsFromPayload(raw, "", "")
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	id, err := extractEditSaleIDFromTotals(snaps.Totals)
	if err != nil || id != 500 {
		t.Fatalf("editSaleId perdido en totals: id=%d err=%v totals=%s", id, err, snaps.Totals)
	}
	if err := validateQRPaymentBreakdown(snaps.Totals, snaps.Cart, 6000); err != nil {
		t.Fatalf("mixto 6k QR + 10k efectivo debe validar: %v", err)
	}
	// editSaleId negativo en el payload plano → JSON inválido para uint64.
	bad := []byte(`{"details":[{"barcode":"A","quantity":1,"unitPrice":1,"subtotal":1}],"editSaleId":-1}`)
	if _, err := extractQRSnapshotsFromPayload(bad, "", ""); err == nil {
		t.Error("editSaleId negativo debe rechazarse")
	}
}
