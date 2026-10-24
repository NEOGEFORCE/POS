package services

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// =============================================================================
// B3 — TotalLiquidity debe incluir saldoBoldQrReal
// =============================================================================
//
// Antes del fix la liquidez total del dashboard sumaba sólo bóveda +
// saldoNequiReal + saldoDaviplataReal. Al ignorar el saldo real de Bold QR,
// cada vez que había plata entrada vía QR que todavía no se trasladaba a
// otro bolsillo la métrica subestimaba cuánta plata hay disponible.
//
// No es trivial correr GetOverview en test unitario (depende de muchos
// repos), así que esta prueba es una aserción textual sobre el código: la
// línea de TotalLiquidity debe mencionar `saldoBoldQrReal`. Es la misma
// técnica que el proyecto usa en otros tests "guardian" para asegurar que
// un fix sensible no se revierta por descuido.

func TestTotalLiquidityIncluyeSaldoBoldQrReal(t *testing.T) {
	path := filepath.Join("dashboard_service.go")
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no se pudo leer dashboard_service.go: %v", err)
	}

	// Busca la asignación de TotalLiquidity: debe incluir
	// `saldoBoldQrReal` en el mismo renglón o próximo.
	re := regexp.MustCompile(`TotalLiquidity:\s*[^,\n]+`)
	matches := re.FindAll(src, -1)
	if len(matches) == 0 {
		t.Fatalf("no se encontró asignación de TotalLiquidity en dashboard_service.go")
	}
	found := false
	for _, m := range matches {
		if strings.Contains(string(m), "saldoBoldQrReal") {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("TotalLiquidity ya no suma saldoBoldQrReal. Match actual: %q", string(matches[0]))
	}
}
