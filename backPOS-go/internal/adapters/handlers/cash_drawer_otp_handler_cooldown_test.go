package handlers

import (
	"errors"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/services"
)

// =============================================================================
// Regresiones del handler OTP de cajón.
//
// Fijan tres contratos:
//
//   1. Request con JSON malformado → 400 (antes se tragaba con
//      `_ = c.ShouldBindJSON(&body)` y seguía al servicio, que
//      acababa devolviendo 500).
//
//   2. Request con body vacío o `{}` → NO responde 400. El contrato
//      permite ambas formas canónicas desde el cliente.
//
//   3. Request traduce el error de cooldown del servicio a 429 con
//      código estable `DRAWER_OTP_COOLDOWN` y cabecera `Retry-After`.
// =============================================================================

// -----------------------------------------------------------------------------
// Request: 400 ante JSON malformado
// -----------------------------------------------------------------------------

// Antes, Request hacía `_ = c.ShouldBindJSON(&body)`: cualquier basura
// se silenciaba y el flujo seguía como si el body hubiera sido válido.
// Un cliente con un error de serialización no se daba cuenta hasta
// recibir un 500 corriente abajo. Ahora cualquier cuerpo no vacío que
// no sea JSON válido devuelve 400 explícito.
func TestCashDrawerOTPHandler_Request_PayloadMalformado_400(t *testing.T) {
	h := &CashDrawerOTPHandler{svc: nil}
	c, rec := newOTPTestContext(http.MethodPost, "/api/cash-drawer/otp/request", `not json`)
	c.Set("userDni", "EMP-1")
	h.Request(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("Request con body malformado debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ERR_BAD_REQUEST") {
		t.Errorf("Request con body malformado debe incluir el código genérico ERR_BAD_REQUEST; body=%s", rec.Body.String())
	}
}

// Request con body vacío (ContentLength=0) debe caer a la rama de
// servicio, NO al 400. Nunca llegará al 200 porque `svc=nil` detiene
// la ejecución con panic — así que verificamos la ausencia de 400 en
// otra prueba (estática, abajo).
func TestCashDrawerOTPHandler_Request_BodyVacioNoDa400(t *testing.T) {
	h := &CashDrawerOTPHandler{svc: nil}
	c, rec := newOTPTestContext(http.MethodPost, "/api/cash-drawer/otp/request", "")
	c.Set("userDni", "EMP-1")

	// Si llegamos a `h.svc.RequestChallenge` con svc=nil, panics.
	// Protegemos con recover para que la prueba sólo mida el shape
	// hasta antes de ese punto.
	defer func() {
		_ = recover()
		if rec.Code == http.StatusBadRequest {
			t.Errorf("body vacío NO debe devolver 400; got %d (body=%s)", rec.Code, rec.Body.String())
		}
	}()
	h.Request(c)
}

// `{}` es JSON válido (payload nulo) y el handler debe tratarlo como
// un body opcional sin campos — nunca con 400.
func TestCashDrawerOTPHandler_Request_BodyObjetoVacioNoDa400(t *testing.T) {
	h := &CashDrawerOTPHandler{svc: nil}
	c, rec := newOTPTestContext(http.MethodPost, "/api/cash-drawer/otp/request", `{}`)
	c.Set("userDni", "EMP-1")

	defer func() {
		_ = recover()
		if rec.Code == http.StatusBadRequest {
			t.Errorf("`{}` NO debe devolver 400; got %d (body=%s)", rec.Code, rec.Body.String())
		}
	}()
	h.Request(c)
}

// -----------------------------------------------------------------------------
// Cooldown: código estable y helper del Retry-After
// -----------------------------------------------------------------------------

// Fija que el handler referencia la constante del dominio
// `ErrCodeOTPCooldownActive` como código estable. Un rename del
// literal rompería la rama del modal shadcn en el frontend.
func TestCashDrawerOTPHandler_CodigoEstable_Cooldown(t *testing.T) {
	src := handlerSource(t)
	if !strings.Contains(src, "ErrCodeOTPCooldownActive") {
		t.Error("handler debe referenciar la constante models.ErrCodeOTPCooldownActive para el 429 de cooldown")
	}
	// Y debe incluir el 429 propiamente dicho.
	if !strings.Contains(src, "http.StatusTooManyRequests") {
		t.Error("handler debe devolver 429 (StatusTooManyRequests) ante cooldown")
	}
	// Debe setear la cabecera Retry-After.
	if !strings.Contains(src, `c.Header("Retry-After"`) {
		t.Error("handler debe setear la cabecera Retry-After en 429 de cooldown")
	}
	// Y responder con la rama de servicios.ErrOTPCooldown.
	if !strings.Contains(src, "services.ErrOTPCooldown") {
		t.Error("handler debe comparar contra services.ErrOTPCooldown para traducir a 429")
	}
}

// Prueba el helper `cooldownRetryAfterSeconds` por fuera del flujo HTTP:
// debe ser robusto a (a) error que no envuelve el tipo específico, (b)
// error con RetryAfter negativo o cero, y (c) ceil correcto a segundos.
func TestCashDrawerOTPHandler_CooldownRetryAfterHelper(t *testing.T) {
	// Fallback cuando el error NO es el tipo esperado: devuelve el
	// cooldown completo del dominio (12s si no cambió la constante).
	if got := cooldownRetryAfterSeconds(errors.New("otro error")); got <= 0 {
		t.Errorf("fallback debe devolver un entero >0; got %d", got)
	}

	// Fallback cuando RetryAfter es 0.
	if got := cooldownRetryAfterSeconds(&services.OTPCooldownError{RetryAfter: 0}); got <= 0 {
		t.Errorf("RetryAfter=0 debe caer al fallback; got %d", got)
	}

	// Ceil estricto: 500ms → 1s; 1s exacto → 1s; 1.1s → 2s.
	cases := []struct {
		in   time.Duration
		want int
	}{
		{500 * time.Millisecond, 1},
		{1 * time.Second, 1},
		{1100 * time.Millisecond, 2},
		{11*time.Second + 999*time.Millisecond, 12},
		{12 * time.Second, 12},
	}
	for _, tc := range cases {
		got := cooldownRetryAfterSeconds(&services.OTPCooldownError{RetryAfter: tc.in})
		if got != tc.want {
			t.Errorf("ceil(%v) → %d; want %d", tc.in, got, tc.want)
		}
	}
}

// -----------------------------------------------------------------------------
// Guardianes anti-leak sobre el response de cooldown
// -----------------------------------------------------------------------------

// El cuerpo del 429 no debe revelar cuándo exactamente se emitió el
// OTP anterior ni el challengeId pendiente: sólo cuántos segundos
// faltan para reintentar. El mensaje debe estar escrito sin filtrar
// esa información.
func TestCashDrawerOTPHandler_Cooldown_MensajeSinSecretos(t *testing.T) {
	src := handlerSource(t)

	// Localizamos la rama del case Cooldown y hacemos un snapshot.
	caseRe := regexp.MustCompile(`(?s)case\s+errors\.Is\(err,\s+services\.ErrOTPCooldown\):(.*?)case\s+errors\.Is`)
	m := caseRe.FindStringSubmatch(src)
	if len(m) < 2 {
		t.Fatal("no se pudo delimitar el case de ErrOTPCooldown en Request")
	}
	branch := m[1]

	// Prohibido: filtrar hora de emisión original, challenge previo o
	// nombre del actor en el mensaje. También prohibido echo del OTP.
	for _, forbidden := range []string{
		"challengeId", "challenge_id", "ChallengeID",
		"createdAt", "created_at",
		`"otp"`, `"OTP"`,
	} {
		if strings.Contains(branch, forbidden) {
			t.Errorf("el case de cooldown NO debe incluir %q (secret-leak)", forbidden)
		}
	}
}
