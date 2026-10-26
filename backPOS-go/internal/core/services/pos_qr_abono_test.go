package services

import (
	"testing"

	"backPOS-go/internal/core/domain/models"
)

func TestSnapshotAbonoClientDNI(t *testing.T) {
	cases := []struct {
		totals string
		want   string
	}{
		{`{"totalAmount":20000,"transferAmount":20000,"abonoClientDni":"1122334455"}`, "1122334455"},
		{`{"totalAmount":20000,"abonoClientDni":"  77  "}`, "77"},
		{`{"totalAmount":20000,"abonoClientDni":"0"}`, ""},
		{`{"totalAmount":20000}`, ""},
		{``, ""},
		{`no json`, ""},
	}
	for _, c := range cases {
		got := snapshotAbonoClientDNI(&models.QrPaymentIntent{TotalsSnapshot: c.totals})
		if got != c.want {
			t.Errorf("%q → %q, want %q", c.totals, got, c.want)
		}
	}
	if snapshotAbonoClientDNI(nil) != "" {
		t.Error("nil intent debe dar vacío")
	}
}

// Un abono por QR nunca debe pasar por buildSaleFromSnapshots: el
// materializador lo desvía antes. Guardián textual del orden.
func TestDispatchAutoSale_DesviaAbonoAntesDeConstruirVenta(t *testing.T) {
	src, err := readFile("pos_qr_async_dispatcher.go")
	if err != nil {
		t.Fatal(err)
	}
	abono := indexOf(src, "snapshotAbonoClientDNI(claimed)")
	build := indexOf(src, "buildSaleFromSnapshots(claimed)")
	if abono < 0 || build < 0 || abono > build {
		t.Fatalf("el desvío de abono debe ir antes de buildSaleFromSnapshots (abono=%d build=%d)", abono, build)
	}
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
