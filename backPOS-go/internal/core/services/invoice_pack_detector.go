package services

import (
	"strconv"
	"strings"
)

// =============================================================================
// Detector determinista de multiplicadores de empaque en nombres de factura.
//
// Regla de negocio: la recepción OCR debe trabajar SIEMPRE en unidades
// individuales. Pero los proveedores suelen escribir el nombre con un
// multiplicador ya pegado al empaque — "CAP*20", "DP*18 9GR", "CAP*24UN" —
// y la cantidad numérica de la factura hace referencia a esos empaques,
// no a las unidades sueltas.
//
// Este detector es un paso de LECTURA pura: encuentra el multiplicador y lo
// expone en PackHintUnits/RequiresPackConfirmation. NO toca cantidades,
// precios ni totales; la UI confirma con el operador antes de convertir.
//
// Lo que SÍ se reconoce (en orden de preferencia):
//
//  1. Marcador '*' o '×' (asterisco o signo matemático de multiplicación):
//     siempre que vaya precedido de ≥1 letra (opcional espacio) y seguido
//     de 1..3 dígitos. Son símbolos no-léxicos: no aparecen en pesos ni
//     volúmenes, así que su presencia es evidencia clara del patrón.
//
//  2. Marcador 'x' o 'X' SÓLO cuando esté flanqueado por espacios por
//     AMBOS lados ("CAP X 24", "CAP x 24"). Pegado a palabras ("FOX25") no
//     cuenta: la letra equis aparece en marcas y abreviaciones y daría
//     falsos positivos indeseables.
//
// Lo que se RECHAZA en todos los casos:
//
//   - Número seguido inmediatamente por G, GR, GRS, GRAMOS, KG, ML, L, LT,
//     LTS, LITROS, OZ, CM, MM, CC: es magnitud física, no multiplicador.
//     Esta regla aplica tanto a sufijos PEGADOS al número ("CAP*18GR") como
//     a sufijos SEPARADOS POR ESPACIO ("X 58 ML", "X 450 GRS") — en facturas
//     el proveedor escribe la presentación con y sin espacio indistintamente
//     y ambos casos son gramaje/volumen, nunca empaque.
//   - Número seguido por '%': es un porcentaje.
//   - Número fuera del rango seguro 2..999.
//   - Marcador en el inicio del nombre o sin letras precediéndolo.
//
// Si el nombre trae varios candidatos (p. ej. "CAP*20 DP*24") se devuelve
// el primero en orden de lectura. La UI puede corregirlo manualmente antes
// de confirmar.
// =============================================================================

const (
	packMultiplierMin = 2
	packMultiplierMax = 999
)

// packUnitSuffixes son los sufijos permitidos tras los dígitos y que
// CONFIRMAN que el número es un multiplicador de empaque: "CAP*24UN",
// "CAP*24UND". Son unidades contables, no magnitudes físicas.
var packUnitSuffixes = map[string]struct{}{
	"UN":    {},
	"UND":   {},
	"UNDS":  {},
	"UNID":  {},
	"UNIDS": {},
	"U":     {},
}

// packRejectSuffixes son los sufijos tras los dígitos que REVELAN que el
// número NO es un multiplicador sino una magnitud física (peso/volumen,
// medidas lineales). Se mantiene en minúsculas; la comparación es
// case-insensitive.
//
// Importante: la lista debe cubrir TODO alias que aparezca en las facturas
// colombianas. Un faltante causa un falso positivo que la UI pediría al
// operador confirmar como pack.
var packRejectSuffixes = map[string]struct{}{
	"G":       {},
	"GR":      {},
	"GRS":     {},
	"GRAMO":   {},
	"GRAMOS":  {},
	"MG":      {},
	"KG":      {},
	"KGS":     {},
	"KILO":    {},
	"KILOS":   {},
	"ML":      {},
	"L":       {},
	"LT":      {},
	"LTS":     {},
	"LITRO":   {},
	"LITROS":  {},
	"CL":      {},
	"OZ":      {},
	"CM":      {},
	"MM":      {},
	"M":       {},
	"CC":      {},
	"PULG":    {},
	"PULGADA": {},
}

