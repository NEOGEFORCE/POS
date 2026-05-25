package utils

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// NormalizeString convierte un texto a MAYÚSCULAS y elimina tildes/acentos
// Ejemplo: "Jabón" -> "JABON"
func NormalizeString(s string) string {
	// 1. Convertir a mayúsculas
	s = strings.ToUpper(s)

	// 2. Descomponer caracteres con acentos (NFD)
	nfd := norm.NFD.String(s)

	// 3. Remover diacríticos EXCEPTO la virgulilla de la Ñ (U+0303)
	var result strings.Builder
	for _, r := range nfd {
		if !unicode.Is(unicode.Mn, r) || r == '\u0303' {
			result.WriteRune(r)
		}
	}

	// 4. Regresar a NFC
	return norm.NFC.String(result.String())
}
