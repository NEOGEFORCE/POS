// Repositorio del challenge OTP para apertura manual del cajón (migración 025).
//
// Responsabilidades:
//
//   - Emitir un challenge nuevo: respetar cooldown por actor (serializado
//     con `pg_advisory_xact_lock` dentro de la misma tx), expirar stale,
//     cancelar PENDING vigente del mismo actor y persistir la fila
//     RESERVED con bcrypt(code_hash). El `challenge_id` opaco se genera
//     con crypto/rand y, ante colisión en la UNIQUE global, se reintenta.
//
//   - Confirmar un challenge dentro de UNA SOLA transacción:
//     1. SELECT FOR UPDATE sobre la fila del challenge, serializando dos
//     pestañas que validan al mismo tiempo.
//     2. Verificaciones: actor coincidente, status=PENDING, no expirado,
//     attempts_used < attempts_max.
//     3. bcrypt.CompareHashAndPassword con el OTP recibido.
//     4a. Si NO coincide: incrementa attempts_used; si llegó al techo,
//     pasa a FAILED. COMMIT para que el intento quede durable. El
//     error de dominio (`ErrCashDrawerOTPMismatch` o `…ExhaustedByThisAttempt`)
//     se devuelve DESPUÉS del Transaction para no gatillar rollback.
//     4b. Si coincide: INSERT en cash_drawer_opens con reason='otp_manual'
//     y otp_challenge_id=X. UPDATE del challenge a CONSUMED con
//     consumed_at=now y consumed_drawer_open_id=<new>. COMMIT.
//     Un error en pasos 4a/4b → rollback y el challenge NO se consume.
//
//   - Cancelar un challenge PENDING (cuando el envío Telegram falla o
//     el admin lo invalida manualmente). Es idempotente: cancelar un
//     challenge que ya está CONSUMED/FAILED es un no-op.
//
// Decisiones clave:
//
//   - El OTP en claro JAMÁS entra a este archivo. El servicio pasa
//     siempre el hash bcrypt o el OTP tecleado por el usuario; la
//     comparación bcrypt corre AQUÍ dentro de la tx para serializar.
//     Ningún log imprime el OTP ni el hash en claro.
//
//   - El `clientBcryptHash` del INSERT lo calcula el servicio ANTES
//     de abrir la tx: bcrypt.GenerateFromPassword es lento (10..14
//     costo) y no queremos ocupar advisory locks durante ese tiempo.
//
//   - El drawer open se inserta DENTRO del repo OTP para asegurar que
//     todo caiga en la misma transacción. Si el handler quisiera
//     hacerlo por fuera, perderíamos la atomicidad.
//
//   - Las transiciones de estado "fin de vida" del challenge
//     (EXPIRED, FAILED, bump de attempts_used) ocurren DENTRO del
//     callback de Transaction pero el error de dominio NO se retorna
//     desde el callback: se guarda en una variable y se emite tras el
//     COMMIT. Devolver el error desde el callback haría ROLLBACK y el
//     ataque de brute-force quedaría sin registro — exactamente lo
//     contrario de la intención.
package repositories

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"

	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// CashDrawerOTPRepository encapsula la persistencia de challenges OTP y
// la auditoría del consumo contra cash_drawer_opens.
type CashDrawerOTPRepository struct {
	db *gorm.DB
}

// NewCashDrawerOTPRepository construye el repositorio.
func NewCashDrawerOTPRepository(db *gorm.DB) *CashDrawerOTPRepository {
	return &CashDrawerOTPRepository{db: db}
}

