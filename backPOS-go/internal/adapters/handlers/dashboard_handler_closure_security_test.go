package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// ============================================================================
// Guardianes de SaveClosure (P0 — 2026-10-04).
//
// Son tests de contrato basados en el SOURCE del handler + un recorrido
// mínimo del flujo HTTP, siguiendo el patrón ya usado por
// `label_handler_test.go`. Las pruebas de BD/transacción viven en el
// paquete `services` (closure_save_security_test.go).
//
// Fijan por lectura estática que:
//
//   - SaveClosure fuerza `closure.ID = 0` antes de llamar al servicio
//     (bloquea el ataque GORM upsert por PK).
//   - SaveClosure limpia `AuthorizedBy` del body antes del servicio
//     (bloquea el spoof del string libre).
//   - SaveClosure extrae `authorizationToken` y `clientTxId` del body.
//   - El código de error para faltante sin autorización es 403.
//   - `isAdminRole` normaliza admin / administrador / superadmin.
// ============================================================================

func readHandlerSource(t *testing.T) string {
	t.Helper()
	return readFile(t, "dashboard_handler.go")
}

func extractSaveClosureBody(t *testing.T, src string) string {
	t.Helper()
	// Delimitamos entre la firma del handler y el siguiente `func (h *`
	// para capturar todo el cuerpo sin preocuparnos por las llaves
	// internas (goroutines, structs anónimos, etc.). Es suficientemente
	// específico para evitar colisiones con otros SaveClosure.
	start := strings.Index(src, "func (h *DashboardHandler) SaveClosure(c *gin.Context) {")
	if start < 0 {
		t.Fatal("no se encontró la firma de SaveClosure")
	}
	rest := src[start:]
	nextFunc := strings.Index(rest[1:], "\nfunc ")
	if nextFunc < 0 {
		return rest
	}
	return rest[:nextFunc+1]
}

func TestSaveClosure_FuerzaIDCeroAntesDelServicio(t *testing.T) {
	src := readHandlerSource(t)
	body := extractSaveClosureBody(t, src)

	// Debe aparecer el guard explícito; sin él, GORM Save haría un
	// UPSERT por PK y permitiría sobrescribir un cierre existente.
	if !regexp.MustCompile(`closure\.ID\s*!=\s*0`).MatchString(body) {
		t.Error("SaveClosure debe rechazar `id` != 0 explícitamente antes de llamar al servicio")
	}
	// Y debe responder 400 BadRequest con un mensaje de contrato.
	if !strings.Contains(body, "No se admite id en la creación de un cierre") {
		t.Error("SaveClosure debe responder 400 con mensaje claro al recibir id > 0 (contrato con el frontend)")
	}
}

func TestSaveClosure_LimpiaAuthorizedByDelBody(t *testing.T) {
	src := readHandlerSource(t)
	body := extractSaveClosureBody(t, src)

	if !regexp.MustCompile(`closure\.AuthorizedBy\s*=\s*""`).MatchString(body) {
		t.Error("SaveClosure debe limpiar `closure.AuthorizedBy` del body antes del servicio para prevenir spoof")
	}
}

func TestSaveClosure_ExtraeTokenYClientTxId(t *testing.T) {
	src := readHandlerSource(t)
	body := extractSaveClosureBody(t, src)

	if !strings.Contains(body, "AuthorizationToken") {
		t.Error("SaveClosure debe deserializar `authorizationToken` del payload")
	}
	if !strings.Contains(body, "ClientTxID") {
		t.Error("SaveClosure debe deserializar `clientTxId` del payload")
	}
	// La verificación server-side del token sólo corre cuando el actor
	// NO es admin — para que un admin firmante no pague el costo de un
	// claim adicional. Chequeamos el llamado al método del AuthService.
	if !strings.Contains(body, "VerifyClosureAuthorization(") {
		t.Error("SaveClosure debe invocar authService.VerifyClosureAuthorization para validar el token (fix P0)")
	}
}

func TestSaveClosure_FaltanteSinTokenDevuelve403(t *testing.T) {
	src := readHandlerSource(t)
	body := extractSaveClosureBody(t, src)

	// La traducción del ErrAuthorizationRequired del servicio en HTTP
	// debe ser 403, con un mensaje legible para el cajero.
	if !regexp.MustCompile(`errors\.Is\(err,\s*services\.ErrAuthorizationRequired\)`).MatchString(body) {
		t.Error("SaveClosure debe mapear services.ErrAuthorizationRequired a 403")
	}
	if !strings.Contains(body, "http.StatusForbidden") {
		t.Error("SaveClosure debe responder StatusForbidden ante ErrAuthorizationRequired")
	}
}

func TestIsAdminRole_NormalizaLosAlias(t *testing.T) {
	cases := []struct {
		role string
		want bool
	}{
		{"admin", true},
		{"ADMIN", true},
		{"administrador", true},
		{"Administrador", true},
		{"superadmin", true},
		{"SUPERADMIN", true},
		{"empleado", false},
		{"", false},
		{"   ", false},
	}
	for _, c := range cases {
		if got := isAdminRole(c.role); got != c.want {
			t.Errorf("isAdminRole(%q) = %v; want %v", c.role, got, c.want)
		}
	}
}

