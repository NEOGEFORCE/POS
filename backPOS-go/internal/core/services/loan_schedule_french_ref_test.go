package services

import (
	"math"
	"testing"
)

// TestFrenchReferenceInstallmentExactValue imprime el valor numérico
// exacto que calcula math.Pow para el caso de referencia del dueño,
// como ancla documental. No falla; sirve de testigo.
func TestFrenchReferenceInstallmentExactValue(t *testing.T) {
	ea := 0.213
	iM := math.Pow(1+ea, 1.0/12.0) - 1
	n := 60
	P := 25_000_000.0
	onePlusIpowN := math.Pow(1+iM, float64(n))
	cuota := P * iM * onePlusIpowN / (onePlusIpowN - 1)
	t.Logf("i_m exacto = %.9f (≈%.4f%% mensual)", iM, iM*100)
	t.Logf("(1+i)^60   = %.9f", onePlusIpowN)
	t.Logf("cuota base = %.4f COP (redondeada: %.2f)", cuota, math.Round(cuota*100)/100)
}
