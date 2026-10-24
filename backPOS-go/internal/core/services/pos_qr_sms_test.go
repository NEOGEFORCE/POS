// Pruebas puras del nuevo formato de puente SMS reenviado desde
// Automate y de los helpers de allowlist/normalización/sanitización.
//
// Alcance:
//
//   - NormalizeBridgeSender y BridgeSenderMatches: casos puros con
//     números internacionales, nacionales, con prefijo + y texto.
//   - isAllowedSMSSender: BOLD_SMS_SENDERS env parseo + match por sufijo.
//   - IngestBridgeWebhook con app:"sms": rechaza por allowlist, por
//     recibido_ms fuera de ventana y por negador sin loguear.
//   - logBoldBridgeNotification: no se llama cuando el remitente queda
//     fuera del allowlist.
//
// Todas las pruebas corren contra `svc := NewQrPaymentService(nil,
// nil, nil)`; el repo es nil porque los rechazos ocurren antes del
// round-trip.

package services

import (
	"bytes"
	"context"
	"log"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// -----------------------------------------------------------------------------
// NormalizeBridgeSender / BridgeSenderMatches
// -----------------------------------------------------------------------------

func TestNormalizeBridgeSender_TrimLowerDigits(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"  BANCOLOMBIA  ", "bancolombia"},
		{"Bancolombia S.A.", "bancolombia s.a."},
		{"+57 300 123 4567", "573001234567"},
		{"(300) 123-4567", "3001234567"},
		{"300 123 4567", "3001234567"},
		{"  ", ""},
		{"", ""},
		{"NEQUI", "nequi"},
		{"+1 (415) 555-0100", "14155550100"},
		{"Nequi\t\n", "nequi"},
	}
	for _, c := range cases {
		got := models.NormalizeBridgeSender(c.in)
		if got != c.want {
			t.Errorf("NormalizeBridgeSender(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestBridgeSenderMatches_SufijoNumerico(t *testing.T) {
	cases := []struct {
		sender  string
		allowed string
		want    bool
	}{
		// Mismo número normalizado.
		{"3001234567", "3001234567", true},
		// Prefijo +57 vs local: sufijo 10 dígitos coincide.
		{"573001234567", "3001234567", true},
		{"3001234567", "573001234567", true},
		// Dos internacionales con el mismo celular colombiano.
		{"573001234567", "+57 300 123 4567", true}, // tras normalizar coincide por sufijo.
		// Último dígito distinto → no.
		{"3001234568", "3001234567", false},
		// Texto vs número: no empatan.
		{"3001234567", "bancolombia", false},
		{"nequi", "3001234567", false},
		// Texto exacto empata.
		{"bancolombia", "bancolombia", true},
		// Vacíos → nunca.
		{"", "3001234567", false},
		{"3001234567", "", false},
		// Un número de 7 dígitos (fijo) no admite sufijo de 10 → exacta.
		{"3123456", "3123456", true},
		{"5553123456", "3123456", false},
	}
	for _, c := range cases {
		// Normalizamos ambos lados (el repo real también lo hace).
		sender := models.NormalizeBridgeSender(c.sender)
		allowed := models.NormalizeBridgeSender(c.allowed)
		got := models.BridgeSenderMatches(sender, allowed)
		if got != c.want {
			t.Errorf("BridgeSenderMatches(%q,%q) = %v, want %v", c.sender, c.allowed, got, c.want)
		}
	}
}

// -----------------------------------------------------------------------------
// isAllowedSMSSender (allowlist env)
// -----------------------------------------------------------------------------

func TestIsAllowedSMSSender_EnvVacia_Rechaza(t *testing.T) {
	os.Unsetenv("BOLD_SMS_SENDERS")
	if isAllowedSMSSender("Bancolombia") {
		t.Fatal("sin BOLD_SMS_SENDERS, cualquier remitente debe rechazarse")
	}
	t.Setenv("BOLD_SMS_SENDERS", "")
	if isAllowedSMSSender("Bancolombia") {
		t.Fatal("BOLD_SMS_SENDERS='' debe rechazarse")
	}
}

func TestIsAllowedSMSSender_RemitenteVacio_Rechaza(t *testing.T) {
	t.Setenv("BOLD_SMS_SENDERS", "Bancolombia,Nequi")
	if isAllowedSMSSender("") {
		t.Fatal("remitente vacío debe rechazarse")
	}
}

func TestIsAllowedSMSSender_ComaSeparada(t *testing.T) {
	t.Setenv("BOLD_SMS_SENDERS", " Bancolombia , Nequi , +57 300 999 0000 ")
	for _, s := range []string{"Bancolombia", " BANCOLOMBIA ", "nequi", "3009990000", "+57 300 999 0000"} {
		if !isAllowedSMSSender(s) {
			t.Errorf("%q debería estar en allowlist", s)
		}
	}
	for _, s := range []string{"WhatsApp", "3119999999", "", "Bancolombia S.A."} {
		if isAllowedSMSSender(s) {
			t.Errorf("%q NO debería estar en allowlist", s)
		}
	}
}

func TestIsAllowedSMSSender_SufijoDiezDigitos(t *testing.T) {
	t.Setenv("BOLD_SMS_SENDERS", "573001234567")
	// Mismo número local (sin +57).
	if !isAllowedSMSSender("3001234567") {
		t.Error("sufijo de 10 dígitos debe empatar número local vs internacional")
	}
	// Con formato humano.
	if !isAllowedSMSSender("(300) 123-4567") {
		t.Error("formato humano debe normalizarse a dígitos y empatar sufijo")
	}
	// Un dígito distinto rompe.
	if isAllowedSMSSender("3001234568") {
		t.Error("un dígito distinto en el sufijo NO debe empatar")
	}
}

// -----------------------------------------------------------------------------
// SanitizeBridgeNote
// -----------------------------------------------------------------------------

func TestSanitizeBridgeNote_LimpiaControlesYTrunca(t *testing.T) {
	cases := []struct {
		in   string
		max  int
		want string
	}{
		{"Hola\nmundo\t!", 0, "Hola mundo !"},
		{"  abc  ", 0, "abc"},
		{"\x00\x01abc\x7f", 0, "abc"},
		{strings.Repeat("x", 300), 0, strings.Repeat("x", 200)},
		{"a\n\n\n\nb", 0, "a b"},
		{"", 0, ""},
	}
	for _, c := range cases {
		got := models.SanitizeBridgeNote(c.in, c.max)
		if got != c.want {
			t.Errorf("SanitizeBridgeNote(%q, %d) = %q, want %q", c.in, c.max, got, c.want)
		}
	}
}

func TestSanitizeBridgeNote_MaxExcedente(t *testing.T) {
	// Pide 500 → clamp a 255.
	got := models.SanitizeBridgeNote(strings.Repeat("y", 400), 500)
	if len(got) > 255 {
		t.Fatalf("SanitizeBridgeNote debe acotar a 255 chars, got len=%d", len(got))
	}
}

// -----------------------------------------------------------------------------
// IngestBridgeWebhook (SMS)
// -----------------------------------------------------------------------------

func TestQrPaymentService_IngestBridge_SMSSinAllowlist(t *testing.T) {
	t.Setenv(envBoldBridgeToken, "tok")
	os.Unsetenv(envBoldSMSSenders)
	svc := NewQrPaymentService(nil, nil, nil)
	body := []byte(`{"app":"sms","remitente":"BANCOLOMBIA","mensaje":"Recibiste $45.800","recibido_ms":1700000000000}`)
	_, err := svc.IngestBridgeWebhook(context.Background(), body, "tok")
	if err != ErrQRWebhookRejected {
		t.Fatalf("SMS sin allowlist debe ser Rejected, got %v", err)
	}
}

func TestQrPaymentService_IngestBridge_SMSAllowlistSinMatch(t *testing.T) {
	t.Setenv(envBoldBridgeToken, "tok")
	t.Setenv(envBoldSMSSenders, "Nequi,Bancolombia")
	svc := NewQrPaymentService(nil, nil, nil)
	body := []byte(`{"app":"sms","remitente":"WhatsApp","mensaje":"Recibiste $45.800","recibido_ms":1700000000000}`)
	_, err := svc.IngestBridgeWebhook(context.Background(), body, "tok")
	if err != ErrQRWebhookRejected {
		t.Fatalf("SMS con remitente fuera del allowlist debe ser Rejected, got %v", err)
	}
}

func TestQrPaymentService_IngestBridge_SMSRecibidoMsAntiguo(t *testing.T) {
	t.Setenv(envBoldBridgeToken, "tok")
	t.Setenv(envBoldSMSSenders, "Bancolombia")
	svc := NewQrPaymentService(nil, nil, nil)
	// Congelar reloj.
	svc = svc.WithClock(func() time.Time {
		return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	})
	oldReceivedMs := time.Date(2026, 10, 20, 11, 30, 0, 0, time.UTC).UnixMilli() // 30 min atrás
	body := []byte(`{"app":"sms","remitente":"Bancolombia","mensaje":"Recibiste $45.800","recibido_ms":` + strconv.FormatInt(oldReceivedMs, 10) + `}`)
	_, err := svc.IngestBridgeWebhook(context.Background(), body, "tok")
	if err != ErrQRWebhookRejected {
		t.Fatalf("recibido_ms más viejo que QRBridgeMaxEventAge debe Rejected, got %v", err)
	}
}

func TestQrPaymentService_IngestBridge_SMSRecibidoMsFuturo(t *testing.T) {
	t.Setenv(envBoldBridgeToken, "tok")
	t.Setenv(envBoldSMSSenders, "Bancolombia")
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	svc := NewQrPaymentService(nil, nil, nil).WithClock(func() time.Time { return now })
	// 10 min en el futuro (más allá del slack de 2 min).
	futureMs := now.Add(10 * time.Minute).UnixMilli()
	body := []byte(`{"app":"sms","remitente":"Bancolombia","mensaje":"Recibiste $45.800","recibido_ms":` + strconv.FormatInt(futureMs, 10) + `}`)
	_, err := svc.IngestBridgeWebhook(context.Background(), body, "tok")
	if err != ErrQRWebhookRejected {
		t.Fatalf("recibido_ms demasiado en el futuro debe Rejected, got %v", err)
	}
}

func TestQrPaymentService_IngestBridge_SMSSinMontoNoLoguea(t *testing.T) {
	// El contrato: nunca loguear título/mensaje salvo si el remitente/app
	// es válido Y hay monto extraído. Un SMS del remitente permitido
	// pero sin monto NO debe aparecer en el log.
	t.Setenv(envBoldBridgeToken, "tok")
	t.Setenv(envBoldSMSSenders, "Bancolombia")
	var buf bytes.Buffer
	previousWriter := log.Writer()
	previousFlags := log.Flags()
	previousPrefix := log.Prefix()
	log.SetOutput(&buf)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(previousWriter)
		log.SetFlags(previousFlags)
		log.SetPrefix(previousPrefix)
	})

	svc := NewQrPaymentService(nil, nil, nil)
	body := []byte(`{"app":"sms","remitente":"Bancolombia","mensaje":"Movimiento informativo","recibido_ms":1700000000000}`)
	_, err := svc.IngestBridgeWebhook(context.Background(), body, "tok")
	if err != ErrQRWebhookRejected {
		t.Fatalf("sin monto parseable debe Rejected, got %v", err)
	}
	got := buf.String()
	if strings.Contains(got, "Movimiento informativo") {
		t.Fatalf("log filtró el mensaje de un SMS sin monto: %s", got)
	}
	if strings.Contains(got, "Bancolombia") {
		t.Fatalf("log filtró el remitente cuando no hubo monto: %s", got)
	}
}

