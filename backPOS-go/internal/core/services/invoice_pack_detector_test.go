package services

import (
	"testing"
)

// =============================================================================
// Contrato del detector determinista de multiplicadores de empaque.
//
// La función `DetectPackMultiplier` es un paso de LECTURA pura sobre el nombre
// de factura. Devuelve el entero N si reconoce un patrón claro de empaque
// ("CAP*20" → 20, "DP X 24" → 24). Devuelve 0 si no hay patrón claro.
//
// Si cualquiera de estos tests falla, el flujo OCR mandaría a la UI un
// `requiresPackConfirmation` erróneo (falso positivo que confunde al operador,
// falso negativo que silencia una confirmación obligatoria).
// =============================================================================

func TestDetectPackMultiplier_CasosPositivos(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   string
		want int
	}{
		// Marcador '*' pegado a letras y dígitos.
		{"CAP*20", "CAP*20", 20},
		{"CAP*24UN", "CAP*24UN", 24},
		{"CAP*24UND", "CAP*24UND", 24},
		{"CAP*24UNID", "CAP*24UNID", 24},
		{"CAP*24U", "CAP*24U", 24},
		{"DP*18 9GR", "DP*18 9GR", 18}, // 9 NO cuenta, 18 sí
		{"DP*18GR vs otra magnitud", "DP*18 500ML", 18},

		// Marcador '×' Unicode.
		{"CAP×24", "CAP×24", 24},
		{"CAP ×24", "CAP ×24", 24},
		{"CAP× 24 UN", "CAP× 24 UN", 24},

		// Marcador 'x'/'X' con espacios a ambos lados.
		{"CAP X 24", "CAP X 24", 24},
		{"CAP x 24", "CAP x 24", 24},
		{"CAP x 24 UN", "CAP x 24 UN", 24},
		{"GALLETA DIA X 6", "GALLETA DIA X 6", 6},

		// Rango inferior y superior del rango seguro.
		{"borde inferior 2", "CAP*2", 2},
		{"borde superior 999", "CAP*999", 999},

		// Nombres compuestos; se devuelve el primer candidato.
		{"primer candidato gana", "CAP*20 DP*24", 20},

		// Con acentos en el nombre.
		{"ÑAM*24", "ÑAM*24", 24},
		{"café*12", "café*12", 12},

		// Espacios en blanco alrededor del marcador '*'.
		{"CAP * 24", "CAP * 24", 24},
		{"CAP  *  24", "CAP  *  24", 24},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			got := DetectPackMultiplier(c.in)
			if got != c.want {
				t.Fatalf("DetectPackMultiplier(%q) = %d, want %d", c.in, got, c.want)
			}
		})
	}
}

func TestDetectPackMultiplier_CasosNegativos(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   string
	}{
		// Pesos/volúmenes puros, sin marcador.
		{"peso 9GR", "DP 9GR"},
		{"volumen 500ML", "COCA 500ML"},
		{"volumen 1.5L", "COCA 1.5L"},
		{"peso 1KG", "ARROZ 1KG"},
		{"peso 100G", "GALLETAS 100G"},
		{"onzas", "AGUA 12OZ"},
		{"centímetros", "CINTA 50CM"},
		{"miligramos", "PASTILLA 500MG"},

		// Porcentajes.
		{"porcentaje IVA", "DESCUENTO 20%"},
		{"porcentaje descuento", "20%"},

		// 'x'/'X' pegadas a letras — brand, no multiplicador.
		{"brand FOX25", "FOX25"},
		{"brand ONYX2", "ONYX2"},
		{"GALLETAX25 pegado", "GALLETAX25"},
		{"X 25 sin letra previa", "X 25 UND"},
		{"CAPx25 sin espacio izq", "CAPx25"},
		{"CAP x25 sin espacio der", "CAP x25"},

		// Número solo, sin marcador.
		{"solo número", "25"},
		{"palabra 25", "COCA 25"},

		// Marcador al inicio.
		{"inicio *24", "*24"},
		{"inicio ×24", "×24"},

		// Precios con separadores — no son multiplicadores.
		{"precio con punto", "VALOR 1.500"},
		{"precio con coma", "VALOR 1,500"},

		// Códigos largos (barcode).
		{"código largo tras *", "SKU*1234567"},
		{"código 13 dígitos", "7701234567890"},

		// Marcador seguido inmediatamente de decimal.
		{"CAP*2.5L es volumen", "CAP*2.5L"},

		// Marcador con número 0 o 1 (fuera de rango seguro).
		{"CAP*1 fuera de rango", "CAP*1"},
		{"CAP*0 fuera de rango", "CAP*0"},

		// Marcador con número > 999.
		{"CAP*1000 fuera de rango", "CAP*1000"},
		{"CAP*5000 fuera de rango", "CAP*5000"},

		// Sufijo desconocido (ni pack ni físico): rechazamos por conservador.
		{"CAP*24XYZ sufijo raro", "CAP*24XYZ"},

		// Marcador precedido por dígito, no por letra.
		{"12*34 fórmula", "12*34"},
		{"2*5 fórmula al inicio", "2*5"},

		// Vacío y whitespace puro.
		{"vacío", ""},
		{"solo espacios", "   "},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			got := DetectPackMultiplier(c.in)
			if got != 0 {
				t.Fatalf("DetectPackMultiplier(%q) = %d, se esperaba 0 (no pack)", c.in, got)
			}
		})
	}
}

func TestDetectPackMultiplier_NoReaccionaAPorcentajeTrasElNumero(t *testing.T) {
	t.Parallel()
	// Un `%` adyacente al número indica porcentaje — nunca es pack.
	for _, in := range []string{"IVA*19%", "DTO*5%", "CAP*20%"} {
		if got := DetectPackMultiplier(in); got != 0 {
			t.Errorf("DetectPackMultiplier(%q) = %d, se esperaba 0 (porcentaje)", in, got)
		}
	}
}

func TestDetectPackMultiplier_PriorizaAsteriscoSobreX(t *testing.T) {
	t.Parallel()
	// Si una línea trae ambos marcadores, el '*' manda porque es menos
	// ambiguo. El test documenta la precedencia.
	got := DetectPackMultiplier("CAP*20 DP X 24")
	if got != 20 {
		t.Fatalf("primer marcador '*' debe ganar: got %d want 20", got)
	}
}

func TestDetectPackMultiplier_ToleraEspacioNoRompible(t *testing.T) {
	t.Parallel()
	// Algunas facturas vienen con NBSP (U+00A0) alrededor de los números.
	// El detector debe tolerarlo igual que un espacio normal.
	in := "CAP\u00A0*\u00A024"
	if got := DetectPackMultiplier(in); got != 24 {
		t.Fatalf("NBSP debe tratarse como espacio: got %d want 24", got)
	}
}
