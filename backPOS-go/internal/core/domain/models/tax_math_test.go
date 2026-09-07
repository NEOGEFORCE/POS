package models

import (
	"math"
	"testing"
)

func eq(t *testing.T, got, want float64, label string) {
	t.Helper()
	if math.Abs(got-want) > 0.01 {
		t.Errorf("%s = %.4f; want %.4f", label, got, want)
	}
}

// TestGrossFromNet_EsAditiva fija la fórmula canónica. Es la que ve el operador
// en la pantalla de recepción y la que exige reception_discount_test.go.
func TestGrossFromNet_EsAditiva(t *testing.T) {
	casos := []struct {
		nombre string
		net    float64
		rates  TaxRates
		want   float64
	}{
		{"sin impuestos", 1000, TaxRates{}, 1000},
		{"IVA 19", 1000, TaxRates{IvaPct: 19}, 1190},
		{"IVA 5", 2000, TaxRates{IvaPct: 5}, 2100},
		{"IBUA 10 sola", 1000, TaxRates{IbuaPct: 10}, 1100},
		{"ICUI 8 solo", 1000, TaxRates{IcuiPct: 8}, 1080},
		// El caso que separaba las dos fórmulas del proyecto.
		{"IVA 19 + IBUA 10", 1000, TaxRates{IvaPct: 19, IbuaPct: 10}, 1290},
		{"los tres", 1000, TaxRates{IvaPct: 19, IcuiPct: 8, IbuaPct: 10}, 1370},
		{"base cero", 0, TaxRates{IvaPct: 19}, 0},
	}
	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			eq(t, GrossFromNet(c.net, c.rates), c.want, "GrossFromNet")
		})
	}
}

// TestNoEsMultiplicativa es el guardián del bug: si alguien "arregla" la
// fórmula encadenando factores, este test lo detecta. Con IVA 19% + IBUA 10%
// la multiplicativa da 1.309 y la aditiva 1.290.
func TestNoEsMultiplicativa(t *testing.T) {
	rates := TaxRates{IvaPct: 19, IbuaPct: 10}
	aditiva := GrossFromNet(1000, rates)
	multiplicativa := 1000 * 1.19 * 1.10

	eq(t, aditiva, 1290, "aditiva")
	if math.Abs(aditiva-multiplicativa) < 1 {
		t.Fatal("el test perdió su poder: las dos fórmulas ya no se distinguen")
	}
	if math.Abs(aditiva-multiplicativa) > 25 {
		t.Errorf("separación esperada ~19 pesos, got %.2f", math.Abs(aditiva-multiplicativa))
	}
}

// TestNetFromGross_EsInversaExacta: aplicar ida y vuelta tiene que devolver el
// valor original. La mezcla anterior de aditiva y multiplicativa no lo cumplía,
// así que el lector de facturas y la recepción llegaban a costos distintos para
// la misma factura.
func TestNetFromGross_EsInversaExacta(t *testing.T) {
	rates := []TaxRates{
		{},
		{IvaPct: 19},
		{IvaPct: 5, IbuaPct: 10},
		{IvaPct: 19, IcuiPct: 8, IbuaPct: 10},
	}
	for _, r := range rates {
		for _, net := range []float64{1, 1000, 1331, 87654.32} {
			gross := GrossFromNet(net, r)
			vuelta := NetFromGross(gross, r)
			if math.Abs(vuelta-net) > 0.0001 {
				t.Errorf("ida y vuelta con %+v sobre %.2f dio %.6f", r, net, vuelta)
			}
		}
	}
}

// TestTaxAmounts_SumanExactamenteElBruto: los montos por impuesto se usan para
// la trazabilidad de la factura, así que no pueden dejar residuo contra el total.
func TestTaxAmounts_SumanExactamenteElBruto(t *testing.T) {
	rates := TaxRates{IvaPct: 19, IcuiPct: 8, IbuaPct: 10}
	net := 1234.56

	iva, icui, ibua := TaxAmounts(net, rates)
	eq(t, net+iva+icui+ibua, GrossFromNet(net, rates), "base + montos vs bruto")
	eq(t, iva, 234.5664, "monto de IVA")
}

// TestRatesFromAmounts_ReconstruyeLosPorcentajes cubre el bug de la ruta
// receive-stock: llegaban montos y se guardaban como si fueran tasas.
func TestRatesFromAmounts_ReconstruyeLosPorcentajes(t *testing.T) {
	// $1.000 de base con $190 de IVA es 19%, no 190%.
	r := RatesFromAmounts(1000, 190, 0, 0)
	eq(t, r.IvaPct, 19, "IVA deducido")
	eq(t, r.IcuiPct, 0, "ICUI deducido")

	r2 := RatesFromAmounts(1000, 190, 80, 100)
	eq(t, r2.IvaPct, 19, "IVA")
	eq(t, r2.IcuiPct, 8, "ICUI")
	eq(t, r2.IbuaPct, 10, "IBUA")

	// Ida y vuelta: montos -> tasas -> bruto debe coincidir.
	eq(t, GrossFromNet(1000, r2), 1370, "bruto reconstruido")

	// Sin base no se puede deducir tasa: preferimos cero antes que inventarla.
	vacio := RatesFromAmounts(0, 190, 0, 0)
	if !vacio.IsZero() {
		t.Errorf("con base 0 no hay tasa deducible; got %+v", vacio)
	}
}

// TestFactor_NoConvierteDatoCorruptoEnDescuento: un porcentaje negativo en la
// base sería un dato corrupto; no puede terminar rebajando el costo.
func TestFactor_NoConvierteDatoCorruptoEnDescuento(t *testing.T) {
	eq(t, TaxRates{IvaPct: -19}.Factor(), 1, "factor con tasa negativa")
	eq(t, GrossFromNet(1000, TaxRates{IvaPct: -19}), 1000, "costo con tasa negativa")
	eq(t, TaxRates{}.Factor(), 1, "factor sin impuestos")
}

// TestElDescuentoNoEntraEnLaMatematicaDeImpuestos documenta la frontera: el DTO
// del proveedor no se modela acá porque por regla de negocio no toca el costo.
func TestElDescuentoNoEntraEnLaMatematicaDeImpuestos(t *testing.T) {
	// Caso del dueño en reception_discount_test.go: costo 1331 sin impuestos.
	eq(t, GrossFromNet(1331, TaxRates{}), 1331, "costo intacto sin impuestos")
	// Y con IVA sólo suma el impuesto, nunca resta un descuento.
	eq(t, GrossFromNet(1000, TaxRates{IvaPct: 19}), 1190, "costo con IVA 19%")
}
