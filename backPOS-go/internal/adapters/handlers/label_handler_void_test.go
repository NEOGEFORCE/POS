package handlers

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// Guardianes de los endpoints nuevos del LabelHandler (fix 2026-10-04):
//
//   - POST /labels/codes/:code/void  → admin-only.
//   - PATCH /labels/print-jobs/:id/status → empleado+admin.
//
// Validan contrato HTTP (401/400) y que las rutas estén registradas en
// el grupo correcto de main.go.
// ============================================================================

func newVoidTestContext(code string) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	url := "/api/labels/codes/" + code + "/void"
	req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(nil))
	req.Header.Set("Content-Type", "application/json")
	c.Request = req
	c.Params = gin.Params{{Key: "code", Value: code}}
	return c, rec
}

func TestVoidCode_SinSesion_401(t *testing.T) {
	h := &LabelHandler{repo: nil}
	c, rec := newVoidTestContext("LC-abc")
	// No seteamos userDni → sin sesión.

	h.VoidCode(c)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("VoidCode sin sesión debe devolver 401, got %d", rec.Code)
	}
}

func TestVoidCode_SinCode_400(t *testing.T) {
	h := &LabelHandler{repo: nil}
	c, rec := newVoidTestContext("")
	c.Set("userDni", "ADMIN-01")

	h.VoidCode(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("VoidCode sin code debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

// --- MarkPrintJobStatus ---

func newMarkPrintJobCtx(idStr, body string) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	req := httptest.NewRequest(http.MethodPatch, "/api/labels/print-jobs/"+idStr+"/status", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	c.Request = req
	c.Params = gin.Params{{Key: "id", Value: idStr}}
	return c, rec
}

func TestMarkPrintJobStatus_SinSesion_401(t *testing.T) {
	h := &LabelHandler{repo: nil}
	c, rec := newMarkPrintJobCtx("1", `{"status":"printed"}`)

	h.MarkPrintJobStatus(c)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("MarkPrintJobStatus sin sesión debe devolver 401, got %d", rec.Code)
	}
}

func TestMarkPrintJobStatus_IDInvalido_400(t *testing.T) {
	h := &LabelHandler{repo: nil}
	c, rec := newMarkPrintJobCtx("abc", `{"status":"printed"}`)
	c.Set("userDni", "EMP-01")

	h.MarkPrintJobStatus(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("MarkPrintJobStatus id='abc' debe devolver 400, got %d", rec.Code)
	}
}

// --- Rutas registradas en main.go ---

func TestVoidYMarkPrintJob_RutasRegistradasEnMain(t *testing.T) {
	root := filepath.Join("..", "..", "..", "cmd", "api", "main.go")
	bts, err := os.ReadFile(root)
	if err != nil {
		t.Skipf("No se pudo leer %s: %v", root, err)
	}
	src := string(bts)
	if !regexp.MustCompile(`labelsAdmin\.POST\("\s*/codes/:code/void\s*",\s*labelHandler\.VoidCode\)`).MatchString(src) {
		t.Error(`main.go debe registrar POST /labels/codes/:code/void dentro del grupo labelsAdmin`)
	}
	if !regexp.MustCompile(`labels\.PATCH\("\s*/print-jobs/:id/status\s*",\s*labelHandler\.MarkPrintJobStatus\)`).MatchString(src) {
		t.Error(`main.go debe registrar PATCH /labels/print-jobs/:id/status dentro del grupo labels`)
	}
	// La ruta de void debe estar en labelsAdmin (admin-only), no en el
	// grupo general de labels. Validamos la ordenación textual del
	// registro: aparece después de labelsAdmin.Use(RoleMiddleware(...)).
	if idx := strings.Index(src, `labelsAdmin.POST("/codes/:code/void"`); idx > 0 {
		head := src[:idx]
		if !strings.Contains(head, `labelsAdmin.Use(middlewares.RoleMiddleware("admin"))`) {
			t.Error("void endpoint debe quedar DESPUÉS de labelsAdmin.Use(RoleMiddleware(\"admin\")) para que la protección aplique")
		}
	}
}

// --- Cash drawer: cross-check de sale ownership ---

func TestOpenCashDrawer_SaleIDValida_PropiedadDelCajero(t *testing.T) {
	// Guardián estático: el handler debe invocar IsSaleOwnedByCashier
	// cuando el actor NO es admin y envía saleId. Sin este cross-check
	// un empleado podía abrir el cajón citando la venta de otro.
	src := readFile(t, "label_handler.go")
	if !strings.Contains(src, "IsSaleOwnedByCashier(") {
		t.Error("OpenCashDrawer debe llamar a repo.IsSaleOwnedByCashier antes de aceptar req.SaleID (fix 2026-10-04)")
	}
	if !strings.Contains(src, `"CASH_DRAWER_SALE_NOT_OWNED"`) {
		t.Error("OpenCashDrawer debe exponer el código de error CASH_DRAWER_SALE_NOT_OWNED al frontend")
	}
}