// Errores sentinela del dominio. El servicio los traduce a códigos
// HTTP estables. NUNCA incluyen fragmentos del OTP o del hash.
var (
	// ErrCashDrawerOTPActorInvalid: el DNI del actor viene vacío.
	ErrCashDrawerOTPActorInvalid = errors.New("cash drawer otp: actor DNI requerido")

	// ErrCashDrawerOTPHashInvalid: el hash bcrypt viene con tamaño fuera
	// del rango esperado. Replica el CHECK de la migración y evita
	// pegar un INSERT que violaría ck_cdoc_code_hash_bcrypt_size.
	ErrCashDrawerOTPHashInvalid = errors.New("cash drawer otp: hash bcrypt inválido")

	// ErrCashDrawerOTPNotFound: no existe el challenge_id consultado.
	ErrCashDrawerOTPNotFound = errors.New("cash drawer otp: challenge no encontrado")

	// ErrCashDrawerOTPWrongActor: el challenge_id existe pero el DNI del
	// autor no coincide con el actor que lo está validando.
	ErrCashDrawerOTPWrongActor = errors.New("cash drawer otp: challenge pertenece a otro actor")

	// ErrCashDrawerOTPNotPending: el challenge ya fue consumido,
	// cancelado o expiró (status != PENDING).
	ErrCashDrawerOTPNotPending = errors.New("cash drawer otp: challenge no está en PENDING")

	// ErrCashDrawerOTPExpired: expires_at ya pasó.
	ErrCashDrawerOTPExpired = errors.New("cash drawer otp: challenge expirado")

	// ErrCashDrawerOTPExhausted: attempts_used >= attempts_max.
	ErrCashDrawerOTPExhausted = errors.New("cash drawer otp: challenge agotado")

	// ErrCashDrawerOTPMismatch: el OTP ingresado NO coincide con el
	// hash. El intento se registró durable antes de devolver el error.
	ErrCashDrawerOTPMismatch = errors.New("cash drawer otp: código incorrecto")

	// ErrCashDrawerOTPExhaustedByThisAttempt: variante de Mismatch
	// cuando el bump de attempts_used llevó al techo y el challenge
	// pasó a FAILED en el mismo COMMIT. Permite al handler responder
	// con un código distinto para que la UI muestre "pedí otro OTP".
	ErrCashDrawerOTPExhaustedByThisAttempt = errors.New("cash drawer otp: challenge agotado tras este intento")

	// ErrCashDrawerOTPGeneratorExhausted: el generador de challenge_id
	// agotó sus reintentos tras colisiones consecutivas. Imposible en
	// la práctica (256 bits de entropía) pero cubierto por el handler.
	ErrCashDrawerOTPGeneratorExhausted = errors.New("cash drawer otp: generador de challenge_id agotó reintentos")

	// ErrCashDrawerOTPCooldown: el actor ya emitió un OTP hace menos
	// de `Cooldown`. El servicio y el handler lo traducen a HTTP 429
	// con `Retry-After`. El wrapper `*CashDrawerOTPCooldownError`
	// transporta el remanente concreto para la cabecera; el sentinel
	// permite `errors.Is` sin filtrar la ventana.
	ErrCashDrawerOTPCooldown = errors.New("cash drawer otp: cooldown activo")
)

// CashDrawerOTPCooldownError envuelve `ErrCashDrawerOTPCooldown` con el
// tiempo exacto que resta para poder reintentar. Se devuelve desde
// `Issue` cuando la verificación de cooldown falla. El servicio hace
// `errors.As(err, &cdErr)` para construir el `Retry-After`.
//
// `Unwrap` apunta al sentinel para que `errors.Is(err, ErrCashDrawerOTPCooldown)`
// siga siendo el chequeo canónico.
type CashDrawerOTPCooldownError struct {
	// RetryAfter es el tiempo que falta para poder emitir un nuevo
	// challenge. Siempre > 0 cuando el error se construye.
	RetryAfter time.Duration
}

func (e *CashDrawerOTPCooldownError) Error() string {
	return ErrCashDrawerOTPCooldown.Error()
}

func (e *CashDrawerOTPCooldownError) Unwrap() error {
	return ErrCashDrawerOTPCooldown
}

// cashDrawerOTPMaxGenerateAttempts es el techo de reintentos del
// generador de challenge_id ante colisión con la UNIQUE global.
const cashDrawerOTPMaxGenerateAttempts = 10

// cashDrawerOTPActorLockSQL serializa concurrentes solicitudes del
// mismo actor dentro de la tx. `pg_advisory_xact_lock` se libera
// automáticamente al COMMIT/ROLLBACK, sin riesgo de leak si el
// handler panica.
const cashDrawerOTPActorLockSQL = `SELECT pg_advisory_xact_lock(hashtext(?))`

