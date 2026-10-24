package models

import (
	"strings"
	"testing"
	"time"
)

// =============================================================================
// Guardianes del dominio QR Bold/Bre-B. Verifican constantes y validadores
// puros. Las pruebas de SELECT FOR UPDATE y biyecciones viven en el repo;
// las de HMAC/parsing COP viven en el servicio.
// =============================================================================

// -----------------------------------------------------------------------------
// Constantes: TTL de 5 min y topes de monto
// -----------------------------------------------------------------------------

// TestQRPaymentIntentDefaultTTL_Es15Min verifica el TTL elevado por la
// migración 027. Antes era 5 min; con el flujo asíncrono (bandeja
// global + materialización en segundo plano) el cajero deja QR en
// espera y sigue atendiendo, por lo que necesitamos una ventana más
// amplia que cubra el tiempo típico de una compra extendida en la que
// el cliente demora en escanear.
func TestQRPaymentIntentDefaultTTL_Es15Min(t *testing.T) {
	if QRPaymentIntentDefaultTTL != 15*time.Minute {
		t.Fatalf("QRPaymentIntentDefaultTTL = %v, el spec operativo del flujo asíncrono exige 15 min",
			QRPaymentIntentDefaultTTL)
	}
}

func TestQRPaymentIntent_RangoMonto(t *testing.T) {
	if QRPaymentIntentMinAmountCOP != 100 {
		t.Errorf("Min=%d, se esperaba 100", QRPaymentIntentMinAmountCOP)
	}
	if QRPaymentIntentMaxAmountCOP != 50_000_000 {
		t.Errorf("Max=%d, se esperaba 50M", QRPaymentIntentMaxAmountCOP)
	}
	if QRPaymentIntentMinAmountCOP >= QRPaymentIntentMaxAmountCOP {
		t.Error("Min debe ser menor que Max")
	}
}

func TestQRBridgeReplayWindow_LoSuficientementeCorta(t *testing.T) {
	// Si la ventana crece mucho, dos pagos legítimos al mismo monto
	// colisionarían más seguido. 60s es el máximo tolerable.
	if QRBridgeReplayWindow > 90*time.Second {
		t.Errorf("replay window demasiado larga: %v", QRBridgeReplayWindow)
	}
	if QRBridgeReplayWindow <= 0 {
		t.Errorf("replay window debe ser positiva: %v", QRBridgeReplayWindow)
	}
}

func TestQRBridgeMaxEventAge_MayorQueReplayWindow(t *testing.T) {
	if QRBridgeMaxEventAge <= QRBridgeReplayWindow {
		t.Errorf("MaxEventAge (%v) debe ser mayor que ReplayWindow (%v)",
			QRBridgeMaxEventAge, QRBridgeReplayWindow)
	}
}

// -----------------------------------------------------------------------------
// Validadores de inputs
// -----------------------------------------------------------------------------

