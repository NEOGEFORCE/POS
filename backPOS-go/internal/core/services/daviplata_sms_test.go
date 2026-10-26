package services

import "testing"

// SMS reales del 85888 (capturas del dueño, 2026-10-26).
func TestExtractDaviplataPayment_SMSReales(t *testing.T) {
	cases := []struct {
		text   string
		amount int64
		kind   string
		ok     bool
	}{
		{"Recibio un pago con codigo QR en su Daviplata por  13,600.", 13600, "QR", true},
		{"Recibio un pago con codigo QR en su Daviplata por  100.", 100, "QR", true},
		{"Recibió un pago con código QR en su DaviPlata por 33,600.", 33600, "QR", true},
		{"Recibiste  76,500. Para saber mas, consulta tus movimientos.", 76500, "LLAVE", true},
		{"Recibiste  200. Para saber mas, consulta tus movimientos.", 200, "LLAVE", true},
		{"DaviPlata: acabas de hacer una compra por PSE de  220,500. Para saber mas, consulta tus movimientos desde la app DaviPlata.", 0, "", false},
		{"Transaccion exitosa: Recibiste una compra por Codigo QR, consulta tus movimientos desde el app DaviPlata.", 0, "", false},
		{"Su pago fue rechazado por 10,000.", 0, "", false},
		{"", 0, "", false},
	}
	for _, c := range cases {
		amount, kind, ok := extractDaviplataPayment(c.text)
		if ok != c.ok || amount != c.amount || kind != c.kind {
			t.Errorf("%q → (%d, %q, %v), want (%d, %q, %v)", c.text, amount, kind, ok, c.amount, c.kind, c.ok)
		}
	}
}

func TestIsDaviplataSender(t *testing.T) {
	for _, s := range []string{"85888", " 85888 ", "+85888"} {
		if !isDaviplataSender(s) {
			t.Errorf("%q debe ser Daviplata", s)
		}
	}
	for _, s := range []string{"", "890412", "3001234567", "858880"} {
		if isDaviplataSender(s) {
			t.Errorf("%q NO debe ser Daviplata", s)
		}
	}
}