// cashDrawerOTPActorLockKey separa el espacio de claves de este
// advisory lock de cualquier otro del sistema (p.ej. etiquetas,
// ClientTxId de ventas).
func cashDrawerOTPActorLockKey(actorDNI string) string {
	return "cash_drawer_otp:actor:" + actorDNI
}

// cashDrawerOTPLastEmissionSQL consulta la última emisión del actor
// (independiente de su status actual). Se usa EXCLUSIVAMENTE para
// evaluar el cooldown; no filtra por PENDING porque el actor podría
// haber consumido/perdido el anterior y aun así debería respetar la
// ventana.
const cashDrawerOTPLastEmissionSQL = `SELECT MAX(created_at) FROM cash_drawer_otp_challenges WHERE requested_by_dni = ?`

// =========================================================================
// Emisión
// =========================================================================

// IssueOptions parametriza la emisión del challenge.
type IssueOptions struct {
	// ActorDNI es el DNI del empleado que pidió el OTP (viene de la
	// sesión en el handler). El valor NO lo elige el cliente.
	ActorDNI string
	// CodeHash es bcrypt(OTP). El servicio lo computa fuera de la tx.
	CodeHash []byte
	// TTL es la ventana de validez. 0 → models.CashDrawerOTPDefaultTTL.
	TTL time.Duration
	// MaxAttempts es el techo de intentos. 0 → models.CashDrawerOTPDefaultMaxAttempts.
	MaxAttempts int
	// Cooldown exige que haya transcurrido al menos este lapso desde
	// la última emisión del mismo actor. 0 → se omite la verificación
	// (modo de compatibilidad para tests legados). En producción el
	// servicio pasa siempre `models.CashDrawerOTPRequestCooldown`.
	Cooldown time.Duration
	// Now permite inyectar un reloj desde los tests. nil → time.Now.
	Now func() time.Time
}

