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

// =============================================================================
// Regresión: magnitudes físicas separadas por espacio del número.
//
// Antes del fix, `CREMA DENTAL ... X 58 ML` devolvía 58 como multiplicador
// porque el detector sólo miraba letras PEGADAS al número y, al ver un
// espacio tras el 58, caía al return permisivo. Con el fix, el detector
// hace lookahead a la siguiente palabra y, si está en packRejectSuffixes
// (unidades de medida/presentación: ml, l, g, gr, grs, kg, mg, …), descarta
// el candidato — igual que si estuviera pegado.
//
// Estos tests son la red crítica: documentan los ejemplos exactos del
// usuario y variantes de mayúsculas/espaciado para evitar que gramajes y
// volúmenes se interpreten como cientos de unidades.
// =============================================================================

func TestDetectPackMultiplier_GramajeVolumenConEspacio(t *testing.T) {
	t.Parallel()
	// Todos estos nombres deben devolver 0: el número tras la 'X' es una
	// presentación física (ml, g, gr, grs, kg, mg, cc, oz, l), no un
	// multiplicador de empaque.
	cases := []struct {
		name string
		in   string
	}{
		// Ejemplos textuales reportados por el usuario.
		{"crema dental X 58 ML", "CREMA DENTAL COLGATE X 58 ML"},
		{"detergente X 450 GRS", "DETERGENTE BLANCOX X 450 GRS"},

		// Volumen (ml, L, cl, cc, oz).
		{"X 500 ML", "AGUA X 500 ML"},
		{"X 350 ML (bebida)", "BEBIDA ENERGIZANTE X 350 ML"},
		{"X 1000 ML aceite", "ACEITE X 1000 ML"},
		{"X 350 CC", "BEBIDA X 350 CC"},
		{"X 500 cl minúscula", "jugo X 500 cl"},
		{"X 12 OZ", "COCA COLA X 12 OZ"},

		// Peso (g, gr, grs, mg, kg).
		{"X 500 G", "JABON X 500 G"},
		{"X 500 GR", "ARROZ X 500 GR"},
		{"X 100 GR galleta", "GALLETAS X 100 GR"},
		{"X 125 G yogurt", "YOGURT X 125 G"},
		{"X 1 KG arroz", "ARROZ X 1 KG"},
		{"X 500 MG pastilla", "PASTILLA X 500 MG"},
		{"X 50 GRAMOS", "SNACK X 50 GRAMOS"},
		{"X 2 KILOS", "DETERGENTE X 2 KILOS"},

		// Longitud lineal (cm, mm, m, pulg).
		{"X 50 CM", "CINTA X 50 CM"},
		{"X 10 MM", "CORDEL X 10 MM"},
		{"X 5 M", "MANGUERA X 5 M"},

		// Mayúsculas/minúsculas y espacios múltiples.
		{"X 58 ml minúsculas", "crema x 58 ml"},
		{"X  58  ML doble espacio", "CREMA X  58  ML"},
		{"X\t58\tML tab", "CREMA X\t58\tML"},
		{"X 58 ML. con punto final", "CREMA X 58 ML."},
		{"X 450 Grs mixto", "DETERGENTE X 450 Grs"},

		// Marcador '*' con gramaje separado por espacio (poco común, pero
		// el fix lo cubre también).
		{"CAP* 58 ML", "CAP* 58 ML"},
		{"CAP * 450 GRS", "CAP * 450 GRS"},
		{"DP× 500 ML", "DP× 500 ML"},

		// NBSP entre número y unidad: debe tratarse como espacio normal.
		{"X 58\u00A0ML con NBSP", "CREMA X 58\u00A0ML"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			got := DetectPackMultiplier(c.in)
			if got != 0 {
				t.Fatalf("DetectPackMultiplier(%q) = %d, se esperaba 0 (gramaje/volumen)", c.in, got)
			}
		})
	}
}

