// Package models — tipos del dominio para el módulo de cobro QR Bold /
// Bre-B del Supermercado Surtifamiliar (titular Sebastian Sarmiento,
// comercio Bre-B 0093097755). Dos tablas durables respaldan el flujo:
//
//   - pos_qr_payment_intents (migración 026): intención PENDIENTE con
//     TTL de 5 min, máquina de 5 estados.
//   - pos_qr_webhook_events (migración 026): auditoría append-only de
//     cada webhook recibido (BOLD_OFFICIAL o BRIDGE_NOTIFICATION), con
//     dedupe doble (external_id canónico y fingerprint anti-replay).
//
// IMPORTANTE: estos modelos NO forman parte de schemaModels() en
// migrations/catalog.go. Las tablas físicas las crea EXCLUSIVAMENTE la
// migración 026. Mantenerlos fuera de schemaModels protege el checksum
// de la migración 002 (model_schema) y respeta la política del runner:
// la BD la mutan sólo migraciones explícitas durante una ventana
// aprobada. Mismo patrón que labels.go, internal_barcode_reservation.go
// y cash_drawer_otp_challenge.go.
//
// Reglas financieras que el modelo refleja:
//
//   - amount_cop es BIGINT (int64 en Go). COP enteros, sin centavos:
//     el flujo QR trabaja pesos exactos. Esto hace que el match sea por
//     igualdad bit-a-bit, no por aproximación con tolerancia.
//
//   - AMBIGUA NO existe como status de la intención. Si llega un
//     webhook con monto que coincide con >1 PENDIENTES, el EVENTO
//     queda AMBIGUOUS pero las intenciones siguen vivas (nunca se
//     termina a varias en bloque). El cajero resuelve manualmente con
//     DNI auditor y SOLO esa transita a CONFIRMADA_MANUAL.
//
//   - Los secretos (BOLD_SECRET_KEY, BOLD_BRIDGE_TOKEN) NUNCA se
//     persisten. El fingerprint persistido es sha256(source + "|" +
//     amount + "|" + bucket_tiempo) y nunca contiene el token ni la
//     firma HMAC.
package models

import (
	"regexp"
	"strings"
	"time"
)

// =========================================================================
// Constantes del protocolo QR
// =========================================================================

const (
	// QRPaymentIntentDefaultTTL es la ventana de validez de una
	// intención PENDIENTE: 15 minutos. Se elevó de 5 min a 15 min
	// cuando se incorporó el flujo asíncrono (migración 027): el cajero
	// puede dejar en espera un cobro QR, seguir atendiendo y recibir la
	// notificación de MacroDroid cuando el cliente finalmente escanee
	// desde su banco (algunos bancos tardan en entregar el push). El
	// handler lo usa como default al calcular expires_at.
	QRPaymentIntentDefaultTTL = 15 * time.Minute

	// QRPaymentIntentMaxAmountCOP acota el monto arriba (50M COP) para
	// que una notificación basura o una venta con error tipográfico no
	// coma un slot del matcher. Valor conservador: una compra de víveres
	// típica no pasa de 2M.
	QRPaymentIntentMaxAmountCOP int64 = 50_000_000

	// QRPaymentIntentMinAmountCOP: el regex del bridge y la validación
	// del handler no toman montos menores a esto. Se alinea con la
	// práctica de que una venta mínima en el POS vale al menos $100.
	QRPaymentIntentMinAmountCOP int64 = 100

	// QRVentaTempIDMinLen / MaxLen acotan la longitud del identificador
	// temporal provisto por el frontend. Es un string generado por el
	// cliente (p.ej. crypto.randomUUID → 36 chars); se admite rango
	// amplio para no romper con variantes razonables.
	QRVentaTempIDMinLen = 8
	QRVentaTempIDMaxLen = 80

	// QRCajaIDMinLen / MaxLen. caja_id es un string arbitrario del POS
	// (lo típico es "CAJA-1"); se acepta corto para IDs numéricos y
	// hasta 64 chars para los compuestos.
	QRCajaIDMinLen = 1
	QRCajaIDMaxLen = 64

	// QRBridgeReplayWindow es la ventana en la que el fingerprint
	// MacroDroid es idéntico ante replays. Si el bridge reintenta
	// dentro de esta ventana con la misma notificación, el UNIQUE
	// (source, fingerprint) rechaza el segundo INSERT y el handler
	// responde 200 OK (idempotente). Dos pagos legítimos al mismo
	// monto dentro de este bucket colisionan (falso negativo) y
	// requieren confirmación manual — exactamente lo que pidió el
	// dueño: "falso negativo antes que doble aprobación".
	QRBridgeReplayWindow = 60 * time.Second

	// QRBridgeMaxEventAge es la ventana más allá de la cual un evento
	// del bridge se descarta por "demasiado viejo" (replay tardío).
	// Si MacroDroid encola un mensaje por falta de red y lo entrega
	// tarde, preferimos ignorarlo antes que correlacionarlo con una
	// venta posterior del mismo monto.
	QRBridgeMaxEventAge = 10 * time.Minute

	// QRWebhookMaxBodyBytes acota el tamaño del body aceptado por los
	// webhooks públicos (defensa anti-DoS). Un payload Bold legítimo
	// pesa <2 KB; damos holgura.
	QRWebhookMaxBodyBytes = 16 * 1024

	// QRIntentIniciarMaxBodyBytes acota el body del endpoint POS
	// /iniciar; es un JSON pequeño (3 campos).
	QRIntentIniciarMaxBodyBytes = 4 * 1024
)