// Issue persiste un challenge PENDING para el actor:
//
//  1. Cooldown por actor: toma `pg_advisory_xact_lock` sobre una clave
//     derivada del DNI (serializa pestañas/IPs del mismo usuario) y
//     consulta `MAX(created_at)` del actor. Si transcurrió menos del
//     cooldown configurado, aborta sin cambios y devuelve
//     `*CashDrawerOTPCooldownError`.
//  2. Expira stale (PENDING cuyo expires_at ya pasó, para no gatillar
//     el UNIQUE PARCIAL `ux_cdoc_live_by_actor` por basura antigua).
//  3. Cancela cualquier PENDING vigente del mismo actor — un segundo
//     Request siempre desplaza al anterior. La columna CANCELLED hace
//     que el UNIQUE PARCIAL libere el slot.
//  4. INSERT con status=PENDING. El challenge_id se genera con
//     crypto/rand y reintenta ante colisión con la UNIQUE global.
//
// Devuelve el challenge recién insertado (sin el code_hash en memoria
// nuevo; sólo IDs/metadata). El servicio NO debe conservar el hash
// después de este punto; la verificación bcrypt vive en Confirm.
func (r *CashDrawerOTPRepository) Issue(ctx context.Context, opts IssueOptions) (*models.CashDrawerOTPChallenge, error) {
	actor := strings.TrimSpace(opts.ActorDNI)
	if actor == "" {
		return nil, ErrCashDrawerOTPActorInvalid
	}
	// Blindaje: la columna acepta bcrypt (59..72 bytes) exclusivamente.
	// Si el servicio pasa un hash con el tamaño fuera de rango, el CHECK
	// ck_cdoc_code_hash_bcrypt_size abortaría el INSERT; el error aquí
	// deja un mensaje más estable sin fragmentos del driver.
	if sz := len(opts.CodeHash); sz < 59 || sz > 72 {
		return nil, ErrCashDrawerOTPHashInvalid
	}
	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}
	ttl := opts.TTL
	if ttl <= 0 {
		ttl = models.CashDrawerOTPDefaultTTL
	}
	maxAttempts := opts.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = models.CashDrawerOTPDefaultMaxAttempts
	}

	var out *models.CashDrawerOTPChallenge
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		currentNow := now()

		// 0) Cooldown por actor (solo si está configurado).
		//
		// El advisory lock se adquiere ANTES del SELECT MAX para que
		// dos solicitudes concurrentes del mismo actor se serialicen:
		// la primera emite, suelta el lock al COMMIT, y la segunda
		// despierta a leer un MAX(created_at) que YA refleja la nueva
		// emisión → responde con el cooldown correcto.
		if opts.Cooldown > 0 {
			if err := tx.Exec(cashDrawerOTPActorLockSQL, cashDrawerOTPActorLockKey(actor)).Error; err != nil {
				return fmt.Errorf("advisory lock cooldown: %w", err)
			}
			var lastCreatedAt sql.NullTime
			if err := tx.Raw(cashDrawerOTPLastEmissionSQL, actor).Row().Scan(&lastCreatedAt); err != nil {
				// `sql.ErrNoRows` jamás ocurre con MAX() (aggregate siempre
				// retorna 1 fila, posiblemente con NULL). Cualquier otro
				// error aborta la emisión.
				return fmt.Errorf("consulta cooldown: %w", err)
			}
			if lastCreatedAt.Valid {
				elapsed := currentNow.Sub(lastCreatedAt.Time)
				if elapsed < opts.Cooldown {
					retryAfter := opts.Cooldown - elapsed
					if retryAfter <= 0 {
						// Protección contra tiempo retrocedido (NTP skew).
						retryAfter = time.Second
					}
					return &CashDrawerOTPCooldownError{RetryAfter: retryAfter}
				}
			}
		}

		// 1) Expirar stale del mismo actor. Hacemos UPDATE acotado al
		// actor en vez de global para no sacar locks sobre filas de
		// otros empleados.
		if err := tx.Model(&models.CashDrawerOTPChallenge{}).
			Where("requested_by_dni = ? AND status = ? AND expires_at <= ?",
				actor, models.CashDrawerOTPStatusPending, currentNow).
			Update("status", models.CashDrawerOTPStatusExpired).Error; err != nil {
			return fmt.Errorf("expirando stale: %w", err)
		}

		// 2) Cancelar PENDING vigente del actor. Un operador que oprima
		// Home dos veces seguidas desplaza su OTP anterior.
		if err := tx.Model(&models.CashDrawerOTPChallenge{}).
			Where("requested_by_dni = ? AND status = ?",
				actor, models.CashDrawerOTPStatusPending).
			Update("status", models.CashDrawerOTPStatusCancelled).Error; err != nil {
			return fmt.Errorf("cancelando previo: %w", err)
		}

		// 3) Generar challenge_id único y persistir.
		for attempt := 0; attempt < cashDrawerOTPMaxGenerateAttempts; attempt++ {
			candidate, err := generateChallengeID()
			if err != nil {
				return fmt.Errorf("crypto/rand no disponible: %w", err)
			}
			// Copiamos el hash para no retener el buffer del servicio
			// después del INSERT; el GORM Create tomará ownership.
			hashCopy := append([]byte(nil), opts.CodeHash...)
			row := models.CashDrawerOTPChallenge{
				ChallengeID:    candidate,
				RequestedByDNI: actor,
				CodeHash:       hashCopy,
				CreatedAt:      currentNow,
				ExpiresAt:      currentNow.Add(ttl),
				AttemptsUsed:   0,
				AttemptsMax:    maxAttempts,
				Status:         models.CashDrawerOTPStatusPending,
			}
			if err := tx.Create(&row).Error; err != nil {
				if isUniqueViolationErr(err) {
					// Colisión improbable en 256 bits — reintentar.
					continue
				}
				return err
			}
			// Blindaje: el hash NO viaja hacia fuera del repo.
			row.CodeHash = nil
			out = &row
			return nil
		}
		return ErrCashDrawerOTPGeneratorExhausted
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// =========================================================================
// Lookup
// =========================================================================

