package services

import "testing"

func TestApplyRoundingKeepsHistoricRule(t *testing.T) {
	cases := map[float64]float64{
		524:   500,
		525:   600,
		537:   600,
		1200:  1200,
		15220: 15200,
		15230: 15300,
	}
	for input, want := range cases {
		if got := applyRounding(input); got != want {
			t.Fatalf("applyRounding(%v) = %v, want %v", input, got, want)
		}
	}
}

func TestNormalizeManualSalePricePreservesFiftyEndings(t *testing.T) {
	if got := normalizeManualSalePrice(550); got != 550 {
		t.Fatalf("normalizeManualSalePrice(550) = %v, want 550", got)
	}
	if got := normalizeManualSalePrice(15250); got != 15250 {
		t.Fatalf("normalizeManualSalePrice(15250) = %v, want 15250", got)
	}
	if got := normalizeManualSalePrice(537); got != 600 {
		t.Fatalf("normalizeManualSalePrice(537) = %v, want 600", got)
	}
	if got := normalizeManualSalePrice(0); got != 0 {
		t.Fatalf("normalizeManualSalePrice(0) = %v, want 0", got)
	}
}

func TestRoundSaleLineSubtotalRespectsFiftyPrices(t *testing.T) {
	cases := []struct {
		price float64
		qty   float64
		want  float64
	}{
		{price: 550, qty: 1, want: 550},
		{price: 550, qty: 2, want: 1100},
		{price: 550, qty: 12, want: 6600},
		{price: 1200, qty: 1, want: 1200},
		{price: 1200, qty: 3, want: 3600},
		{price: 12300, qty: 0.5, want: 6200},
		{price: 550, qty: 0, want: 0},
	}
	for _, test := range cases {
		if got := roundSaleLineSubtotal(test.price, test.qty); got != test.want {
			t.Fatalf("roundSaleLineSubtotal(%v, %v) = %v, want %v", test.price, test.qty, got, test.want)
		}
	}
}
