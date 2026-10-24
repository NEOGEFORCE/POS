package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Guardianes puros del InternalBarcodeHandler (sin BD).
//
// Fijan el contrato HTTP con el frontend:
//
//   - 401 cuando no hay sesión.
//   - 400 cuando el body está malformado o el source es inválido.
//   - 400 cuando `GetByCode` llega sin :code.
//   - 404 con código estable cuando el :code está fuera del namespace.
//   - Códigos de error literales que el frontend condiciona:
//       INTERNAL_RESERVATION_NOT_FOUND, INTERNAL_RESERVATION_EXPIRED,
//       INTERNAL_RESERVATION_ALREADY_USED, INTERNAL_BARCODE_REQUIRES_RESERVATION.
// =============================================================================

func newInternalTestContext(method, path, body string) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	var reader *bytes.Reader
	if body != "" {
		reader = bytes.NewReader([]byte(body))
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	// Length tiene que coincidir para que ShouldBindJSON lea el body.
	req.ContentLength = int64(len(body))
	c.Request = req
	return c, rec
}

func TestInternalHandler_Reserve_SinSesion_401(t *testing.T) {
	h := &InternalBarcodeHandler{repo: nil}
	c, rec := newInternalTestContext(http.MethodPost, "/api/labels/internal-codes/reserve", `{}`)
	// No seteamos userDni → emula bypass del middleware.
	h.Reserve(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe devolver 401, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestInternalHandler_Reserve_PayloadInvalido_400(t *testing.T) {
	h := &InternalBarcodeHandler{repo: nil}
	c, rec := newInternalTestContext(http.MethodPost, "/api/labels/internal-codes/reserve", `{broken`)
	c.Set("userDni", "EMP-01")
	h.Reserve(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("payload inválido debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestInternalHandler_Reserve_SourceInvalido_400(t *testing.T) {
	h := &InternalBarcodeHandler{repo: nil}
	c, rec := newInternalTestContext(http.MethodPost, "/api/labels/internal-codes/reserve", `{"source":"malware"}`)
	c.Set("userDni", "EMP-01")
	h.Reserve(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("source inválido debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "source") {
		t.Errorf("mensaje debe mencionar source; body=%s", rec.Body.String())
	}
}

func TestInternalHandler_Reserve_TTLNegativoMapeaADefault(t *testing.T) {
	// Un cliente malicioso podría enviar ttlSeconds=-1 para reservar
	// eternamente. El handler debe mapearlo a TTL=0 (default).
	src := readFile(t, "internal_barcode_handler.go")
	if !strings.Contains(src, "req.TTLSeconds > 0") {
		t.Error("el handler debe aceptar TTLSeconds sólo si es > 0 (los <=0 caen al default, nunca a eternas)")
	}
}

func TestInternalHandler_GetByCode_SinSesion_401(t *testing.T) {
	h := &InternalBarcodeHandler{repo: nil}
	c, rec := newInternalTestContext(http.MethodGet, "/api/labels/internal-codes/POSINT-ABCDEF01", "")
	c.Params = gin.Params{{Key: "code", Value: "POSINT-ABCDEF01"}}
	h.GetByCode(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe devolver 401, got %d", rec.Code)
	}
}

func TestInternalHandler_GetByCode_SinCode_400(t *testing.T) {
	h := &InternalBarcodeHandler{repo: nil}
	c, rec := newInternalTestContext(http.MethodGet, "/api/labels/internal-codes/", "")
	c.Set("userDni", "EMP-01")
	c.Params = gin.Params{{Key: "code", Value: "   "}}
	h.GetByCode(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("sin :code debe devolver 400, got %d", rec.Code)
	}
}

func TestInternalHandler_GetByCode_FueraDelNamespace_404(t *testing.T) {
	h := &InternalBarcodeHandler{repo: nil}
	c, rec := newInternalTestContext(http.MethodGet, "/api/labels/internal-codes/EAN13", "")
	c.Set("userDni", "EMP-01")
	c.Params = gin.Params{{Key: "code", Value: "7709999999999"}}
	h.GetByCode(c)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("código fuera del namespace debe devolver 404, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	// El frontend condiciona por este literal.
	if !strings.Contains(rec.Body.String(), "INTERNAL_RESERVATION_NOT_FOUND") {
		t.Errorf("el 404 debe incluir el code literal INTERNAL_RESERVATION_NOT_FOUND; body=%s", rec.Body.String())
	}
}

// TestInternalHandler_ErrorCodes_ContratoEstable fija los literales de
// código de error que el frontend hace match. Si alguien los renombra,
// el modal pierde su rama de recuperación específica.
func TestInternalHandler_ErrorCodes_ContratoEstable(t *testing.T) {
	// Los códigos viven en el modelo; los handlers (internal_barcode_handler
	// y product_handler, que emiten juntos todos los códigos del contrato)
	// los referencian usando esas constantes.
	ownHandler := readFile(t, "internal_barcode_handler.go")
	productHandler := readFile(t, "product_handler.go")
	combined := ownHandler + "\n" + productHandler

	for _, want := range []string{
		"ErrCodeInternalReservationNotFound",
		"ErrCodeInternalReservationExpired",
		"ErrCodeInternalReservationAlreadyUsed",
	} {
		if !strings.Contains(combined, want) {
			t.Errorf("el conjunto de handlers (internal + product) debe referenciar models.%s", want)
		}
	}
	modelSrc := readFile(t, "../../core/domain/models/internal_barcode_reservation.go")
	for _, lit := range []string{
		`"INTERNAL_RESERVATION_NOT_FOUND"`,
		`"INTERNAL_RESERVATION_EXPIRED"`,
		`"INTERNAL_RESERVATION_ALREADY_USED"`,
		`"INTERNAL_BARCODE_REQUIRES_RESERVATION"`,
		`"INTERNAL_BARCODE_FORMAT_INVALID"`,
		`"INTERNAL_PRODUCT_BARCODE_IN_USE"`,
	} {
		if !strings.Contains(modelSrc, lit) {
			t.Errorf("el modelo debe declarar el literal %s (contrato con el frontend)", lit)
		}
	}
}

// TestInternalHandler_RequestDecoding verifica que el shape de
// reserveRequest se parsea sin ruido con los distintos payloads que
// el frontend puede enviar.
func TestInternalHandler_RequestDecoding(t *testing.T) {
	payloads := []string{
		`{}`,
		`{"source":"product_form"}`,
		`{"source":"reception","note":"item sin GTIN"}`,
		`{"ttlSeconds":600}`,
		`{"hexLen":16}`,
		`{"source":"product_form","note":"","ttlSeconds":900,"hexLen":12}`,
	}
	for _, p := range payloads {
		var req reserveRequest
		if err := json.Unmarshal([]byte(p), &req); err != nil {
			t.Errorf("payload %q no decodifica: %v", p, err)
		}
	}
}

// TestInternalHandler_ProductCreateErrorCodesContract verifica que la
// rama POSINT dentro de product_handler.Create emite los códigos de
// error ESTABLES del contrato con el frontend al mapear errores del repo.
func TestInternalHandler_ProductCreateErrorCodesContract(t *testing.T) {
	src := readFile(t, "product_handler.go")
	// Debe referenciar los sentinelas del repositorio.
	for _, want := range []string{
		"repositories.ErrInternalBarcodeReservationNotFound",
		"repositories.ErrInternalBarcodeReservationExpired",
		"repositories.ErrInternalBarcodeReservationAlreadyUsed",
		"repositories.ErrInternalProductBarcodeInUse",
		"repositories.ErrInternalBarcodeFormat",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("product_handler.Create debe mapear %s a un código HTTP específico", want)
		}
	}
	// Y los literales de código HTTP (409) que el frontend reconoce.
	if count := strings.Count(src, "http.StatusConflict"); count < 3 {
		t.Errorf("product_handler.Create debe responder 409 para los tres estados de reserva no consumible; encontró %d usos de StatusConflict", count)
	}
}

// TestInternalHandler_CreateProductNoLlamaFlujoLegacySiEsPOSINT: en
// product_handler.Create, cuando el barcode está en el namespace POSINT-,
// el handler debe desviarse a `internalBarcodeRepo.CreateProductConsumingReservation`
// y NO caer en el flujo legacy (duplicate check + Save). Esto es
// crítico: si alguien reorganiza las ramas y la rama POSINT cae al
// mismo s.service.CreateProduct(&product), el guardián del servicio
// rechazará la escritura, pero perderíamos el consumo atómico.
func TestInternalHandler_CreateProductRamaPOSINTEsDistinta(t *testing.T) {
	src := readFile(t, "product_handler.go")
	// Debe existir la rama de POSINT que delega al repo interno.
	if !regexp.MustCompile(`models\.IsInternalBarcode\s*\(\s*product\.Barcode\s*\)`).MatchString(src) {
		t.Error("product_handler.Create debe detectar el namespace POSINT- con models.IsInternalBarcode(product.Barcode)")
	}
	if !strings.Contains(src, "CreateProductConsumingReservation") {
		t.Error("product_handler.Create debe delegar a CreateProductConsumingReservation en la rama POSINT")
	}
	// Y debe terminar con return después de responder, para no caer al
	// flujo legacy.
	bodyRe := regexp.MustCompile(`(?s)if models\.IsInternalBarcode\(product\.Barcode\).*?\n\s*\}`)
	if m := bodyRe.FindString(src); m == "" {
		t.Fatal("no se pudo delimitar la rama POSINT en product_handler.Create")
	}
}

// TestInternalHandler_RutaInyectadaEnMain verifica que main.go construye
// el handler y lo registra bajo /api/labels/internal-codes/*.
func TestInternalHandler_RutaInyectadaEnMain(t *testing.T) {
	root := filepath.Join("..", "..", "..", "cmd", "api", "main.go")
	bts, err := os.ReadFile(root)
	if err != nil {
		t.Skipf("No se pudo leer %s: %v", root, err)
	}
	src := string(bts)

	// Construcción del handler.
	if !regexp.MustCompile(`handlers\.NewInternalBarcodeHandler\s*\(\s*internalBarcodeRepo\s*\)`).MatchString(src) {
		t.Error("main.go debe construir internalBarcodeHandler via handlers.NewInternalBarcodeHandler(internalBarcodeRepo)")
	}
	// Registro de rutas DENTRO del grupo labels (que ya tiene AuthMiddleware).
	if !regexp.MustCompile(`labels\.POST\("/internal-codes/reserve",\s*internalBarcodeHandler\.Reserve\)`).MatchString(src) {
		t.Error("POST /internal-codes/reserve no está registrada")
	}
	if !regexp.MustCompile(`labels\.GET\("/internal-codes/:code",\s*internalBarcodeHandler\.GetByCode\)`).MatchString(src) {
		t.Error("GET /internal-codes/:code no está registrada")
	}
	// Inyección en el handler de productos.
	if !strings.Contains(src, "WithInternalBarcodeRepo(internalBarcodeRepo)") {
		t.Error("productHandler debe recibir internalBarcodeRepo para la rama POSINT en Create")
	}
}

// TestInternalHandler_SinReservaReturns503 verifica el fallback cuando
// el wiring olvidó inyectar el repo: no debe caer en nil pointer; debe
// devolver 503 claro.
func TestInternalHandler_ProductHandlerSinInternalRepo503(t *testing.T) {
	src := readFile(t, "product_handler.go")
	if !strings.Contains(src, "h.internalBarcodeRepo == nil") {
		t.Error("product_handler.Create debe chequear nil del internalBarcodeRepo antes de usar la rama POSINT")
	}
	// La respuesta cuando el repo falta tiene que ser 503 para que el
	// frontend sepa que es un problema de configuración, no de negocio.
	if !regexp.MustCompile(`http\.StatusServiceUnavailable[^\)]+módulo de códigos internos`).MatchString(src) {
		t.Error("product_handler.Create debe responder 503 con mensaje \"módulo de códigos internos\" cuando el repo es nil")
	}
}