// --- SendPartialReport ---

func extractSendPartialReportBody(t *testing.T, src string) string {
	t.Helper()
	start := strings.Index(src, "func (h *DashboardHandler) SendPartialReport(c *gin.Context) {")
	if start < 0 {
		t.Fatal("no se encontró la firma de SendPartialReport")
	}
	rest := src[start:]
	nextFunc := strings.Index(rest[1:], "\nfunc ")
	if nextFunc < 0 {
		return rest
	}
	return rest[:nextFunc+1]
}

func TestSendPartialReport_UsaDatosTrustedDelServicio(t *testing.T) {
	src := readHandlerSource(t)
	body := extractSendPartialReportBody(t, src)

	// El handler NO debe deserializar un `models.CashierClosure` crudo
	// y pasárselo a Telegram/PDF: siempre debe pedirle los totales al
	// servicio. Chequeamos la llamada canónica.
	if !strings.Contains(body, "h.service.GetCashierClosure()") {
		t.Error("SendPartialReport debe leer los totales trusted desde h.service.GetCashierClosure()")
	}
	// Y debe recomputar los agregados con la fuente única.
	if !strings.Contains(body, "services.ComputeClosureMetrics(") {
		t.Error("SendPartialReport debe recomputar métricas con services.ComputeClosureMetrics (no confiar en el body)")
	}
}

// --- UpdateClosure ---

func extractUpdateClosureBody(t *testing.T, src string) string {
	t.Helper()
	start := strings.Index(src, "func (h *DashboardHandler) UpdateClosure(c *gin.Context) {")
	if start < 0 {
		t.Fatal("no se encontró la firma de UpdateClosure")
	}
	rest := src[start:]
	nextFunc := strings.Index(rest[1:], "\nfunc ")
	if nextFunc < 0 {
		return rest
	}
	return rest[:nextFunc+1]
}

func TestUpdateClosure_UsaAllowlistEstricta(t *testing.T) {
	src := readHandlerSource(t)
	body := extractUpdateClosureBody(t, src)

	// Debe validar las claves del body contra la allowlist antes de
	// pasar nada al servicio. Un cliente malicioso que mande
	// `closed_by_dni` debe recibir 400 con "Campo no editable".
	if !strings.Contains(body, "updateClosureAllowedKeys") {
		t.Error("UpdateClosure debe consultar updateClosureAllowedKeys para rechazar claves fuera de la allowlist")
	}
	if !strings.Contains(body, "Campo no editable") {
		t.Error("UpdateClosure debe emitir 400 con mensaje \"Campo no editable\" para claves prohibidas")
	}
}

func TestUpdateClosure_UsaZonaBogotaParaFechas(t *testing.T) {
	src := readHandlerSource(t)
	body := extractUpdateClosureBody(t, src)

	// Prohibir time.Local (zona del PC Windows): el frontend envía
	// datetime sin zona y hay que interpretarlo como hora Bogotá para
	// que no se desplace a UTC o a otra zona del servidor.
	if strings.Contains(body, "time.Local") {
		t.Error("UpdateClosure NO debe usar time.Local: parsea en zona America/Bogota vía bogotaLocation()")
	}
	if !strings.Contains(body, "bogotaLocation()") {
		t.Error("UpdateClosure debe parsear las fechas con bogotaLocation() (America/Bogota)")
	}
}

// --- Guardián de la allowlist ---

func TestUpdateClosureAllowedKeys_IncluyeFechasYCifrasNecesarias(t *testing.T) {
	must := []string{
		"start_date", "end_date", "date",
		"physical_cash", "coins100", "coins200", "coins500", "coins1000",
		"cash_bills", "cash_breakdown", "authorized_by",
		"total_expenses", "total_returns", "expenses_detail",
		"forgotten_expenses",
	}
	for _, k := range must {
		if _, ok := updateClosureAllowedKeys[k]; !ok {
			t.Errorf("updateClosureAllowedKeys debe contener %q (editable por admin)", k)
		}
	}
	// Y NO debe contener campos sensibles.
	forbidden := []string{"id", "closed_by_dni", "closed_by_name", "created_at", "deleted_at", "client_tx_id"}
	for _, k := range forbidden {
		if _, ok := updateClosureAllowedKeys[k]; ok {
			t.Errorf("updateClosureAllowedKeys NO debe contener %q (campo sensible)", k)
		}
	}
}

// --- Smoke test del contrato de autenticación de /auth/verify-admin ---

func TestVerifyAdminHandler_Request_DecodeDelCuerpo(t *testing.T) {
	// Fija el shape del request para que un refactor del struct VerifyAdminRequest
	// no mueva silenciosamente la clave que consume el frontend.
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	body := map[string]string{"username": "DUEÑA", "password": "pin1234"}
	payload, _ := json.Marshal(body)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/auth/verify-admin", bytes.NewReader(payload))
	c.Request.Header.Set("Content-Type", "application/json")

	var req VerifyAdminRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		t.Fatalf("ShouldBindJSON: %v", err)
	}
	if req.Username != "DUEÑA" || req.Password != "pin1234" {
		t.Fatalf("VerifyAdminRequest no mapea: %+v", req)
	}
}
