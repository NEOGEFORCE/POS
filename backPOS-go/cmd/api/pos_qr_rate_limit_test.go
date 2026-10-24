package main

import (
	"os"
	"regexp"
	"testing"
)

// El grupo /pos/pagos-qr llegó a devolver 429 en /iniciar en operación
// normal, con el límite de 20/min, por el polling de la bandeja y las
// reconexiones SSE. Este test impide volver a ese valor.
func TestPosQrRateLimitNoBloqueaOperacionNormal(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	re := regexp.MustCompile(`posQr := protected\.Group\("/pos/pagos-qr"\)\s*\n\s*posQr\.Use\(middlewares\.RateLimitMiddleware\(120, 2\)\)`)
	if !re.Match(src) {
		t.Fatal("el grupo /pos/pagos-qr debe usar RateLimitMiddleware(120, 2)")
	}
}
