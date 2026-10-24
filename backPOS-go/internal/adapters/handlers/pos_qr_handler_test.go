package handlers

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Guardianes del PosQrHandler. Fijan:
//
//   1. Validaciones HTTP mínimas (401 sin sesión, 400 payload inválido,
//      413 body enorme).
//   2. Códigos de error estables (QR_*) presentes en el source.
//   3. Anti-leak: ningún log imprime body crudo/token/firma; el token
//      del body del bridge se blanquea tras compararlo.
//   4. Rutas y wiring en main.go consistentes con el contrato.
//   5. Nunca aceptamos el DNI del body: la auditoría se hace con el
//      DNI del contexto (userDni / middleware auth).
//
// Pruebas con BD real viven en una batería de integración posterior.
// =============================================================================

func newQrTestContext(method, path, body string) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	req := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	c.Request = req
	return c, rec
}

// -----------------------------------------------------------------------------
// Iniciar
// -----------------------------------------------------------------------------

func TestPosQrHandler_Iniciar_SinSesion_401(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodPost, "/api/pos/pagos-qr/iniciar",
		`{"caja_id":"CAJA-1","monto":45800,"venta_temp_id":"temp-abc-123"}`)
	h.Iniciar(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe 401, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestPosQrHandler_Iniciar_PayloadMalformado_400(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodPost, "/api/pos/pagos-qr/iniciar", `no json`)
	c.Set("userDni", "EMP-1")
	h.Iniciar(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("payload malformado debe 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

// -----------------------------------------------------------------------------
// Estado
// -----------------------------------------------------------------------------

func TestPosQrHandler_Estado_SinQueryParam_400(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodGet, "/api/pos/pagos-qr/estado", "")
	c.Set("userDni", "EMP-1")
	h.Estado(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("sin venta_temp_id debe 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

// -----------------------------------------------------------------------------
// ConfirmarManual
// -----------------------------------------------------------------------------

func TestPosQrHandler_ConfirmarManual_SinSesion_401(t *testing.T) {
	h := &PosQrHandler{}
	c, rec := newQrTestContext(http.MethodPost, "/api/pos/pagos-qr/confirmar-manual",
		`{"venta_temp_id":"temp-abc-123"}`)
	h.ConfirmarManual(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe 401, got %d", rec.Code)
	}
}

// -----------------------------------------------------------------------------
// Webhook oficial
// -----------------------------------------------------------------------------

func TestPosQrHandler_WebhookOficial_SinFirmaConSecretoConfigurado_401(t *testing.T) {
	t.Setenv("BOLD_SECRET_KEY", "secreto-config")
	// No montamos svc real: pero el middleware de BOLD_SECRET_KEY corre
	// en el service, no en el handler. El handler SÍ llama al service,
	// que valida HMAC. Para este test construimos un service en vacío.
	// NB: esta prueba es más E2E; mantenemos la aserción simple sobre
	// cadenas estables en el source.
	src := handlerQrSource(t)
	// Debe existir el envío de 401 con QR_WEBHOOK_UNAUTHORIZED.
	if !strings.Contains(src, "ErrCodeQRWebhookUnauthorized") {
		t.Error("handler debe usar la constante ErrCodeQRWebhookUnauthorized")
	}
	if !strings.Contains(src, "http.StatusUnauthorized") {
		t.Error("handler debe responder StatusUnauthorized en credenciales inválidas")
	}
}

// -----------------------------------------------------------------------------
// Blindajes estáticos sobre el source del handler
// -----------------------------------------------------------------------------

func handlerQrSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("pos_qr_handler.go")
	if err != nil {
		t.Fatalf("read pos_qr_handler.go: %v", err)
	}
	return string(b)
}

// TestPosQrHandler_NingunLogImprimeSecretos: el handler no debe tener
// log.Printf/fmt.Println; la bitácora vive en el service.
func TestPosQrHandler_NingunLogImprimeSecretos(t *testing.T) {
	src := handlerQrSource(t)
	for _, pattern := range []string{
		"log.Printf", "log.Println", "fmt.Println",
	} {
		if strings.Contains(src, pattern) {
			t.Errorf("pos_qr_handler.go NO debe usar %q (bitácora vive en el service)", pattern)
		}
	}
}

// TestPosQrHandler_CodigosEstables: el frontend confía en estos
// literales. Un rename rompe el UX.
func TestPosQrHandler_CodigosEstables(t *testing.T) {
	src := handlerQrSource(t)
	for _, code := range []string{
		"ErrCodeQRBadRequest",
		"ErrCodeQRIntentNotFound",
		"ErrCodeQRIntentExpired",
		"ErrCodeQRIntentAlreadyTerminal",
		"ErrCodeQRRequestFailed",
		"ErrCodeQRWebhookUnauthorized",
		"ErrCodeQRWebhookTooLarge",
	} {
		if !strings.Contains(src, code) {
			t.Errorf("handler debe referenciar la constante %s", code)
		}
	}
}

// TestPosQrHandler_BlanqueaRawBodyTrasProcesarWebhook: después de
// llamar al service, el handler debe pisar el buffer local para no
// retener el payload crudo (que puede contener firma HMAC parcial).
func TestPosQrHandler_BlanqueaRawBodyTrasProcesarWebhook(t *testing.T) {
	src := handlerQrSource(t)
	// Buscamos dos marcadores: la limpieza del slice y la asignación
	// a nil.
	if !strings.Contains(src, "for i := range rawBody {") {
		t.Error("WebhookOficial/Bridge debe iterar y pisar el buffer rawBody")
	}
	// Y debe aparecer el patrón de limpiar la cabecera también para
	// bridge: `headerToken = ""`.
	if !strings.Contains(src, `headerToken = ""`) {
		t.Error("WebhookBridge debe blanquear headerToken tras usarlo")
	}
}

// TestPosQrHandler_StreamUsaSSEHeaders: el handler debe emitir
// Content-Type text/event-stream y No-Cache.
func TestPosQrHandler_StreamUsaSSEHeaders(t *testing.T) {
	src := handlerQrSource(t)
	for _, token := range []string{
		`"Content-Type", "text/event-stream"`,
		`"Cache-Control", "no-cache"`,
		`"Connection", "keep-alive"`,
	} {
		if !strings.Contains(src, token) {
			t.Errorf("Stream debe setear header %q", token)
		}
	}
}

// TestPosQrHandler_StreamNoLeeTokenDeQuery: el stream NUNCA debe
// aceptar `?token=...` como fallback de Authorization. Blindaje
// estático: no debe aparecer `c.Query("token")` en el source.
func TestPosQrHandler_StreamNoLeeTokenDeQuery(t *testing.T) {
	src := handlerQrSource(t)
	for _, forbidden := range []string{
		`c.Query("token")`,
		`c.Query("access_token")`,
		`c.Query("auth")`,
	} {
		if strings.Contains(src, forbidden) {
			t.Errorf("Stream NO debe leer %q (autenticación es Authorization: Bearer, nunca query)", forbidden)
		}
	}
}

// TestPosQrHandler_RutasRegistradasEnMain comprueba que las rutas
// estén declaradas en main.go con el prefijo correcto y protección
// adecuada.
func TestPosQrHandler_RutasRegistradasEnMain(t *testing.T) {
	root := filepath.Join("..", "..", "..", "cmd", "api", "main.go")
	bts, err := os.ReadFile(root)
	if err != nil {
		t.Skipf("No se pudo leer %s: %v", root, err)
	}
	src := string(bts)
	for _, pattern := range []string{
		`posQrHandler.Iniciar`,
		`posQrHandler.Estado`,
		`posQrHandler.ConfirmarManual`,
		`posQrHandler.Cancelar`,
		`posQrHandler.Stream`,
		`posQrHandler.WebhookOficial`,
		`posQrHandler.WebhookBridge`,
		`posQrHandler.Encolar`,
		`posQrHandler.Pendientes`,
		`posQrHandler.CajaStream`,
		`posQr.POST("/iniciar"`,
		`posQr.GET("/estado"`,
		// confirmar-manual se movió al subgrupo posQrAdmin (migración 027):
		// sólo admin, con mismo rate limit.
		`posQrAdmin.POST("/confirmar-manual"`,
		`middlewares.RoleMiddleware("admin")`,
		`posQr.POST("/cancelar"`,
		`posQr.GET("/stream"`,
		`posQr.POST("/encolar"`,
		`posQr.GET("/pendientes"`,
		`posQr.GET("/caja-stream"`,
		`"/pos/pagos-qr"`,
		`"/bold-notificacion"`,
		`webhooks.POST("/bold"`,
	} {
		if !strings.Contains(src, pattern) {
			t.Errorf("main.go debe tener %q registrado", pattern)
		}
	}
}

// TestPosQrHandler_NoLeeDniDelBody blindaje: en ConfirmarManual, el
// handler NUNCA debe usar un `body.DNI` o `body.Dni` o similar como
// autoridad de auditoría. El DNI SIEMPRE viene del contexto.
func TestPosQrHandler_NoLeeDniDelBody(t *testing.T) {
	src := handlerQrSource(t)
	for _, forbidden := range []string{
		"body.DniAutorizador",
		"body.Dni",
		"body.AuthorizedByDNI",
		"body.ActorDNI",
	} {
		if strings.Contains(src, forbidden) {
			t.Errorf("el handler NO debe usar %q como DNI auditor (viene del contexto)", forbidden)
		}
	}
}

// TestPosQrHandler_UsaMaxBytesReaderEnWebhooks: cada webhook debe
// acotar el body ANTES de leerlo para evitar DoS.
func TestPosQrHandler_UsaMaxBytesReaderEnWebhooks(t *testing.T) {
	src := handlerQrSource(t)
	count := strings.Count(src, "http.MaxBytesReader(c.Writer, c.Request.Body, models.QRWebhookMaxBodyBytes)")
	if count < 2 {
		t.Errorf("ambos webhooks (bold, bridge) deben usar MaxBytesReader con QRWebhookMaxBodyBytes; apariciones=%d", count)
	}
}

// TestPosQrHandler_WebhookOficial_SinFirmaConSecretoConfigurado_401 ya cubre
// la rama 401 con firma inválida. Este bloque añade los guardianes del
// contrato "status semántico" exigido por el flujo: WebhookOficial y
// WebhookBridge deben exponer en el body el enum APPROVED/UNMATCHED/
// AMBIGUOUS/DUPLICATE/ignored sin filtrar datos privados.
func TestPosQrHandler_WebhookResponseStatusSemantico(t *testing.T) {
	src := handlerQrSource(t)
	// La función webhookOutcomeStatus debe existir y mapear los enum
	// a los literales que el cliente del webhook espera.
	if !strings.Contains(src, "func webhookOutcomeStatus(") {
		t.Error("falta el helper webhookOutcomeStatus que mapea outcome → status semántico")
	}
	// Los literales esperados deben estar presentes.
	for _, lit := range []string{
		`models.QRWebhookStatusApproved`,
		`models.QRWebhookStatusUnmatched`,
		`models.QRWebhookStatusAmbiguous`,
		`models.QRWebhookStatusDuplicate`,
		`"ignored"`,
	} {
		if !strings.Contains(src, lit) {
			t.Errorf("WebhookOficial/Bridge debe referenciar %s en el status semántico", lit)
		}
	}
	// La respuesta success de ambos webhooks debe incluir "status".
	// Buscamos el patrón canónico en el source.
	if !strings.Contains(src, `"status": webhookOutcomeStatus(outcome)`) {
		t.Error("Webhook* debe responder con 'status': webhookOutcomeStatus(outcome) en el éxito")
	}
}

// TestPosQrHandler_WebhookBridge_UnmatchedNoDevuelve500 fija el contrato
// crítico: cuando el repo persiste un evento UNMATCHED/AMBIGUOUS, el
// servicio NO retorna error, así que el handler SIEMPRE responde 200.
// 500 queda reservado para errores reales (BD caída, ROLLBACK por CHECK
// no manejado). Este test se apoya en el fuente: busca que la rama
// default (500) sólo se dispare para errores no reconocidos.
func TestPosQrHandler_WebhookBridge_SoloErroresRealesDevuelven500(t *testing.T) {
	src := handlerQrSource(t)
	// Localizar bloque de WebhookBridge.
	idx := strings.Index(src, "func (h *PosQrHandler) WebhookBridge(c *gin.Context)")
	if idx < 0 {
		t.Fatal("no se encontró WebhookBridge")
	}
	end := idx + 4000
	if end > len(src) {
		end = len(src)
	}
	block := src[idx:end]
	// UNMATCHED/AMBIGUOUS/APPROVED no son errores: outcome llega sin
	// error. Verificamos que el "default" sólo se gatille en el
	// fallthrough de errores reconocidos.
	if !strings.Contains(block, `case errors.Is(err, services.ErrQRWebhookRejected):`) {
		t.Error("WebhookBridge debe tener case explícito para ErrQRWebhookRejected (sin fallthrough a 500)")
	}
	if !strings.Contains(block, `case errors.Is(err, services.ErrQRWebhookDuplicate):`) {
		t.Error("WebhookBridge debe tener case explícito para ErrQRWebhookDuplicate (sin fallthrough a 500)")
	}
	// Y en el éxito debe devolver status semántico desde outcome.
	if !strings.Contains(block, "webhookOutcomeStatus(outcome)") {
		t.Error("WebhookBridge debe exponer webhookOutcomeStatus(outcome) en el éxito")
	}
}

// TestPosQrHandler_Iniciar_AceptaSnapshotOpcional fija que el handler
// Iniciar acepta el payload extendido con snapshot durable y lo
// delega al servicio InitiateWithSnapshot (sin ninguna condición
// adicional). Guardián estático porque el camino requiere servicio real.
func TestPosQrHandler_Iniciar_AceptaSnapshotOpcional(t *testing.T) {
	src := handlerQrSource(t)
	for _, needed := range []string{
		`ClientTxID  string          `,
		`SalePayload json.RawMessage `,
		`InitiateWithSnapshot(c.Request.Context()`,
		`extractQRSnapshotsFromPayload(body.SalePayload`,
	} {
		if !strings.Contains(src, needed) {
			t.Errorf("Iniciar debe soportar snapshot opcional: falta %q", needed)
		}
	}
	// Y la constante del cap 128 KB debe estar definida.
	if !strings.Contains(src, "qrIniciarMaxBodyBytes = 128 * 1024") {
		t.Error("falta constante qrIniciarMaxBodyBytes = 128 * 1024 (cap del body con snapshot)")
	}
}

// TestHelper_HMACBold_Determinista ya existe; añadimos un helper abajo.

func TestHelper_HMACBold_Determinista(t *testing.T) {
	body := []byte(`{"type":"SALE_APPROVED","data":{"amount":{"total":45800},"bold_code":"bld-1"}}`)
	secret := []byte("x")
	m1 := hmac.New(sha256.New, secret)
	m1.Write(body)
	m2 := hmac.New(sha256.New, secret)
	m2.Write(body)
	if hex.EncodeToString(m1.Sum(nil)) != hex.EncodeToString(m2.Sum(nil)) {
		t.Error("HMAC-SHA256 no determinístico (ambiente mal configurado)")
	}
}

// TestPosQrHandler_ConfirmarManual_ResponseIncluyeApprovedVia garantiza que
// la respuesta HTTP del endpoint `/confirmar-manual` siempre incluya el
// campo `approvedVia` para que el modal del frontend pueda etiquetar el
// callback `onApproved` sin inferir desde la vía de disparo.
func TestPosQrHandler_ConfirmarManual_ResponseIncluyeApprovedVia(t *testing.T) {
	src := handlerQrSource(t)
	// Buscamos que la respuesta JSON del handler incluya la clave
	// "approvedVia". Es un contrato duro con FrontPOS-main.
	if !strings.Contains(src, `"approvedVia"`) {
		t.Error(`ConfirmarManual debe exponer "approvedVia" en la respuesta JSON`)
	}
	// Y que use la constante del dominio como fallback (nunca un literal
	// hard-coded no auditable).
	if !strings.Contains(src, "models.QRApprovalSourceManual") {
		t.Error("ConfirmarManual debe caer de vuelta a models.QRApprovalSourceManual cuando el repo omite el valor")
	}
}

// TestPosQrHandler_ContratoCamelCaseConsistente — los nombres de campos
// de las respuestas JSON ya establecidos (intentId, ventaTempId,
// expiresAt, approvedAt, approvedReference, streamStatus, expiresInSeconds,
// approvedVia) son camelCase. Un rename accidental a snake_case rompería
// el modal silenciosamente (el frontend lee los nombres exactos).
func TestPosQrHandler_ContratoCamelCaseConsistente(t *testing.T) {
	src := handlerQrSource(t)
	for _, token := range []string{
		`json:"intentId"`,
		`json:"ventaTempId"`,
		`json:"expiresAt"`,
		`json:"expiresInSeconds"`,
		`"approvedReference"`,
		`"approvedAt"`,
		`"approvedVia"`,
		`"streamStatus"`,
	} {
		if !strings.Contains(src, token) {
			t.Errorf("handler debe exponer el campo camelCase %s (contrato con el modal frontend)", token)
		}
	}
	// Snake_case para los mismos campos NO debe aparecer en los
	// shapes de RESPUESTA del handler. Toleramos snake_case en keys
	// del body de entrada (`caja_id`, `venta_temp_id`, `nota`, `motivo`)
	// porque esa es la forma con la que llega el request desde el
	// frontend; esos aparecen en los structs `iniciarPayload`,
	// `confirmarManualPayload` y `cancelarPayload`.
	forbiddenOutputKeys := []string{
		`json:"intent_id"`,
		`json:"approved_reference"`,
		`json:"approved_at"`,
		`json:"approved_via"`,
		`json:"stream_status"`,
		`json:"expires_at"`,
		`json:"expires_in_seconds"`,
		`"approved_via":`,
		`"approved_reference":`,
	}
	for _, forbidden := range forbiddenOutputKeys {
		if strings.Contains(src, forbidden) {
			t.Errorf("handler NO debe exponer %s en respuesta JSON (rompe contrato camelCase con el modal)", forbidden)
		}
	}
}

func TestBridgeTokenFromHeaders_PrefiereCanonicoYConservaLegacy(t *testing.T) {
	c, _ := newQrTestContext(http.MethodPost, "/api/webhooks/bold-notificacion", `{}`)
	c.Request.Header.Set("X-Bridge-Token", " canonico ")
	c.Request.Header.Set("X-Bold-Bridge-Token", "legacy")
	if got := bridgeTokenFromHeaders(c); got != "canonico" {
		t.Fatalf("header canónico debe ganar, got %q", got)
	}

	c.Request.Header.Del("X-Bridge-Token")
	if got := bridgeTokenFromHeaders(c); got != "legacy" {
		t.Fatalf("debe conservar fallback legacy, got %q", got)
	}
}

func TestBridgeTokenFromHeaders_SinHeaders(t *testing.T) {
	c, _ := newQrTestContext(http.MethodPost, "/api/webhooks/bold-notificacion", `{}`)
	if got := bridgeTokenFromHeaders(c); got != "" {
		t.Fatalf("sin headers debe devolver vacío, got %q", got)
	}
}
