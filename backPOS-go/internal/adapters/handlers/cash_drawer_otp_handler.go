// Handler HTTP del flujo OTP para apertura manual del cajón (migración 025).
//
// Reglas HTTP:
//
//   - POST /api/cash-drawer/otp/request
//     Empleado+admin autenticado. Rate-limited con bucket específico.
//     Emite un challenge PENDING y manda el OTP por Telegram
//     SÍNCRONAMENTE. Respuestas:
//     200 { challengeId, expiresAt, attemptsMax, ttlSeconds }
//     401 sin sesión
//     503 Telegram inactivo o envío falló (challenge queda CANCELLED)
//     500 fallo transitorio (BD, crypto)
//
//   - POST /api/cash-drawer/otp/confirm
//     Empleado+admin autenticado. Rate-limited con bucket específico.
//     Valida el challenge, abre el cajón y devuelve la auditoría.
//     Respuestas:
//     200 { drawerOpenId, openedAt, challengeId }
//     400 OTP malformado (shape ^\d{6}$)
//     401 sin sesión
//     403 actor del challenge distinto al actor de la sesión
//     404 challenge inexistente
//     409 challenge ya consumido/cancelado
//     410 challenge expirado o agotó intentos
//     422 OTP incorrecto (aún quedan intentos)
//
// Contrato de secretos:
//
//   - El OTP tecleado por el usuario NUNCA se incluye en la respuesta,
//     en el log del servidor ni en el error devuelto.
//   - El hash bcrypt NUNCA viaja al cliente.
//   - El challenge_id SÍ viaja al cliente, pero es opaco: no revela
//     ni DNI ni el OTP.
package handlers

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"

	"github.com/gin-gonic/gin"
)

// CashDrawerOTPHandler agrupa las rutas del flujo OTP.
type CashDrawerOTPHandler struct {
	svc *services.CashDrawerOTPService
}

// NewCashDrawerOTPHandler construye el handler.
func NewCashDrawerOTPHandler(svc *services.CashDrawerOTPService) *CashDrawerOTPHandler {
	return &CashDrawerOTPHandler{svc: svc}
}

// requestChallengePayload es intencionalmente VACÍO en lo relevante
// para seguridad: el actor viene del contexto (middleware auth), nunca
// del body. Si en el futuro queremos admitir una nota corta, se agrega
// aquí — pero NUNCA aceptar `requestedByDni` del cliente.
type requestChallengePayload struct {
	// Reservado: una futura iteración podría permitir una nota
	// descriptiva ("devolver cambio al cliente"), que viajaría a
	// cash_drawer_opens.note tras consumir.
	Note string `json:"note"`
}

// requestChallengeResponse es el 200 OK de /request.
type requestChallengeResponse struct {
	OK          bool   `json:"ok"`
	ChallengeID string `json:"challengeId"`
	ExpiresAt   string `json:"expiresAt"`
	AttemptsMax int    `json:"attemptsMax"`
	TTLSeconds  int    `json:"ttlSeconds"`
	Message     string `json:"message"`
}

