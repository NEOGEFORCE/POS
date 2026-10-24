// Package models — tipos del dominio para el challenge OTP de apertura
// manual del cajón de dinero, disparado por la tecla Home de /sales/new
// cuando el actor no es admin.
//
// IMPORTANTE: este modelo NO forma parte de schemaModels() en
// migrations/catalog.go. La tabla física la crea exclusivamente la
// migración `025_cash_drawer_otp_challenges.sql`. Mantenerlo fuera de
// schemaModels protege el checksum de la migración 002 (model_schema) y
// respeta la política del runner: la BD la mutan sólo migraciones
// explícitas durante una ventana aprobada.
//
// Mapping snake_case ↔ Go sigue la convención GORM con `column:` explícito,
// idéntica a labels.go e internal_barcode_reservation.go.
package models

import (
	"regexp"
	"strings"
	"time"
)

// =========================================================================
// Constantes del protocolo OTP
// =========================================================================

const (
	// CashDrawerOTPLength es la longitud EXACTA del OTP emitido por el
	// servidor. El valor debe empatar con el regex del validador en el
	// handler y con la validación del service. Un cambio aquí requiere
	// coordinar con la UI (shadcn pide 6 dígitos).
	CashDrawerOTPLength = 6

	// CashDrawerOTPDefaultTTL es la vida útil del challenge PENDING. El
	// spec operativo fija 90 segundos: suficiente para abrir Telegram,
	// leer el código y teclearlo; corto para limitar la ventana en caso
	// de que el chat quede expuesto.
	CashDrawerOTPDefaultTTL = 90 * time.Second

	// CashDrawerOTPDefaultMaxAttempts es el techo de intentos por
	// challenge. Al tercer fallo pasa a FAILED durable y el actor debe
	// pedir uno nuevo. Empata con el default de la columna attempts_max
	// (CHECK ck_cdoc_attempts_bounds >= 1).
	CashDrawerOTPDefaultMaxAttempts = 3

	// CashDrawerOTPChallengeIDHexLen es el ancho del challenge_id opaco
	// en nibbles hex. 64 nibbles = 32 bytes = 256 bits de entropía, muy
	// por encima del tamaño del espacio de ataque posible.
	CashDrawerOTPChallengeIDHexLen = 64

	// CashDrawerOTPRequestCooldown es el lapso mínimo que debe pasar
	// entre dos emisiones consecutivas de OTP para el MISMO actor. Se
	// alinea con el refill del token bucket por IP (`RateLimitMiddleware`
	// con 5/60 tokens/segundo ≈ 1 token cada 12 segundos). El bucket por
	// IP ya existe; este cooldown es durable y por actor, serializado
	// con `pg_advisory_xact_lock` para resistir solicitudes concurrentes
	// desde pestañas distintas o IPs compartidas (NAT/proxy).
	CashDrawerOTPRequestCooldown = 12 * time.Second
)

// =========================================================================
// Estados del challenge
// =========================================================================
//
// Deben coincidir EXACTAMENTE con los literales enumerados por el CHECK
// `ck_cdoc_status_known` de la migración 025. Un typo acá produce un
// INSERT que viola el CHECK — el servicio prefiere rechazar temprano.

const (
	CashDrawerOTPStatusPending   = "PENDING"
	CashDrawerOTPStatusConsumed  = "CONSUMED"
	CashDrawerOTPStatusFailed    = "FAILED"
	CashDrawerOTPStatusExpired   = "EXPIRED"
	CashDrawerOTPStatusCancelled = "CANCELLED"
)

// IsValidCashDrawerOTPStatus replica el enum del CHECK para que el
// servicio pueda rechazar inputs inválidos antes de llegar a la BD.
func IsValidCashDrawerOTPStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case CashDrawerOTPStatusPending,
		CashDrawerOTPStatusConsumed,
		CashDrawerOTPStatusFailed,
		CashDrawerOTPStatusExpired,
		CashDrawerOTPStatusCancelled:
		return true
	default:
		return false
	}
}

