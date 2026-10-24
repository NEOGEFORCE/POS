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
// Guardianes del CashDrawerOTPHandler.
//
// Fijan tres contratos:
//
//   1. Shape HTTP: 401 sin sesión, 400 sin body, delegación al servicio
//      sólo cuando los validadores básicos pasan.
//
//   2. Contrato de códigos de error: los literales DRAWER_OTP_* deben
//      aparecer textuales en el handler para que el frontend los
//      detecte sin ambigüedad.
//
//   3. Anti-leak del OTP: el handler NUNCA debe loguear el valor del
//      OTP, ni devolverlo en la respuesta, ni interpolarlo en errores.
//
// La BD real no se toca aquí; las pruebas con tx viven en el repo y
// las de orquestación en el service.
// =============================================================================

func newOTPTestContext(method, path, body string) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	req := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	c.Request = req
	return c, rec
}

// -----------------------------------------------------------------------------
// Request handler
// -----------------------------------------------------------------------------

func TestCashDrawerOTPHandler_Request_SinSesion_401(t *testing.T) {
	h := &CashDrawerOTPHandler{svc: nil}
	c, rec := newOTPTestContext(http.MethodPost, "/api/cash-drawer/otp/request", "{}")
	// Sin userDni / role en el contexto: emula bypass del middleware.
	h.Request(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("Request sin sesión debe devolver 401, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

// -----------------------------------------------------------------------------
// Confirm handler
// -----------------------------------------------------------------------------

func TestCashDrawerOTPHandler_Confirm_SinSesion_401(t *testing.T) {
	h := &CashDrawerOTPHandler{svc: nil}
	c, rec := newOTPTestContext(http.MethodPost, "/api/cash-drawer/otp/confirm", `{"challengeId":"a","otp":"123456"}`)
	h.Confirm(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("Confirm sin sesión debe devolver 401, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestCashDrawerOTPHandler_Confirm_SinOTP_400(t *testing.T) {
	h := &CashDrawerOTPHandler{svc: nil}
	c, rec := newOTPTestContext(http.MethodPost, "/api/cash-drawer/otp/confirm", `{"challengeId":"abc"}`)
	c.Set("userDni", "EMP-1")
	h.Confirm(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("Confirm sin OTP debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	// El código del error debe ser el genérico BAD_REQUEST (no un
	// DRAWER_OTP_* porque la validación profunda sucede en el servicio).
	if !strings.Contains(rec.Body.String(), "obligatorios") {
		t.Errorf("Confirm sin OTP debe explicar que faltan campos; body=%s", rec.Body.String())
	}
}

func TestCashDrawerOTPHandler_Confirm_PayloadMalformado_400(t *testing.T) {
	h := &CashDrawerOTPHandler{svc: nil}
	c, rec := newOTPTestContext(http.MethodPost, "/api/cash-drawer/otp/confirm", `not json`)
	c.Set("userDni", "EMP-1")
	h.Confirm(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("Confirm con body malformado debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

// -----------------------------------------------------------------------------
// Guardianes estáticos sobre el source del handler
// -----------------------------------------------------------------------------

// handlerSource devuelve el source del handler para los guards.
func handlerSource(t *testing.T) string {
	t.Helper()
	bts, err := os.ReadFile("cash_drawer_otp_handler.go")
	if err != nil {
		t.Fatalf("read cash_drawer_otp_handler.go: %v", err)
	}
	return string(bts)
}

// TestCashDrawerOTPHandler_NingunLogImprimeOTP: ninguna llamada a
// log.Printf del handler puede interpolar el OTP.
func TestCashDrawerOTPHandler_NingunLogImprimeOTP(t *testing.T) {
	src := handlerSource(t)
	// Ningún log directo en el handler: toda la auditoría la hace el
	// servicio, que ya tiene su propio guardian anti-leak.
	for _, pattern := range []string{
		"log.Printf", "log.Println", "fmt.Println",
	} {
		if strings.Contains(src, pattern) {
			t.Errorf("cash_drawer_otp_handler.go NO debe usar %q (toda bitácora vive en el service, sin OTP)", pattern)
		}
	}
}

// TestCashDrawerOTPHandler_RespuestaNoContieneOTP: inspección estática
// sobre las respuestas (gin.H / struct responses) para asegurar que no
// hay ningún campo "otp" devuelto al cliente.
func TestCashDrawerOTPHandler_RespuestaNoContieneOTP(t *testing.T) {
	src := handlerSource(t)
	// Prohibido en el response: cualquier campo literal "otp".
	for _, forbidden := range []string{
		`"otp":`,
		`"OTP":`,
	} {
		if strings.Contains(src, forbidden) {
			t.Errorf("el handler NO debe devolver el OTP en el response: encontrado %q", forbidden)
		}
	}
	// El OTP SÍ se pasa a `svc.ConfirmChallenge`, que es legítimo. Nos
	// aseguramos de que esa es la única salida de la variable: fuera
	// del servicio, no debe aparecer en gin.H ni en construcciones del
	// response. Verificamos buscando `body.OTP` sólo en el bloque que
	// construye el response de 200.
	rspBodyRe := regexp.MustCompile(`(?s)c\.JSON\(http\.StatusOK,\s*confirmChallengeResponse\{.*?\}\)`)
	match := rspBodyRe.FindString(src)
	if match == "" {
		t.Fatal("no se pudo encontrar el bloque de response 200 de Confirm")
	}
	if strings.Contains(match, "OTP") || strings.Contains(match, "otp") {
		t.Errorf("el response 200 NO debe contener la variable OTP: %q", match)
	}
}

// TestCashDrawerOTPHandler_CodigosEstables fija los literales que el
// frontend busca para distinguir ramas del flujo.
func TestCashDrawerOTPHandler_CodigosEstables(t *testing.T) {
	src := handlerSource(t)
	for _, code := range []string{
		"ErrCodeOTPTelegramUnavailable",
		"ErrCodeOTPRequestFailed",
		"ErrCodeOTPFormatInvalid",
		"ErrCodeOTPChallengeNotFound",
		"ErrCodeOTPChallengeWrongActor",
		"ErrCodeOTPChallengeExpired",
		"ErrCodeOTPChallengeExhausted",
		"ErrCodeOTPChallengeAlreadyUsed",
		"ErrCodeOTPChallengeInvalid",
	} {
		if !strings.Contains(src, code) {
			t.Errorf("handler debe referenciar la constante %s", code)
		}
	}
}

// TestCashDrawerOTPHandler_RutasRegistradasEnMain comprueba que las dos
// rutas estén declaradas dentro del grupo con el rate limiter específico.
func TestCashDrawerOTPHandler_RutasRegistradasEnMain(t *testing.T) {
	root := filepath.Join("..", "..", "..", "cmd", "api", "main.go")
	bts, err := os.ReadFile(root)
	if err != nil {
		t.Skipf("No se pudo leer %s: %v", root, err)
	}
	src := string(bts)
	for _, pattern := range []string{
		`cashDrawerOTP := protected.Group("/cash-drawer/otp")`,
		`cashDrawerOTP.Use(middlewares.RateLimitMiddleware(`,
		`cashDrawerOTP.POST("/request", cashDrawerOTPHandler.Request)`,
		`cashDrawerOTP.POST("/confirm", cashDrawerOTPHandler.Confirm)`,
	} {
		if !strings.Contains(src, pattern) {
			t.Errorf("main.go debe tener %q registrado dentro del grupo OTP con rate limiter",
				pattern)
		}
	}
}

// TestCashDrawerOTPHandler_ConfirmTieneBlindajeDeOTP comprueba que el
// cuerpo de Confirm anula el OTP del struct en memoria con un `defer`,
// para que un panic recoverer que loguee la petición no lo exponga.
func TestCashDrawerOTPHandler_ConfirmTieneBlindajeDeOTP(t *testing.T) {
	src := handlerSource(t)
	bodyRe := regexp.MustCompile(`(?s)func\s+\(h\s+\*CashDrawerOTPHandler\)\s+Confirm\s*\(c\s+\*gin\.Context\)\s*\{.*?\n\}\s*\n`)
	body := bodyRe.FindString(src)
	if body == "" {
		t.Fatal("no se pudo delimitar el cuerpo de Confirm")
	}
	if !strings.Contains(body, "defer func() { body.OTP = \"\" }()") {
		t.Error("Confirm debe anular body.OTP en un defer (blindaje anti-leak si hay panic recoverer)")
	}
}

// =============================================================================
// Decodificación del payload — los nombres JSON son parte del contrato
// con el frontend. Un rename accidental deja al modal sin forma de
// enviar/recibir OTP.
// =============================================================================

func TestCashDrawerOTPHandler_PayloadsDecodeConContratoEstable(t *testing.T) {
	var confirm confirmChallengePayload
	raw := `{"challengeId":"abc","otp":"123456","note":"devolver cambio"}`
	if err := json.Unmarshal([]byte(raw), &confirm); err != nil {
		t.Fatalf("confirmChallengePayload no decodifica: %v", err)
	}
	if confirm.ChallengeID != "abc" || confirm.OTP != "123456" || confirm.Note != "devolver cambio" {
		t.Fatalf("confirmChallengePayload mapea mal los campos: %+v", confirm)
	}

	// El request body puede traer `note` opcional; vacío es válido.
	var reqBody requestChallengePayload
	if err := json.Unmarshal([]byte(`{"note":"vueltas"}`), &reqBody); err != nil {
		t.Fatalf("requestChallengePayload no decodifica: %v", err)
	}
	if reqBody.Note != "vueltas" {
		t.Fatalf("requestChallengePayload.note mapea mal: %+v", reqBody)
	}
}

// TestCashDrawerOTPHandler_ResponseContieneDriverAvailableYMensajeDeBridge:
// el 200 OK debe informar que el pulso físico sale por el bridge, no
// por este endpoint. Mismo contrato que /cash-drawer/open.
func TestCashDrawerOTPHandler_ResponseContieneDriverAvailableYMensajeDeBridge(t *testing.T) {
	src := handlerSource(t)
	for _, token := range []string{
		`"driverAvailable"`,
		"bridge local",
		"kickDrawer",
	} {
		if !strings.Contains(src, token) {
			t.Errorf("el response 200 debe mencionar %q (el pulso físico lo manda el bridge)", token)
		}
	}
}