// GetByChallengeID devuelve el challenge por su ID opaco. Devuelve
// ErrCashDrawerOTPNotFound si no existe. El código bcrypt NO se expone:
// se blanquea antes de retornar para que un uso descuidado no acabe
// imprimiéndolo en logs.
func (r *CashDrawerOTPRepository) GetByChallengeID(ctx context.Context, challengeID string) (*models.CashDrawerOTPChallenge, error) {
	id := strings.TrimSpace(challengeID)
	if id == "" {
		return nil, ErrCashDrawerOTPNotFound
	}
	var row models.CashDrawerOTPChallenge
	err := r.db.WithContext(ctx).
		Where("challenge_id = ?", id).
		First(&row).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrCashDrawerOTPNotFound
		}
		return nil, err
	}
	// Nunca se expone el hash fuera del tx de Confirm.
	row.CodeHash = nil
	return &row, nil
}

// =========================================================================
// Cancelación
// =========================================================================

// CancelPendingByID marca el challenge como CANCELLED si está en
// PENDING. Idempotente: si ya está en otro estado, no hace nada.
// Se usa cuando el envío Telegram falla tras persistir el PENDING.
func (r *CashDrawerOTPRepository) CancelPendingByID(ctx context.Context, id uint64) error {
	if id == 0 {
		return ErrCashDrawerOTPNotFound
	}
	return r.db.WithContext(ctx).
		Model(&models.CashDrawerOTPChallenge{}).
		Where("id = ? AND status = ?", id, models.CashDrawerOTPStatusPending).
		Update("status", models.CashDrawerOTPStatusCancelled).Error
}

// =========================================================================
// Confirmación atómica
// =========================================================================

// ConfirmResult es el shape que devuelve ConfirmChallenge en el camino
// exitoso. Incluye la apertura del cajón recién creada; el servicio la
// usa para informar al cliente que puede disparar el pulso físico.
type ConfirmResult struct {
	DrawerOpen *models.CashDrawerOpen
	Challenge  *models.CashDrawerOTPChallenge
}

// ConfirmInput agrupa los parámetros que necesita la confirmación
// atómica. El `OTP` se recibe en claro y se descarta tras la verificación;
// NUNCA se persiste.
type ConfirmInput struct {
	ChallengeID string
	ActorDNI    string
	OTP         string
	Note        string
	Now         func() time.Time
}

