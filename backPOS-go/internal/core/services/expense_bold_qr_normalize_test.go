package services

import (
	"errors"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================================
// B4 — Normalización y validación de egresos Bold QR
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

func TestValidateAndNormalizeBoldQRExpense_RechazaBoldConSlash(t *testing.T) {
	// Un PaymentSource compuesto que mezcla Bold con otros canales por
	// texto DEBE rechazarse: no hay columna física para desglosar.
	cases := []string{
		"BOLD_QR / CAJA: $50000",
		"CAJA: $20000 / BOLD_QR: $30000",
		"BOLD QR/NEQUI",
	}
	for _, src := range cases {
		e := &models.Expense{PaymentSource: src}
		err := validateAndNormalizeBoldQRExpense(e)
		if err == nil {
			t.Errorf("payload mixto %q no fue rechazado", src)
			continue
		}
		if !errors.Is(err, errBoldQrNoCombinable) {
			t.Errorf("payload %q devolvió error %q; want %q", src, err, errBoldQrNoCombinable)
		}
	}
}

func TestValidateAndNormalizeBoldQRExpense_RechazaBoldConColumnas(t *testing.T) {
	cases := []struct {
		name string
		exp  models.Expense
	}{
		{"BOLD + cash", models.Expense{PaymentSource: "BOLD_QR", CashAmount: 10_000}},
		{"BOLD + nequi", models.Expense{PaymentSource: "BOLD_QR", NequiAmount: 20_000}},
		{"BOLD + davi", models.Expense{PaymentSource: "BOLD_QR", DaviplataAmount: 5_000}},
		{"BOLD + fondo", models.Expense{PaymentSource: "bold_qr", FondoAmount: 15_000}},
		{"BOLD + coins", models.Expense{PaymentSource: "BOLD-QR", CoinsAmount: 2_000}},
	}
	for _, c := range cases {
		e := c.exp
		err := validateAndNormalizeBoldQRExpense(&e)
		if err == nil {
			t.Errorf("caso %q: no fue rechazado (%+v)", c.name, e)
			continue
		}
		if !errors.Is(err, errBoldQrNoCombinable) {
			t.Errorf("caso %q: error %q; want %q", c.name, err, errBoldQrNoCombinable)
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
	// Las columnas desglosadas se mantienen en cero: la "evidencia" de
	// que el canal es Bold QR vive en el texto, no en una columna.
	if e.CashAmount != 0 || e.NequiAmount != 0 || e.DaviplataAmount != 0 ||
		e.FondoAmount != 0 || e.CoinsAmount != 0 {
		t.Fatalf("columnas desglosadas tocadas: %+v", e)
	}
}

func TestValidateAndNormalizeBoldQRExpense_NilExpense(t *testing.T) {
	if err := validateAndNormalizeBoldQRExpense(nil); err != nil {
		t.Fatalf("nil: devolvió error inesperado: %v", err)
	}
}

// Mensaje en español exacto: el frontend lo muestra tal cual al usuario.
func TestValidateAndNormalizeBoldQRExpense_MensajeEnEspanol(t *testing.T) {
	e := &models.Expense{PaymentSource: "BOLD_QR", CashAmount: 10}
	err := validateAndNormalizeBoldQRExpense(e)
	if err == nil {
		t.Fatal("esperaba error")
	}
	want := "Bold QR no se puede combinar con otros medios de pago"
	if err.Error() != want {
		t.Fatalf("mensaje = %q; want %q", err.Error(), want)
	}
}