// =========================================================================
// Estados de la intención (storage) y del stream SSE (transporte).
// =========================================================================

// Status de la intención en BD. Deben empatar EXACTAMENTE con los
// literales de ck_pqpi_status_known en la migración 026.
const (
	QRIntentStatusPending         = "PENDIENTE"
	QRIntentStatusApproved        = "APROBADA"
	QRIntentStatusConfirmedManual = "CONFIRMADA_MANUAL"
	QRIntentStatusExpired         = "EXPIRADA"
	QRIntentStatusCancelled       = "CANCELADA"
)

// Fuente de la aprobación. Deben empatar con ck_pqpi_approved_source_known.
const (
	QRApprovalSourceBoldOfficial = "BOLD_OFFICIAL"
	QRApprovalSourceBridge       = "BRIDGE_NOTIFICATION"
	QRApprovalSourceManual       = "MANUAL"
)

// Fuentes de evento (webhook). Deben empatar con ck_pqwe_source_known.
const (
	QRWebhookSourceOfficial = "BOLD_OFFICIAL"
	QRWebhookSourceBridge   = "BRIDGE_NOTIFICATION"
)

// Estado de procesamiento del evento. Deben empatar con
// ck_pqwe_processed_status_known.
const (
	QRWebhookStatusPending   = "PENDING"
	QRWebhookStatusApproved  = "APPROVED"
	QRWebhookStatusUnmatched = "UNMATCHED"
	QRWebhookStatusAmbiguous = "AMBIGUOUS"
	QRWebhookStatusDuplicate = "DUPLICATE"
	QRWebhookStatusInvalid   = "INVALID"
)

// Estados "de transporte" que viajan por SSE al frontend. Son los
// literales que `classifyStreamEvent` del helper del front espera. Un
// cambio aquí requiere actualizar `BOLD_QR_STATUS` del frontend.
const (
	QRStreamStatusPending   = "PENDIENTE"
	QRStreamStatusApproved  = "APROBADO"
	QRStreamStatusExpired   = "EXPIRADO"
	QRStreamStatusCancelled = "CANCELADO"
	QRStreamStatusError     = "ERROR"
	QRStreamStatusUnmatched = "UNMATCHED"
	QRStreamStatusAmbiguous = "AMBIGUOUS"
)

// MapIntentStatusToStream traduce el estado durable a lo que viaja por
// SSE. CONFIRMADA_MANUAL y APROBADA se colapsan a APROBADO porque el
// frontend las trata idénticamente (ambas disparan cierre e impresión).
// La distinción vive en la auditoría, no en el canal realtime.
func MapIntentStatusToStream(status string) string {
	switch status {
	case QRIntentStatusPending:
		return QRStreamStatusPending
	case QRIntentStatusApproved, QRIntentStatusConfirmedManual:
		return QRStreamStatusApproved
	case QRIntentStatusExpired:
		return QRStreamStatusExpired
	case QRIntentStatusCancelled:
		return QRStreamStatusCancelled
	default:
		return QRStreamStatusError
	}
}