// =========================================================================
// Códigos de error estables (contrato con el frontend)
// =========================================================================
//
// Si alguien los renombra, el UX del modal shadcn pierde su rama de
// recuperación específica (reintento, "pedir otro OTP", etc.). Son parte
// del contrato — un cambio requiere coordinación con pos-next-frontend.
const (
	// ErrCodeOTPChallengeNotFound: el challenge_id del payload no existe
	// o pertenece a otro actor.
	ErrCodeOTPChallengeNotFound = "DRAWER_OTP_NOT_FOUND"

	// ErrCodeOTPChallengeWrongActor: el challenge existe pero fue
	// emitido para otro DNI. Nunca debería ocurrir en operación normal
	// (el servicio liga challenge → actor), pero el handler devuelve
	// este código si llega a ocurrir — defensa en profundidad.
	ErrCodeOTPChallengeWrongActor = "DRAWER_OTP_WRONG_ACTOR"

	// ErrCodeOTPChallengeExpired: el challenge existe pero expires_at
	// ya pasó. El actor debe pedir otro OTP.
	ErrCodeOTPChallengeExpired = "DRAWER_OTP_EXPIRED"

	// ErrCodeOTPChallengeExhausted: el challenge agotó attempts_max
	// (FAILED). El actor debe pedir otro OTP.
	ErrCodeOTPChallengeExhausted = "DRAWER_OTP_ATTEMPTS_EXHAUSTED"

	// ErrCodeOTPChallengeInvalid: el OTP ingresado NO coincide con el
	// hash. El attempt se registra durable y, si llegó al techo, el
	// challenge pasa a FAILED en el mismo COMMIT.
	ErrCodeOTPChallengeInvalid = "DRAWER_OTP_INVALID"

	// ErrCodeOTPChallengeAlreadyUsed: el challenge ya fue consumido
	// por una apertura previa (single-use).
	ErrCodeOTPChallengeAlreadyUsed = "DRAWER_OTP_ALREADY_USED"

	// ErrCodeOTPChallengeCancelled: el challenge fue cancelado — el
	// actor pidió otro o el envío Telegram falló.
	ErrCodeOTPChallengeCancelled = "DRAWER_OTP_CANCELLED"

	// ErrCodeOTPTelegramUnavailable: Telegram no está activo o el
	// envío síncrono falló/timeouteó. Se marca el challenge CANCELLED
	// y la respuesta es 503.
	ErrCodeOTPTelegramUnavailable = "DRAWER_OTP_TELEGRAM_UNAVAILABLE"

	// ErrCodeOTPRequestFailed: fallo transitorio en la emisión (BD,
	// crypto). El actor puede reintentar.
	ErrCodeOTPRequestFailed = "DRAWER_OTP_REQUEST_FAILED"

	// ErrCodeOTPFormatInvalid: el OTP enviado NO cumple el shape
	// ^\d{6}$ (6 dígitos exactos). Se rechaza antes de abrir cualquier
	// transacción para no gastar un intento.
	ErrCodeOTPFormatInvalid = "DRAWER_OTP_FORMAT_INVALID"

	// ErrCodeOTPCooldownActive: el actor pidió un OTP hace menos de
	// `CashDrawerOTPRequestCooldown` segundos. Se traduce a HTTP 429
	// con cabecera `Retry-After`. El mensaje al cliente NO revela cuánto
	// tiempo lleva emitido el anterior; sólo cuánto falta para reintentar.
	ErrCodeOTPCooldownActive = "DRAWER_OTP_COOLDOWN"
)

// =========================================================================
// Shape del OTP y challenge_id
// =========================================================================

// cashDrawerOTPShape valida 6 dígitos exactos. Puro ASCII; no se admiten
// signos, espacios ni letras. El handler lo usa como primer filtro para
// rechazar inputs malformados antes de leer la BD.
var cashDrawerOTPShape = regexp.MustCompile(`^\d{6}$`)

// IsValidCashDrawerOTPFormat valida el OTP tecleado por el usuario.
// NO verifica correctitud — sólo shape. La verificación bcrypt la hace
// el servicio dentro de la tx de SELECT FOR UPDATE.
//
// Importante: el OTP NUNCA entra a logs. El handler usa este helper
// como filtro inicial y descarta el valor antes de responder al cliente.
func IsValidCashDrawerOTPFormat(otp string) bool {
	return cashDrawerOTPShape.MatchString(otp)
}

// cashDrawerChallengeIDShape valida que el challenge_id opaco emitido
// por el servidor tenga el shape esperado (hex ASCII, hasta 64 chars).
// Un cliente malicioso NO puede pasar strings con bytes raros para
// provocar errores de parsing o CHECK violation en la BD.
var cashDrawerChallengeIDShape = regexp.MustCompile(`^[0-9a-fA-F]{32,64}$`)

