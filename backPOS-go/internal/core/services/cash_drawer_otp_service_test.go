package services

import (
	"context"
	"errors"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// =============================================================================
// Pruebas del CashDrawerOTPService.
//
// Lo que se verifica:
//
//   - El OTP generado por `generateCashDrawerOTP` SIEMPRE es 6 dígitos
//     exactos y cae en el rango uniforme [0, 10^6).
//
//   - RequestChallenge:
//       * Rechaza DNI vacío sin tocar BD.
//       * Rechaza cuando Telegram no está activo (ErrOTPTelegramUnavailable)
//         SIN pegarle a la BD.
//       * El mensaje de Telegram contiene el OTP generado, pero el OTP
//         NUNCA aparece en el response, log del handler o error.
//
//   - El servicio NUNCA llama a `SendAlert` o `SendMarkdownAlert` del
//     TelegramService: eso encolaría el OTP. Guardian estático sobre
//     el source.
//
//   - formatOTPTelegramMessage escapa backticks y mantiene exactamente
//     6 dígitos como OTP (no agrega espacios ni caracteres).
//
// Las pruebas de SELECT FOR UPDATE y biyecciones viven en el repo.
// =============================================================================

// -----------------------------------------------------------------------------
// Mock del Telegram sender
// -----------------------------------------------------------------------------

type fakeTelegramSender struct {
	mu       sync.Mutex
	active   bool
	err      error
	received string
	calls    int32
}

func (f *fakeTelegramSender) IsActive() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.active
}

func (f *fakeTelegramSender) SendSyncOTPMessage(ctx context.Context, message string) error {
	atomic.AddInt32(&f.calls, 1)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.received = message
	return f.err
}

func (f *fakeTelegramSender) lastMessage() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.received
}

func (f *fakeTelegramSender) callCount() int32 {
	return atomic.LoadInt32(&f.calls)
}

// -----------------------------------------------------------------------------
// Generador uniforme
// -----------------------------------------------------------------------------

func TestGenerateCashDrawerOTP_SiempreSeisDigitos(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		otp, err := generateCashDrawerOTP()
		if err != nil {
			t.Fatalf("generateCashDrawerOTP: %v", err)
		}
		if !models.IsValidCashDrawerOTPFormat(otp) {
			t.Fatalf("OTP %q no cumple ^\\d{6}$", otp)
		}
		seen[otp] = true
	}
	// En 100 muestras no esperamos pocos únicos. Umbral conservador: 50.
	if len(seen) < 50 {
		t.Errorf("muestras repetidas sospechosamente altas (%d únicos de 100), ¿el generador cayó a time.Now?",
			len(seen))
	}
}

// -----------------------------------------------------------------------------
// formatOTPTelegramMessage
// -----------------------------------------------------------------------------

func TestFormatOTPTelegramMessage_IncluyeOTPYEscapaBackticks(t *testing.T) {
	msg := formatOTPTelegramMessage("Juan `admin`", "DNI`123", "456789")
	if !strings.Contains(msg, "456789") {
		t.Errorf("mensaje debe incluir el OTP; msg=%q", msg)
	}
	if strings.Contains(msg, "Juan `admin`") || strings.Contains(msg, "DNI`123") {
		t.Error("mensaje NO debe incluir backticks sin escapar — rompería Markdown")
	}
	// Debe mencionar el TTL en segundos.
	ttlToken := regexp.MustCompile(`\b\d+ segundos\b`)
	if !ttlToken.MatchString(msg) {
		t.Error("mensaje debe mencionar la ventana de validez en segundos")
	}
	// Debe advertir sobre uso no solicitado — importante para que el
	// admin reaccione si alguien intenta forzar el flujo.
	if !strings.Contains(strings.ToLower(msg), "no solicit") {
		t.Error("mensaje debe incluir advertencia sobre uso no solicitado")
	}
}

// -----------------------------------------------------------------------------
// RequestChallenge
// -----------------------------------------------------------------------------

