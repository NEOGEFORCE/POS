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

// =============================================================
// Guardianes del handler SaveAlias.
//
// Cubren las validaciones TEMPRANAS que cortan antes de llegar al
// servicio. Patrón: handler sin servicio inyectado. Si una ruta llegara
// a disparar h.service.SaveSupplierAlias, el test fallaría con
// nil-deref — garantía adicional de que la validación corta ANTES de
// la llamada downstream.
//
//   - 400 cuando falta supplierId (o es 0).
//   - 400 cuando falta invoiceName (vacío o whitespace).
//   - 400 cuando falta productBarcode (vacío o whitespace).
//   - 400 cuando el JSON está malformado.
// =============================================================

func newSaveAliasContext(t *testing.T, body []byte) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	req := httptest.NewRequest(http.MethodPost, "/api/suppliers/alias", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	c.Request = req
	return c, rec
}

func TestSaveAlias_400_SinSupplierID(t *testing.T) {
	h := &ProductHandler{} // sin service: si falla la validación, el test revienta
	body, _ := json.Marshal(map[string]any{
		"invoiceName":    "COCA 400ML",
		"productBarcode": "7701",
	})
	c, rec := newSaveAliasContext(t, body)
	h.SaveAlias(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("sin supplierId debe devolver 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "proveedor") {
		t.Errorf("el mensaje debe mencionar proveedor, got %s", rec.Body.String())
	}
}

func TestSaveAlias_400_SupplierIDCero(t *testing.T) {
	h := &ProductHandler{}
	body, _ := json.Marshal(map[string]any{
		"supplierId":     0,
		"invoiceName":    "COCA 400ML",
		"productBarcode": "7701",
	})
	c, rec := newSaveAliasContext(t, body)
	h.SaveAlias(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("supplierId=0 debe devolver 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSaveAlias_400_SinInvoiceName(t *testing.T) {
	h := &ProductHandler{}
	body, _ := json.Marshal(map[string]any{
		"supplierId":     1,
		"invoiceName":    "   ", // sólo whitespace
		"productBarcode": "7701",
	})
	c, rec := newSaveAliasContext(t, body)
	h.SaveAlias(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invoiceName vacío debe devolver 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "factura") && !strings.Contains(rec.Body.String(), "nombre") {
		t.Errorf("el mensaje debe mencionar nombre/factura, got %s", rec.Body.String())
	}
}

func TestSaveAlias_400_SinProductBarcode(t *testing.T) {
	h := &ProductHandler{}
	body, _ := json.Marshal(map[string]any{
		"supplierId":     1,
		"invoiceName":    "COCA 400ML",
		"productBarcode": "   ",
	})
	c, rec := newSaveAliasContext(t, body)
	h.SaveAlias(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("productBarcode vacío debe devolver 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "código") && !strings.Contains(rec.Body.String(), "codigo") {
		t.Errorf("el mensaje debe mencionar el código del producto, got %s", rec.Body.String())
	}
}

func TestSaveAlias_400_JSONInvalido(t *testing.T) {
	h := &ProductHandler{}
	c, rec := newSaveAliasContext(t, []byte("{this is not json"))
	h.SaveAlias(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("JSON inválido debe devolver 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}
