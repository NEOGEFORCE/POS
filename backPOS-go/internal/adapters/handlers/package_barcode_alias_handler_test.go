package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Guardianes puros del handler de alias de código de paquete (sin BD).
//
// Fijan el contrato con el frontend:
//
//   - 401 sin sesión.
//   - 400 cuando faltan productBarcode/packageCode o unitsPerPack < 1.
//   - El código de error del 409 es exactamente
//     PACKAGE_CODE_BELONGS_TO_OTHER_PRODUCT (contrato estable).
//   - El handler Resolve exige el query param `code`.
//   - MarkSeen SIN packageCode (solo aliasId, o payload vacío) devuelve 400:
//     el handler nunca más responde 200 silencioso sin actualizar nada.
// =============================================================================

func newAliasTestContext(method, path, body string) (*gin.Context, *httptest.ResponseRecorder) {
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
	c.Request = req
	return c, rec
}

func TestPackageBarcodeAlias_Ensure_SinSesion_401(t *testing.T) {
	h := &PackageBarcodeAliasHandler{repo: nil}
	c, rec := newAliasTestContext(http.MethodPost, "/api/inventory/package-barcode", `{"productBarcode":"UNIT123","packageCode":"PACK999","unitsPerPack":12}`)
	h.Ensure(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe devolver 401, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestPackageBarcodeAlias_Ensure_UnitsPerPackInvalido_400(t *testing.T) {
	h := &PackageBarcodeAliasHandler{repo: nil}
	// Con sesión seteada, pero unitsPerPack=0.
	c, rec := newAliasTestContext(http.MethodPost, "/api/inventory/package-barcode", `{"productBarcode":"UNIT123","packageCode":"PACK999","unitsPerPack":0}`)
	c.Set("userDni", "TEST-DNI")
	h.Ensure(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unitsPerPack=0 debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body no es JSON: %v", err)
	}
	msg, _ := body["error"].(string)
	if !strings.Contains(msg, ">= 1") {
		t.Errorf("mensaje debe explicar la cota mínima, got %q", msg)
	}
}

func TestPackageBarcodeAlias_Ensure_CamposObligatorios_400(t *testing.T) {
	h := &PackageBarcodeAliasHandler{repo: nil}
	payloads := []string{
		`{"packageCode":"PACK999","unitsPerPack":12}`,                     // falta productBarcode
		`{"productBarcode":"UNIT123","unitsPerPack":12}`,                  // falta packageCode
		`{"productBarcode":"","packageCode":"PACK999","unitsPerPack":12}`, // vacío
		`{"productBarcode":"UNIT123","packageCode":"","unitsPerPack":12}`,
	}
	for _, p := range payloads {
		c, rec := newAliasTestContext(http.MethodPost, "/api/inventory/package-barcode", p)
		c.Set("userDni", "TEST-DNI")
		h.Ensure(c)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("payload %s debe devolver 400, got %d (body=%s)", p, rec.Code, rec.Body.String())
		}
	}
}

func TestPackageBarcodeAlias_Resolve_SinCode_400(t *testing.T) {
	h := &PackageBarcodeAliasHandler{repo: nil}
	c, rec := newAliasTestContext(http.MethodGet, "/api/inventory/package-barcode/resolve", "")
	c.Set("userDni", "TEST-DNI")
	h.Resolve(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("resolve sin code debe devolver 400, got %d", rec.Code)
	}
}

func TestPackageBarcodeAlias_MarkSeen_RequiereIdentificador_400(t *testing.T) {
	h := &PackageBarcodeAliasHandler{repo: nil}
	c, rec := newAliasTestContext(http.MethodPost, "/api/inventory/package-barcode/seen", `{}`)
	c.Set("userDni", "TEST-DNI")
	h.MarkSeen(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("MarkSeen sin packageCode debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

// TestPackageBarcodeAlias_MarkSeen_SoloAliasId_400 verifica el fix del bug
// detectado en la revisión 1: antes, un cliente que mandara solo `aliasId`
// (sin `packageCode`) recibía 200 OK aunque la operación NO actualizaba
// nada en BD. Ahora el handler responde 400 con mensaje claro y nunca
// aparenta éxito.
func TestPackageBarcodeAlias_MarkSeen_SoloAliasId_400(t *testing.T) {
	h := &PackageBarcodeAliasHandler{repo: nil}
	c, rec := newAliasTestContext(http.MethodPost, "/api/inventory/package-barcode/seen", `{"aliasId":42}`)
	c.Set("userDni", "TEST-DNI")
	h.MarkSeen(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("MarkSeen con solo aliasId debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body no es JSON: %v", err)
	}
	msg, _ := body["error"].(string)
	if !strings.Contains(strings.ToLower(msg), "packagecode") {
		t.Errorf("el mensaje debe mencionar que packageCode es obligatorio, got %q", msg)
	}
}

// TestPackageBarcodeAlias_ErrorCode_ContratoEstable asegura que el string
// literal del código de error esté hardcoded en el handler. Si alguien lo
// renombra, el frontend no detectaría el 409 y mostraría un error genérico.
func TestPackageBarcodeAlias_ErrorCode_ContratoEstable(t *testing.T) {
	src := readFile(t, "package_barcode_alias_handler.go")
	// Se enlaza al literal declarado en models/package_barcode_alias.go
	if !strings.Contains(src, "models.ErrCodePackageBelongsToOther") {
		t.Fatal("el handler debe responder el 409 con models.ErrCodePackageBelongsToOther")
	}
	// Y el literal real:
	modelSrc := readFile(t, "../../core/domain/models/package_barcode_alias.go")
	expected := `"PACKAGE_CODE_BELONGS_TO_OTHER_PRODUCT"`
	if !strings.Contains(modelSrc, expected) {
		t.Fatalf("el modelo debe declarar la constante %s; el frontend hace match literal por este string.", expected)
	}
}

func TestPackageBarcodeAlias_EnsureRequest_DecodeTolerante(t *testing.T) {
	payloads := []string{
		`{"productBarcode":"UNIT123","packageCode":"PACK999","unitsPerPack":12,"supplierId":7}`,
		`{"productBarcode":"UNIT123","packageCode":"PACK999","unitsPerPack":12}`,
		`{"productBarcode":"UNIT123","packageCode":"PACK999","unitsPerPack":1}`,
	}
	for _, p := range payloads {
		var req ensureAliasRequest
		if err := json.Unmarshal([]byte(p), &req); err != nil {
			t.Fatalf("payload %q no decodifica: %v", p, err)
		}
	}
}

// Blindaje: el handler NUNCA debe tocar products.alternateCodes.
func TestPackageBarcodeAlias_Handler_NuncaEscribeAAlternateCodes(t *testing.T) {
	src := readFile(t, "package_barcode_alias_handler.go")
	if strings.Contains(src, "alternateCodes") || strings.Contains(src, "alternate_codes") {
		if strings.Contains(src, "UPDATE") || strings.Contains(src, "INSERT") || strings.Contains(src, ".Save(") {
			t.Fatal("El handler de package_barcode_aliases NUNCA debe escribir a products.alternateCodes.")
		}
	}
	// Verificamos que no exista llamada directa al repo de products:
	if strings.Contains(src, "productRepo") {
		t.Fatal("El handler de package_barcode_aliases no debe inyectar el repo de productos: todo pasa por el repo de alias.")
	}
}