// ConfirmChallenge valida el challenge y, si todo cuadra, crea la fila
// cash_drawer_opens con reason='otp_manual' y marca el challenge
// CONSUMED. Toda la secuencia va dentro de UNA SOLA transacción:
//
//  1. SELECT FOR UPDATE del challenge (serializa dos confirmaciones
//     paralelas).
//  2. Validar actor, status, expiración y attempts_used.
//  3. bcrypt.CompareHashAndPassword con el OTP recibido.
//     3a. Mismatch: UPDATE attempts_used += 1; si llegó al techo, pasa
//     a FAILED. COMMIT. Devuelve ErrCashDrawerOTPMismatch o
//     ErrCashDrawerOTPExhaustedByThisAttempt (devueltos TRAS el
//     COMMIT para no gatillar rollback del bump).
//     3b. Match: INSERT cash_drawer_opens; UPDATE challenge a CONSUMED
//     con consumed_at=now y consumed_drawer_open_id=<new>. COMMIT.
//
// Las transiciones de "fin de vida" (EXPIRED, FAILED, bump de intento)
// deben persistir aunque devolvamos un error de dominio al handler.
// Devolver el error desde el callback de `Transaction` haría rollback
// y los intentos de brute-force quedarían sin rastro — exactamente lo
// contrario de la intención. Por eso guardamos el error de dominio en
// una variable local y lo devolvemos DESPUÉS del COMMIT.
//
// En cambio, los paths "sin cambios" (actor incorrecto, challenge no
// encontrado, status != PENDING sin tocar la fila) sí retornan error
// desde el callback para que GORM haga ROLLBACK: no gastan intento y
// no mutan la BD.
//
// Nunca registra el OTP ni el hash en el log; el callsite del servicio
// escribe un log sanitizado con el challengeID y el DNI del actor.
func (r *CashDrawerOTPRepository) ConfirmChallenge(ctx context.Context, in ConfirmInput) (*ConfirmResult, error) {
	chID := strings.TrimSpace(in.ChallengeID)
	actor := strings.TrimSpace(in.ActorDNI)
	if chID == "" {
		return nil, ErrCashDrawerOTPNotFound
	}
	if actor == "" {
		return nil, ErrCashDrawerOTPActorInvalid
	}
	now := time.Now
	if in.Now != nil {
		now = in.Now
	}

	var result ConfirmResult
	// domainErr guarda el error de dominio que debe emitirse DESPUÉS
	// del COMMIT. Si está puesto, significa que la tx hizo mutaciones
	// durables (bump de attempts_used, status=EXPIRED/FAILED) y el
	// callback retornó nil para que GORM las confirme.
	var domainErr error
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1) Lock de la fila del challenge.
		var challenge models.CashDrawerOTPChallenge
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("challenge_id = ?", chID).
			First(&challenge).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				// Sin fila que mutar → rollback limpio, sin gastar intento.
				return ErrCashDrawerOTPNotFound
			}
			return err
		}

		// 2a) Actor mismatch: ROLLBACK sin tocar la fila. Devolver el
		// error desde el callback asegura rollback y preserva la
		// propiedad "actor incorrecto NO gasta intento".
		if challenge.RequestedByDNI != actor {
			return ErrCashDrawerOTPWrongActor
		}

		// 2b) Status no PENDING: no hay mutación que confirmar;
		// rollback limpio con el error traducido.
		if challenge.Status != models.CashDrawerOTPStatusPending {
			switch challenge.Status {
			case models.CashDrawerOTPStatusConsumed:
				return ErrCashDrawerOTPNotPending
			case models.CashDrawerOTPStatusFailed:
				return ErrCashDrawerOTPExhausted
			case models.CashDrawerOTPStatusExpired:
				return ErrCashDrawerOTPExpired
			case models.CashDrawerOTPStatusCancelled:
				return ErrCashDrawerOTPNotPending
			default:
				return ErrCashDrawerOTPNotPending
			}
		}

		currentNow := now()

		// 2c) Expiración: transición durable a EXPIRED → COMMIT con
		// el UPDATE, error de dominio devuelto afuera.
		if !currentNow.Before(challenge.ExpiresAt) {
			if err := tx.Model(&models.CashDrawerOTPChallenge{}).
				Where("id = ? AND status = ?", challenge.ID, models.CashDrawerOTPStatusPending).
				Update("status", models.CashDrawerOTPStatusExpired).Error; err != nil {
				// Error real de BD → rollback de la transición y
				// propagamos el error técnico.
				return err
			}
			domainErr = ErrCashDrawerOTPExpired
			return nil
		}

		// 2d) attempts_used ya topó (defensa en profundidad; status
		// debería estar FAILED en condiciones normales). Normalizamos
		// a FAILED en el mismo COMMIT.
		if challenge.AttemptsUsed >= challenge.AttemptsMax {
			if err := tx.Model(&models.CashDrawerOTPChallenge{}).
				Where("id = ? AND status = ?", challenge.ID, models.CashDrawerOTPStatusPending).
				Update("status", models.CashDrawerOTPStatusFailed).Error; err != nil {
				return err
			}
			domainErr = ErrCashDrawerOTPExhausted
			return nil
		}

		// 3) Verificación bcrypt. CompareHashAndPassword tiene costo
		// constante contra timing attacks dentro de un mismo cost
		// factor.
		mismatch := bcrypt.CompareHashAndPassword(challenge.CodeHash, []byte(in.OTP)) != nil
		if mismatch {
			// 3a) Bump durable. El attempt se COMMIT-ea aunque este
			// path devuelva error de dominio al handler. Si el bump
			// llega al techo, marcamos FAILED en el mismo UPDATE
			// para no quedar en estado inconsistente.
			newUsed := challenge.AttemptsUsed + 1
			updates := map[string]interface{}{"attempts_used": newUsed}
			exhaustedByThis := newUsed >= challenge.AttemptsMax
			if exhaustedByThis {
				updates["status"] = models.CashDrawerOTPStatusFailed
			}
			if err := tx.Model(&models.CashDrawerOTPChallenge{}).
				Where("id = ? AND status = ?", challenge.ID, models.CashDrawerOTPStatusPending).
				Updates(updates).Error; err != nil {
				// Error real de BD → rollback del bump. Reintentar
				// no gasta un intento (que no quedó persistido) — un
				// comportamiento aceptable: el fallo es visible por
				// log.
				return err
			}
			if exhaustedByThis {
				domainErr = ErrCashDrawerOTPExhaustedByThisAttempt
			} else {
				domainErr = ErrCashDrawerOTPMismatch
			}
			return nil
		}

		// 3b) Match: insertar la apertura del cajón DENTRO del mismo tx.
		challengeIDForOpen := challenge.ID
		open := models.CashDrawerOpen{
			OpenedAt:       currentNow,
			ActorDNI:       actor,
			Reason:         models.CashDrawerReasonOtpManual,
			OtpChallengeID: &challengeIDForOpen,
			Note:           strings.TrimSpace(in.Note),
		}
		if err := tx.Create(&open).Error; err != nil {
			// Rollback por retorno: el challenge queda intacto en
			// PENDING, el attempt NO se cuenta.
			return fmt.Errorf("insert cash_drawer_opens: %w", err)
		}

		// Y marcar el challenge como CONSUMED con la biyección exacta
		// (consumed_at + consumed_drawer_open_id) para no violar
		// ck_cdoc_consumed_coherent.
		openIDForChallenge := uint64(open.ID)
		updates := map[string]interface{}{
			"status":                  models.CashDrawerOTPStatusConsumed,
			"consumed_at":             currentNow,
			"consumed_drawer_open_id": openIDForChallenge,
		}
		res := tx.Model(&models.CashDrawerOTPChallenge{}).
			Where("id = ? AND status = ?", challenge.ID, models.CashDrawerOTPStatusPending).
			Updates(updates)
		if res.Error != nil {
			return fmt.Errorf("update challenge CONSUMED: %w", res.Error)
		}
		if res.RowsAffected != 1 {
			// Carrera imposible bajo FOR UPDATE, pero si ocurre, aborta
			// la tx para no dejar el drawer open sin su challenge.
			return ErrCashDrawerOTPNotPending
		}

		// Blanqueamos el hash antes de devolver.
		challenge.CodeHash = nil
		challenge.Status = models.CashDrawerOTPStatusConsumed
		challenge.ConsumedAt = &currentNow
		challenge.ConsumedDrawerOpenID = &openIDForChallenge
		result = ConfirmResult{DrawerOpen: &open, Challenge: &challenge}
		return nil
	})
	// Un error desde el callback que haga rollback (NotFound, WrongActor,
	// NotPending, EXPIRED antes del UPDATE, errores reales de BD) viene
	// aquí; se devuelve tal cual.
	if err != nil {
		return nil, err
	}
	// Un error de dominio emitido TRAS el COMMIT: la transición durable
	// quedó guardada y ahora reportamos el error al servicio.
	if domainErr != nil {
		return nil, domainErr
	}
	return &result, nil
}

// =========================================================================
// Helpers
// =========================================================================

// generateChallengeID produce un identificador opaco de 64 nibbles hex
// (256 bits) con crypto/rand. NO contiene DNI, OTP ni timestamp.
// Siempre lowercase para empatar con la normalización del handler y
// evitar lookups case-sensitive fallidos.
func generateChallengeID() (string, error) {
	const hexLen = models.CashDrawerOTPChallengeIDHexLen
	buf := make([]byte, hexLen/2)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// GenerateChallengeIDForTest expone generateChallengeID a los tests del
// mismo paquete sin filtrar el helper al runtime. Mantiene la función
// interna como "paquete-privado" para que no la invoque un servicio.
func GenerateChallengeIDForTest() (string, error) {
	return generateChallengeID()
}