// IsValidQRIntentStatus replica el enum de ck_pqpi_status_known.
func IsValidQRIntentStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case QRIntentStatusPending,
		QRIntentStatusApproved,
		QRIntentStatusConfirmedManual,
		QRIntentStatusExpired,
		QRIntentStatusCancelled:
		return true
	default:
		return false
	}
}

// IsValidQRApprovalSource replica el enum de ck_pqpi_approved_source_known.
func IsValidQRApprovalSource(src string) bool {
	switch strings.TrimSpace(src) {
	case QRApprovalSourceBoldOfficial,
		QRApprovalSourceBridge,
		QRApprovalSourceManual:
		return true
	default:
		return false
	}
}

// =========================================================================
// Códigos de error estables (contrato con el frontend)
// =========================================================================
//
// Un rename aquí rompe el UX del modal ModalPagoBoldQR. Los mantenemos
// como constantes exportadas para que el guardián de tests del handler
// detecte cambios silenciosos.
const (
	// ErrCodeQRBadRequest: payload malformado (caja_id/monto/venta_temp_id
	// inválido).
	ErrCodeQRBadRequest = "QR_BAD_REQUEST"

	// ErrCodeQRIntentNotFound: venta_temp_id sin intención viva.
	ErrCodeQRIntentNotFound = "QR_INTENT_NOT_FOUND"

	// ErrCodeQRIntentExpired: la intención ya expiró.
	ErrCodeQRIntentExpired = "QR_INTENT_EXPIRED"

	// ErrCodeQRIntentAlreadyTerminal: la intención está en estado
	// terminal (APROBADA/CONFIRMADA_MANUAL/CANCELADA) y no admite
	// transición.
	ErrCodeQRIntentAlreadyTerminal = "QR_INTENT_ALREADY_TERMINAL"

	// ErrCodeQRIntentWrongActor: el actor que intenta cancelar o
	// confirmar no es el autor y no es admin. (La política concreta la
	// aplica el servicio; el handler expone el código estable.)
	ErrCodeQRIntentWrongActor = "QR_INTENT_WRONG_ACTOR"

	// ErrCodeQRRequestFailed: fallo transitorio (BD, crypto).
	ErrCodeQRRequestFailed = "QR_REQUEST_FAILED"

	// ErrCodeQRWebhookUnauthorized: HMAC o token inválido.
	ErrCodeQRWebhookUnauthorized = "QR_WEBHOOK_UNAUTHORIZED"

	// ErrCodeQRWebhookTooLarge: body excede límite.
	ErrCodeQRWebhookTooLarge = "QR_WEBHOOK_TOO_LARGE"

	// ErrCodeQRRateLimit: rate limiter rebotó la petición.
	ErrCodeQRRateLimit = "QR_RATE_LIMIT"

	// ErrCodeQREventNotFound: no existe el evento pos_qr_webhook_events
	// solicitado por /asignar.
	ErrCodeQREventNotFound = "QR_EVENT_NOT_FOUND"

	// ErrCodeQREventAlreadyAssigned: el evento ya transita APPROVED o
	// tiene matched_intent_id (otro operador se adelantó). También se
	// usa cuando el evento está fuera de la ventana de asignación
	// manual (60 min).
	ErrCodeQREventAlreadyAssigned = "QR_EVENT_ALREADY_ASSIGNED"

	// ErrCodeQRAmountMismatch: el monto del evento no empata con el
	// monto de la intención en /asignar. Nunca se aprueba un cobro
	// cuyo monto difiere, aun si el cajero lo pide.
	ErrCodeQRAmountMismatch = "QR_AMOUNT_MISMATCH"

	// ErrCodeQRIntentAlreadyPaid: el venta_temp_id ya tiene una
	// intención APROBADA/CONFIRMADA_MANUAL. El frontend lo usa para
	// cerrar el modal/bandeja sin reabrir el cobro y, si el response
	// trae `saleId`, para redirigir al ticket de la venta ya cerrada.
	// Se emite desde /iniciar (response 200 con alreadyPaid:true),
	// /encolar (409) y /asignar (409).
	ErrCodeQRIntentAlreadyPaid = "QR_INTENT_ALREADY_PAID"
)

// =========================================================================
// Bridge SMS: constantes y helpers de normalización
// =========================================================================