func TestIsValidQRVentaTempID(t *testing.T) {
	type tc struct {
		name string
		in   string
		want bool
	}
	cases := []tc{
		{"uuid clásico", "f81d4fae-7dec-11d0-a765-00a0c91e6bf6", true},
		{"ulid", "01HBVY5EYJVNG5V9Z0WCRN7ANB", true},
		{"base64url sin padding", "abcd_EFGH-1234ZZZZ", true},
		{"vacío", "", false},
		{"espacios", "   ", false},
		{"demasiado corto", "abc", false},
		{"demasiado largo", strings.Repeat("x", 100), false},
		{"con espacio", "temp id 1234", false},
		{"con barra", "temp/id/1234", false},
		{"con punto", "temp.id.1234", false},
		{"control char", "temp\x00id1234", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := IsValidQRVentaTempID(c.in); got != c.want {
				t.Errorf("IsValidQRVentaTempID(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

func TestIsValidQRCajaID(t *testing.T) {
	type tc struct {
		name string
		in   string
		want bool
	}
	cases := []tc{
		{"nombre típico", "CAJA-1", true},
		{"numérico", "1", true},
		{"compuesto con punto", "pos.caja.a", true},
		{"vacío", "", false},
		{"solo espacios", "   ", false},
		{"demasiado largo", strings.Repeat("x", 70), false},
		{"con espacio", "CAJA 1", false},
		{"con /", "caja/1", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := IsValidQRCajaID(c.in); got != c.want {
				t.Errorf("IsValidQRCajaID(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}

func TestIsValidQRAmountCOP(t *testing.T) {
	type tc struct {
		in   int64
		want bool
	}
	cases := []tc{
		{0, false},
		{-1, false},
		{99, false},
		{100, true},
		{45800, true},
		{QRPaymentIntentMaxAmountCOP, true},
		{QRPaymentIntentMaxAmountCOP + 1, false},
		{1 << 60, false},
	}
	for _, c := range cases {
		if got := IsValidQRAmountCOP(c.in); got != c.want {
			t.Errorf("IsValidQRAmountCOP(%d) = %v, want %v", c.in, got, c.want)
		}
	}
}

// -----------------------------------------------------------------------------
// Enumeraciones (deben empatar con los CHECK de la migración 026)
// -----------------------------------------------------------------------------

func TestIsValidQRIntentStatus(t *testing.T) {
	valid := []string{
		QRIntentStatusPending,
		QRIntentStatusApproved,
		QRIntentStatusConfirmedManual,
		QRIntentStatusExpired,
		QRIntentStatusCancelled,
	}
	for _, s := range valid {
		if !IsValidQRIntentStatus(s) {
			t.Errorf("IsValidQRIntentStatus(%q) debe ser true", s)
		}
	}
	for _, bad := range []string{"", "pendiente", "APPROVED", "VENCIDA", "random"} {
		if IsValidQRIntentStatus(bad) {
			t.Errorf("IsValidQRIntentStatus(%q) debe ser false", bad)
		}
	}
}

func TestIsValidQRApprovalSource(t *testing.T) {
	valid := []string{
		QRApprovalSourceBoldOfficial,
		QRApprovalSourceBridge,
		QRApprovalSourceManual,
	}
	for _, s := range valid {
		if !IsValidQRApprovalSource(s) {
			t.Errorf("IsValidQRApprovalSource(%q) debe ser true", s)
		}
	}
	for _, bad := range []string{"", "bold", "manual", "OFICIAL"} {
		if IsValidQRApprovalSource(bad) {
			t.Errorf("IsValidQRApprovalSource(%q) debe ser false", bad)
		}
	}
}

// -----------------------------------------------------------------------------
// MapIntentStatusToStream: el único contrato público del SSE
// -----------------------------------------------------------------------------

func TestMapIntentStatusToStream(t *testing.T) {
	cases := map[string]string{
		QRIntentStatusPending:         QRStreamStatusPending,
		QRIntentStatusApproved:        QRStreamStatusApproved,
		QRIntentStatusConfirmedManual: QRStreamStatusApproved, // ambos aprobados colapsan
		QRIntentStatusExpired:         QRStreamStatusExpired,
		QRIntentStatusCancelled:       QRStreamStatusCancelled,
		"BASURA":                      QRStreamStatusError, // defensa
	}
	for in, want := range cases {
		if got := MapIntentStatusToStream(in); got != want {
			t.Errorf("MapIntentStatusToStream(%q) = %q, want %q", in, got, want)
		}
	}
}

// Contrato con el helper del frontend: los valores de transporte deben
// seguir siendo los literales que `BOLD_QR_STATUS` del helper espera.
// Un rename aquí rompería el modal.
func TestQRStreamStatusLiteralsMatchFrontendContract(t *testing.T) {
	expected := map[string]string{
		"QRStreamStatusPending":   "PENDIENTE",
		"QRStreamStatusApproved":  "APROBADO",
		"QRStreamStatusExpired":   "EXPIRADO",
		"QRStreamStatusCancelled": "CANCELADO",
		"QRStreamStatusError":     "ERROR",
		"QRStreamStatusUnmatched": "UNMATCHED",
		"QRStreamStatusAmbiguous": "AMBIGUOUS",
	}
	actual := map[string]string{
		"QRStreamStatusPending":   QRStreamStatusPending,
		"QRStreamStatusApproved":  QRStreamStatusApproved,
		"QRStreamStatusExpired":   QRStreamStatusExpired,
		"QRStreamStatusCancelled": QRStreamStatusCancelled,
		"QRStreamStatusError":     QRStreamStatusError,
		"QRStreamStatusUnmatched": QRStreamStatusUnmatched,
		"QRStreamStatusAmbiguous": QRStreamStatusAmbiguous,
	}
	for k, want := range expected {
		if actual[k] != want {
			t.Errorf("%s = %q, want %q (rompe contrato con FrontPOS-main/src/lib/bold-qr-helpers.mjs)",
				k, actual[k], want)
		}
	}
}

// -----------------------------------------------------------------------------
// Métodos de la intención: IsLive e IsTerminal
// -----------------------------------------------------------------------------

func TestQrPaymentIntent_IsLive(t *testing.T) {
	now := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)

	// nil → false (defensa)
	var nilIntent *QrPaymentIntent
	if nilIntent.IsLive(now) {
		t.Error("nil intent debe ser !IsLive")
	}

	// PENDIENTE + no expirado
	alive := &QrPaymentIntent{Status: QRIntentStatusPending, ExpiresAt: now.Add(time.Minute)}
	if !alive.IsLive(now) {
		t.Error("PENDIENTE no expirado debe IsLive")
	}

	// PENDIENTE pero expirado
	stale := &QrPaymentIntent{Status: QRIntentStatusPending, ExpiresAt: now.Add(-time.Second)}
	if stale.IsLive(now) {
		t.Error("PENDIENTE expirado debe !IsLive")
	}

	// Status terminal
	for _, status := range []string{
		QRIntentStatusApproved,
		QRIntentStatusConfirmedManual,
		QRIntentStatusExpired,
		QRIntentStatusCancelled,
	} {
		dead := &QrPaymentIntent{Status: status, ExpiresAt: now.Add(time.Hour)}
		if dead.IsLive(now) {
			t.Errorf("status %q no debe ser IsLive aunque expires_at > now", status)
		}
	}
}

func TestQrPaymentIntent_IsTerminal(t *testing.T) {
	// nil → false
	var nilIntent *QrPaymentIntent
	if nilIntent.IsTerminal() {
		t.Error("nil intent !IsTerminal")
	}
	// PENDIENTE no es terminal
	if (&QrPaymentIntent{Status: QRIntentStatusPending}).IsTerminal() {
		t.Error("PENDIENTE no es terminal")
	}
	// Los 4 terminales
	for _, s := range []string{
		QRIntentStatusApproved,
		QRIntentStatusConfirmedManual,
		QRIntentStatusExpired,
		QRIntentStatusCancelled,
	} {
		if !(&QrPaymentIntent{Status: s}).IsTerminal() {
			t.Errorf("status %q debe ser terminal", s)
		}
	}
}

// -----------------------------------------------------------------------------
// TableName — un rename accidental de la constante rompería GORM silenciosamente
// -----------------------------------------------------------------------------

func TestQR_TableNames(t *testing.T) {
	if (QrPaymentIntent{}).TableName() != "pos_qr_payment_intents" {
		t.Errorf("TableName intents mal mapeada")
	}
	if (QrWebhookEvent{}).TableName() != "pos_qr_webhook_events" {
		t.Errorf("TableName events mal mapeada")
	}
}

// -----------------------------------------------------------------------------
// Guardián de códigos de error (contrato con el frontend)
// -----------------------------------------------------------------------------

func TestQR_ErrorCodesStable(t *testing.T) {
	// Si estos literales cambian, el frontend pierde su rama de UX.
	cases := map[string]string{
		"ErrCodeQRBadRequest":            "QR_BAD_REQUEST",
		"ErrCodeQRIntentNotFound":        "QR_INTENT_NOT_FOUND",
		"ErrCodeQRIntentExpired":         "QR_INTENT_EXPIRED",
		"ErrCodeQRIntentAlreadyTerminal": "QR_INTENT_ALREADY_TERMINAL",
		"ErrCodeQRIntentWrongActor":      "QR_INTENT_WRONG_ACTOR",
		"ErrCodeQRRequestFailed":         "QR_REQUEST_FAILED",
		"ErrCodeQRWebhookUnauthorized":   "QR_WEBHOOK_UNAUTHORIZED",
		"ErrCodeQRWebhookTooLarge":       "QR_WEBHOOK_TOO_LARGE",
		"ErrCodeQRRateLimit":             "QR_RATE_LIMIT",
		"ErrCodeQRIntentAlreadyPaid":     "QR_INTENT_ALREADY_PAID",
	}
	actual := map[string]string{
		"ErrCodeQRBadRequest":            ErrCodeQRBadRequest,
		"ErrCodeQRIntentNotFound":        ErrCodeQRIntentNotFound,
		"ErrCodeQRIntentExpired":         ErrCodeQRIntentExpired,
		"ErrCodeQRIntentAlreadyTerminal": ErrCodeQRIntentAlreadyTerminal,
		"ErrCodeQRIntentWrongActor":      ErrCodeQRIntentWrongActor,
		"ErrCodeQRRequestFailed":         ErrCodeQRRequestFailed,
		"ErrCodeQRWebhookUnauthorized":   ErrCodeQRWebhookUnauthorized,
		"ErrCodeQRWebhookTooLarge":       ErrCodeQRWebhookTooLarge,
		"ErrCodeQRRateLimit":             ErrCodeQRRateLimit,
		"ErrCodeQRIntentAlreadyPaid":     ErrCodeQRIntentAlreadyPaid,
	}
	for k, want := range cases {
		if actual[k] != want {
			t.Errorf("%s = %q, want %q", k, actual[k], want)
		}
	}
}
