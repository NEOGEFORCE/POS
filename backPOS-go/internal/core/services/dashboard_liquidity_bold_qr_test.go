package services

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// =============================================================================
// TotalLiquidity sin Bold (2026-10-26)
// =============================================================================
//
// Bold se retiró como canal de cobro: el QR es de Daviplata y sus ventas
// entran al saldo Daviplata. El saldo Bold histórico ya no forma parte de la
// liquidez de la tienda, así que TotalLiquidity = bóveda + Nequi + Daviplata.
// Guardián textual: si alguien vuelve a sumar saldoBoldQrReal, el total
// general se inflaría con plata que ya no se maneja en el POS.

func TestTotalLiquidityNoSumaSaldoBold(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("dashboard_service.go"))
	if err != nil {
		t.Fatalf("no se pudo leer dashboard_service.go: %v", err)
	}
	re := regexp.MustCompile(`TotalLiquidity:\s*[^,\n]+`)
	matches := re.FindAll(src, -1)
	if len(matches) == 0 {
		t.Fatalf("no se encontró asignación de TotalLiquidity")
	}
	for _, m := range matches {
		s := string(m)
		if strings.Contains(s, "saldoBoldQrReal") {
			t.Fatalf("TotalLiquidity no debe sumar el saldo Bold: %q", s)
		}
		if !strings.Contains(s, "saldoDaviplataReal") {
			t.Fatalf("TotalLiquidity debe incluir Daviplata: %q", s)
		}
	}
}