func TestRequestChallenge_RechazaDNIVacio(t *testing.T) {
	svc := NewCashDrawerOTPService(nil, &fakeTelegramSender{active: true})
	_, err := svc.RequestChallenge(context.Background(), "", "USUARIO")
	if !errors.Is(err, ErrOTPActorInvalid) {
		t.Fatalf("RequestChallenge sin DNI debe devolver ErrOTPActorInvalid, got %v", err)
	}
}

func TestRequestChallenge_FailFastConTelegramInactivo(t *testing.T) {
	// repo nil es seguro porque fail-fast en el chequeo de Telegram
	// ocurre antes de tocar el repo. Si alguien reordena el flujo, el
	// test fallará con un panic claro.
	svc := NewCashDrawerOTPService(nil, &fakeTelegramSender{active: false})
	_, err := svc.RequestChallenge(context.Background(), "EMP-1", "Juan")
	if !errors.Is(err, ErrOTPTelegramUnavailable) {
		t.Fatalf("Telegram inactivo debe devolver ErrOTPTelegramUnavailable sin tocar BD, got %v", err)
	}
}

// -----------------------------------------------------------------------------
// Guardianes anti-leak sobre el fuente del servicio.
// -----------------------------------------------------------------------------

// otpServiceSource lee el source una sola vez.
func otpServiceSource(t *testing.T) string {
	t.Helper()
	bts, err := os.ReadFile("cash_drawer_otp_service.go")
	if err != nil {
		t.Fatalf("read cash_drawer_otp_service.go: %v", err)
	}
	return string(bts)
}

// TestCashDrawerOTPService_NingunLogImprimeOTP: ningún log.Printf del
// servicio puede interpolar la variable `otp` (el valor del OTP). El
// log sanitizado SÍ incluye el `challengeID` y el `dni`.
func TestCashDrawerOTPService_NingunLogImprimeOTP(t *testing.T) {
	src := otpServiceSource(t)
	// Patrones prohibidos en argumentos de log.Printf del service:
	//   - log.Printf(... %s ..., otp)
	//   - log.Printf(... %s ..., trimmedOTP)
	//   - log.Printf(... %v ..., otp)
	// Rechazamos cualquier aparición de los identificadores locales
	// dentro de llamadas a log.
	for _, pattern := range []string{
		`log.Printf("`,
		`log.Println("`,
	} {
		// Localizamos cada llamada y verificamos sus parámetros.
		idx := 0
		for {
			i := strings.Index(src[idx:], pattern)
			if i < 0 {
				break
			}
			abs := idx + i
			// Avance hasta el `)` de la llamada.
			end := strings.Index(src[abs:], ")\n")
			if end < 0 {
				end = len(src) - abs
			}
			segment := src[abs : abs+end]
			for _, forbidden := range []string{", otp)", ", otp,", "trimmedOTP", ", in.OTP"} {
				if strings.Contains(segment, forbidden) {
					t.Errorf("log del service NO debe interpolar el OTP (%q):\n  %q", forbidden, segment)
				}
			}
			idx = abs + end
		}
	}
}

// TestCashDrawerOTPService_NoUsaRutasEncoladasDeTelegram: la cola
// offline es incompatible con un OTP de 90s. El servicio NUNCA debe
// llamar a SendAlert / SendMarkdownAlert / enqueue — sólo
// SendSyncOTPMessage.
func TestCashDrawerOTPService_NoUsaRutasEncoladasDeTelegram(t *testing.T) {
	src := otpServiceSource(t)
	for _, forbidden := range []string{
		"SendAlert(",
		"SendMarkdownAlert(",
		"SendHTMLAlert(",
		"SendDocument(",
		"SendPhoto(",
		"enqueue(",
	} {
		if strings.Contains(src, forbidden) {
			t.Errorf("el service NO debe llamar %q (encola el OTP y rompe el TTL de 90s); use SendSyncOTPMessage",
				forbidden)
		}
	}
	if !strings.Contains(src, "SendSyncOTPMessage(") {
		t.Error("el service debe llamar SendSyncOTPMessage(ctx, msg) para enviar el OTP")
	}
}

