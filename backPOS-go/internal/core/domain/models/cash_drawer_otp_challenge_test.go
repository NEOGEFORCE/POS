package models

import (
	"strings"
	"testing"
	"time"
)

// =============================================================================
// Validaciones de shape sobre el OTP y el challenge_id. Fijan el contrato
// con el handler: inputs malformados se rechazan en el servicio ANTES de
// abrir una transacción, para no gastar un intento.
// =============================================================================

func TestIsValidCashDrawerOTPFormat_AceptaExactamenteSeisDigitos(t *testing.T) {
	cases := []struct {
		input string
		ok    bool
		why   string
	}{
		{"000000", true, "ceros son válidos (padding por la izquierda)"},
		{"123456", true, "6 dígitos típicos"},
		{"999999", true, "techo del espacio"},
		{"", false, "vacío inválido"},
		{"12345", false, "5 dígitos — demasiado corto"},
		{"1234567", false, "7 dígitos — demasiado largo"},
		{"12345a", false, "letra prohibida"},
		{"abcdef", false, "sólo letras"},
		{" 123456", false, "espacio por delante — el servicio hace trim antes, aquí es puro"},
		{"123 456", false, "espacio en medio prohibido"},
		{"123.456", false, "signos prohibidos"},
		{"−123456", false, "signo unicode prohibido"},
		{"١٢٣٤٥٦", false, "dígitos arábigos no ASCII"},
	}
	for _, c := range cases {
		if got := IsValidCashDrawerOTPFormat(c.input); got != c.ok {
			t.Errorf("IsValidCashDrawerOTPFormat(%q) = %v, want %v (%s)", c.input, got, c.ok, c.why)
		}
	}
}

func TestIsValidCashDrawerChallengeID_AceptaHexExclusivamente(t *testing.T) {
	cases := []struct {
		input string
		ok    bool
	}{
		{strings.Repeat("a", 64), true},
		{strings.Repeat("f", 32), true},
		{strings.Repeat("0", 64), true},
		{strings.Repeat("A", 48), true},
		{"", false},
		{strings.Repeat("a", 31), false},
		{strings.Repeat("a", 65), false},
		{strings.Repeat("g", 64), false},
		{"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", false},
		{strings.Repeat("ab-", 20), false},
	}
	for _, c := range cases {
		if got := IsValidCashDrawerChallengeID(c.input); got != c.ok {
			t.Errorf("IsValidCashDrawerChallengeID(%q) = %v, want %v", c.input, got, c.ok)
		}
	}
}

// =============================================================================
// Validaciones del enum de status. Replican el CHECK ck_cdoc_status_known.
// =============================================================================

func TestIsValidCashDrawerOTPStatus_EspejoDelCHECK(t *testing.T) {
	allowed := []string{"PENDING", "CONSUMED", "FAILED", "EXPIRED", "CANCELLED"}
	for _, s := range allowed {
		if !IsValidCashDrawerOTPStatus(s) {
			t.Errorf("status %q debe ser válido (CHECK ck_cdoc_status_known)", s)
		}
	}
	for _, bad := range []string{"", "pending", "DONE", "USED", "unknown"} {
		if IsValidCashDrawerOTPStatus(bad) {
			t.Errorf("status %q NO debe ser válido", bad)
		}
	}
}

// =============================================================================
// IsLive refleja la combinación status=PENDING ∧ expiración futura ∧
// attempts < max. Un typo acá llevaría a aceptar un challenge agotado.
// =============================================================================

func TestCashDrawerOTPChallenge_IsLive(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	future := now.Add(60 * time.Second)
	past := now.Add(-1 * time.Second)

	cases := []struct {
		name string
		row  CashDrawerOTPChallenge
		want bool
	}{
		{
			name: "live con todos los flags en orden",
			row:  CashDrawerOTPChallenge{Status: "PENDING", ExpiresAt: future, AttemptsUsed: 0, AttemptsMax: 3},
			want: true,
		},
		{
			name: "status FAILED mata",
			row:  CashDrawerOTPChallenge{Status: "FAILED", ExpiresAt: future, AttemptsUsed: 3, AttemptsMax: 3},
			want: false,
		},
		{
			name: "status CONSUMED mata",
			row:  CashDrawerOTPChallenge{Status: "CONSUMED", ExpiresAt: future, AttemptsUsed: 1, AttemptsMax: 3},
			want: false,
		},
		{
			name: "status CANCELLED mata",
			row:  CashDrawerOTPChallenge{Status: "CANCELLED", ExpiresAt: future, AttemptsUsed: 0, AttemptsMax: 3},
			want: false,
		},
		{
			name: "expiración pasada mata aunque status sea PENDING",
			row:  CashDrawerOTPChallenge{Status: "PENDING", ExpiresAt: past, AttemptsUsed: 0, AttemptsMax: 3},
			want: false,
		},
		{
			name: "attempts al techo mata aunque status sea PENDING",
			row:  CashDrawerOTPChallenge{Status: "PENDING", ExpiresAt: future, AttemptsUsed: 3, AttemptsMax: 3},
			want: false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := c.row.IsLive(now)
			if got != c.want {
				t.Errorf("IsLive() = %v, want %v", got, c.want)
			}
		})
	}

	// nil-safe: un *CashDrawerOTPChallenge nulo nunca debe panic.
	var nilRow *CashDrawerOTPChallenge
	if nilRow.IsLive(now) {
		t.Error("un *CashDrawerOTPChallenge nulo NO debe ser 'live'")
	}
}

