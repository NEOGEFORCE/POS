package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"backPOS-go/internal/core/services"

	"github.com/gin-gonic/gin"
)

// =============================================================
// Guardianes del handler ScanInvoice.
//
// Cubren TODAS las validaciones que viven antes de llamar a Claude:
//
//   - 400 cuando falta supplierId.
//   - 400 cuando falta imageBase64.
//   - 400 cuando el mimeType no está entre los aceptados.
//   - 413 cuando el base64 excede MaxInvoiceBase64Chars.
//
// La ruta que llega a Claude (503 cuando no está disponible, 500 en el
// resto) se cubre indirectamente por el guardián de errores sanitizados.
//
// Patrón: handler sin servicio inyectado. Si una ruta llegara a disparar
// h.service.ScanInvoice, el test fallaría con nil-deref — garantía
// adicional de que la validación corta ANTES de la llamada externa.
// =============================================================

func newScanInvoiceContext(t *testing.T, body []byte) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	req := httptest.NewRequest(http.MethodPost, "/api/inventory/scan-invoice", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	c.Request = req
	return c, rec
}

func TestScanInvoice_400_SinSupplierID(t *testing.T) {
	h := &ProductHandler{} // sin service: si falla la validación, el test revienta
	body, _ := json.Marshal(map[string]any{
		"imageBase64": "/9j/4AAQSkZJRg==",
		"mimeType":    "image/jpeg",
		// SupplierID omitido → 0 → 400
	})
	c, rec := newScanInvoiceContext(t, body)
	h.ScanInvoice(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("sin supplierId debe devolver 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "proveedor") {
		t.Errorf("el mensaje debe mencionar proveedor, got %s", rec.Body.String())
	}
}

func TestScanInvoice_400_SinImagen(t *testing.T) {
	h := &ProductHandler{}
	body, _ := json.Marshal(map[string]any{
		"supplierId":  1,
		"mimeType":    "image/jpeg",
		"imageBase64": "   ", // sólo whitespace
	})
	c, rec := newScanInvoiceContext(t, body)
	h.ScanInvoice(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("sin imagen debe devolver 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "imagen") {
		t.Errorf("el mensaje debe mencionar la imagen, got %s", rec.Body.String())
	}
}

func TestScanInvoice_400_MimeNoSoportado(t *testing.T) {
	h := &ProductHandler{}
	body, _ := json.Marshal(map[string]any{
		"supplierId":  1,
		"mimeType":    "application/pdf", // Claude Vision no acepta PDF
		"imageBase64": "aGVsbG8gd29ybGQ=",
	})
	c, rec := newScanInvoiceContext(t, body)
	h.ScanInvoice(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("mime no soportado debe devolver 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "soportado") {
		t.Errorf("mensaje debe explicar formato soportado, got %s", rec.Body.String())
	}
}

func TestScanInvoice_413_Base64DemasiadoGrande(t *testing.T) {
	h := &ProductHandler{}
	// Un string que excede MaxInvoiceBase64Chars POR POCO: 1 byte extra
	// garantiza la rama de validación sin saturar RAM del CI.
	bigImage := strings.Repeat("A", services.MaxInvoiceBase64Chars+1)

	body, _ := json.Marshal(map[string]any{
		"supplierId":  1,
		"mimeType":    "image/jpeg",
		"imageBase64": bigImage,
	})
	c, rec := newScanInvoiceContext(t, body)
	h.ScanInvoice(c)

	// MaxBytesReader puede cortar antes y emitir 413 por la vía del body
	// (si el body excede MaxInvoiceBodyBytes), o la validación explícita
	// del handler puede emitir 413 cuando el base64 excede su propio tope.
	// Ambos casos son 413 por diseño.
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("imagen gigante debe devolver 413, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "grande") && !strings.Contains(rec.Body.String(), "resolución") {
		t.Errorf("mensaje debe sugerir una imagen más pequeña, got %s", rec.Body.String())
	}
}

func TestScanInvoice_400_JSONInvalido(t *testing.T) {
	h := &ProductHandler{}
	c, rec := newScanInvoiceContext(t, []byte("{this is not json"))
	h.ScanInvoice(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("JSON inválido debe devolver 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestScanInvoice_413_BodyExcedeMaxBytesReader(t *testing.T) {
	// Alineado con MaxInvoiceBodyBytes: un body que lo excede dispara
	// http.MaxBytesReader → "request body too large" → 413. Esto cubre el
	// vector de ataque DOS: cliente malicioso que envía 50 MB en vez de
	// una foto normal de factura (~2-3 MB).
	h := &ProductHandler{}
	oversizedBody := bytes.Repeat([]byte("A"), services.MaxInvoiceBodyBytes+1024)

	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	req := httptest.NewRequest(http.MethodPost, "/api/inventory/scan-invoice", bytes.NewReader(oversizedBody))
	req.Header.Set("Content-Type", "application/json")
	c.Request = req

	h.ScanInvoice(c)

	if rec.Code != http.StatusRequestEntityTooLarge && rec.Code != http.StatusBadRequest {
		// http.MaxBytesReader emite el error durante ShouldBindJSON; el
		// handler lo mapea a 413 cuando reconoce la firma. Si por el
		// motor de bind el error llega sin la firma, caerá a 400. Ambos
		// son aceptables (no pasa a Claude ni consume RAM).
		t.Fatalf("body gigante debe cortarse en 413 o 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

// -------------- NormalizeMimeType expuesto como contrato --------------

func TestServicesNormalizeMimeType_ReflejadoEnHandler(t *testing.T) {
	// Guardián: el handler usa services.NormalizeMimeType. Si alguien lo
	// renombra o relaja (p.ej. aceptando bmp sin que Claude lo soporte),
	// este test falla en el paquete del contrato.
	if got := services.NormalizeMimeType("image/bmp"); got != "" {
		t.Errorf("NormalizeMimeType('image/bmp') debe rechazar (bmp no está en Claude), got %q", got)
	}
	if got := services.NormalizeMimeType("image/jpg"); got != "image/jpeg" {
		t.Errorf("NormalizeMimeType('image/jpg') debe mapear a image/jpeg, got %q", got)
	}
}
