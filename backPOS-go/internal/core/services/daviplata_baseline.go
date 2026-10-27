package services

import (
	"log"
	"time"
)

// =========================================================================
// Saldo Daviplata con punto de partida fijo
// =========================================================================
//
// El dueño confirmó el saldo real de la cuenta Daviplata el 2026-10-27 a las
// 08:19 (hora Colombia): $341.915 (corte anterior: 2026-10-26 13:29, $311.055). Desde entonces el saldo del dashboard es
//
//	DaviplataBaselineAmount + (ventas Daviplata + abonos Daviplata
//	                           − egresos Daviplata) desde DaviplataBaselineAt
//
// Así las ventas anteriores al corte (ya incluidas en el saldo real) no se
// vuelven a sumar, y no se crea ninguna venta ni egreso de ajuste.

// DaviplataBaselineAmount es el saldo real confirmado en el corte.
const DaviplataBaselineAmount = 341915.0

// DaviplataBaselineAt es el instante del corte.
var DaviplataBaselineAt = time.Date(2026, time.October, 27, 8, 19, 0, 0, time.FixedZone("America/Bogota", -5*60*60))

type daviplataNetSource interface {
	DaviplataNetSince(since time.Time) (float64, error)
}

// daviplataBaselineBalance calcula el saldo Daviplata desde el corte. Si el
// repositorio no lo soporta o la consulta falla, devuelve ok=false y el
// dashboard conserva el cálculo histórico.
func daviplataBaselineBalance(repo interface{}) (float64, bool) {
	src, ok := repo.(daviplataNetSource)
	if !ok {
		return 0, false
	}
	net, err := src.DaviplataNetSince(DaviplataBaselineAt)
	if err != nil {
		log.Printf("[Dashboard] saldo Daviplata desde el corte falló: %v", err)
		return 0, false
	}
	return DaviplataBaselineAmount + net, true
}