// Request maneja POST /api/cash-drawer/otp/request.
//
// Validaciones:
//   - 401 si no hay DNI en el contexto.
//   - 503 si Telegram no está activo o el envío falla.
//   - 500 si el repo/crypto fallan.
//
// La respuesta 200 NO incluye el OTP ni ningún fragmento del hash.
// El operador recibirá el OTP en el chat de Telegram.
func (h *CashDrawerOTPHandler) Request(c *gin.Context) {
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "sesión requerida",
			"code":  ErrUnauthorized,
		})
		return
	}

	// Nombre para el mensaje de Telegram. El middleware lo setea desde
	// las claims del JWT; si no vino, el servicio usa "USUARIO".
	name := ""
	if v, ok := c.Get("userName"); ok {
		if s, isString := v.(string); isString {
			name = s
		}
	}

	// Body opcional. El actor viene del contexto (middleware auth),
	// NUNCA del body. Contrato de validación:
	//   - Body vacío (ContentLength=0 o EOF)      → OK, body queda en cero.
	//   - Body `{}` o JSON válido con campos      → OK, decodifica normal.
	//   - JSON malformado (`not json`, truncado…) → 400 explícito.
	// Antes esto se tragaba con `_ = c.ShouldBindJSON(&body)` y servía
	// 500 corriente abajo. Un 400 explícito evita confundir al cliente.
	var body requestChallengePayload
	if c.Request != nil && c.Request.ContentLength != 0 {
		if err := c.ShouldBindJSON(&body); err != nil && !errors.Is(err, io.EOF) {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "payload inválido",
				"code":  ErrBadRequest,
			})
			return
		}
	}

	out, err := h.svc.RequestChallenge(c.Request.Context(), dni, name)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrOTPActorInvalid):
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "sesión requerida",
				"code":  ErrUnauthorized,
			})
		case errors.Is(err, services.ErrOTPCooldown):
			// Cooldown por actor: 429 con `Retry-After` y campo del
			// body `retryAfterSeconds`. El mensaje NO revela cuánto
			// tiempo lleva emitido el OTP anterior; sólo cuánto falta.
			retryAfterSec := cooldownRetryAfterSeconds(err)
			c.Header("Retry-After", strconv.Itoa(retryAfterSec))
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error":             "Debes esperar antes de solicitar otro OTP.",
				"code":              models.ErrCodeOTPCooldownActive,
				"retryAfterSeconds": retryAfterSec,
			})
		case errors.Is(err, services.ErrOTPTelegramUnavailable):
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": "No se pudo enviar el OTP: Telegram no está disponible. Pida apertura directa al administrador.",
				"code":  models.ErrCodeOTPTelegramUnavailable,
			})
		default:
			// Nunca propagamos el error técnico: podría tener fragmentos
			// de BD. El servicio ya logueó los detalles antes.
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "No se pudo emitir el OTP. Intente de nuevo en unos segundos.",
				"code":  models.ErrCodeOTPRequestFailed,
			})
		}
		return
	}

	c.JSON(http.StatusOK, requestChallengeResponse{
		OK:          true,
		ChallengeID: out.ChallengeID,
		ExpiresAt:   out.ExpiresAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		AttemptsMax: out.AttemptsMax,
		TTLSeconds:  out.TTLSeconds,
		Message:     "Se envió un OTP al chat de administración. Ingréselo para abrir el cajón.",
	})
}

// confirmChallengePayload es el body de /confirm.
//
// Importante:
//   - `OTP` llega AQUÍ, pero NUNCA sale de este archivo salvo hacia el
//     servicio, que lo entrega al repo dentro de la tx. Al retornar, el
//     handler no debe echo-earlo ni al log ni al response.
type confirmChallengePayload struct {
	ChallengeID string `json:"challengeId"`
	OTP         string `json:"otp"`
	Note        string `json:"note"`
}

// confirmChallengeResponse es el 200 OK de /confirm.
type confirmChallengeResponse struct {
	OK              bool   `json:"ok"`
	DrawerOpenID    uint   `json:"drawerOpenId"`
	OpenedAt        string `json:"openedAt"`
	ChallengeID     string `json:"challengeId"`
	DriverAvailable bool   `json:"driverAvailable"`
	Note            string `json:"note"`
}

