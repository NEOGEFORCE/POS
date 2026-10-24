// Servicio del flujo OTP para apertura manual del cajón (migración 025).
//
// Responsabilidades:
//
//   - RequestChallenge: genera un OTP aleatorio de 6 dígitos con
//     crypto/rand, calcula bcrypt, persiste un challenge PENDING vía
//     el repositorio y envía el OTP por Telegram SÍNCRONAMENTE. Si el
//     envío falla, marca el challenge CANCELLED y devuelve un error
//     para que el handler responda 503. El OTP en claro NO entra ni a
//     logs, ni al response, ni a errores.
//
//   - ConfirmChallenge: delega en el repositorio la verificación en
//     una sola transacción (SELECT FOR UPDATE + bcrypt + insert drawer
//     open + UPDATE CONSUMED). Traduce los errores sentinela del repo
//     a códigos estables para el frontend.
//
// Decisiones clave:
//
//   - El OTP se genera con `crypto/rand.Int` sobre el espacio uniforme
//     [0, 10^6). No usamos `rand.Read` + modulo porque introduce sesgo
//     levísimo hacia valores bajos.
//
//   - La zona horaria y la ventana TTL se derivan del dominio
//     (models.CashDrawerOTPDefaultTTL = 90s). El servicio NO lee env
//     nuevas: todo parámetro operativo viene del dominio o del caller.
//
//   - La interfaz `OTPTelegramSender` permite inyectar un fake en los
//     tests sin levantar un bot real. En producción, el servicio
//     recibe un `*TelegramService`.
package services

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"

	"golang.org/x/crypto/bcrypt"
)

// OTPTelegramSender es la dependencia hacia Telegram que el servicio
// necesita. `*services.TelegramService` la satisface vía
// SendSyncOTPMessage; los tests pueden inyectar un fake con el mismo
// shape sin importar la librería del bot.
type OTPTelegramSender interface {
	SendSyncOTPMessage(ctx context.Context, message string) error
	IsActive() bool
}

// cashDrawerOTPService es el servicio concreto. Lo expone un
// constructor que recibe sus dos dependencias (repo + telegram) para
// evitar un package-level singleton.
type CashDrawerOTPService struct {
	repo     *repositories.CashDrawerOTPRepository
	telegram OTPTelegramSender
	// bcryptCost mantiene el costo configurable para los tests —
	// bcrypt.MinCost acelera las pruebas unitarias. En producción
	// usamos bcrypt.DefaultCost (10), que es consistente con el resto
	// del sistema (auth_service.go).
	bcryptCost int
	// clock permite inyectar un reloj desde los tests.
	clock func() time.Time
}

// NewCashDrawerOTPService construye el servicio con los defaults
// seguros. En producción se instancia desde main.go con el repo real
// y *TelegramService como sender.
func NewCashDrawerOTPService(repo *repositories.CashDrawerOTPRepository, telegram OTPTelegramSender) *CashDrawerOTPService {
	return &CashDrawerOTPService{
		repo:       repo,
		telegram:   telegram,
		bcryptCost: bcrypt.DefaultCost,
		clock:      time.Now,
	}
}

// WithBcryptCost permite a los tests reducir el costo para no tardar
// 100ms por caso. Nunca llamarlo desde producción.
func (s *CashDrawerOTPService) WithBcryptCost(cost int) *CashDrawerOTPService {
	if cost < bcrypt.MinCost || cost > bcrypt.MaxCost {
		return s
	}
	s.bcryptCost = cost
	return s
}

// WithClock inyecta un reloj. Nunca llamarlo desde producción.
func (s *CashDrawerOTPService) WithClock(fn func() time.Time) *CashDrawerOTPService {
	if fn != nil {
		s.clock = fn
	}
	return s
}

// =========================================================================
// Errores sentinela del servicio
// =========================================================================

