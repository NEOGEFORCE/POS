package services

import (
	"strings"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================================
// Normalización y validación de egresos BOLD_QR tras la migración 028
//
// Antes de la 028 el canal BOLD_QR vivía SÓLO como texto en `paymentSource`
// y cualquier combinación con otro canal se rechazaba porque no había
// bolsillo físico donde desglosarlo. La migración 028 agregó
// `expenses.bold_qr_amount DECIMAL(10,2) NOT NULL DEFAULT 0`, por lo que:
//
//   - Bold puro ("BOLD_QR", "bold-qr", "BOLDQR"…) se NORMALIZA al valor
//     canónico `BOLD_QR` para que los agregadores agrupen bajo la misma
//     clave.
//   - Bold MIXTO ya es válido: el string compuesto se preserva y
//     `parsePaymentSourceAmounts` reparte cada token en su bolsillo
//     físico (incluyendo `bold_qr_amount`).
//   - La invariante numérica se protege con `validateExpenseChannelSum`:
//     la suma de los seis bolsillos no puede exceder `amount+tax_amount`
//     más una tolerancia pequeña (±$5 COP por redondeos).
// =============================================================================

func TestValidateAndNormalizeBoldQRExpense_PasaCuandoNoHayBold(t *testing.T) {
	e := &models.Expense{PaymentSource: "CAJA", CashAmount: 100_000}
	if err := validateAndNormalizeBoldQRExpense(e); err != nil {
		t.Fatalf("egreso sin marca BOLD devolvió error: %v", err)
	}
	if e.PaymentSource != "CAJA" {
		t.Fatalf("PaymentSource mutado sin marca BOLD: %q", e.PaymentSource)
	}
}

func TestValidateAndNormalizeBoldQRExpense_NormalizaVariantes(t *testing.T) {
	cases := []string{"BOLD_QR", "bold_qr", "BoldQR", "BOLD-QR", "BOLD QR", "BOLD_QR_BRE_B", "  BOLD_QR  "}
	for _, src := range cases {
		e := &models.Expense{PaymentSource: src}
		if err := validateAndNormalizeBoldQRExpense(e); err != nil {
			t.Errorf("variante %q devolvió error inesperado: %v", src, err)
			continue
		}
		if e.PaymentSource != models.PaymentSourceBoldQR {
			t.Errorf("variante %q no normalizó a %q (quedó %q)", src, models.PaymentSourceBoldQR, e.PaymentSource)
		}
	}
}

// B2 (2026-10-24): Antes la función rechazaba cualquier `paymentSource`
// con "/" que mencionara BOLD. Con la migración 028 ese caso ya es válido:
// el string compuesto se preserva y el parser reparte los tokens entre
// los bolsillos físicos.
func TestValidateAndNormalizeBoldQRExpense_PreservaPaymentSourceCompuesto(t *testing.T) {
	cases := []string{
		"BOLD_QR / CAJA: $50000",
		"CAJA: $20000 / BOLD_QR: $30000",
		"BOLD QR/NEQUI",
	}
	for _, src := range cases {
		e := &models.Expense{PaymentSource: src}
		if err := validateAndNormalizeBoldQRExpense(e); err != nil {
			t.Errorf("payload mixto %q fue rechazado: %v", src, err)
			continue
		}
		// El string compuesto se CONSERVA tal cual (incluidos los dos
		// puntos y los montos) para que parsePaymentSourceAmounts pueda
		// reconstruir el reparto por tokens.
		if e.PaymentSource != src {
			t.Errorf("payload mixto %q fue mutado a %q", src, e.PaymentSource)
		}
	}
}

// B2 (2026-10-24): El payload Bold+columna ya es válido tras la 028. La
// función ya no rechaza por tener BoldQrAmount>0 o columnas desglosadas
// junto a BOLD; se limita a normalizar el `paymentSource`.
func TestValidateAndNormalizeBoldQRExpense_PermiteBoldConColumnas(t *testing.T) {
	cases := []struct {
		name string
		exp  models.Expense
	}{
		{"BOLD + cash", models.Expense{PaymentSource: "BOLD_QR", CashAmount: 10_000, BoldQrAmount: 20_000, Amount: 30_000}},
		{"BOLD + nequi", models.Expense{PaymentSource: "BOLD_QR", NequiAmount: 20_000, BoldQrAmount: 10_000, Amount: 30_000}},
		{"BOLD + fondo", models.Expense{PaymentSource: "bold_qr", FondoAmount: 15_000, BoldQrAmount: 5_000, Amount: 20_000}},
	}
	for _, c := range cases {
		e := c.exp
		if err := validateAndNormalizeBoldQRExpense(&e); err != nil {
			t.Errorf("caso %q: fue rechazado %v (%+v)", c.name, err, e)
			continue
		}
		if e.PaymentSource != models.PaymentSourceBoldQR {
			t.Errorf("caso %q: PaymentSource = %q; want %q", c.name, e.PaymentSource, models.PaymentSourceBoldQR)
		}
	}
}

func TestValidateAndNormalizeBoldQRExpense_BoldPuroNoTocaColumnas(t *testing.T) {
	e := &models.Expense{PaymentSource: "bold_qr", Amount: 45_000}
	if err := validateAndNormalizeBoldQRExpense(e); err != nil {
		t.Fatalf("Bold QR puro devolvió error: %v", err)
	}
	if e.PaymentSource != models.PaymentSourceBoldQR {
		t.Fatalf("PaymentSource = %q; want %q", e.PaymentSource, models.PaymentSourceBoldQR)
	}
	// Las columnas desglosadas se mantienen en cero: el reparto a
	// BoldQrAmount lo hace parsePaymentSourceAmounts, no esta función.
	if e.CashAmount != 0 || e.NequiAmount != 0 || e.DaviplataAmount != 0 ||
		e.FondoAmount != 0 || e.CoinsAmount != 0 || e.BoldQrAmount != 0 {
		t.Fatalf("columnas desglosadas tocadas por el normalizador: %+v", e)
	}
}

func TestValidateAndNormalizeBoldQRExpense_NilExpense(t *testing.T) {
	if err := validateAndNormalizeBoldQRExpense(nil); err != nil {
		t.Fatalf("nil: devolvió error inesperado: %v", err)
	}
}

// =============================================================================
// validateExpenseChannelSum: invariante de suma post-reparto
// =============================================================================

func TestValidateExpenseChannelSum_NilEgreso(t *testing.T) {
	if err := validateExpenseChannelSum(nil); err != nil {
		t.Fatalf("nil devolvió error: %v", err)
	}
}

func TestValidateExpenseChannelSum_TodoCero(t *testing.T) {
	e := &models.Expense{Status: "PAID", Amount: 10_000}
	if err := validateExpenseChannelSum(e); err != nil {
		t.Fatalf("sin desglose devolvió error: %v", err)
	}
}

func TestValidateExpenseChannelSum_CuadraExacto(t *testing.T) {
	e := &models.Expense{
		Status:       "PAID",
		Amount:       30_000,
		NequiAmount:  20_000,
		BoldQrAmount: 10_000,
	}
	if err := validateExpenseChannelSum(e); err != nil {
		t.Fatalf("suma exacta rechazada: %v", err)
	}
}

func TestValidateExpenseChannelSum_ToleranciaCOP(t *testing.T) {
	// $5 por encima del total (tolerancia) está permitido.
	e := &models.Expense{
		Status:       "PAID",
		Amount:       30_000,
		NequiAmount:  20_000,
		BoldQrAmount: 10_005,
	}
	if err := validateExpenseChannelSum(e); err != nil {
		t.Fatalf("diferencia dentro de tolerancia rechazada: %v", err)
	}
}

func TestValidateExpenseChannelSum_ExcedeMontoFalla(t *testing.T) {
	// Payload malicioso: Nequi + BOLD_QR duplican el monto. Debe rechazar.
	e := &models.Expense{
		Status:       "PAID",
		Amount:       30_000,
		NequiAmount:  20_000,
		BoldQrAmount: 20_000, // 40_000 > 30_000 + 5
	}
	err := validateExpenseChannelSum(e)
	if err == nil {
		t.Fatal("suma 40k vs monto 30k no fue rechazada")
	}
	if !strings.Contains(err.Error(), "suma") {
		t.Fatalf("mensaje inesperado: %q", err.Error())
	}
}

func TestValidateExpenseChannelSum_IncluyeTaxAmount(t *testing.T) {
	// amount=30k + tax=120 → total=30120. Suma de 30120 debe cuadrar.
	e := &models.Expense{
		Status:       "PAID",
		Amount:       30_000,
		TaxAmount:    120,
		NequiAmount:  20_000,
		BoldQrAmount: 10_120,
	}
	if err := validateExpenseChannelSum(e); err != nil {
		t.Fatalf("suma incluyendo tax rechazada: %v", err)
	}
}

func TestValidateExpenseChannelSum_PendingNoValida(t *testing.T) {
	// Un egreso PENDING puede tener columnas en 0 incluso con amount>0;
	// no corresponde validar porque la plata todavía no salió.
	e := &models.Expense{
		Status:       "PENDING",
		Amount:       30_000,
		CashAmount:   20_000,
		BoldQrAmount: 50_000, // disparate si validara, pero no aplica
	}
	if err := validateExpenseChannelSum(e); err != nil {
		t.Fatalf("PENDING devolvió error: %v", err)
	}
}

func TestValidateExpenseChannelSum_PrestamoNoValida(t *testing.T) {
	e := &models.Expense{
		Status:        "PAID",
		Amount:        30_000,
		PaymentSource: "PRESTAMO",
		CashAmount:    50_000, // residuo heredado, no debería existir
	}
	if err := validateExpenseChannelSum(e); err != nil {
		t.Fatalf("PRESTAMO devolvió error: %v", err)
	}
}
