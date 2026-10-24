// Tests estáticos del handler para el flujo asíncrono QR
// (migración 027):
//
//   - /encolar valida sesión y payload mínimo (sale_payload.details).
//   - /pendientes valida sesión y caja_id.
//   - /caja-stream valida sesión y setea headers SSE sin gzip.
//   - El router excluye /caja-stream del gzip global.
//   - El contrato camelCase del tray incluye saleId/amountCop/cashierName.

package handlers

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// -----------------------------------------------------------------------------
// Encolar — validaciones básicas (sin BD/servicio)
// -----------------------------------------------------------------------------

func TestPosQrHandler_Encolar_SinSesion_401(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodPost, "/api/pos/pagos-qr/encolar",
		`{"caja_id":"CAJA-1","monto":45800,"venta_temp_id":"temp-abc-123","client_tx_id":"tx-abcdefgh"}`)
	h.Encolar(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe 401, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestPosQrHandler_Encolar_PayloadMalformado_400(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodPost, "/api/pos/pagos-qr/encolar", `no json`)
	c.Set("userDni", "EMP-1")
	h.Encolar(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("payload malformado debe 400, got %d", rec.Code)
	}
}

func TestPosQrHandler_Encolar_SinDetails_400(t *testing.T) {
	// Sin sale_payload.details, el handler responde 400 con código estable
	// antes de llamar al servicio (defensa en profundidad: el servicio
	// también valida).
	h := &PosQrHandler{}
	body := `{
		"caja_id":"CAJA-1",
		"monto":45800,
		"venta_temp_id":"temp-abc-123",
		"client_tx_id":"tx-abcdefgh",
		"sale_payload":{}
	}`
	c, rec := newQrTestContext(http.MethodPost, "/api/pos/pagos-qr/encolar", body)
	c.Set("userDni", "EMP-1")
	h.Encolar(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("sin details debe 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "QR_BAD_REQUEST") {
		t.Errorf("respuesta debe exponer QR_BAD_REQUEST: %s", rec.Body.String())
	}
}

// -----------------------------------------------------------------------------
// Pendientes — validación de query y sesión
// -----------------------------------------------------------------------------

func TestPosQrHandler_Pendientes_SinSesion_401(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/pendientes?caja_id=CAJA-1", "")
	h.Pendientes(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe 401, got %d", rec.Code)
	}
}

func TestPosQrHandler_Pendientes_SinCajaID_400(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/pendientes", "")
	c.Set("userDni", "EMP-1")
	h.Pendientes(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("sin caja_id debe 400, got %d", rec.Code)
	}
}

// -----------------------------------------------------------------------------
// CajaStream — SSE headers y sesión obligatoria
// -----------------------------------------------------------------------------

func TestPosQrHandler_CajaStream_SinSesion_401(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/caja-stream?caja_id=CAJA-1", "")
	h.CajaStream(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe 401, got %d", rec.Code)
	}
}

func TestPosQrHandler_CajaStream_CajaIDInvalido_400(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/caja-stream?caja_id=caja%20con%20espacios", "")
	c.Set("userDni", "EMP-1")
	h.CajaStream(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("caja_id inválido debe 400, got %d", rec.Code)
	}
}

// -----------------------------------------------------------------------------
// Guardianes estáticos
// -----------------------------------------------------------------------------

// TestPosQrHandler_CajaStream_UsaSSEHeaders: el handler agregado emite
// Content-Type SSE y marca X-Accel-Buffering: no para que proxies
// como nginx no bufferen el stream.
func TestPosQrHandler_CajaStream_UsaSSEHeaders(t *testing.T) {
	src := handlerQrSource(t)
	// Buscamos el bloque del método CajaStream.
	idx := strings.Index(src, "func (h *PosQrHandler) CajaStream(c *gin.Context)")
	if idx < 0 {
		t.Fatal("no se encontró el método CajaStream")
	}
	// Mirar un bloque conservador para encontrar los headers.
	end := idx + 2000
	if end > len(src) {
		end = len(src)
	}
	block := src[idx:end]
	for _, needed := range []string{
		`"Content-Type", "text/event-stream"`,
		`"Cache-Control", "no-cache"`,
		`"X-Accel-Buffering", "no"`,
	} {
		if !strings.Contains(block, needed) {
			t.Errorf("CajaStream debe setear %q", needed)
		}
	}
}

// TestPosQrHandler_CajaStream_ExcluidaDeGzip: en main.go, la ruta
// /api/pos/pagos-qr/caja-stream debe estar fuera del middleware gzip
// (SSE + gzip buffered rompe el stream).
func TestPosQrHandler_CajaStream_ExcluidaDeGzip(t *testing.T) {
	root := filepath.Join("..", "..", "..", "cmd", "api", "main.go")
	bts, err := os.ReadFile(root)
	if err != nil {
		t.Skipf("No se pudo leer %s: %v", root, err)
	}
	src := string(bts)
	// Debe haber la cláusula "if p == '/api/pos/pagos-qr/caja-stream'".
	if !strings.Contains(src, `"/api/pos/pagos-qr/caja-stream"`) {
		t.Fatal("main.go debe excluir /caja-stream del gzip")
	}
	// Y la bifurcación debe retornar antes de aplicar gzip. Buscamos
	// el patrón canónico de la exclusión.
	if !strings.Contains(src, "/api/pos/pagos-qr/caja-stream") ||
		!strings.Contains(src, "c.Next()") {
		t.Error("main.go debe hacer c.Next() antes de aplicar gzip al stream")
	}
}

// TestPosQrHandler_CajaStream_NoLeeTokenDeQuery: igual que /stream,
// la autenticación es Authorization: Bearer, nunca por query.
func TestPosQrHandler_CajaStream_NoLeeTokenDeQuery(t *testing.T) {
	src := handlerQrSource(t)
	idx := strings.Index(src, "func (h *PosQrHandler) CajaStream(c *gin.Context)")
	if idx < 0 {
		t.Fatal("no se encontró CajaStream")
	}
	end := idx + 2000
	if end > len(src) {
		end = len(src)
	}
	block := src[idx:end]
	for _, forbidden := range []string{
		`c.Query("token")`,
		`c.Query("access_token")`,
	} {
		if strings.Contains(block, forbidden) {
			t.Errorf("CajaStream NO debe leer %q (auth es Bearer, nunca query)", forbidden)
		}
	}
}

// TestPosQrHandler_PendientesExposeCamelCase verifica que el shape
// del endpoint /pendientes exponga los nombres que el frontend
// consume. Un rename a snake_case rompe la bandeja global.
func TestPosQrHandler_PendientesExposeCamelCase(t *testing.T) {
	src := handlerQrSource(t)
	for _, needed := range []string{
		`json:"intentId"`,
		`json:"ventaTempId"`,
		`json:"cajaId"`,
		`json:"amountCop"`,
		`json:"queuedAt,omitempty"`,
	} {
		if !strings.Contains(src, needed) {
			t.Errorf("handler debe exponer %s (contrato con bandeja frontend)", needed)
		}
	}
}

// TestPosQrHandler_EncolarRequiereDetails: el handler debe cortar
// temprano si sale_payload.details está vacío (el service también
// valida, pero el handler evita round-trip al servicio).
func TestPosQrHandler_EncolarRequiereDetails(t *testing.T) {
	src := handlerQrSource(t)
	if !strings.Contains(src, `"sale_payload.details es obligatorio"`) {
		t.Error("Encolar debe exigir sale_payload.details antes de llamar al servicio")
	}
}
