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
// Guardianes puros del handler (sin BD).
//
// Las validaciones de rol y venta reciente que requieren Postgres se cubren
// en los repository tests. Aquí fijamos el contrato del handler:
//
//   - 401 sin sesión (no hay "dni" en el contexto).
//   - El decodificador acepta payloads opcionales.
//   - El helper actorIsAdmin reconoce los 3 alias.
//   - El código de error 403 está hardcoded exactamente como lo espera el
//     front: CASH_DRAWER_REQUIRES_SALE_OR_ADMIN.
// =============================================================================

func newTestContext(method, body string) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	var reader *bytes.Reader
	if body != "" {
		reader = bytes.NewReader([]byte(body))
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, "/api/cash-drawer/open", reader)
	req.Header.Set("Content-Type", "application/json")
	c.Request = req
	return c, rec
}

func TestOpenCashDrawer_SinSesion_401(t *testing.T) {
	h := &LabelHandler{repo: nil}
	c, rec := newTestContext(http.MethodPost, `{}`)
	// No seteamos "dni" ni "role" en el contexto: emula un bypass del
	// middleware (no debería ocurrir, pero el handler es defensivo).

	h.OpenCashDrawer(c)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe devolver 401, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestActorIsAdmin_RespetaRolDelContexto(t *testing.T) {
	cases := []struct {
		role string
		want bool
	}{
		{"admin", true},
		{"ADMIN", true},
		{"administrador", true},
		{"superadmin", true},
		{"empleado", false},
		{"", false},
	}
	for _, c := range cases {
		gin.SetMode(gin.TestMode)
		rec := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(rec)
		ctx.Set("role", c.role)
		got := actorIsAdmin(ctx)
		if got != c.want {
			t.Errorf("actorIsAdmin(role=%q) = %v, want %v", c.role, got, c.want)
		}
	}
}

func TestActorDNI_PreferContextOverHeader(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Actor-DNI", "FROM-HEADER")
	c.Request = req
	c.Set("userDni", "FROM-CTX")

	got := actorDNI(c)
	if got != "FROM-CTX" {
		t.Fatalf("actorDNI debe preferir userDni del contexto, got %q", got)
	}
}

func TestOpenDrawerRequest_DecodeTolerantes(t *testing.T) {
	payloads := []string{
		`{"override":true}`,
		`{"saleId":42}`,
		`{"returnId":7}`,
		`{"note":"motivo","override":true}`,
		`{}`,
	}
	for _, p := range payloads {
		var req openDrawerRequest
		if err := json.Unmarshal([]byte(p), &req); err != nil {
			t.Fatalf("payload %q no decodifica: %v", p, err)
		}
	}
}

// TestCashDrawerErrorCode_ContratoEstable fija el contrato con el frontend:
// el código "CASH_DRAWER_REQUIRES_SALE_OR_ADMIN" aparece textual en el
// handler. Si alguien lo renombra, este test se rompe para que el frontend
// se entere ANTES del deploy.
func TestCashDrawerErrorCode_ContratoEstable(t *testing.T) {
	// Leemos el source del handler y buscamos el string literal.
	// Un cambio de nombre dejaría al frontend sin forma de detectar el 403.
	src := readFile(t, "label_handler.go")
	expected := `"CASH_DRAWER_REQUIRES_SALE_OR_ADMIN"`
	if !strings.Contains(src, expected) {
		t.Fatalf("el handler ya no responde con %s; el frontend no detectará el bloqueo", expected)
	}
}

// =============================================================================
// Guardianes de ResolveCode (GET /labels/codes/resolve).
//
// Fijan el contrato HTTP del handler con el frontend:
//
//   - 401 cuando no hay sesión (contexto sin userDni).
//   - 400 cuando falta `code`.
//   - Shape 200 incluye el literal "match" y los valores "label_code" /
//     "unknown" (contrato con useNewSale.ts).
//   - El handler NO expone códigos de error del alias de paquete
//     (PACKAGE_CODE_...), para que el frontend no confunda shapes.
// =============================================================================

func newResolveTestContext(method, query string) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	url := "/api/labels/codes/resolve"
	if query != "" {
		url += "?" + query
	}
	req := httptest.NewRequest(method, url, nil)
	c.Request = req
	return c, rec
}