// IsValidCashDrawerChallengeID valida el challenge_id tal como lo
// recibe el handler Confirm. Es la última defensa antes del lookup; la
// BD también lo rechazaría por longitud (VARCHAR(64)) pero el servicio
// prefiere fallar temprano con un código estable.
func IsValidCashDrawerChallengeID(id string) bool {
	return cashDrawerChallengeIDShape.MatchString(id)
}

// =========================================================================
// Modelo GORM
// =========================================================================

// CashDrawerOTPChallenge es la fila de `cash_drawer_otp_challenges` que
// crea la migración 025. Un challenge por intento de apertura manual.
//
// Garantías de la BD que el modelo refleja fielmente:
//
//   - `ChallengeID` UNIQUE (opaco, ASCII hex), para que el cliente lo
//     mande de vuelta al validar sin exponer la fila por PK.
//   - `RequestedByDNI` fija al autor desde la sesión. El servicio NUNCA
//     deja que el cliente elija el actor libremente.
//   - `CodeHash` es BYTEA bcrypt. El OTP en claro JAMÁS vive aquí;
//     viaja por Telegram y regresa en el POST de validación.
//   - `AttemptsUsed`/`AttemptsMax` con default 3 (CHECK >= 1).
//   - `Status` enumerado (CHECK ck_cdoc_status_known).
//   - Biyección CONSUMED ↔ (consumed_at, consumed_drawer_open_id)
//     garantizada por ck_cdoc_consumed_coherent.
//
// Mapping camelCase de JSON respeta la convención del front-end.
type CashDrawerOTPChallenge struct {
	ID                   uint64     `gorm:"primaryKey;autoIncrement;column:id"           json:"id"`
	ChallengeID          string     `gorm:"column:challenge_id;type:varchar(64);not null;uniqueIndex" json:"challengeId"`
	RequestedByDNI       string     `gorm:"column:requested_by_dni;type:varchar(32);not null"         json:"requestedByDni"`
	CodeHash             []byte     `gorm:"column:code_hash;type:bytea;not null"                      json:"-"`
	CreatedAt            time.Time  `gorm:"column:created_at;not null;default:now()"                  json:"createdAt"`
	ExpiresAt            time.Time  `gorm:"column:expires_at;not null"                                json:"expiresAt"`
	AttemptsUsed         int        `gorm:"column:attempts_used;not null;default:0"                   json:"attemptsUsed"`
	AttemptsMax          int        `gorm:"column:attempts_max;not null;default:3"                    json:"attemptsMax"`
	Status               string     `gorm:"column:status;type:varchar(16);not null;default:'PENDING'" json:"status"`
	ConsumedAt           *time.Time `gorm:"column:consumed_at"                                        json:"consumedAt,omitempty"`
	ConsumedDrawerOpenID *uint64    `gorm:"column:consumed_drawer_open_id"                            json:"consumedDrawerOpenId,omitempty"`
}

// TableName obliga a GORM a usar el nombre exacto creado por la 025.
func (CashDrawerOTPChallenge) TableName() string {
	return "cash_drawer_otp_challenges"
}

// IsLive reporta si el challenge aún se puede consumir en `now`.
// Combina status=PENDING, no expirado y attempts_used < attempts_max.
// El servicio lo usa como gate antes de verificar el hash; la BD vuelve
// a validar con CHECKs en el mismo COMMIT, pero fallar temprano permite
// devolver un error estable antes de gastar bcrypt.CompareHashAndPassword
// (que es intencionalmente lento).
func (c *CashDrawerOTPChallenge) IsLive(now time.Time) bool {
	if c == nil || c.Status != CashDrawerOTPStatusPending {
		return false
	}
	if !now.Before(c.ExpiresAt) {
		return false
	}
	if c.AttemptsUsed >= c.AttemptsMax {
		return false
	}
	return true
}

// IsExhausted reporta si el challenge agotó sus intentos. Útil para el
// handler que distingue INVALID (aún puede reintentar) de EXHAUSTED
// (debe pedir otro OTP). Lo evaluamos sobre el objeto después del
// bump de attempts_used, no antes.
func (c *CashDrawerOTPChallenge) IsExhausted() bool {
	if c == nil {
		return false
	}
	return c.AttemptsUsed >= c.AttemptsMax
}