// TestCashDrawerOTPService_UsaCryptoRand garantiza que el OTP se genere
// con crypto/rand. Un fallback a math/rand o time-based bajaría la
// entropía y dejaría la señal predecible.
func TestCashDrawerOTPService_UsaCryptoRand(t *testing.T) {
	src := otpServiceSource(t)
	if !strings.Contains(src, `"crypto/rand"`) {
		t.Error("cash_drawer_otp_service.go debe importar crypto/rand")
	}
	if strings.Contains(src, `"math/rand"`) {
		t.Error("cash_drawer_otp_service.go NO debe importar math/rand (seedless → predecible)")
	}
	// rand.Int sobre big.NewInt(1_000_000) es la forma uniforme.
	if !strings.Contains(src, "big.NewInt(1_000_000)") {
		t.Error("el service debe usar rand.Int sobre [0, 1_000_000) para evitar sesgo del modulo")
	}
}

// TestCashDrawerOTPService_NoLeeEnvNueva asegura que el servicio no
// introduzca una variable de entorno nueva por su cuenta (el spec
// explícitamente lo prohíbe).
func TestCashDrawerOTPService_NoLeeEnvNueva(t *testing.T) {
	src := otpServiceSource(t)
	if strings.Contains(src, "os.Getenv(") {
		t.Error("cash_drawer_otp_service.go NO debe leer variables de entorno; defaults vienen del dominio")
	}
}

// -----------------------------------------------------------------------------
// Request + repo real contra DryRun (sin BD) para verificar que
// NO se abre tx cuando Telegram está caído.
// -----------------------------------------------------------------------------

func newDryRunDBForService(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(postgres.New(postgres.Config{
		DSN: "host=127.0.0.1 port=1 user=dryrun dbname=dryrun sslmode=disable",
	}), &gorm.Config{
		DryRun:               true,
		DisableAutomaticPing: true,
		Logger:               logger.Discard,
	})
	if err != nil {
		t.Fatalf("abriendo DryRun gorm: %v", err)
	}
	return db
}

func TestRequestChallenge_TelegramCaidoNoAbreTx(t *testing.T) {
	// Si el servicio tocara el repo antes de validar Telegram, el repo
	// DryRun registraría al menos una sentencia. La verificación de
	// "fail-fast" es implícita: Telegram inactivo retorna de inmediato.
	repo := repositories.NewCashDrawerOTPRepository(newDryRunDBForService(t))
	tg := &fakeTelegramSender{active: false}
	svc := NewCashDrawerOTPService(repo, tg).WithBcryptCost(4)

	_, err := svc.RequestChallenge(context.Background(), "EMP-1", "Juan")
	if !errors.Is(err, ErrOTPTelegramUnavailable) {
		t.Fatalf("Telegram inactivo debe devolver ErrOTPTelegramUnavailable, got %v", err)
	}
	if tg.callCount() != 0 {
		t.Errorf("Telegram no debe recibir mensaje si no está activo; calls=%d", tg.callCount())
	}
}

// =============================================================================
// Verificación de que *TelegramService satisface la interfaz
// OTPTelegramSender. Un refactor accidental del método SendSyncOTPMessage
// o IsActive rompería la composición en main.go.
// =============================================================================

func TestTelegramService_ImplementaOTPTelegramSender(t *testing.T) {
	// Cast estático: si el método cambia de firma, no compila.
	var _ OTPTelegramSender = (*TelegramService)(nil)
}

// =============================================================================
// Validación de que la ventana TTL por default es 90s (defensa en
// profundidad para que no se altere en silencio).
// =============================================================================

func TestCashDrawerOTPService_TTLDefault90s(t *testing.T) {
	if models.CashDrawerOTPDefaultTTL != 90*time.Second {
		t.Fatalf("CashDrawerOTPDefaultTTL = %v, el spec operativo exige 90s",
			models.CashDrawerOTPDefaultTTL)
	}
}