func TestQrPaymentService_IngestBridge_SMSFueraDeAllowlistNoLoguea(t *testing.T) {
	t.Setenv(envBoldBridgeToken, "tok")
	t.Setenv(envBoldSMSSenders, "Bancolombia")
	var buf bytes.Buffer
	previousWriter := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(previousWriter) })

	svc := NewQrPaymentService(nil, nil, nil)
	body := []byte(`{"app":"sms","remitente":"MicrocreditosXYZ","mensaje":"Recibiste $45.800","recibido_ms":1700000000000}`)
	_, err := svc.IngestBridgeWebhook(context.Background(), body, "tok")
	if err != ErrQRWebhookRejected {
		t.Fatalf("SMS fuera del allowlist debe Rejected, got %v", err)
	}
	got := buf.String()
	for _, forbidden := range []string{"$45.800", "MicrocreditosXYZ", "Recibiste"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("log filtró contenido de un SMS fuera del allowlist: %q en %s", forbidden, got)
		}
	}
}

// itoa helper eliminado: colisiona con la copia del paquete
// (supplier_schedule.go). Usamos strconv.FormatInt donde haga falta.

// -----------------------------------------------------------------------------
// Privacidad del log: co.bold legacy con negador tampoco loguea.
// -----------------------------------------------------------------------------