// Package Android que MacroDroid declara en el nuevo formato de puente.
// Las notificaciones reenviadas desde SMS tienen `app:"sms"` en lugar
// de `co.bold`, porque el intermediario es la app Mensajes del
// teléfono y no la app Bold.
const (
	QRBridgeAppSMS = "sms"

	// QRBridgeNoteMaxLen acota el resumen saneado del mensaje que se
	// persiste en `pos_qr_webhook_events.note` para conciliación. El
	// CHECK ck_pqwe_note_shape de la 026 permite hasta 255 chars; 200
	// deja margen por si el handler agrega sufijos (" | asignado:...").
	QRBridgeNoteMaxLen = 200

	// QRBridgeFutureAgeSlack es la holgura máxima hacia el futuro
	// que aceptamos en `recibido_ms`. El reloj del celular puede
	// adelantarse unos segundos; 2 min es más que suficiente para
	// absorber esa deriva.
	QRBridgeFutureAgeSlack = 2 * time.Minute

	// QRAssignmentWindow es el máximo tiempo transcurrido desde que
	// se recibió un evento AMBIGUOUS/UNMATCHED para que el cajero
	// pueda asignarlo manualmente a una intención. Más allá de este
	// umbral se asume que ya es tarde para correlacionar sin riesgo
	// de cerrar una venta con un cobro antiguo que corresponde a
	// otra operación. Se aplica cuando el actor es un cajero regular.
	QRAssignmentWindow = 60 * time.Minute

	// QRAssignmentWindowAdmin extiende la ventana a 24 h cuando el
	// actor es admin/administrador/superadmin. Soluciona el caso del
	// dueño que recibe un pago QR real, no lo asigna al momento y
	// más tarde (hasta 24 h después) necesita vincularlo a la venta
	// que estaba corrigiendo. Siempre viaja con auditoría por DNI.
	QRAssignmentWindowAdmin = 24 * time.Hour

	// QRUnassignedMinutosMin / Max acotan el parámetro `minutos` del
	// endpoint GET /pagos-sin-asignar. 1 min es el mínimo útil (nada
	// más estrecho tendría sentido operativo); 1440 min (24 h) cubre
	// toda la jornada operativa — un pago huérfano del mediodía debe
	// seguir visible por la tarde cuando el dueño lo busca.
	QRUnassignedMinutosMin = 1
	QRUnassignedMinutosMax = 1440
)

// bridgeSenderDigitRe captura números y el prefijo + de números
// internacionales. Usado para decidir si un remitente es "mayormente
// numérico" y por tanto debe compararse como teléfono (sufijo de 10
// dígitos) y no como texto plano.
var bridgeSenderDigitRe = regexp.MustCompile(`^[+\d\s\-\(\)]+$`)

// NormalizeBridgeSender aplica la regla del sprint:
//
//   - trim + lower.
//   - Si el valor es "mayormente dígitos" (o un número con prefijo +),
//     se extraen SÓLO los dígitos (sin + ni espacios) y se devuelve el
//     string de dígitos.
//   - En cualquier otro caso, se devuelve el texto en minúsculas,
//     colapsando espacios para que "   Bancolombia  " y "bancolombia"
//     empaten.
//
// La función es pura y la comparten repo/service/handler. Nunca loguea
// ni retiene el valor.
func NormalizeBridgeSender(s string) string {
	trimmed := strings.ToLower(strings.TrimSpace(s))
	if trimmed == "" {
		return ""
	}
	if bridgeSenderDigitRe.MatchString(trimmed) {
		var b strings.Builder
		for _, r := range trimmed {
			if r >= '0' && r <= '9' {
				b.WriteRune(r)
			}
		}
		return b.String()
	}
	// Colapsar múltiples espacios en texto alfabético.
	fields := strings.Fields(trimmed)
	return strings.Join(fields, " ")
}