// Regresión: empaques REALES con unidad pack separada por espacio tras el
// número. El lookahead debe CONFIRMAR estos casos (equivalente al sufijo
// pegado CAP*24UN) devolviendo el multiplicador. Antes del fix funcionaba
// por el camino "palabra desconocida → return n permisivo", y debe seguir
// funcionando ahora por el camino explícito "palabra en packUnitSuffixes".
func TestDetectPackMultiplier_PackUnidadSeparadaConservada(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   string
		want int
	}{
		{"CAP X 24 UN", "CAP X 24 UN", 24},
		{"CAP x 24 UND", "CAP x 24 UND", 24},
		{"CAP X 12 UNDS", "CAP X 12 UNDS", 12},
		{"CAP X 24 UNID", "CAP X 24 UNID", 24},
		{"CAP X 24 UNIDS", "CAP X 24 UNIDS", 24},
		{"CAP X 24 U", "CAP X 24 U", 24},
		{"PACK X 6", "PACK X 6", 6},
		{"PACK X 6 UN", "PACK X 6 UN", 6},
		{"con asterisco separado", "DP * 18 UN", 18},
		{"con equis Unicode separada", "DP × 24 UND", 24},
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

// Regresión: palabra tras el número que NO es ni unidad pack ni magnitud
// física. El detector mantiene el comportamiento permisivo histórico y
// devuelve el número — romperlo rompería empaques descritos con el nombre
// del contenido ("CAP X 24 CAJAS", "CAP X 24 BOTELLAS") que funcionaban
// antes del fix.
func TestDetectPackMultiplier_PalabraDesconocidaSeMantienePermisiva(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   string
		want int
	}{
		{"CAP X 24 CAJAS", "CAP X 24 CAJAS", 24},
		{"PAQUETE X 24 BOTELLAS", "COCA COLA PAQUETE X 24 BOTELLAS", 24},
		{"CAP X 6 LATAS", "CAP X 6 LATAS", 6},
		{"CAP X 12 BOLSAS", "CAP X 12 BOLSAS", 12},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			got := DetectPackMultiplier(c.in)
			if got != c.want {
				t.Fatalf("DetectPackMultiplier(%q) = %d, want %d (palabra desconocida: comportamiento permisivo)", c.in, got, c.want)
			}
		})
	}
}

// Regresión: números fuera del rango seguro con gramaje. Se verifica que
// el filtro de rango sigue cortando ANTES del lookahead y que para
// mayor-que-999 el detector devuelve 0 sin ambigüedad (aunque el lookahead
// también lo haría por su cuenta, defensa en profundidad).
func TestDetectPackMultiplier_GramajeFueraDeRangoSigueSiendo0(t *testing.T) {
	t.Parallel()
	cases := []string{
		"COCA COLA X 1 L",   // 1 < 2 (bajo rango)
		"ACEITE X 1000 ML",  // 1000 > 999 (sobre rango)
		"ACEITE X 1500 GR",  // 1500 > 999
		"ACEITE X 2000 ML",  // 2000 > 999
		"PASTILLA X 500 MG", // dentro de rango pero MG → rechazo
		"ARROZ X 999 GR",    // borde superior pero GR → rechazo
	}
	for _, in := range cases {
		in := in
		t.Run(in, func(t *testing.T) {
			t.Parallel()
			if got := DetectPackMultiplier(in); got != 0 {
				t.Fatalf("DetectPackMultiplier(%q) = %d, se esperaba 0", in, got)
			}
		})
	}
}

// Regresión conservadora: ante ambigüedad, prevalece el falso negativo.
// Un nombre que mezcla gramaje y potencial pack ("X 58 ML X 24 UN") debería
// quedar en 0 porque el PRIMER marcador 'X' encuentra "58 ML" y lo descarta
// correctamente. El segundo marcador 'X 24 UN' SÍ cuenta como pack real.
func TestDetectPackMultiplier_PrioridadFalsoNegativoSobreFalsoPositivo(t *testing.T) {
	t.Parallel()
	// Si tras rechazar el primer candidato (gramaje) aparece un pack
	// legítimo más adelante en el nombre, el detector lo encuentra porque
	// el `continue` sigue iterando sobre los runes buscando el siguiente
	// marcador del mismo tipo. Esto está bien: priorizamos NO perder packs
	// reales explícitos, siempre que el candidato previo sea gramaje
	// INEQUÍVOCO.
	cases := []struct {
		name string
		in   string
		want int
	}{
		// Gramaje primero, pack real después: debe encontrar el pack real.
		{"gramaje + pack real", "CREMA X 58 ML X 24 UN", 24},
		{"volumen + pack real", "GASEOSA X 350 ML X 6 UND", 6},

		// Sólo gramaje: 0 (sin falso positivo).
		{"sólo gramaje", "CREMA X 58 ML", 0},
		{"sólo gramaje con punto", "CREMA X 58 ML.", 0},
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