func TestQrPaymentService_IngestBridge_LegacyConNegadorNoLoguea(t *testing.T) {
	t.Setenv(envBoldBridgeToken, "tok")
	var buf bytes.Buffer
	previousWriter := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(previousWriter) })

	svc := NewQrPaymentService(nil, nil, nil)
	// co.bold legacy con un negador debe rechazarse sin loguear el
	// texto. El mensaje contiene "$45.800" pero el negador "reversada"
	// anula la extracción.
	body := []byte(`{"app":"co.bold","titulo":"Bold","mensaje":"Transferencia reversada $45.800","token":"tok"}`)
	_, err := svc.IngestBridgeWebhook(context.Background(), body, "")
	if err != ErrQRWebhookRejected {
		t.Fatalf("negador debe Rejected, got %v", err)
	}
	got := buf.String()
	for _, forbidden := range []string{"$45.800", "Transferencia reversada"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("log filtró contenido con negador: %q en %s", forbidden, got)
		}
	}
}

// -----------------------------------------------------------------------------
// Concurrencia conceptual: dos SMS idénticos con distinto recibido_ms
// producen fingerprints distintos → eventos distintos en BD.
// -----------------------------------------------------------------------------

func TestFingerprintBridge_DosSMSMismoMontoDistintoRecibidoMs(t *testing.T) {
	msg := "Recibiste $45.800 de JUAN"
	remitente := "3001234567"
	now := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	// Dos SMS reales distintos, mismo monto, mismo minuto.
	t1 := now.Add(2 * time.Second).UnixMilli()
	t2 := now.Add(45 * time.Second).UnixMilli()
	f1 := fingerprintBridge(msg, remitente, 45800, t1, now)
	f2 := fingerprintBridge(msg, remitente, 45800, t2, now)
	if f1 == f2 {
		t.Fatalf("dos SMS distintos deben producir fingerprints distintos (recibido_ms t1=%d t2=%d): %s", t1, t2, f1)
	}
	// Pero el replay literal del primer SMS cae en el mismo fingerprint
	// → la UNIQUE (source, fingerprint) lo marcará DUPLICATE.
	f3 := fingerprintBridge(msg, remitente, 45800, t1, now)
	if f3 != f1 {
		t.Fatalf("replay literal del mismo SMS debe producir mismo fingerprint, got %s vs %s", f1, f3)
	}
}