var (
	// ErrOTPActorInvalid: DNI del actor viene vacío (defensa contra
	// bypass del middleware).
	ErrOTPActorInvalid = errors.New("otp cajón: actor DNI requerido")

	// ErrOTPTelegramUnavailable: Telegram inactivo o el envío falló.
	// El challenge queda CANCELLED antes de responder.
	ErrOTPTelegramUnavailable = errors.New("otp cajón: Telegram no disponible")

	// ErrOTPRequestFailed: fallo transitorio en la emisión (BD, crypto).
	ErrOTPRequestFailed = errors.New("otp cajón: no se pudo emitir el challenge")

	// Errores de validación propagados del repo.
	ErrOTPNotFound   = errors.New("otp cajón: challenge no encontrado")
	ErrOTPExpired    = errors.New("otp cajón: challenge expirado")
	ErrOTPExhausted  = errors.New("otp cajón: challenge agotó intentos")
	ErrOTPMismatch   = errors.New("otp cajón: código incorrecto")
	ErrOTPConsumed   = errors.New("otp cajón: challenge ya consumido/cancelado")
	ErrOTPWrongActor = errors.New("otp cajón: challenge pertenece a otro actor")
	ErrOTPBadFormat  = errors.New("otp cajón: formato de OTP inválido")

	// ErrOTPCooldown: el actor pidió un OTP hace menos del cooldown
	// configurado. El handler lo traduce a 429 con `Retry-After`.
	// Mensaje sin secretos: no revela cuándo exactamente se emitió el
	// anterior, sólo cuánto esperar.
	ErrOTPCooldown = errors.New("otp cajón: cooldown activo")
)

// OTPCooldownError envuelve `ErrOTPCooldown` con el tiempo exacto que
// resta para poder emitir otro OTP. El handler lo usa para construir
// la cabecera `Retry-After` y el campo `retryAfterSeconds` del body.
//
// `Unwrap` devuelve el sentinel para que `errors.Is(err, ErrOTPCooldown)`
// siga siendo el chequeo canónico en los switches del handler.
type OTPCooldownError struct {
	RetryAfter time.Duration
}

func (e *OTPCooldownError) Error() string {
	return ErrOTPCooldown.Error()
}

func (e *OTPCooldownError) Unwrap() error {
	return ErrOTPCooldown
}

// =========================================================================
// Request
// =========================================================================

// RequestOutput es el shape que el handler devuelve en el 200 OK de
// Request. Incluye el challenge_id opaco y la ventana restante. NUNCA
// incluye el OTP ni el hash.
type RequestOutput struct {
	ChallengeID string
	ExpiresAt   time.Time
	AttemptsMax int
	TTLSeconds  int
}