// DetectPackMultiplier devuelve el multiplicador de empaque reconocido en el
// nombre de la factura. Devuelve 0 cuando no hay un marcador claro.
//
// Es una función PURA: no toca estado, no mira el contexto fuera del string,
// no asume locale. Está testeada con una matriz grande de casos positivos y
// negativos (ver invoice_pack_detector_test.go).
func DetectPackMultiplier(name string) int {
	// 1. Primero intentamos los marcadores no ambiguos ('*' y '×').
	for _, marker := range []rune{'*', '×'} {
		if n := findPackByMarker(name, marker, false); n > 0 {
			return n
		}
	}
	// 2. Luego 'x'/'X' pero exigiendo espacios a ambos lados.
	for _, marker := range []rune{'x', 'X'} {
		if n := findPackByMarker(name, marker, true); n > 0 {
			return n
		}
	}
	return 0
}

// findPackByMarker localiza la primera ocurrencia del rune `marker` cuyo
// contexto (lo que lo rodea en el string) cumple la regla de multiplicador.
//
//	requireWhitespace=true  → 'x'/'X': exige espacio a ambos lados.
//	requireWhitespace=false → '*'/'×': no exige espacio.
//
// Devuelve 0 si no hay un match válido en todo el string.
func findPackByMarker(name string, marker rune, requireWhitespace bool) int {
	runes := []rune(name)
	for i, r := range runes {
		if r != marker {
			continue
		}

		// --- Contexto izquierdo: debe haber al menos una letra precediendo. ---
		leftIdx := i - 1
		sawSpaceLeft := false
		for leftIdx >= 0 && isSpace(runes[leftIdx]) {
			sawSpaceLeft = true
			leftIdx--
		}
		if leftIdx < 0 {
			continue // marcador al inicio
		}
		if !isAlphaRune(runes[leftIdx]) {
			continue // antes del marcador no hay una palabra (sería ruido)
		}
		if requireWhitespace && !sawSpaceLeft {
			continue
		}

		// --- Contexto derecho: espacios opcionales + dígitos. ---
		rightIdx := i + 1
		sawSpaceRight := false
		for rightIdx < len(runes) && isSpace(runes[rightIdx]) {
			sawSpaceRight = true
			rightIdx++
		}
		if rightIdx >= len(runes) {
			continue
		}
		if requireWhitespace && !sawSpaceRight {
			continue
		}

		// --- Parseo de los dígitos: 1..3 dígitos consecutivos. ---
		digitStart := rightIdx
		for rightIdx < len(runes) && isDigit(runes[rightIdx]) {
			rightIdx++
		}
		if rightIdx == digitStart {
			continue
		}
		digitLen := rightIdx - digitStart
		if digitLen > 3 {
			// > 3 dígitos excede el rango seguro: posible código, barcode o
			// precio concatenado. Ignoramos la coincidencia.
			continue
		}
		// Si el dígito siguiente es un separador decimal, también lo
		// descartamos: "CAP*2.5L" no es un pack de 2 unidades sino un
		// volumen de 2,5 litros.
		if rightIdx < len(runes) {
			nx := runes[rightIdx]
			if nx == '.' || nx == ',' {
				continue
			}
		}

		n, err := strconv.Atoi(string(runes[digitStart:rightIdx]))
		if err != nil {
			continue
		}
		if n < packMultiplierMin || n > packMultiplierMax {
			continue
		}

		// --- Rechazo por sufijo físico / porcentaje adyacente. ---
		if rightIdx < len(runes) && runes[rightIdx] == '%' {
			continue
		}

		// Fase 1 — Sufijo PEGADO (sin espacio): recoger letras inmediatamente
		// adyacentes al número. Si existen y NO son una unidad de empaque
		// conocida, descartamos el candidato: "DP*18 9GR" → "9GR" NO es
		// candidato porque "9" no tiene marcador precediendo; "CAP*18GR" sí
		// sería rechazado aquí (GR tras los dígitos).
		suffixStart := rightIdx
		for rightIdx < len(runes) && isAlphaRune(runes[rightIdx]) {
			rightIdx++
		}
		if rightIdx > suffixStart {
			suffix := strings.ToUpper(string(runes[suffixStart:rightIdx]))
			if _, isPack := packUnitSuffixes[suffix]; isPack {
				return n
			}
			if _, isReject := packRejectSuffixes[suffix]; isReject {
				continue
			}
			// Sufijo desconocido tras los dígitos: para evitar falsos
			// positivos (por ejemplo brands que escriban "*24X" con una
			// letra arbitraria), descartamos el candidato. La regla
			// explícita del requisito es "no confundir códigos".
			continue
		}

		// Fase 2 — Sufijo SEPARADO POR ESPACIO (lookahead): protege contra
		// "CREMA ... X 58 ML" o "DETERGENTE ... X 450 GRS" donde el proveedor
		// escribe la presentación (ml/g/kg/…) con un espacio entre el número
		// y la unidad. El detector antes devolvía 58/450 como multiplicador y
		// la UI pedía confirmar un pack inexistente. Si la siguiente palabra
		// (saltando espacios) está en packRejectSuffixes, se descarta el
		// candidato. Si está en packUnitSuffixes, se confirma. Si es
		// desconocida (p. ej. "CAP X 24 CAJAS"), se mantiene la decisión
		// permisiva actual (return n) para no romper empaques reales.
		//
		// IMPORTANTE: este bloque sólo corre cuando NO había letras pegadas
		// al número (rightIdx == suffixStart). Si había letras pegadas, ya se
		// decidió arriba y nunca llegamos aquí.
		lookIdx := rightIdx
		for lookIdx < len(runes) && isSpace(runes[lookIdx]) {
			lookIdx++
		}
		wordStart := lookIdx
		for lookIdx < len(runes) && isAlphaRune(runes[lookIdx]) {
			lookIdx++
		}
		if lookIdx > wordStart {
			word := strings.ToUpper(string(runes[wordStart:lookIdx]))
			if _, isReject := packRejectSuffixes[word]; isReject {
				continue // magnitud física separada por espacio → NO es pack
			}
			if _, isPack := packUnitSuffixes[word]; isPack {
				return n // "CAP X 24 UN" / "CAP X 24 UND" → pack confirmado
			}
			// Palabra desconocida: mantener comportamiento permisivo actual.
		}

		return n
	}
	return 0
}

// isSpace cubre espacios ASCII y el espacio no-rompible común en facturas.
func isSpace(r rune) bool {
	switch r {
	case ' ', '\t', '\u00A0':
		return true
	}
	return false
}

// isDigit es ASCII puro — los números de factura siempre vienen en dígitos
// occidentales.
func isDigit(r rune) bool {
	return r >= '0' && r <= '9'
}

// isAlphaRune cubre letras ASCII y los acentos/eñe comunes en español.
// Se mantiene local al detector para evitar depender de unicode.IsLetter,
// que incluiría ideogramas y símbolos extraños que no deben contar como
// "letra" para la regla de multiplicador.
func isAlphaRune(r rune) bool {
	if r >= 'a' && r <= 'z' {
		return true
	}
	if r >= 'A' && r <= 'Z' {
		return true
	}
	switch r {
	case 'ñ', 'Ñ',
		'á', 'é', 'í', 'ó', 'ú',
		'Á', 'É', 'Í', 'Ó', 'Ú',
		'ü', 'Ü':
		return true
	}
	return false
}