// TestCashDrawerOTPChallenge_IsExhausted — espejo del CHECK bound
// attempts_used <= attempts_max.
func TestCashDrawerOTPChallenge_IsExhausted(t *testing.T) {
	row := &CashDrawerOTPChallenge{AttemptsUsed: 0, AttemptsMax: 3}
	if row.IsExhausted() {
		t.Error("0 de 3 no debe ser exhausted")
	}
	row.AttemptsUsed = 2
	if row.IsExhausted() {
		t.Error("2 de 3 no debe ser exhausted")
	}
	row.AttemptsUsed = 3
	if !row.IsExhausted() {
		t.Error("3 de 3 debe ser exhausted")
	}
}

// =============================================================================
// Constantes del protocolo. Un cambio accidental acá rompe la UI y la
// migración 025 (que fija defaults en la BD). Si alguien los toca, este
// test obliga a revisarlos.
// =============================================================================

func TestCashDrawerOTPConstants_FijanElContratoOperativo(t *testing.T) {
	if CashDrawerOTPLength != 6 {
		t.Errorf("CashDrawerOTPLength = %d, el frontend y el regex esperan 6", CashDrawerOTPLength)
	}
	if CashDrawerOTPDefaultTTL != 90*time.Second {
		t.Errorf("CashDrawerOTPDefaultTTL = %v, el spec fija 90s", CashDrawerOTPDefaultTTL)
	}
	if CashDrawerOTPDefaultMaxAttempts != 3 {
		t.Errorf("CashDrawerOTPDefaultMaxAttempts = %d, la migración 025 pone default 3",
			CashDrawerOTPDefaultMaxAttempts)
	}
	if CashDrawerOTPChallengeIDHexLen != 64 {
		t.Errorf("CashDrawerOTPChallengeIDHexLen = %d, VARCHAR(64) de la 025 lo acomoda",
			CashDrawerOTPChallengeIDHexLen)
	}
}

// =============================================================================
// Códigos estables contrato con el frontend. Un rename deja a la UI sin
// forma de distinguir "OTP inválido" de "OTP expirado" o "Telegram caído".
// =============================================================================

func TestCashDrawerOTPErrorCodes_SonLiteralesEstables(t *testing.T) {
	expected := map[string]string{
		"ErrCodeOTPChallengeNotFound":    "DRAWER_OTP_NOT_FOUND",
		"ErrCodeOTPChallengeWrongActor":  "DRAWER_OTP_WRONG_ACTOR",
		"ErrCodeOTPChallengeExpired":     "DRAWER_OTP_EXPIRED",
		"ErrCodeOTPChallengeExhausted":   "DRAWER_OTP_ATTEMPTS_EXHAUSTED",
		"ErrCodeOTPChallengeInvalid":     "DRAWER_OTP_INVALID",
		"ErrCodeOTPChallengeAlreadyUsed": "DRAWER_OTP_ALREADY_USED",
		"ErrCodeOTPChallengeCancelled":   "DRAWER_OTP_CANCELLED",
		"ErrCodeOTPTelegramUnavailable":  "DRAWER_OTP_TELEGRAM_UNAVAILABLE",
		"ErrCodeOTPRequestFailed":        "DRAWER_OTP_REQUEST_FAILED",
		"ErrCodeOTPFormatInvalid":        "DRAWER_OTP_FORMAT_INVALID",
	}
	actual := map[string]string{
		"ErrCodeOTPChallengeNotFound":    ErrCodeOTPChallengeNotFound,
		"ErrCodeOTPChallengeWrongActor":  ErrCodeOTPChallengeWrongActor,
		"ErrCodeOTPChallengeExpired":     ErrCodeOTPChallengeExpired,
		"ErrCodeOTPChallengeExhausted":   ErrCodeOTPChallengeExhausted,
		"ErrCodeOTPChallengeInvalid":     ErrCodeOTPChallengeInvalid,
		"ErrCodeOTPChallengeAlreadyUsed": ErrCodeOTPChallengeAlreadyUsed,
		"ErrCodeOTPChallengeCancelled":   ErrCodeOTPChallengeCancelled,
		"ErrCodeOTPTelegramUnavailable":  ErrCodeOTPTelegramUnavailable,
		"ErrCodeOTPRequestFailed":        ErrCodeOTPRequestFailed,
		"ErrCodeOTPFormatInvalid":        ErrCodeOTPFormatInvalid,
	}
	for name, want := range expected {
		if actual[name] != want {
			t.Errorf("constante %s = %q, want %q (contrato con el frontend)", name, actual[name], want)
		}
	}
}

// =============================================================================
// Modelo CashDrawerOpen con el campo OtpChallengeID y la constante
// CashDrawerReasonOtpManual (migración 025).
// =============================================================================

func TestCashDrawerOpen_TieneOtpChallengeIDYReasonOtpManual(t *testing.T) {
	if CashDrawerReasonOtpManual != "otp_manual" {
		t.Errorf("CashDrawerReasonOtpManual = %q, migración 025 fija 'otp_manual'", CashDrawerReasonOtpManual)
	}
	// El campo debe aceptar un *uint64 — pointer nullable es el shape
	// requerido por la migración (otp_challenge_id BIGINT NULL con FK).
	id := uint64(42)
	open := CashDrawerOpen{OtpChallengeID: &id}
	if open.OtpChallengeID == nil || *open.OtpChallengeID != 42 {
		t.Error("CashDrawerOpen.OtpChallengeID debe ser *uint64 asignable")
	}
	// Y el reason del namespace del CHECK no debe repetir el valor.
	seen := map[string]bool{}
	for _, r := range []string{
		CashDrawerReasonSale,
		CashDrawerReasonReturn,
		CashDrawerReasonAdminOverride,
		CashDrawerReasonOther,
		CashDrawerReasonOtpManual,
	} {
		if seen[r] {
			t.Fatalf("razón duplicada: %q", r)
		}
		seen[r] = true
	}
}