func TestResolveLabelCode_SinSesion_401(t *testing.T) {
	h := &LabelHandler{repo: nil}
	c, rec := newResolveTestContext(http.MethodGet, "code=LC-abc")
	// No seteamos userDni ni header X-Actor-DNI → sin sesión.

	h.ResolveCode(c)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("ResolveCode sin sesión debe devolver 401, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestResolveLabelCode_SinCode_400(t *testing.T) {
	h := &LabelHandler{repo: nil}
	c, rec := newResolveTestContext(http.MethodGet, "")
	c.Set("userDni", "EMP-01")

	h.ResolveCode(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("ResolveCode sin code debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "code requerido") {
		t.Errorf("ResolveCode sin code debe explicar que falta code; body=%s", rec.Body.String())
	}
}

func TestResolveLabelCode_CodeConSoloEspacios_400(t *testing.T) {
	h := &LabelHandler{repo: nil}
	c, rec := newResolveTestContext(http.MethodGet, "code=%20%20%20")
	c.Set("userDni", "EMP-01")

	h.ResolveCode(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("ResolveCode con code=spaces debe devolver 400 (TrimSpace vacío), got %d", rec.Code)
	}
}

// TestResolveLabelCode_ContratoShape fija el shape del handler sin
// depender de BD. Verifica los literales que el frontend condiciona.
func TestResolveLabelCode_ContratoShape(t *testing.T) {
	src := readFile(t, "label_handler.go")
	// Contrato visible: match literal y los dos valores.
	// Se buscan en el handler como literales emitidos vía gin.H o vía el
	// struct ResolveLabelResult del repo.
	if !strings.Contains(src, `"match"`) {
		t.Errorf(`El handler debe exponer la clave "match" en 200 (contrato con useNewSale.ts).`)
	}
	if !strings.Contains(src, `"unknown"`) {
		t.Errorf(`El handler debe emitir "unknown" como fallback (contrato con useNewSale.ts).`)
	}
	// El handler NO debe EMITIR códigos de error del alias de paquete.
	// Delimitamos el cuerpo de ResolveCode (sin godoc) para que una
	// mención en un comentario explicativo no dispare el guardián.
	bodyRe := regexp.MustCompile(`(?s)func\s+\(h\s+\*LabelHandler\)\s+ResolveCode\s*\(c\s+\*gin\.Context\)\s*\{.*?\n\}\s*\n`)
	body := bodyRe.FindString(src)
	if body == "" {
		t.Fatal("No se pudo delimitar el cuerpo de ResolveCode: ¿se renombró?")
	}
	if strings.Contains(body, "PACKAGE_CODE_") {
		t.Errorf(`El cuerpo de ResolveCode NO debe emitir códigos "PACKAGE_CODE_...": son del alias de paquete, no de etiquetas.`)
	}
	// Y referencia explícita al método del repo que resuelve.
	if !strings.Contains(body, "repo.ResolveLabelCode(") {
		t.Errorf("El handler debe delegar en repo.ResolveLabelCode(ctx, code).")
	}
}

// TestResolveLabelCode_RutaRegistradaEnMain comprueba estáticamente
// que la ruta exista en main.go dentro del grupo autenticado /labels.
func TestResolveLabelCode_RutaRegistradaEnMain(t *testing.T) {
	// Localizamos cmd/api/main.go relativo al root del backPOS-go.
	// El test corre desde internal/adapters/handlers, así que subimos 3.
	root := filepath.Join("..", "..", "..", "cmd", "api", "main.go")
	bts, err := os.ReadFile(root)
	if err != nil {
		t.Skipf("No se pudo leer %s (quizá fuera de este workspace): %v", root, err)
	}
	src := string(bts)
	if !regexp.MustCompile(`labels\.GET\("\s*/codes/resolve\s*",\s*labelHandler\.ResolveCode\)`).MatchString(src) {
		t.Errorf(`La ruta GET /codes/resolve → labelHandler.ResolveCode debe estar registrada dentro del grupo labels en main.go.`)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	bts, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", path, err)
	}
	return string(bts)
}