// Confirm maneja POST /api/cash-drawer/otp/confirm.
//
// Flujo:
//
//  1. Rechazar si no hay DNI en el contexto (401).
//  2. Rechazar si falta challengeId u OTP (400).
//  3. Delegar en el service, que:
//     - Verifica formato del OTP (shape ^\d{6}$).
//     - Hace SELECT FOR UPDATE sobre el challenge.
//     - Verifica actor, status, expiración y attempts.
//     - bcrypt.CompareHashAndPassword.
//     - En éxito, INSERT en cash_drawer_opens + UPDATE CONSUMED en una
//     sola transacción.
//     - En fallo, bumpea attempts_used durablemente (y pasa a FAILED
//     al tocar el techo).
//  4. Traducir cada error del service a su código HTTP + código estable.
//
// Blindaje: el `confirmChallengePayload` se descarta al salir del
// handler (defer anula el OTP). El código tecleado NO aparece en logs
// ni en el response. Un wrapper de tests estático verifica estas
// garantías.
func (h *CashDrawerOTPHandler) Confirm(c *gin.Context) {
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{
			"error": "sesión requerida",
			"code":  ErrUnauthorized,
		})
		return
	}

	var body confirmChallengePayload
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "payload inválido",
			"code":  ErrBadRequest,
		})
		return
	}
	// Blindaje: anular el OTP del struct en memoria al salir del
	// handler para que un panic recoverer que logee la petición no lo
	// exponga. defer corre antes del Response flush.
	defer func() { body.OTP = "" }()

	chID := strings.TrimSpace(body.ChallengeID)
	otpTrimmed := strings.TrimSpace(body.OTP)
	if chID == "" || otpTrimmed == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "challengeId y otp son obligatorios",
			"code":  ErrBadRequest,
		})
		return
	}

	out, err := h.svc.ConfirmChallenge(c.Request.Context(), dni, chID, otpTrimmed, body.Note)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrOTPActorInvalid):
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "sesión requerida",
				"code":  ErrUnauthorized,
			})
		case errors.Is(err, services.ErrOTPBadFormat):
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "El OTP debe ser de 6 dígitos.",
				"code":  models.ErrCodeOTPFormatInvalid,
			})
		case errors.Is(err, services.ErrOTPNotFound):
			c.JSON(http.StatusNotFound, gin.H{
				"error": "Challenge no encontrado.",
				"code":  models.ErrCodeOTPChallengeNotFound,
			})
		case errors.Is(err, services.ErrOTPWrongActor):
			c.JSON(http.StatusForbidden, gin.H{
				"error": "El challenge fue emitido para otro usuario.",
				"code":  models.ErrCodeOTPChallengeWrongActor,
			})
		case errors.Is(err, services.ErrOTPExpired):
			c.JSON(http.StatusGone, gin.H{
				"error": "El OTP expiró. Solicite uno nuevo.",
				"code":  models.ErrCodeOTPChallengeExpired,
			})
		case errors.Is(err, services.ErrOTPExhausted):
			c.JSON(http.StatusGone, gin.H{
				"error": "Se agotaron los intentos. Solicite un OTP nuevo.",
				"code":  models.ErrCodeOTPChallengeExhausted,
			})
		case errors.Is(err, services.ErrOTPConsumed):
			c.JSON(http.StatusConflict, gin.H{
				"error": "El challenge ya fue usado o fue cancelado.",
				"code":  models.ErrCodeOTPChallengeAlreadyUsed,
			})
		case errors.Is(err, services.ErrOTPMismatch):
			// 422 porque la sintaxis fue correcta pero la semántica
			// (código ingresado) es incorrecta. Permite al cliente
			// reintentar sin pedir uno nuevo.
			c.JSON(http.StatusUnprocessableEntity, gin.H{
				"error": "OTP incorrecto. Intente de nuevo.",
				"code":  models.ErrCodeOTPChallengeInvalid,
			})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": "No se pudo validar el OTP. Intente de nuevo en unos segundos.",
				"code":  models.ErrCodeOTPRequestFailed,
			})
		}
		return
	}

	// Blanquear nuevamente antes de responder (paranoia).
	body.OTP = ""

	c.JSON(http.StatusOK, confirmChallengeResponse{
		OK:              true,
		DrawerOpenID:    out.DrawerOpenID,
		OpenedAt:        out.OpenedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		ChallengeID:     out.ChallengeID,
		DriverAvailable: false,
		Note:            "La apertura quedó auditada. El pulso físico del cajón lo envía el bridge local (kickDrawer); es independiente de impresión.",
	})
}

// cooldownRetryAfterSeconds extrae el remanente del cooldown del error
// del servicio (si es `*services.OTPCooldownError`) y lo convierte a un
// entero de segundos redondeado hacia arriba para la cabecera
// `Retry-After` (RFC 9110 §10.2.3 admite "delta-seconds"). Si el error
// no transporta el remanente, usamos el cooldown completo como fallback
// seguro: el cliente esperará un ciclo entero antes de reintentar.
func cooldownRetryAfterSeconds(err error) int {
	fallback := int(models.CashDrawerOTPRequestCooldown / time.Second)
	if fallback < 1 {
		fallback = 1
	}
	var cdErr *services.OTPCooldownError
	if !errors.As(err, &cdErr) || cdErr == nil {
		return fallback
	}
	if cdErr.RetryAfter <= 0 {
		return fallback
	}
	// Ceil(d / 1s) sin importar `math`: suma (1s - 1ns) y divide.
	seconds := int((cdErr.RetryAfter + time.Second - time.Nanosecond) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	return seconds
}
