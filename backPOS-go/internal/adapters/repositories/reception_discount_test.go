package repositories

import (
	"math"
	"testing"
)

// =============================================================
// Regla del negocio: el COSTO capturado en la recepción es el precio
// NETO ya pagado en la factura. El DTO % del proveedor NO se le resta;
// es un beneficio que se traslada al PVP subiendo el margen.
// =============================================================

func almostEq(t *testing.T, got, want float64, label string) {
	t.Helper()
	if math.Abs(got-want) > 0.5 {
		t.Errorf("%s: got %.2f, want %.2f", label, got, want)
	}
}

// costoEntrada replica el cálculo de costo de la recepción
// (postgres_product_inventory.go): impuestos SÍ suman, descuento NO resta.
func costoEntrada(base, iva, icui, ibua float64) float64 {
	return base + iva + icui + ibua
}

// pvpSugerido replica la fórmula del front (ReceptionRow.calculatePVP):
// margen total = GAN % + DTO %.
func pvpSugerido(costoNeto, ganPct, dtoPct float64) float64 {
	return costoNeto * (1 + (ganPct+dtoPct)/100)
}

func TestDescuentoNoDisminuyeElCosto(t *testing.T) {
	// Caso del dueño: costo neto pagado $1.331, sin impuestos.
	const costo = 1331.0

	got := costoEntrada(costo, 0, 0, 0)
	almostEq(t, got, 1331, "el costo debe quedar intacto")

	// Con la fórmula anterior (restaba 12%) daba $1.171: perdía dinero.
	if got <= 1171.5 {
		t.Errorf("el descuento sigue restándose al costo: %.2f", got)
	}
}

func TestDescuentoSeSumaAlMargenDelPVP(t *testing.T) {
	// COSTO = 1.331, GAN = 20%, DTO = 12% -> margen total 32%
	const costo, gan, dto = 1331.0, 20.0, 12.0

	pvp := pvpSugerido(costo, gan, dto)
	almostEq(t, pvp, 1757, "PVP con margen total del 32%")

	// Debe ser MAYOR que el PVP sin descuento (solo 20%).
	sinDto := pvpSugerido(costo, gan, 0)
	almostEq(t, sinDto, 1597, "PVP solo con GAN 20%")
	if pvp <= sinDto {
		t.Error("el descuento debe SUBIR el precio al público, no bajarlo")
	}

	// La ganancia real que muestra el badge = (PVP / costo) - 1 = 32%
	margenReal := (pvp/costo - 1) * 100
	almostEq(t, margenReal, 32, "GANANCIA REAL % del badge")
}

func TestImpuestosSiSumanAlCosto(t *testing.T) {
	// El DTO no resta, pero IVA/ICUI/IBUA sí deben sumar al costo.
	base := 1000.0
	iva := base * 0.19
	got := costoEntrada(base, iva, 0, 0)
	almostEq(t, got, 1190, "costo con IVA del 19%")

	// Y el PVP se calcula sobre ese costo con impuestos.
	almostEq(t, pvpSugerido(got, 20, 12), 1570.8, "PVP sobre costo con impuestos")
}

func TestSinDescuentoElComportamientoNoCambia(t *testing.T) {
	// Regresión: sin DTO el resultado debe ser el clásico costo * (1+GAN).
	almostEq(t, pvpSugerido(2000, 30, 0), 2600, "PVP sin descuento")
	almostEq(t, costoEntrada(2000, 0, 0, 0), 2000, "costo sin descuento")
}
