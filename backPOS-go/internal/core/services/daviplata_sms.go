package services

import (
	"regexp"
	"strings"
)

// =========================================================================
// SMS de Daviplata (remitente 85888)
// =========================================================================
//
// Desde 2026-10-26 la tienda cobra por QR y llave Bre-B de Daviplata (Bold
// se retiró por el 4×1000). El celular reenvía por el puente los SMS del
// 85888. Formatos reales observados:
//
//	"Recibio un pago con codigo QR en su Daviplata por  13,600."
//	"Recibiste  76,500. Para saber mas, consulta tus movimientos."   (llave)
//
// Se IGNORAN los demás SMS del 85888, en particular las salidas:
//
//	"DaviPlata: acabas de hacer una compra por PSE de  220,500. ..."
//
// El monto no lleva "$" y usa coma de miles. La notificación de la app
// Daviplata no trae monto y no se usa.

// DaviplataSMSSender es el código corto de Daviplata.
const DaviplataSMSSender = "85888"

var (
	daviQRPaymentRe  = regexp.MustCompile(`recibio un pago con codigo qr en su daviplata por\s+([\d.,]+)`)
	daviKeyPaymentRe = regexp.MustCompile(`^\s*(?:daviplata:\s*)?recibiste\s+(?:\$\s*)?([\d.,]+)`)
	accentReplacer   = strings.NewReplacer("á", "a", "é", "e", "í", "i", "ó", "o", "ú", "u", "ü", "u", "ñ", "n")
)

// isDaviplataSender reporta si el remitente es el código corto de Daviplata.
func isDaviplataSender(sender string) bool {
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, sender)
	return digits == DaviplataSMSSender
}

// normalizeDaviText pasa a minúsculas, quita tildes y colapsa espacios.
func normalizeDaviText(text string) string {
	t := accentReplacer.Replace(strings.ToLower(text))
	return strings.Join(strings.Fields(t), " ")
}

// extractDaviplataPayment devuelve (monto, tipo, ok). tipo es "QR" o "LLAVE".
// Sólo reconoce pagos RECIBIDOS; cualquier otro SMS devuelve ok=false.
func extractDaviplataPayment(text string) (int64, string, bool) {
	t := normalizeDaviText(text)
	if t == "" {
		return 0, "", false
	}
	for _, n := range copMessageNegators {
		if strings.Contains(t, n) {
			return 0, "", false
		}
	}
	if strings.Contains(t, "compra por pse") || strings.Contains(t, "acabas de hacer") {
		return 0, "", false
	}
	kind := ""
	var m []string
	if m = daviQRPaymentRe.FindStringSubmatch(t); m != nil {
		kind = "QR"
	} else if m = daviKeyPaymentRe.FindStringSubmatch(t); m != nil {
		kind = "LLAVE"
	} else {
		return 0, "", false
	}
	token := strings.TrimRight(m[1], ".,")
	amount, ok := parseCOPToken(token)
	if !ok {
		return 0, "", false
	}
	return amount, kind, true
}