// BridgeSenderMatches aplica la regla:
//   - exacta en texto cuando ambos lados no son numéricos.
//   - cuando ambos son numéricos y >=10 dígitos, aceptar coincidencia
//     por SUFIJO de los últimos 10 dígitos (compara "móvil con prefijo
//     +57" contra "móvil local").
//   - si uno es numérico y el otro no, no empatan.
//
// Pre-condición: ambos valores ya pasaron por NormalizeBridgeSender.
func BridgeSenderMatches(sender, allowed string) bool {
	if sender == "" || allowed == "" {
		return false
	}
	senderIsDigits := isAllDigits(sender)
	allowedIsDigits := isAllDigits(allowed)
	if senderIsDigits != allowedIsDigits {
		return false
	}
	if !senderIsDigits {
		return sender == allowed
	}
	if sender == allowed {
		return true
	}
	if len(sender) >= 10 && len(allowed) >= 10 {
		return sender[len(sender)-10:] == allowed[len(allowed)-10:]
	}
	return false
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// SanitizeBridgeNote produce un resumen del mensaje apto para
// persistir en `pos_qr_webhook_events.note`:
//
//   - Elimina controles (CR/LF/TAB/<0x20/0x7F).
//   - Colapsa espacios.
//   - Trunca a `max` chars (default QRBridgeNoteMaxLen=200).
//
// NUNCA copia el token: la función recibe únicamente el texto del
// mensaje, no el payload completo. Si el llamador le pasara el token
// por error, igualmente queda truncado.
func SanitizeBridgeNote(msg string, max int) string {
	if max <= 0 {
		max = QRBridgeNoteMaxLen
	}
	if max > 255 {
		max = 255
	}
	trimmed := strings.TrimSpace(msg)
	if trimmed == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(trimmed))
	lastSpace := false
	for _, r := range trimmed {
		if r == '\n' || r == '\r' || r == '\t' {
			if !lastSpace {
				b.WriteRune(' ')
				lastSpace = true
			}
			continue
		}
		if r < 0x20 || r == 0x7f {
			continue
		}
		if r == ' ' {
			if lastSpace {
				continue
			}
			lastSpace = true
			b.WriteRune(' ')
			continue
		}
		lastSpace = false
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	if len(out) > max {
		out = out[:max]
	}
	return out
}

// =========================================================================
// Shape de inputs comunes
// =========================================================================

// qrVentaTempIDShape acepta ASCII alfanumérico con `-` y `_` para no
// bloquear UUID (`-`), ULID (sin separadores) ni cualquier identificador
// base64url. Rechazamos espacios, barras, controles y Unicode exótico
// que podrían usarse para inyección en logs.
var qrVentaTempIDShape = regexp.MustCompile(`^[A-Za-z0-9_\-]+$`)

// IsValidQRVentaTempID valida la longitud y el shape.
func IsValidQRVentaTempID(s string) bool {
	s = strings.TrimSpace(s)
	if len(s) < QRVentaTempIDMinLen || len(s) > QRVentaTempIDMaxLen {
		return false
	}
	return qrVentaTempIDShape.MatchString(s)
}

// qrCajaIDShape acepta ASCII imprimible estrecho: alfanumérico, `-`,
// `_` y `.`. Suficiente para "CAJA-1", "1", "pos.caja.a", y evita el
// riesgo de meter caracteres de control en logs/BD.
var qrCajaIDShape = regexp.MustCompile(`^[A-Za-z0-9_\-\.]+$`)

// IsValidQRCajaID valida longitud y shape de caja_id.
func IsValidQRCajaID(s string) bool {
	s = strings.TrimSpace(s)
	if len(s) < QRCajaIDMinLen || len(s) > QRCajaIDMaxLen {
		return false
	}
	return qrCajaIDShape.MatchString(s)
}

// IsValidQRAmountCOP acota el monto al rango permitido. El valor es
// int64 (BIGINT) para empatar con amount_cop en la BD.
func IsValidQRAmountCOP(amount int64) bool {
	return amount >= QRPaymentIntentMinAmountCOP && amount <= QRPaymentIntentMaxAmountCOP
}

// =========================================================================
// Modelo GORM — QrPaymentIntent
// =========================================================================

// QrPaymentIntent mapea la fila de pos_qr_payment_intents que crea la
// migración 026.
//
// Garantías que replicamos fielmente:
//
//   - amount_cop es int64 (BIGINT).
//   - status pasa por 5 valores legales; la transición vive en el
//     servicio y la coherencia la impone ck_pqpi_approval_coherent.
//   - approved_at/approved_source/approved_reference/approved_event_id
//     se pueblan en bloque al transitar a APROBADA; manual_* se puebla
//     al transitar a CONFIRMADA_MANUAL.
//   - related_sale_id es FK soft (sin REFERENCES) para no romper
//     auditoría cuando una venta se borra lógicamente.
type QrPaymentIntent struct {
	ID                   uint64     `gorm:"primaryKey;autoIncrement;column:id" json:"id"`
	VentaTempID          string     `gorm:"column:venta_temp_id;type:varchar(80);not null"      json:"ventaTempId"`
	CajaID               string     `gorm:"column:caja_id;type:varchar(64);not null"            json:"cajaId"`
	CreatedByDNI         string     `gorm:"column:created_by_dni;type:varchar(32);not null"     json:"createdByDni"`
	AmountCOP            int64      `gorm:"column:amount_cop;type:bigint;not null"              json:"amountCop"`
	Status               string     `gorm:"column:status;type:varchar(24);not null;default:'PENDIENTE'" json:"status"`
	CreatedAt            time.Time  `gorm:"column:created_at;not null;default:now()"            json:"createdAt"`
	ExpiresAt            time.Time  `gorm:"column:expires_at;not null"                          json:"expiresAt"`
	ApprovedAt           *time.Time `gorm:"column:approved_at"                                  json:"approvedAt,omitempty"`
	ApprovedSource       string     `gorm:"column:approved_source;type:varchar(24)"             json:"approvedSource,omitempty"`
	ApprovedReference    string     `gorm:"column:approved_reference;type:varchar(128)"         json:"approvedReference,omitempty"`
	ApprovedEventID      *uint64    `gorm:"column:approved_event_id"                            json:"approvedEventId,omitempty"`
	CancelledAt          *time.Time `gorm:"column:cancelled_at"                                 json:"cancelledAt,omitempty"`
	CancelledByDNI       string     `gorm:"column:cancelled_by_dni;type:varchar(32)"            json:"cancelledByDni,omitempty"`
	CancelReason         string     `gorm:"column:cancel_reason;type:varchar(64)"               json:"cancelReason,omitempty"`
	ManualConfirmedByDNI string     `gorm:"column:manual_confirmed_by_dni;type:varchar(32)"     json:"manualConfirmedByDni,omitempty"`
	ManualConfirmedNote  string     `gorm:"column:manual_confirmed_note;type:text"              json:"manualConfirmedNote,omitempty"`
	RelatedSaleID        *uint64    `gorm:"column:related_sale_id"                              json:"relatedSaleId,omitempty"`

	// -------------------------------------------------------------
	// Columnas agregadas por la migración 027 (checkout asíncrono).
	// Todas son opcionales en la BD; una fila legacy pre-027 queda
	// con snapshots NULL y finalization_status='NOT_STARTED', lo que
	// el service trata como "cerrada por fuera" (no reintenta).
	// -------------------------------------------------------------

	// CartSnapshot es el carrito congelado al emitir la intención.
	// JSONB opaco a la BD; el servicio Go lo decodifica a models.Sale
	// con un adapter interno. Si NULL, la finalización asíncrona
	// no arranca y la intención se trata como legacy sincrónica.
	CartSnapshot string `gorm:"column:cart_snapshot;type:jsonb" json:"-"`

	// ClientSnapshot congela los datos del cliente al emitir.
	ClientSnapshot string `gorm:"column:client_snapshot;type:jsonb" json:"-"`

	// TotalsSnapshot congela totales/pagos al emitir.
	TotalsSnapshot string `gorm:"column:totals_snapshot;type:jsonb" json:"-"`

	// SaleClientTxID es la clave de idempotencia reservada al emitir
	// la intención. Se pasa a SaleService.CreateSale como ClientTxId
	// para que dos entregas del webhook jamás creen dos ventas.
	SaleClientTxID string `gorm:"column:sale_client_tx_id;type:varchar(64)" json:"saleClientTxId,omitempty"`

	// CashierName es un campo TRANSIENTE (no se persiste): la 027 no
	// define la columna `cashier_name` en pos_qr_payment_intents, así
	// que GORM debe ignorarlo con `gorm:"-"`. Se usa como vehículo
	// in-memory para empatar el nombre humano del cajero al evento
	// SSE de bandeja (QRTrayEvent.CashierName). La autoría durable
	// vive exclusivamente en `created_by_dni`.
	CashierName string `gorm:"-" json:"cashierName,omitempty"`

	// QueuedAt se setea cuando el cajero pulsa "Dejar en espera y
	// seguir atendiendo". NULL mientras el modal está abierto.
	QueuedAt *time.Time `gorm:"column:queued_at" json:"queuedAt,omitempty"`

	// FinalizationStatus describe el lifecycle de la MATERIALIZACIÓN
	// de la venta (separado del status del pago). Valores legales:
	// NOT_STARTED, IN_PROGRESS, SUCCEEDED, FAILED.
	FinalizationStatus string `gorm:"column:finalization_status;type:varchar(24);not null;default:'NOT_STARTED'" json:"finalizationStatus"`

	FinalizationStartedAt   *time.Time `gorm:"column:finalization_started_at"           json:"finalizationStartedAt,omitempty"`
	FinalizationCompletedAt *time.Time `gorm:"column:finalization_completed_at"         json:"finalizationCompletedAt,omitempty"`
	FinalizationAttempts    int        `gorm:"column:finalization_attempts;not null;default:0" json:"finalizationAttempts"`
	FinalizationLastError   string     `gorm:"column:finalization_last_error;type:varchar(255)" json:"finalizationLastError,omitempty"`
	FinalizationNextRetryAt *time.Time `gorm:"column:finalization_next_retry_at"        json:"finalizationNextRetryAt,omitempty"`

	// CashierNotifiedAt es la última vez que el servidor emitió por
	// SSE el evento post-commit que dispara alerta + sonido + impresión.
	CashierNotifiedAt *time.Time `gorm:"column:cashier_notified_at" json:"cashierNotifiedAt,omitempty"`
}

// =========================================================================
// Finalización asíncrona (checkout del QR por detrás)
// =========================================================================

// Status del lifecycle de materialización. Deben empatar literalmente
// con `ck_pqpi_finalization_status_known` de la migración 027.
const (
	QRFinalizationStatusNotStarted = "NOT_STARTED"
	QRFinalizationStatusInProgress = "IN_PROGRESS"
	QRFinalizationStatusSucceeded  = "SUCCEEDED"
	QRFinalizationStatusFailed     = "FAILED"
)

// Backoff del reintentador de finalización. Base 15 s con duplicación por
// intento y techo 5 min. El CHECK ck_pqpi_finalization_attempts_bounds
// corta en 100 intentos.
const (
	QRFinalizationBaseBackoff = 15 * time.Second
	QRFinalizationMaxBackoff  = 5 * time.Minute
	QRFinalizationMaxAttempts = 10
	// QRFinalizationStuckAfter marca cuándo un IN_PROGRESS se
	// considera atascado (process murió a mitad de la tx) y el
	// barredor puede volver a reclamarlo.
	QRFinalizationStuckAfter = 2 * time.Minute
	// QRFinalizationSweepInterval es el período del ticker del sweeper.
	QRFinalizationSweepInterval = 20 * time.Second
	// QRFinalizationLastErrorMaxLen hace empatar el CHECK de la 027
	// (ck_pqpi_finalization_last_error_shape, 1..255 chars).
	QRFinalizationLastErrorMaxLen = 255
)

// =========================================================================
// Bandeja global por caja (SSE qr_tray_update)
// =========================================================================

// QRTrayKind* son los literales del evento `qr_tray_update` emitido
// por el canal SSE /api/pos/pagos-qr/caja-stream. Un cambio aquí rompe
// el helper `classifyTrayEvent` del frontend.
const (
	QRTrayKindEnqueued  = "ENQUEUED"
	QRTrayKindApproved  = "APPROVED"
	QRTrayKindAmbiguous = "AMBIGUOUS"
	QRTrayKindUnmatched = "UNMATCHED"
	QRTrayKindExpired   = "EXPIRED"
	QRTrayKindCancelled = "CANCELLED"
	QRTrayKindError     = "ERROR"
)

// QRTrayEvent es el payload serializado por SSE a la bandeja global
// de cada caja. Keyed por `caja_id`, nunca filtra entre cajas.
type QRTrayEvent struct {
	Kind        string `json:"kind"`
	VentaTempID string `json:"ventaTempId"`
	IntentID    uint64 `json:"intentId,omitempty"`
	CajaID      string `json:"cajaId,omitempty"`
	AmountCOP   int64  `json:"amountCop,omitempty"`
	SaleID      uint64 `json:"saleId,omitempty"`
	Reference   string `json:"reference,omitempty"`
	ApprovedAt  string `json:"approvedAt,omitempty"`
	ApprovedVia string `json:"approvedVia,omitempty"`
	Reason      string `json:"reason,omitempty"`
	ClientDNI   string `json:"clientDni,omitempty"`
	CashierName string `json:"cashierName,omitempty"`
	OccurredAt  string `json:"occurredAt,omitempty"`
}

// IsValidQRTrayKind reporta si el literal cae en el enum documentado.
// Útil para que el servicio no publique un kind inventado por bug.
func IsValidQRTrayKind(kind string) bool {
	switch strings.TrimSpace(kind) {
	case QRTrayKindEnqueued,
		QRTrayKindApproved,
		QRTrayKindAmbiguous,
		QRTrayKindUnmatched,
		QRTrayKindExpired,
		QRTrayKindCancelled,
		QRTrayKindError:
		return true
	default:
		return false
	}
}

// TableName obliga a GORM a usar el nombre exacto creado por la 026.
func (QrPaymentIntent) TableName() string { return "pos_qr_payment_intents" }

// IsLive reporta si la intención aún se puede aprobar/confirmar.
// Combina status=PENDIENTE y no expirado. La BD también lo valida con
// CHECKs en el mismo COMMIT, pero fallar temprano permite devolver un
// código estable sin reventar la tx.
func (i *QrPaymentIntent) IsLive(now time.Time) bool {
	if i == nil || i.Status != QRIntentStatusPending {
		return false
	}
	return now.Before(i.ExpiresAt)
}

// IsTerminal reporta si la intención está en estado terminal (y por
// tanto no admite más transiciones).
func (i *QrPaymentIntent) IsTerminal() bool {
	if i == nil {
		return false
	}
	switch i.Status {
	case QRIntentStatusApproved,
		QRIntentStatusConfirmedManual,
		QRIntentStatusExpired,
		QRIntentStatusCancelled:
		return true
	default:
		return false
	}
}

// =========================================================================
// Modelo GORM — QrWebhookEvent
// =========================================================================

// QrWebhookEvent mapea la fila de pos_qr_webhook_events que crea la
// migración 026.
//
// Garantías:
//
//   - source ∈ {BOLD_OFFICIAL, BRIDGE_NOTIFICATION}.
//   - processed_status ∈ {PENDING, APPROVED, UNMATCHED, AMBIGUOUS,
//     DUPLICATE, INVALID}.
//   - fingerprint OBLIGATORIO y UNIQUE (source, fingerprint). Nunca
//     contiene el token BOLD_BRIDGE_TOKEN ni la firma HMAC.
//   - external_id (bold_code) UNIQUE parcial (source, external_id).
//   - matched_intent_id SÓLO poblado cuando processed_status=APPROVED
//     (biyección exacta por ck_pqwe_matched_only_if_approved).
type QrWebhookEvent struct {
	ID              uint64     `gorm:"primaryKey;autoIncrement;column:id" json:"id"`
	ReceivedAt      time.Time  `gorm:"column:received_at;not null;default:now()"       json:"receivedAt"`
	Source          string     `gorm:"column:source;type:varchar(24);not null"         json:"source"`
	EventType       string     `gorm:"column:event_type;type:varchar(32)"              json:"eventType,omitempty"`
	ExternalID      string     `gorm:"column:external_id;type:varchar(128)"            json:"externalId,omitempty"`
	Fingerprint     string     `gorm:"column:fingerprint;type:varchar(128);not null"   json:"fingerprint"`
	AmountCOP       int64      `gorm:"column:amount_cop;type:bigint;not null"          json:"amountCop"`
	ProcessedAt     *time.Time `gorm:"column:processed_at"                             json:"processedAt,omitempty"`
	ProcessedStatus string     `gorm:"column:processed_status;type:varchar(24);not null;default:'PENDING'" json:"processedStatus"`
	MatchedIntentID *uint64    `gorm:"column:matched_intent_id"                        json:"matchedIntentId,omitempty"`
	Note            string     `gorm:"column:note;type:varchar(255)"                   json:"note,omitempty"`
}

// TableName obliga a GORM a usar el nombre exacto creado por la 026.
func (QrWebhookEvent) TableName() string { return "pos_qr_webhook_events" }
