package utils

import (
	"strings"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

// RemoveAccents elimina tildes y normaliza a mayúsculas
// Ej: "CAFÉ" -> "CAFE", "ñ" -> "n"
func RemoveAccents(s string) string {
	t := transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)
	result, _, _ := transform.String(t, s)
	// Reemplazar específicamente la ñ si el transform no la maneja como queremos (opcional)
	result = strings.ReplaceAll(result, "ñ", "n")
	result = strings.ReplaceAll(result, "Ñ", "N")
	return strings.ToUpper(strings.TrimSpace(result))
}
