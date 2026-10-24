package models

import "testing"

// Centinela sobre IsBoldQRPaymentSource: cualquier cambio en el helper
// debe demostrar que sigue reconociendo las variantes reales del canal
// Bold QR / Bre-B que viajan desde el frontend y el materializador
// asíncrono (pos_qr_async_dispatcher.go). Mismo patrón que el centinela
// de IsLoanFundedPaymentSource.

func TestIsBoldQRPaymentSource(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		// Variantes aceptadas.
		{"BOLD_QR", true},
		{"bold_qr", true},
		{"bold-qr", true},
		{"bold qr", true},
		{"BOLDQR", true},
		{"  BOLD_QR  ", true},
		{"BOLD_QR_BRE_B", true},
		{"QR_BOLD", true},
		{"PAGO BOLD", true},

		// Rechazos.
		{"", false},
		{"NEQUI", false},
		{"DAVIPLATA", false},
		{"EFECTIVO", false},
		{"CAJA", false},
		{"FONDO", false},
		{"ALCANCIA", false},
		{"PRESTAMO", false},
		{"PREST.", false},
		// "QR" solitario sin la marca "BOLD" no es Bold QR: cubre
		// descripciones como "código QR del banco X".
		{"QR", false},
		{"codigo QR del banco", false},
	}
	for _, c := range cases {
		if got := IsBoldQRPaymentSource(c.in); got != c.want {
			t.Errorf("IsBoldQRPaymentSource(%q) = %v; want %v", c.in, got, c.want)
		}
	}
}

func TestIsBoldQRSaleTransferSource_EspejoDePaymentSource(t *testing.T) {
	// IsBoldQRSaleTransferSource existe como alias semántico para que el
	// lector sepa que aplica al campo `sales.transferSource`. Ambos helpers
	// deben compartir reglas: si divergen, el canal se contaría distinto en
	// ventas y en egresos.
	inputs := []string{"BOLD_QR", "bold qr", "NEQUI", "QR", ""}
	for _, s := range inputs {
		if IsBoldQRPaymentSource(s) != IsBoldQRSaleTransferSource(s) {
			t.Errorf("divergencia entre payment y transfer para %q: ambos deben coincidir", s)
		}
	}
}