// RequestChallenge emite un OTP y lo manda por Telegram. El flujo
// completo:
//
//  1. Validar que Telegram esté activo. Si no → ErrOTPTelegramUnavailable
//     sin tocar la BD (fail-fast que ahorra una tx innecesaria).
//  2. Generar OTP de 6 dígitos uniforme con crypto/rand.
//  3. bcrypt(OTP) con cost configurado.
//  4. Insertar challenge PENDING vía el repo.
//  5. Mandar OTP por Telegram SÍNCRONAMENTE con timeout.
//  6. Si falla el envío → CANCELLED el challenge y devolver
//     ErrOTPTelegramUnavailable.
//  7. Devolver RequestOutput.
//
// El `actorName` es sólo para el mensaje de Telegram (sin ser el OTP);
// si viene vacío usamos "USUARIO". El OTP nunca aparece en el log del
// servicio: usamos sólo el challengeID y el DNI del actor.
func (s *CashDrawerOTPService) RequestChallenge(ctx context.Context, actorDNI, actorName string) (*RequestOutput, error) {
	dni := strings.TrimSpace(actorDNI)
	if dni == "" {
		return nil, ErrOTPActorInvalid
	}
	nameForMessage := strings.TrimSpace(actorName)
	if nameForMessage == "" {
		nameForMessage = "USUARIO"
	}

	// 1) Fail-fast si Telegram no está disponible.
	if s.telegram == nil || !s.telegram.IsActive() {
		return nil, ErrOTPTelegramUnavailable
	}

	// 2) Generar OTP.
	otp, err := generateCashDrawerOTP()
	if err != nil {
		log.Printf("[otp-cajón] fallo crypto/rand al generar OTP para dni=%s: %v", dni, err)
		return nil, ErrOTPRequestFailed
	}
	// Blindaje: la variable `otp` vive sólo en esta función.
	defer wipeString(&otp)

	// 3) Hash bcrypt.
	hash, err := bcrypt.GenerateFromPassword([]byte(otp), s.bcryptCost)
	if err != nil {
		log.Printf("[otp-cajón] bcrypt falló para dni=%s: %v", dni, err)
		return nil, ErrOTPRequestFailed
	}

	// 4) INSERT challenge PENDING.
	issued, err := s.repo.Issue(ctx, repositories.IssueOptions{
		ActorDNI:    dni,
		CodeHash:    hash,
		TTL:         models.CashDrawerOTPDefaultTTL,
		MaxAttempts: models.CashDrawerOTPDefaultMaxAttempts,
		Cooldown:    models.CashDrawerOTPRequestCooldown,
		Now:         s.clock,
	})
	if err != nil {
		// 4a) Cooldown por actor: traducimos preservando el remanente
		// para el `Retry-After`. NO logueamos ningún valor sensible;
		// sólo el DNI y la ventana que falta.
		var cdErr *repositories.CashDrawerOTPCooldownError
		if errors.As(err, &cdErr) {
			log.Printf("[otp-cajón] cooldown activo (dni=%s retryAfter=%s)", dni, cdErr.RetryAfter)
			return nil, &OTPCooldownError{RetryAfter: cdErr.RetryAfter}
		}
		log.Printf("[otp-cajón] repo.Issue falló para dni=%s: %v", dni, err)
		return nil, ErrOTPRequestFailed
	}

	// 5) Enviar OTP por Telegram SÍNCRONAMENTE. El payload incluye el
	// OTP en claro y debe ser lo más minimalista posible: no incluir el
	// hash, ni el challenge_id, ni timestamps absolutos.
	message := formatOTPTelegramMessage(nameForMessage, dni, otp)
	if sendErr := s.telegram.SendSyncOTPMessage(ctx, message); sendErr != nil {
		// 6) Fallo en envío: cancelar el challenge y devolver 503.
		// Si el cancel falla, lo logueamos pero devolvemos el error
		// del envío al cliente (la cola de limpieza expirará la fila
		// por TTL).
		if cancelErr := s.repo.CancelPendingByID(context.Background(), issued.ID); cancelErr != nil {
			log.Printf("[otp-cajón] cancel tras fallo Telegram también falló (challengeID=%s dni=%s): %v",
				issued.ChallengeID, dni, cancelErr)
		}
		log.Printf("[otp-cajón] envío Telegram falló (challengeID=%s dni=%s): %v",
			issued.ChallengeID, dni, sendErr)
		return nil, ErrOTPTelegramUnavailable
	}

	log.Printf("[otp-cajón] challenge emitido (challengeID=%s dni=%s expira=%s)",
		issued.ChallengeID, dni, issued.ExpiresAt.Format(time.RFC3339))

	ttlSec := int(models.CashDrawerOTPDefaultTTL / time.Second)
	return &RequestOutput{
		ChallengeID: issued.ChallengeID,
		ExpiresAt:   issued.ExpiresAt,
		AttemptsMax: issued.AttemptsMax,
		TTLSeconds:  ttlSec,
	}, nil
}

// =========================================================================
// Confirm
// =========================================================================

// ConfirmOutput es el shape que el handler devuelve en el 200 OK de
// Confirm. Incluye el ID y timestamp de la apertura del cajón recién
// auditada. El frontend lo usa para disparar el pulso físico.
type ConfirmOutput struct {
	DrawerOpenID uint
	OpenedAt     time.Time
	ChallengeID  string
}

// ConfirmChallenge valida el OTP tecleado por el usuario contra el
// challenge persistido. Reglas:
//
//   - El OTP debe cumplir ^\d{6}$. Si no, se rechaza antes de abrir una
//     tx y no gasta un intento.
//   - El actor del body se comparara con el `requested_by_dni` del
//     challenge dentro de la tx.
//   - El resto (SELECT FOR UPDATE, bcrypt, drawer insert, UPDATE
//     CONSUMED) ocurre atómicamente dentro del repo.
//
// NUNCA registra el OTP en logs. Un intento inválido deja log sin el
// código ingresado; sólo el challengeID y el DNI.
func (s *CashDrawerOTPService) ConfirmChallenge(ctx context.Context, actorDNI, challengeID, otp, note string) (*ConfirmOutput, error) {
	dni := strings.TrimSpace(actorDNI)
	if dni == "" {
		return nil, ErrOTPActorInvalid
	}

	chID := strings.TrimSpace(challengeID)
	if !models.IsValidCashDrawerChallengeID(chID) {
		return nil, ErrOTPNotFound
	}

	trimmedOTP := strings.TrimSpace(otp)
	if !models.IsValidCashDrawerOTPFormat(trimmedOTP) {
		// Fail-fast sin consumir intento: la BD jamás ve el OTP malformado.
		return nil, ErrOTPBadFormat
	}

	result, err := s.repo.ConfirmChallenge(ctx, repositories.ConfirmInput{
		ChallengeID: chID,
		ActorDNI:    dni,
		OTP:         trimmedOTP,
		Note:        note,
		Now:         s.clock,
	})

	// El OTP vive sólo en el stack del request. Blanqueamos tras el call.
	wipeString(&trimmedOTP)

	if err != nil {
		switch {
		case errors.Is(err, repositories.ErrCashDrawerOTPNotFound):
			return nil, ErrOTPNotFound
		case errors.Is(err, repositories.ErrCashDrawerOTPWrongActor):
			log.Printf("[otp-cajón] actor mismatch (challengeID=%s dni_actor=%s)", chID, dni)
			return nil, ErrOTPWrongActor
		case errors.Is(err, repositories.ErrCashDrawerOTPExpired):
			return nil, ErrOTPExpired
		case errors.Is(err, repositories.ErrCashDrawerOTPExhausted):
			return nil, ErrOTPExhausted
		case errors.Is(err, repositories.ErrCashDrawerOTPMismatch):
			log.Printf("[otp-cajón] intento inválido (challengeID=%s dni=%s)", chID, dni)
			return nil, ErrOTPMismatch
		case errors.Is(err, repositories.ErrCashDrawerOTPExhaustedByThisAttempt):
			log.Printf("[otp-cajón] intento inválido agotó challenge (challengeID=%s dni=%s)", chID, dni)
			return nil, ErrOTPExhausted
		case errors.Is(err, repositories.ErrCashDrawerOTPNotPending):
			return nil, ErrOTPConsumed
		default:
			log.Printf("[otp-cajón] confirm falló (challengeID=%s dni=%s): %v", chID, dni, err)
			return nil, ErrOTPRequestFailed
		}
	}

	log.Printf("[otp-cajón] challenge CONSUMED (challengeID=%s dni=%s drawerOpenId=%d)",
		result.Challenge.ChallengeID, dni, result.DrawerOpen.ID)

	return &ConfirmOutput{
		DrawerOpenID: result.DrawerOpen.ID,
		OpenedAt:     result.DrawerOpen.OpenedAt,
		ChallengeID:  result.Challenge.ChallengeID,
	}, nil
}

// =========================================================================
// Helpers
// =========================================================================

// generateCashDrawerOTP produce un OTP uniforme de 6 dígitos usando
// crypto/rand.Int sobre [0, 10^6). Devuelve el OTP padded con ceros a
// la izquierda si cae por debajo de 100000.
func generateCashDrawerOTP() (string, error) {
	max := big.NewInt(1_000_000) // exclusive upper bound
	n, err := rand.Int(rand.Reader, max)
	if err != nil {
		return "", err
	}
	// %06d garantiza 6 dígitos exactos.
	return fmt.Sprintf("%06d", n.Int64()), nil
}

// formatOTPTelegramMessage arma el mensaje Markdown que recibe el chat
// admin. Mantiene minimalista el payload: nombre, DNI, OTP y ventana.
// NO incluye el challenge_id (información del servidor que no suma al
// operador que lee el OTP).
func formatOTPTelegramMessage(name, dni, otp string) string {
	// Escapamos backticks para no romper el bloque de código Markdown.
	safeName := strings.ReplaceAll(name, "`", "'")
	safeDNI := strings.ReplaceAll(dni, "`", "'")
	ttlSec := int(models.CashDrawerOTPDefaultTTL / time.Second)
	return fmt.Sprintf(
		"🔐 *APERTURA MANUAL DEL CAJÓN*\n\n"+
			"Usuario: *%s* (DNI %s)\n"+
			"Código OTP: `%s`\n"+
			"Vence en %d segundos.\n\n"+
			"Si NO solicitaste esto, avisa inmediatamente al administrador.",
		safeName, safeDNI, otp, ttlSec,
	)
}

// wipeString intenta reemplazar el valor de `s` por una cadena vacía
// para que un `panic`+dump posterior no lo imprima. Go no permite
// borrar realmente la memoria de un string (son inmutables), pero
// anular la referencia reduce la ventana. Más defensivo que útil.
func wipeString(s *string) {
	if s == nil {
		return
	}
	*s = ""
}
