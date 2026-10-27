// Servicio del flujo QR Bold/Bre-B.
//
// Responsabilidades:
//
//   - Iniciar intención: delega al repo (que serializa por venta_temp_id)
//     y publica un snapshot inicial por el QRHub.
//
//   - Validar + ingerir webhook oficial Bold:
//     1. Lee la variable de entorno BOLD_SECRET_KEY sin loguearla.
//     2. Exige que esté configurada; si falta, deshabilita el canal con
//     401 y registra un WARN sin secretos (fail-closed).
//     3. Verifica HMAC-SHA256 del cuerpo crudo con `hmac.Equal`
//     (tiempo constante). Si no concuerda → 401.
//     4. Parsea el JSON, extrae data.amount.total y data.bold_code.
//     5. Construye el fingerprint determinístico (bold_code o
//     derivado), llama repo.IngestWebhook y publica el resultado
//     en el QRHub DESPUÉS del commit.
//
//   - Validar + ingerir bridge MacroDroid:
//     1. Lee `X-Bridge-Token` (preferido), `X-Bold-Bridge-Token` (legacy)
//     o el campo `token` y compara contra BOLD_BRIDGE_TOKEN en tiempo constante.
//     2. Exige `app: "co.bold"` y blanquea el token tras compararlo.
//     3. Registra sólo título/mensaje escapados, nunca headers ni body crudo.
//     4. Parsea título + mensaje con el regex COP y descarta negadores.
//     5. Construye fingerprint determinístico con bucket de 60s y
//     delega al repo.
//
//   - Confirmar manual: delega al repo, publica APROBADO en SSE y
//     registra en audit_logs con DNI del contexto.
//
//   - Cancelar: delega al repo, publica CANCELADO en SSE.
//
//   - Recuperar PENDIENTES al arranque: lee del repo y repopula el
//     hub en memoria con un snapshot inicial.
//
// Reglas de seguridad:
//
//   - La verificación HMAC NUNCA incluye en los errores ni en los logs
//     la firma recibida ni la esperada; sólo el flag "hmac mismatch".
//   - El token del bridge se compara en tiempo constante y se blanquea
//     en la variable local tras la comparación.
//   - El servicio nunca persiste `rawBody`, `signatureHeader`, ni el
//     token: la BD sólo recibe `fingerprint`, `amount`, `source` y
//     `external_id` normalizados.
package services

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/sse"
)

// =========================================================================
// Nombres de variables de entorno
// =========================================================================
//
// Los nombres canónicos los pide el dueño en el spec:
//   - BOLD_SECRET_KEY   → firma HMAC-SHA256 del webhook oficial.
//   - BOLD_BRIDGE_TOKEN → autenticación del puente MacroDroid.
// Más dos adicionales para no acoplar a nombres de headers específicos
// (Bold NO VERIFICADO en el momento de redactar):
//   - BOLD_SIGNATURE_HEADER (default "X-Bold-Signature")
//   - BOLD_EVENT_SALE_APPROVED (default "SALE_APPROVED")

const (
	envBoldSecretKey        = "BOLD_SECRET_KEY"
	envBoldBridgeToken      = "BOLD_BRIDGE_TOKEN"
	envBoldSignatureHeader  = "BOLD_SIGNATURE_HEADER"
	envBoldSaleApprovedEvt  = "BOLD_EVENT_SALE_APPROVED"
	envBoldSMSSenders       = "BOLD_SMS_SENDERS"
	defaultSignatureHeader  = "X-Bold-Signature"
	defaultSaleApprovedType = "SALE_APPROVED"
	boldAndroidPackage      = "co.bold"
)

// =========================================================================
// Errores del servicio
// =========================================================================

var (
	// ErrQRInvalidInput: input duro inválido (DNI vacío, monto fuera
	// de rango). El handler lo traduce a 400.
	ErrQRInvalidInput = errors.New("qr: input inválido")

	// ErrQRIntentNotFound: no hay intención viva ni histórica para
	// venta_temp_id.
	ErrQRIntentNotFound = errors.New("qr: intención no encontrada")

	// ErrQRIntentExpired: la intención ya pasó su TTL.
	ErrQRIntentExpired = errors.New("qr: intención expirada")

	// ErrQRIntentNotPending: la intención está en estado terminal y
	// no admite la transición pedida.
	ErrQRIntentNotPending = errors.New("qr: intención en estado terminal")

	// ErrQRWebhookUnauthorized: la firma HMAC no coincidió o el token
	// del bridge no empató.
	ErrQRWebhookUnauthorized = errors.New("qr webhook: credencial inválida")

	// ErrQRWebhookTooLarge: el body supera el tope operativo.
	ErrQRWebhookTooLarge = errors.New("qr webhook: body excede límite")

	// ErrQRWebhookBadPayload: JSON malformado o campos faltantes.
	ErrQRWebhookBadPayload = errors.New("qr webhook: payload inválido")

	// ErrQRWebhookRejected: el evento se recibió pero su contenido no
	// corresponde a un cobro (p. ej. mensaje push sin monto, event
	// type distinto de SALE_APPROVED). El handler responde 200 OK
	// idempotente.
	ErrQRWebhookRejected = errors.New("qr webhook: evento ignorado")

	// ErrQRWebhookTooOld: el bridge entregó un evento tardío (más
	// viejo que `QRBridgeMaxEventAge`). Se registra como INVALID y se
	// responde 200.
	ErrQRWebhookTooOld = errors.New("qr webhook: evento demasiado viejo")

	// ErrQRWebhookDuplicate: idempotencia (reply/replay).
	ErrQRWebhookDuplicate = errors.New("qr webhook: duplicado")

	// ErrQREventNotFound: /asignar recibió un event_id que no existe.
	ErrQREventNotFound = errors.New("qr event: no encontrado")

	// ErrQREventAlreadyAssigned: /asignar sobre un evento que ya tiene
	// matched_intent_id, cuyo processed_status no es AMBIGUOUS/UNMATCHED,
	// o cuyo received_at supera la ventana de asignación (60 min).
	ErrQREventAlreadyAssigned = errors.New("qr event: ya asignado o fuera de ventana")

	// ErrQRAmountMismatch: /asignar entre un evento y una intención
	// con amount_cop distintos. Nunca aprobamos cobros cuyo monto no
	// corresponde al carrito.
	ErrQRAmountMismatch = errors.New("qr event: monto no coincide con la intención")

	// ErrQRIntentAlreadyPaid: la venta ya tiene un cobro APROBADO. El
	// servicio lo retorna como *IntentAlreadyPaidError (ver abajo) para
	// que el handler responda con `saleId`. El handler puede matchear
	// vía `errors.Is(err, ErrQRIntentAlreadyPaid)` o extraer el saleId
	// con `errors.As(err, &paidErr)`.
	//
	// Es el MISMO valor que repositories.ErrQRIntentAlreadyPaid: el
	// método `Is` de *IntentAlreadyPaidError sólo matchea un sentinel,
	// y queremos que `errors.Is` desde el handler reconozca tanto el
	// error del service como el del repo. Un alias por variable (no
	// `errors.New` nuevo) es la única forma de garantizarlo.
	ErrQRIntentAlreadyPaid = repositories.ErrQRIntentAlreadyPaid
)

// IntentAlreadyPaidError se devuelve desde Enqueue y AssignEventToIntent
// cuando el venta_temp_id ya tiene una intención APROBADA o
// CONFIRMADA_MANUAL. Es un alias de capa de servicio sobre el error
// equivalente del repo: el handler sólo tiene que importar `services`.
type IntentAlreadyPaidError = repositories.IntentAlreadyPaidError

// =========================================================================
// Payload shapes (parseo estricto)
// =========================================================================

// BoldOfficialPayload es el shape mínimo que necesitamos del webhook
// oficial Bold. Shape confirmado por el usuario; el nombre del evento
// y la ruta de `data.amount.total` son configurables (NO VERIFICADO
// contra Bold Payments CO al momento de redactar).
//
// Campos que SÍ guardamos / consumimos:
//   - Type: p.ej. "SALE_APPROVED".
//   - Data.Amount.Total: int64 COP.
//   - Data.BoldCode: identificador canónico global.
//
// Campos que NO parseamos ni guardamos:
//   - Merchant, Customer, Metadata libre. Fuera de alcance.
type BoldOfficialPayload struct {
	Type string `json:"type"`
	Data struct {
		Amount struct {
			Total int64 `json:"total"`
		} `json:"amount"`
		BoldCode string `json:"bold_code"`
	} `json:"data"`
}

// BoldBridgePayload es el shape del POST que emite MacroDroid tras
// capturar una notificación push (`app:"co.bold"`) o un SMS reenviado
// (`app:"sms"` con `remitente`/`recibido_ms`).
type BoldBridgePayload struct {
	Titulo     string `json:"titulo"`
	Mensaje    string `json:"mensaje"`
	App        string `json:"app"`
	Token      string `json:"token"`
	Remitente  string `json:"remitente,omitempty"`
	RecibidoMs int64  `json:"recibido_ms,omitempty"`
}

// =========================================================================
// Servicio
// =========================================================================

// QrPaymentService es el orquestador del flujo.
type QrPaymentService struct {
	repo  *repositories.QrPaymentRepository
	hub   *sse.QRHub
	audit *AuditService
	// saleService inyectado por el bootstrap de main.go para que el
	// materializador asíncrono invoque CreateSale (idempotente por
	// ClientTxId). Puede ser nil en tests antiguos: cuando lo es, la
	// finalización asíncrona queda deshabilitada (publishWebhookOutcome
	// no dispara el dispatcher). El guardián anti-secretos de los
	// tests verifica que CreateSale nunca se llame en el camino de la
	// tx del repo QR (evita deadlock sobre stock_movements).
	saleService *SaleService
	// clientService + saleRepo: abonos de fiado por QR (pos_qr_abono.go).
	// Nil en tests: el abono por QR queda deshabilitado.
	clientService *ClientService
	abonoSaleRepo ports.SaleRepository
	clock         func() time.Time
	warnedNoKey   sync.Once
}

// NewQrPaymentService construye el servicio. La `AuditService` puede ser
// nil (en tests), en cuyo caso las auditorías quedan como no-op.
func NewQrPaymentService(repo *repositories.QrPaymentRepository, hub *sse.QRHub, audit *AuditService) *QrPaymentService {
	return &QrPaymentService{
		repo:  repo,
		hub:   hub,
		audit: audit,
		clock: time.Now,
	}
}

// WithSaleService inyecta el servicio canónico de ventas. Se llama
// desde main.go cuando ambos servicios ya existen (no se puede pasar
// en NewQrPaymentService por el orden de construcción). Si no se
// inyecta, el materializador asíncrono queda deshabilitado y las
// intenciones APROBADAS quedan en finalization_status='NOT_STARTED'.
func (s *QrPaymentService) WithSaleService(saleService *SaleService) *QrPaymentService {
	s.saleService = saleService
	return s
}

// WithClock inyecta un reloj (uso en tests).
func (s *QrPaymentService) WithClock(fn func() time.Time) *QrPaymentService {
	if fn != nil {
		s.clock = fn
	}
	return s
}

// =========================================================================
// Initiate
// =========================================================================

// InitiateOutput es el shape que devuelve POST /iniciar.
//
// AlreadyPaid=true indica que el venta_temp_id ya tiene una intención
// APROBADA/CONFIRMADA_MANUAL y Initiate NO creó una fila nueva. En
// ese caso:
//   - Status es "APROBADA" o "CONFIRMADA_MANUAL".
//   - SaleID carga el related_sale_id (0 si aún no se materializó).
//   - AmountCOP replica el monto exacto del cobro ya pagado.
//   - Reused=true (consistencia con los demás llamados idempotentes).
type InitiateOutput struct {
	IntentID         uint64
	VentaTempID      string
	Status           string
	ExpiresAt        time.Time
	ExpiresInSeconds int
	Reused           bool
	AlreadyPaid      bool
	SaleID           uint64
	AmountCOP        int64
}

// Initiate crea (o reusa) la intención y emite un snapshot inicial
// por SSE. El SSE sólo se publica si el hub tiene suscriptores (no
// bloquea nada si el modal aún no abrió el stream).
func (s *QrPaymentService) Initiate(ctx context.Context, ventaTempID, cajaID, actorDNI string, amountCOP int64) (*InitiateOutput, error) {
	if !models.IsValidQRVentaTempID(ventaTempID) {
		return nil, ErrQRInvalidInput
	}
	if !models.IsValidQRCajaID(cajaID) {
		return nil, ErrQRInvalidInput
	}
	if strings.TrimSpace(actorDNI) == "" {
		return nil, ErrQRInvalidInput
	}
	if !models.IsValidQRAmountCOP(amountCOP) {
		return nil, ErrQRInvalidInput
	}

	outcome, err := s.repo.Initiate(ctx, repositories.InitiateIntentOptions{
		VentaTempID:  ventaTempID,
		CajaID:       cajaID,
		CreatedByDNI: actorDNI,
		AmountCOP:    amountCOP,
		TTL:          models.QRPaymentIntentDefaultTTL,
		Now:          s.clock,
	})
	if err != nil {
		if errors.Is(err, repositories.ErrQRInvalidInput) {
			return nil, ErrQRInvalidInput
		}
		log.Printf("[qr-pagos] fallo repo.Initiate (venta=%s): %v", ventaTempID, err)
		return nil, fmt.Errorf("qr: initiate falló")
	}

	intent := outcome.Intent
	// SSE snapshot inicial (sólo si hay suscriptores). Vale tanto para
	// una fila PENDIENTE nueva como para una reusada; en el caso
	// AlreadyPaid el snapshot emite APROBADO + saleId cuando
	// related_sale_id está presente (ver publishIntentSnapshot).
	s.publishIntentSnapshot(intent)

	return s.buildInitiateOutput(intent, outcome.Reused, outcome.AlreadyPaid), nil
}

// buildInitiateOutput mapea una intención (nueva o reusada) al shape
// de respuesta de /iniciar. Centraliza la propagación de AlreadyPaid/
// SaleID/AmountCOP para que Initiate e InitiateWithSnapshot no se
// desincronicen entre sí.
func (s *QrPaymentService) buildInitiateOutput(intent *models.QrPaymentIntent, reused, alreadyPaid bool) *InitiateOutput {
	out := &InitiateOutput{
		IntentID:         intent.ID,
		VentaTempID:      intent.VentaTempID,
		Status:           intent.Status,
		ExpiresAt:        intent.ExpiresAt,
		ExpiresInSeconds: s.secondsUntil(intent.ExpiresAt),
		Reused:           reused,
		AlreadyPaid:      alreadyPaid,
	}
	if alreadyPaid {
		// AmountCOP es parte del contrato del handler para que el
		// frontend reconstruya el ticket sin re-consultar.
		out.AmountCOP = intent.AmountCOP
		if intent.RelatedSaleID != nil && *intent.RelatedSaleID > 0 {
			out.SaleID = *intent.RelatedSaleID
		}
	}
	return out
}

// =========================================================================
// Enqueue — bandeja global (migración 027)
// =========================================================================

// EnqueueInput parametriza el encolado del QR con snapshot durable.
// El servicio valida snapshots no vacíos, clientTxId con shape 8..64,
// y publica un evento ENQUEUED post-commit al canal de la caja.
//
// NO existen columnas `cashier_name` ni `client_dni` en la migración
// 027. `CashierName` viaja sólo como etiqueta del evento SSE a la
// bandeja (QRTrayEvent.CashierName) y `ClientDNI` entra como parte
// de `ClientSnapshot` (JSONB opaco en BD, decodificado por el
// materializador).
type EnqueueInput struct {
	VentaTempID    string
	CajaID         string
	ActorDNI       string
	CashierName    string
	AmountCOP      int64
	ClientTxID     string
	ClientDNI      string
	CartSnapshot   []byte // JSON ya serializado por el handler
	ClientSnapshot []byte
	TotalsSnapshot []byte
}

// EnqueueOutput es lo que recibe el frontend tras POST /encolar.
type EnqueueOutput struct {
	IntentID         uint64
	VentaTempID      string
	Status           string
	StreamStatus     string
	ExpiresAt        time.Time
	ExpiresInSeconds int
	Reused           bool
}

// Enqueue persiste la intención + snapshot + clientTxId y marca
// queued_at. Reutiliza la MISMA intención emitida por /iniciar (si
// existe con el mismo venta_temp_id y mismo monto): la repo hace el
// adjunto atómico de snapshots+clientTxId+queued_at dentro de la
// misma transacción, sin crear una segunda fila.
//
// Si no existe PENDIENTE previa, inserta una nueva con todos los
// campos del flujo asíncrono poblados en el mismo INSERT.
//
// Si el venta_temp_id YA tiene una intención APROBADA o
// CONFIRMADA_MANUAL, el repo responde con AlreadyPaid=true: /encolar
// debe devolver 409 QR_INTENT_ALREADY_PAID (nunca abrir un segundo
// cobro). Lo señalamos vía *IntentAlreadyPaidError para que el handler
// propague `saleId` al frontend.
//
// El evento ENQUEUED se publica al canal de la caja después del
// commit, con el CashierName sólo transportado en memoria (no se
// persiste a BD porque no existe columna).
func (s *QrPaymentService) Enqueue(ctx context.Context, in EnqueueInput) (*EnqueueOutput, error) {
	if !models.IsValidQRVentaTempID(in.VentaTempID) {
		return nil, ErrQRInvalidInput
	}
	if !models.IsValidQRCajaID(in.CajaID) {
		return nil, ErrQRInvalidInput
	}
	if strings.TrimSpace(in.ActorDNI) == "" {
		return nil, ErrQRInvalidInput
	}
	if !models.IsValidQRAmountCOP(in.AmountCOP) {
		return nil, ErrQRInvalidInput
	}
	clientTx, verr := validateQRSnapshotInputs(in.ClientTxID, in.CartSnapshot, in.ClientSnapshot, in.TotalsSnapshot)
	if verr != nil {
		return nil, verr
	}

	cashierName := strings.TrimSpace(in.CashierName)

	outcome, err := s.repo.Initiate(ctx, repositories.InitiateIntentOptions{
		VentaTempID:    in.VentaTempID,
		CajaID:         in.CajaID,
		CreatedByDNI:   strings.TrimSpace(in.ActorDNI),
		AmountCOP:      in.AmountCOP,
		TTL:            models.QRPaymentIntentDefaultTTL,
		Now:            s.clock,
		SaleClientTxID: clientTx,
		CartSnapshot:   in.CartSnapshot,
		ClientSnapshot: in.ClientSnapshot,
		TotalsSnapshot: in.TotalsSnapshot,
		MarkQueued:     true,
	})
	if err != nil {
		if errors.Is(err, repositories.ErrQRInvalidInput) {
			return nil, ErrQRInvalidInput
		}
		log.Printf("[qr-pagos] Enqueue repo.Initiate falló (venta=%s): %v", in.VentaTempID, err)
		return nil, fmt.Errorf("qr: encolar falló")
	}
	intent := outcome.Intent

	// Si la venta ya está pagada, NUNCA abrir un segundo cobro ni
	// marcar queued_at: el repo garantizó que no tocó la fila paid.
	// Devolvemos *IntentAlreadyPaidError para que el handler responda
	// 409 QR_INTENT_ALREADY_PAID con saleId.
	if outcome.AlreadyPaid {
		paidErr := &IntentAlreadyPaidError{
			IntentID:  intent.ID,
			AmountCOP: intent.AmountCOP,
			Status:    intent.Status,
		}
		if intent.RelatedSaleID != nil {
			paidErr.SaleID = *intent.RelatedSaleID
		}
		// Snapshot APROBADO al stream por si el modal del cajero
		// seguía abierto; el frontend lo cierra con alreadyPaid.
		s.publishIntentSnapshot(intent)
		return nil, paidErr
	}

	// La fila ahora tiene queued_at NOT NULL en todos los casos
	// (nueva o reuse-con-attach). CashierName es transiente: lo
	// adjuntamos sólo para el evento SSE del tray.
	intent.CashierName = cashierName

	// SSE: snapshot del intent (PENDIENTE) + evento ENQUEUED al tray.
	// El modal aún no debe cerrar; se cerrará cuando el dispatcher
	// publique APROBADO con saleId tras CreateSale exitoso.
	s.publishIntentSnapshot(intent)
	s.publishTrayFromIntent(intent, models.QRTrayKindEnqueued, "")
	return &EnqueueOutput{
		IntentID:         intent.ID,
		VentaTempID:      intent.VentaTempID,
		Status:           intent.Status,
		StreamStatus:     models.MapIntentStatusToStream(intent.Status),
		ExpiresAt:        intent.ExpiresAt,
		ExpiresInSeconds: s.secondsUntil(intent.ExpiresAt),
		Reused:           outcome.Reused,
	}, nil
}

// =========================================================================
// InitiateWithSnapshot — /iniciar con snapshot durable (migración 027)
// =========================================================================

// InitiateWithSnapshotInput parametriza la emisión de una intención
// con snapshot durable, pero sin marcar queued_at. El /encolar
// posterior reutiliza la MISMA fila (match por venta_temp_id + monto)
// y sólo marca queued_at. Esto evita la condición de carrera donde
// /iniciar creaba una fila sin snapshot y /encolar creaba otra con
// snapshot — ambas con el mismo venta_temp_id, lo que violaba el
// UNIQUE parcial `ux_pqpi_live_by_venta_temp`.
//
// NO lleva CashierName ni ClientDNI dedicados: ambos viven dentro del
// ClientSnapshot (JSONB) y del ClientTxID. La autoría durable del
// cajero vive en `created_by_dni` (tomado de ActorDNI).
type InitiateWithSnapshotInput struct {
	VentaTempID    string
	CajaID         string
	ActorDNI       string
	AmountCOP      int64
	ClientTxID     string
	CartSnapshot   []byte
	ClientSnapshot []byte
	TotalsSnapshot []byte
}

// InitiateWithSnapshot persiste cart/client/totals snapshot + sale_client_tx_id
// con queued_at NULL. Reutiliza la validación común con Enqueue;
// delega al repo con MarkQueued=false. El /encolar posterior
// reutiliza la fila y sólo marca queued_at (adjunto atómico en la
// misma tx).
//
// Si no se envía snapshot, el handler NO debe llamar a este método:
// usa `Initiate` (payload legacy). El método existe sólo para preparar
// la intención con la foto durable "al abrir el QR" aunque el cajero
// todavía NO haya pulsado "Dejar en espera".
func (s *QrPaymentService) InitiateWithSnapshot(ctx context.Context, in InitiateWithSnapshotInput) (*InitiateOutput, error) {
	if !models.IsValidQRVentaTempID(in.VentaTempID) {
		return nil, ErrQRInvalidInput
	}
	if !models.IsValidQRCajaID(in.CajaID) {
		return nil, ErrQRInvalidInput
	}
	if strings.TrimSpace(in.ActorDNI) == "" {
		return nil, ErrQRInvalidInput
	}
	if !models.IsValidQRAmountCOP(in.AmountCOP) {
		return nil, ErrQRInvalidInput
	}
	clientTx, verr := validateQRSnapshotInputs(in.ClientTxID, in.CartSnapshot, in.ClientSnapshot, in.TotalsSnapshot)
	if verr != nil {
		return nil, verr
	}

	outcome, err := s.repo.Initiate(ctx, repositories.InitiateIntentOptions{
		VentaTempID:    in.VentaTempID,
		CajaID:         in.CajaID,
		CreatedByDNI:   strings.TrimSpace(in.ActorDNI),
		AmountCOP:      in.AmountCOP,
		TTL:            models.QRPaymentIntentDefaultTTL,
		Now:            s.clock,
		SaleClientTxID: clientTx,
		CartSnapshot:   in.CartSnapshot,
		ClientSnapshot: in.ClientSnapshot,
		TotalsSnapshot: in.TotalsSnapshot,
		// CRÍTICO: /iniciar NO marca queued_at. El cajero sigue viendo
		// el modal; /encolar es quien dispara el salto a la bandeja.
		MarkQueued: false,
	})
	if err != nil {
		if errors.Is(err, repositories.ErrQRInvalidInput) {
			return nil, ErrQRInvalidInput
		}
		log.Printf("[qr-pagos] InitiateWithSnapshot repo.Initiate falló (venta=%s): %v", in.VentaTempID, err)
		return nil, fmt.Errorf("qr: initiate con snapshot falló")
	}

	intent := outcome.Intent
	// SSE snapshot inicial (si hay suscriptores). En AlreadyPaid, la
	// fila paid se publica como APROBADO + saleId cuando related_sale_id
	// está presente — el modal del frontend lo lee para cerrarse sin
	// reabrir el cobro.
	s.publishIntentSnapshot(intent)

	return s.buildInitiateOutput(intent, outcome.Reused, outcome.AlreadyPaid), nil
}

// validateQRSnapshotInputs valida los campos de snapshot durable
// (clientTxId + cart/client/totals JSONB). Se usa desde Enqueue e
// InitiateWithSnapshot para no duplicar reglas de forma/tamaño.
//
// Reglas:
//
//   - ClientTxID debe ser 8..64 chars tras TrimSpace (empata con el
//     shape de sales."clientTxId" migración 009 y con
//     ck_pqpi_sale_client_tx_id_shape de la 027).
//
//   - CartSnapshot es obligatorio, JSON válido y <= 64 KB. Sin cart
//     no hay forma de materializar la venta canónica.
//
//   - ClientSnapshot / TotalsSnapshot son opcionales. Si vienen,
//     deben ser JSON válido y <= 64 KB.
//
// El techo de 64 KB por JSONB es defensa anti-DoS en el service; el
// handler lo refuerza con MaxBytesReader a nivel body (128 KB cuando
// hay snapshot). Un carrito realista pesa <5 KB.
func validateQRSnapshotInputs(clientTxID string, cart, client, totals []byte) (string, error) {
	const snapshotMaxBytes = 64 * 1024
	tx := strings.TrimSpace(clientTxID)
	if len(tx) < 8 || len(tx) > 64 {
		return "", ErrQRInvalidInput
	}
	if len(cart) == 0 || len(cart) > snapshotMaxBytes {
		return "", ErrQRInvalidInput
	}
	if len(client) > snapshotMaxBytes || len(totals) > snapshotMaxBytes {
		return "", ErrQRInvalidInput
	}
	if !json.Valid(cart) {
		return "", ErrQRInvalidInput
	}
	if len(client) > 0 && !json.Valid(client) {
		return "", ErrQRInvalidInput
	}
	if len(totals) > 0 && !json.Valid(totals) {
		return "", ErrQRInvalidInput
	}
	return tx, nil
}

// ListPendingByCaja devuelve la foto de la bandeja para una caja.
func (s *QrPaymentService) ListPendingByCaja(ctx context.Context, cajaID string, limit int) ([]repositories.PendingByCajaItem, error) {
	if !models.IsValidQRCajaID(cajaID) {
		return nil, ErrQRInvalidInput
	}
	items, err := s.repo.ListPendingByCaja(ctx, cajaID, limit, s.clock())
	if err != nil {
		if errors.Is(err, repositories.ErrQRInvalidInput) {
			return nil, ErrQRInvalidInput
		}
		log.Printf("[qr-pagos] ListPendingByCaja falló (caja=%s): %v", cajaID, err)
		return nil, fmt.Errorf("qr: pendientes falló")
	}
	return items, nil
}

// ListPendingGlobal es la variante "scope=all" (B5, 2026-10-23): devuelve
// la foto de la bandeja de TODAS las cajas. La capa HTTP debe verificar
// rol admin/superadmin antes de invocarla; el servicio no autoriza.
func (s *QrPaymentService) ListPendingGlobal(ctx context.Context, limit int) ([]repositories.PendingByCajaItem, error) {
	items, err := s.repo.ListPendingAll(ctx, limit, s.clock())
	if err != nil {
		if errors.Is(err, repositories.ErrQRInvalidInput) {
			return nil, ErrQRInvalidInput
		}
		log.Printf("[qr-pagos] ListPendingAll falló: %v", err)
		return nil, fmt.Errorf("qr: pendientes falló")
	}
	return items, nil
}

// =========================================================================
// Estado
// =========================================================================

// SnapshotOutput es el shape que devuelve GET /estado.
type SnapshotOutput struct {
	VentaTempID       string
	Status            string
	StreamStatus      string
	AmountCOP         int64
	ExpiresAt         time.Time
	ApprovedAt        *time.Time
	ApprovedReference string
	ApprovedSource    string
}

// GetSnapshot devuelve la foto actual de la intención. Útil para
// reconexión tras caída de red.
//
// Orden de preferencia (para que una venta ya pagada NO se reabra ni
// quede en EXPIRADO/CANCELADO por una fila fantasma más reciente):
//  1. Intención APROBADA/CONFIRMADA_MANUAL (si existe), para publicar
//     saleId + amountCop al stream inicial.
//  2. Intención PENDIENTE viva.
//  3. Última intención histórica (devuelve el estado terminal más
//     reciente para el cliente que reconectó tras un cierre).
func (s *QrPaymentService) GetSnapshot(ctx context.Context, ventaTempID string) (*SnapshotOutput, error) {
	if !models.IsValidQRVentaTempID(ventaTempID) {
		return nil, ErrQRInvalidInput
	}
	intent, err := s.repo.GetLatestPaidByVentaTempID(ctx, ventaTempID)
	if err != nil && errors.Is(err, repositories.ErrQRIntentNotFound) {
		intent, err = s.repo.GetLiveByVentaTempID(ctx, ventaTempID)
		if err != nil && errors.Is(err, repositories.ErrQRIntentNotFound) {
			intent, err = s.repo.GetLatestByVentaTempID(ctx, ventaTempID)
		}
	}
	if err != nil {
		if errors.Is(err, repositories.ErrQRIntentNotFound) {
			return nil, ErrQRIntentNotFound
		}
		log.Printf("[qr-pagos] GetSnapshot falló (venta=%s): %v", ventaTempID, err)
		return nil, fmt.Errorf("qr: snapshot falló")
	}
	return &SnapshotOutput{
		VentaTempID:       intent.VentaTempID,
		Status:            intent.Status,
		StreamStatus:      models.MapIntentStatusToStream(intent.Status),
		AmountCOP:         intent.AmountCOP,
		ExpiresAt:         intent.ExpiresAt,
		ApprovedAt:        intent.ApprovedAt,
		ApprovedReference: intent.ApprovedReference,
		ApprovedSource:    intent.ApprovedSource,
	}, nil
}

// =========================================================================
// Cancel
// =========================================================================

// Cancel transita a CANCELADA. El servicio también emite SSE post-commit.
func (s *QrPaymentService) Cancel(ctx context.Context, ventaTempID, actorDNI, reason string) (*SnapshotOutput, error) {
	if !models.IsValidQRVentaTempID(ventaTempID) {
		return nil, ErrQRInvalidInput
	}
	if strings.TrimSpace(actorDNI) == "" {
		return nil, ErrQRInvalidInput
	}
	intent, err := s.repo.Cancel(ctx, ventaTempID, actorDNI, reason, s.clock)
	if err != nil {
		switch {
		case errors.Is(err, repositories.ErrQRIntentNotFound):
			return nil, ErrQRIntentNotFound
		case errors.Is(err, repositories.ErrQRIntentNotPending):
			return nil, ErrQRIntentNotPending
		case errors.Is(err, repositories.ErrQRInvalidInput):
			return nil, ErrQRInvalidInput
		}
		log.Printf("[qr-pagos] Cancel falló (venta=%s): %v", ventaTempID, err)
		return nil, fmt.Errorf("qr: cancel falló")
	}
	// Publica tras commit.
	s.publishIntentSnapshot(intent)
	return s.toSnapshot(intent), nil
}

// =========================================================================
// ConfirmManual
// =========================================================================

// ConfirmManualOutput es el shape que devuelve /confirmar-manual.
type ConfirmManualOutput struct {
	VentaTempID       string
	Status            string
	ApprovedAt        time.Time
	ApprovedReference string
	// ApprovedSource replica la columna `approved_source` (en este
	// camino siempre MANUAL). El handler lo expone al frontend como
	// `approvedVia` para que el modal distinga sin inferir desde la
	// vía de disparo.
	ApprovedSource string
}

// ConfirmManual transita a CONFIRMADA_MANUAL y audita con DNI del
// contexto. El servicio es el único punto donde el DNI entra: NUNCA
// se acepta un DNI arbitrario del body.
func (s *QrPaymentService) ConfirmManual(ctx context.Context, ventaTempID, actorDNI, actorName, note, ip, device string) (*ConfirmManualOutput, error) {
	if !models.IsValidQRVentaTempID(ventaTempID) {
		return nil, ErrQRInvalidInput
	}
	if strings.TrimSpace(actorDNI) == "" {
		return nil, ErrQRInvalidInput
	}
	intent, err := s.repo.ConfirmManual(ctx, repositories.ConfirmManualInput{
		VentaTempID: ventaTempID,
		ActorDNI:    actorDNI,
		Note:        note,
		Reference:   "", // Fallback a MANUAL_<venta>.
		Now:         s.clock,
	})
	if err != nil {
		switch {
		case errors.Is(err, repositories.ErrQRIntentNotFound):
			return nil, ErrQRIntentNotFound
		case errors.Is(err, repositories.ErrQRIntentExpired):
			return nil, ErrQRIntentExpired
		case errors.Is(err, repositories.ErrQRIntentNotPending):
			return nil, ErrQRIntentNotPending
		case errors.Is(err, repositories.ErrQRInvalidInput):
			return nil, ErrQRInvalidInput
		}
		log.Printf("[qr-pagos] ConfirmManual falló (venta=%s): %v", ventaTempID, err)
		return nil, fmt.Errorf("qr: confirmar manual falló")
	}

	// Auditoría crítica con DNI del contexto.
	if s.audit != nil {
		details := fmt.Sprintf("venta=%s intentId=%d monto=%d note=%s",
			intent.VentaTempID, intent.ID, intent.AmountCOP, sanitize(note))
		human := fmt.Sprintf("Confirmación manual de cobro QR Daviplata por $%d (venta temp %s).",
			intent.AmountCOP, intent.VentaTempID)
		changes, _ := json.Marshal(map[string]interface{}{
			"before": map[string]string{"status": models.QRIntentStatusPending},
			"after":  map[string]string{"status": models.QRIntentStatusConfirmedManual},
			"deltas": map[string]interface{}{
				"approvedSource":       models.QRApprovalSourceManual,
				"manualConfirmedByDni": actorDNI,
				"amountCop":            intent.AmountCOP,
				"intentId":             intent.ID,
			},
		})
		s.audit.Log(actorDNI, actorName, "APPROVE_MANUAL", "POS_QR", details, human, string(changes), ip, device, true)
	}

	// SSE tras commit.
	s.publishIntentSnapshot(intent)
	// Materializar de inmediato (venta, edición o abono) en vez de esperar
	// el barrido periódico. Idempotente por ClaimForFinalization.
	s.triggerAutoSale(intent)

	return &ConfirmManualOutput{
		VentaTempID:       intent.VentaTempID,
		Status:            intent.Status,
		ApprovedAt:        derefTime(intent.ApprovedAt),
		ApprovedReference: intent.ApprovedReference,
		ApprovedSource:    intent.ApprovedSource,
	}, nil
}

// =========================================================================
// Webhook oficial Bold
// =========================================================================

// IngestOfficialWebhook valida la firma HMAC y procesa el payload.
// El `rawBody` debe pasarse SIN modificar (el handler lo lee antes
// del parseo JSON). `signatureHeader` llega del header configurado
// (default X-Bold-Signature).
//
// La verificación HMAC se hace con `hmac.Equal` (tiempo constante).
// NUNCA se loguea la firma recibida ni la esperada.
func (s *QrPaymentService) IngestOfficialWebhook(ctx context.Context, rawBody []byte, signatureHeader string) (*repositories.IngestWebhookOutcome, error) {
	if len(rawBody) == 0 {
		return nil, ErrQRWebhookBadPayload
	}
	if len(rawBody) > models.QRWebhookMaxBodyBytes {
		return nil, ErrQRWebhookTooLarge
	}

	// 1) HMAC obligatorio para el canal oficial. Sin secreto configurado
	// fallamos cerrado: aceptar un evento sin firma permitiría aprobar una
	// intención con sólo conocer su monto. El aviso nunca incluye secretos.
	secret := strings.TrimSpace(os.Getenv(envBoldSecretKey))
	if secret == "" {
		s.warnedNoKey.Do(func() {
			log.Printf("[qr-pagos] AVISO: BOLD_SECRET_KEY no configurada; webhook oficial deshabilitado.")
		})
		return nil, ErrQRWebhookUnauthorized
	}
	if !verifyBoldHMAC(rawBody, []byte(secret), signatureHeader) {
		return nil, ErrQRWebhookUnauthorized
	}

	// 2) Parse JSON.
	var payload BoldOfficialPayload
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		return nil, ErrQRWebhookBadPayload
	}

	// 3) Tipo de evento: sólo tratamos SALE_APPROVED. Para otros
	// tipos (p.ej. SALE_REJECTED, REFUND), devolvemos "rejected" para
	// que el handler conteste 200 (idempotente, no procesamos pero
	// tampoco rebotamos a Bold que seguiría reintentando).
	saleApprovedType := strings.TrimSpace(os.Getenv(envBoldSaleApprovedEvt))
	if saleApprovedType == "" {
		saleApprovedType = defaultSaleApprovedType
	}
	if !strings.EqualFold(strings.TrimSpace(payload.Type), saleApprovedType) {
		return nil, ErrQRWebhookRejected
	}

	amount := payload.Data.Amount.Total
	if amount <= 0 || !models.IsValidQRAmountCOP(amount) {
		return nil, ErrQRWebhookRejected
	}
	boldCode := strings.TrimSpace(payload.Data.BoldCode)
	if boldCode == "" {
		// Sin bold_code no podemos deduplicar canónicamente; se
		// rechaza para forzar re-emisión Bold con payload completo.
		return nil, ErrQRWebhookBadPayload
	}

	// 4) Fingerprint determinístico desde bold_code. UNIQUE adicional
	// contra replays dentro del mismo bucket.
	fingerprint := fingerprintOfficial(boldCode, amount)

	// 5) Delega al repo.
	outcome, err := s.repo.IngestWebhook(ctx, repositories.IngestWebhookInput{
		Source:      models.QRWebhookSourceOfficial,
		EventType:   payload.Type,
		ExternalID:  boldCode,
		Fingerprint: fingerprint,
		AmountCOP:   amount,
		Note:        "", // Nada sensible en note.
		Now:         s.clock,
	})
	if err != nil {
		switch {
		case errors.Is(err, repositories.ErrQRWebhookDuplicate):
			return nil, ErrQRWebhookDuplicate
		case errors.Is(err, repositories.ErrQRInvalidInput):
			return nil, ErrQRInvalidInput
		}
		log.Printf("[qr-pagos] IngestWebhook oficial falló: %v", err)
		return nil, fmt.Errorf("qr: ingest oficial falló")
	}

	// 6) SSE tras commit: APROBADO si matched, hint si UNMATCHED/AMBIGUOUS.
	s.publishWebhookOutcome(outcome)
	return outcome, nil
}

// =========================================================================
// Webhook bridge MacroDroid
// =========================================================================

// IngestBridgeWebhook valida el token y procesa la notificación push.
//
// Dos formatos de puente soportados:
//
//  1. Legacy ("co.bold"): {titulo, mensaje, app:"co.bold", token}. El
//     token puede llegar también por X-Bridge-Token / X-Bold-Bridge-Token
//     (header canónico y legacy). El fingerprint usa un bucket de 60 s.
//
//  2. SMS reenviado ("sms"): {app:"sms", remitente, mensaje,
//     recibido_ms:int64, [token]}. El `remitente` se compara en tiempo
//     constante contra BOLD_SMS_SENDERS (allowlist); los no permitidos
//     se descartan sin loguear el texto. `recibido_ms` entra en el
//     fingerprint sin bucket, para que dos SMS distintos del mismo
//     monto en el mismo minuto sean eventos distintos pero el replay
//     del mismo SMS caiga en DUPLICATE.
//
// Reglas comunes:
//   - El token se compara con `subtle.ConstantTimeCompare` contra
//     BOLD_BRIDGE_TOKEN. Si la env falta → 401.
//   - Rechazamos (200 ignored) por app ajena, remitente fuera del
//     allowlist, recibido_ms fuera de ventana o monto no parseable.
//   - El log operativo sólo se emite CUANDO el payload pasó todas las
//     validaciones de autenticidad Y se extrajo un monto válido. Un
//     mensaje con negador o un remitente desconocido NO deja rastro
//     del texto en el log.
func (s *QrPaymentService) IngestBridgeWebhook(ctx context.Context, rawBody []byte, headerToken string) (*repositories.IngestWebhookOutcome, error) {
	if len(rawBody) == 0 {
		return nil, ErrQRWebhookBadPayload
	}
	if len(rawBody) > models.QRWebhookMaxBodyBytes {
		return nil, ErrQRWebhookTooLarge
	}

	bridgeSecret := strings.TrimSpace(os.Getenv(envBoldBridgeToken))
	if bridgeSecret == "" {
		return nil, ErrQRWebhookUnauthorized
	}

	var payload BoldBridgePayload
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		return nil, ErrQRWebhookBadPayload
	}

	// 1) Comparación en tiempo constante. El header tiene prioridad; el
	// campo JSON se conserva únicamente para instalaciones legacy.
	provided := strings.TrimSpace(headerToken)
	if provided == "" {
		provided = strings.TrimSpace(payload.Token)
	}
	tokenOK := subtle.ConstantTimeCompare([]byte(provided), []byte(bridgeSecret)) == 1
	wipeString(&provided)
	payload.Token = ""
	if !tokenOK {
		return nil, ErrQRWebhookUnauthorized
	}

	// 2) Formato: sólo SMS. Desde 2026-10-26 el cobro QR es Daviplata
	// (remitente 85888); los avisos de Bold (push `co.bold` o SMS de Bold)
	// ya no se aceptan.
	appPackage := strings.ToLower(strings.TrimSpace(payload.App))
	isSMS := appPackage == models.QRBridgeAppSMS
	if !isSMS {
		return nil, ErrQRWebhookRejected
	}

	// 3) Remitente: el código corto de Daviplata, o la allowlist
	// configurada en el servidor (BOLD_SMS_SENDERS, por compatibilidad).
	if !isDaviplataSender(payload.Remitente) && !isAllowedSMSSender(payload.Remitente) {
		return nil, ErrQRWebhookRejected
	}
	remitenteNorm := models.NormalizeBridgeSender(payload.Remitente)

	// 4) Validar la ventana temporal cuando el payload entrega
	// recibido_ms. Reloj del celular puede adelantarse unos segundos;
	// la holgura hacia el futuro es QRBridgeFutureAgeSlack. Hacia el
	// pasado se exige <= QRBridgeMaxEventAge (10 min por default).
	now := s.clock()
	if payload.RecibidoMs > 0 {
		received := time.UnixMilli(payload.RecibidoMs).UTC()
		age := now.Sub(received)
		if age > models.QRBridgeMaxEventAge {
			return nil, ErrQRWebhookRejected
		}
		if -age > models.QRBridgeFutureAgeSlack {
			return nil, ErrQRWebhookRejected
		}
	}

	// 5) Monto: sólo pagos RECIBIDOS de Daviplata (QR o llave). Compras
	// PSE y cualquier otro SMS se ignoran sin loguear el texto.
	notificationText := bridgeNotificationText(payload)
	amount, _, ok := extractDaviplataPayment(notificationText)
	if !ok || !models.IsValidQRAmountCOP(amount) {
		return nil, ErrQRWebhookRejected
	}

	// 6) Log operativo. Ahora SÍ: payload autenticado, origen válido,
	// monto extraído con éxito. No se filtra token (`payload.Token=""`
	// desde el inicio de la función).
	logBoldBridgeNotification(payload)

	// 7) Fingerprint. Con recibido_ms → sha256(source|amount|remitente|
	// recibido_ms|texto_norm) sin bucket; dos SMS distintos del mismo
	// monto en el mismo minuto producen fingerprints distintos y
	// quedan como eventos independientes. Sin recibido_ms (co.bold
	// legacy) → bucket de 60 s para que el replay del mismo push dentro
	// de la ventana colisione.
	fingerprint := fingerprintBridge(notificationText, remitenteNorm, amount, payload.RecibidoMs, now)

	// 8) Nota saneada (<=200 chars, sin controles). Para la conciliación
	// manual el cajero ve ese resumen desde /pagos-sin-asignar.
	note := models.SanitizeBridgeNote(notificationText, models.QRBridgeNoteMaxLen)

	outcome, err := s.repo.IngestWebhook(ctx, repositories.IngestWebhookInput{
		Source:      models.QRWebhookSourceBridge,
		EventType:   "PUSH_NOTIFICATION",
		ExternalID:  "", // bridge no tiene id canónico.
		Fingerprint: fingerprint,
		AmountCOP:   amount,
		Note:        note,
		Now:         s.clock,
	})
	if err != nil {
		switch {
		case errors.Is(err, repositories.ErrQRWebhookDuplicate):
			return nil, ErrQRWebhookDuplicate
		case errors.Is(err, repositories.ErrQRInvalidInput):
			return nil, ErrQRInvalidInput
		}
		log.Printf("[qr-pagos] IngestWebhook bridge falló: %v", err)
		return nil, fmt.Errorf("qr: ingest bridge falló")
	}

	s.publishWebhookOutcome(outcome)
	return outcome, nil
}

// =========================================================================
// Barrido de expiración + repoblado al arranque
// =========================================================================

// SweepExpiredAndPublish mueve PENDIENTES stale a EXPIRADA en BD y
// publica el estado terminal por SSE a cada venta_temp_id afectada.
// Devuelve cuántas filas se transicionaron. Pensado para un ticker
// corto (cada 30-60s).
func (s *QrPaymentService) SweepExpiredAndPublish(ctx context.Context) (int64, error) {
	now := s.clock()
	rows, err := s.repo.ListPendingLive(ctx, now.Add(-10*time.Minute)) // ventana amplia
	if err != nil {
		return 0, err
	}
	// Encontramos las que YA están stale (expires_at <= now).
	var stale []models.QrPaymentIntent
	for _, r := range rows {
		if !r.ExpiresAt.After(now) {
			stale = append(stale, r)
		}
	}
	affected, err := s.repo.ExpireStale(ctx, now)
	if err != nil {
		return 0, err
	}
	// Publicar snapshot EXPIRADO por cada stale conocida.
	for i := range stale {
		stale[i].Status = models.QRIntentStatusExpired
		s.publishIntentSnapshot(&stale[i])
	}
	return affected, nil
}

// WarmupFromDB repuebla el hub con snapshots PENDIENTE para intents
// vivas. Pensado para que, tras un reinicio del server, los clientes
// que reconecten su stream reciban el estado correcto como primer
// frame.
//
// En práctica el handler emite el snapshot en el momento del
// Subscribe (leyendo del repo), por lo que WarmupFromDB es defensa
// adicional. No es obligatorio pero mantiene la memoria y la BD
// alineadas desde el arranque.
func (s *QrPaymentService) WarmupFromDB(ctx context.Context) (int, error) {
	intents, err := s.repo.ListPendingLive(ctx, s.clock())
	if err != nil {
		return 0, err
	}
	count := 0
	for i := range intents {
		if s.hub != nil && s.hub.Subscribers(intents[i].VentaTempID) > 0 {
			s.publishIntentSnapshot(&intents[i])
			count++
		}
	}
	return count, nil
}

// =========================================================================
// Snapshot inicial para suscriptores recién llegados al SSE
// =========================================================================

// EmitSnapshotTo publica un snapshot al hub para un venta_temp_id. El
// handler lo llama tras suscribirse para que el primer frame refleje
// el estado actual.
//
// Preferimos la intención paid cuando existe para que un modal que
// reconecta tras un cobro ya aprobado reciba de entrada APROBADO +
// saleId + amountCop, lo que dispara el cierre y la impresión sin
// reabrir el QR.
func (s *QrPaymentService) EmitSnapshotTo(ctx context.Context, ventaTempID string) {
	if !models.IsValidQRVentaTempID(ventaTempID) {
		return
	}
	intent, err := s.repo.GetLatestPaidByVentaTempID(ctx, ventaTempID)
	if err != nil {
		if !errors.Is(err, repositories.ErrQRIntentNotFound) {
			log.Printf("[qr-pagos] EmitSnapshotTo paid lookup falló (venta=%s): %v", ventaTempID, err)
			return
		}
		intent, err = s.repo.GetLiveByVentaTempID(ctx, ventaTempID)
		if err != nil {
			if !errors.Is(err, repositories.ErrQRIntentNotFound) {
				log.Printf("[qr-pagos] EmitSnapshotTo falló (venta=%s): %v", ventaTempID, err)
				return
			}
			// Sin viva ni paid, pintamos la última histórica para que
			// el cliente sepa si terminó (EXPIRADO/CANCELADO).
			intent, err = s.repo.GetLatestByVentaTempID(ctx, ventaTempID)
			if err != nil {
				return
			}
		}
	}
	s.publishIntentSnapshot(intent)
}

// =========================================================================
// Helpers privados
// =========================================================================

// verifyBoldHMAC compara la firma recibida contra la calculada en
// tiempo constante. Acepta hexadecimal con prefijo opcional `sha256=`.
// NUNCA loguea ninguna de las dos.
func verifyBoldHMAC(rawBody []byte, secret []byte, provided string) bool {
	provided = strings.TrimSpace(provided)
	if provided == "" {
		return false
	}
	// Si viene con el prefijo "sha256=" (patrón de Stripe/Shopify, no
	// confirmado para Bold), se lo quitamos antes de parsear.
	provided = strings.TrimPrefix(provided, "sha256=")
	mac := hmac.New(sha256.New, secret)
	mac.Write(rawBody)
	expected := mac.Sum(nil)
	// Parseamos la firma recibida como hex (lo más común). Si falla,
	// retornamos false sin filtrar detalles técnicos.
	providedBytes, err := hex.DecodeString(provided)
	if err != nil {
		return false
	}
	return hmac.Equal(expected, providedBytes)
}

// fingerprintOfficial produce un identificador determinístico para
// deduplicar un evento oficial Bold. Incluye el bold_code (que es
// canónico) y el amount para resistir mutaciones del campo external
// (si Bold cambia el formato de bold_code en el futuro, la UNIQUE
// (source, external_id) sigue siendo suficiente, pero el fingerprint
// nos da un segundo check).
func fingerprintOfficial(boldCode string, amount int64) string {
	h := sha256.New()
	h.Write([]byte(models.QRWebhookSourceOfficial))
	h.Write([]byte{'|'})
	h.Write([]byte(boldCode))
	h.Write([]byte{'|'})
	h.Write([]byte(strconv.FormatInt(amount, 10)))
	return hex.EncodeToString(h.Sum(nil))
}

// fingerprintBridge produce un identificador determinístico para el
// bridge MacroDroid. Dos modos:
//
//   - Si `recibidoMs > 0`: sha256(source|amount|remitente|recibidoMs|
//     texto_norm) SIN bucket. Dos SMS distintos del mismo monto en el
//     mismo minuto producen fingerprints distintos (recibido_ms varía
//     ms a ms); el replay EXACTO del mismo SMS cae en DUPLICATE porque
//     el servidor nunca cambia el texto ni recibido_ms.
//
//   - Si `recibidoMs == 0` (co.bold legacy sin timestamp): se vuelve a
//     usar un bucket de QRBridgeReplayWindow (60 s por default) para
//     que replays idénticos dentro de la ventana colisionen.
//
// NUNCA incluye el token BOLD_BRIDGE_TOKEN. Si el mismo mensaje
// llegara con dos tokens distintos (imposible en operación normal),
// ambos colapsarían al mismo fingerprint, lo cual es intencional:
// preferimos un falso negativo que una doble aprobación.
func fingerprintBridge(message, remitenteNorm string, amount, recibidoMs int64, now time.Time) string {
	h := sha256.New()
	h.Write([]byte(models.QRWebhookSourceBridge))
	h.Write([]byte{'|'})
	h.Write([]byte(strconv.FormatInt(amount, 10)))
	h.Write([]byte{'|'})
	if recibidoMs > 0 {
		h.Write([]byte(strings.ToLower(strings.TrimSpace(remitenteNorm))))
		h.Write([]byte{'|'})
		h.Write([]byte(strconv.FormatInt(recibidoMs, 10)))
	} else {
		bucketSec := int64(models.QRBridgeReplayWindow.Seconds())
		if bucketSec <= 0 {
			bucketSec = 60
		}
		bucket := now.Unix() / bucketSec
		h.Write([]byte(strconv.FormatInt(bucket, 10)))
	}
	h.Write([]byte{'|'})
	norm := strings.ToLower(strings.TrimSpace(message))
	h.Write([]byte(norm))
	return hex.EncodeToString(h.Sum(nil))
}

// copFromMessageRegex: `Recibiste $45.800`, `Transferencia $1.234.567,00`,
// `[Bold] $20.000 confirmados`. El primer match es suficiente; preferimos
// no inventar si hay dos (`$X y $Y`) y nos quedamos con el primero.
//
// IMPORTANTE: NUNCA aceptar un match si el texto incluye palabras
// negadoras ("reversado", "anulado", "pendiente", "fallido", "rechazado",
// "devolución"). Esto evita que una notificación "Transferencia reversada
// $45.800" apruebe el cobro.
var copFromMessageRegex = regexp.MustCompile(`\$\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`)

var copMessageNegators = []string{
	"revers", // reversado / reversó
	"anul",   // anulado / anulación
	"pendiente",
	"rechaz",     // rechazado
	"fallid",     // fallido
	"devolu",     // devolución
	"no se pudo", // "no se pudo completar"
	"cancel",     // cancelado
}

// isBoldAndroidApp restringe el bridge al package oficial declarado por
// MacroDroid. EqualFold tolera únicamente diferencias de mayúsculas.
func isBoldAndroidApp(app string) bool {
	return strings.EqualFold(strings.TrimSpace(app), boldAndroidPackage)
}

// isAllowedSMSSender valida el remitente de un payload `app:"sms"`
// contra la allowlist BOLD_SMS_SENDERS (coma-separada). Reglas:
//
//   - Env vacía o no configurada → rechaza. El puente SMS no debe
//     operar sin allowlist (abriría la puerta a cualquier SMS con el
//     formato esperado).
//   - Remitente vacío → rechaza. En este formato el remitente es parte
//     del contrato.
//   - Cada entrada se normaliza con models.NormalizeBridgeSender y la
//     comparación usa models.BridgeSenderMatches (tolera prefijo +, y
//     cuando ambos tienen >=10 dígitos acepta coincidencia por sufijo
//     de los últimos 10).
//
// Lee la env en cada llamada por simplicidad. En producción la env se
// setea al arranque; el costo de leer una variable in-process es
// despreciable comparado con el round-trip a Postgres.
func isAllowedSMSSender(sender string) bool {
	raw := strings.TrimSpace(os.Getenv(envBoldSMSSenders))
	if raw == "" {
		return false
	}
	norm := models.NormalizeBridgeSender(sender)
	if norm == "" {
		return false
	}
	for _, entry := range strings.Split(raw, ",") {
		if n := models.NormalizeBridgeSender(entry); n != "" && models.BridgeSenderMatches(norm, n) {
			return true
		}
	}
	return false
}

// isBoldQRTransferSMS reconoce el SMS de Bold de un pago recibido por el
// QR: "BoldCF: Recibiste una transferencia QR Bold por valor de $300,00…".
// Exige ambas frases para no aceptar otros avisos del mismo remitente.
func isBoldQRTransferSMS(text string) bool {
	t := strings.ToLower(strings.Join(strings.Fields(text), " "))
	return strings.Contains(t, "recibiste") && strings.Contains(t, "transferencia qr bold")
}

// bridgeNotificationText conserva título y mensaje como dos campos separados
// para parser y fingerprint. Los negadores se evalúan sobre el conjunto.
func bridgeNotificationText(payload BoldBridgePayload) string {
	return strings.TrimSpace(payload.Titulo + "\n" + payload.Mensaje)
}

// logBoldBridgeNotification registra sólo información diagnóstica autorizada.
// %q conserva exactamente los textos y escapa controles/saltos para que una
// notificación no pueda inyectar líneas. El token nunca forma parte del format.
func logBoldBridgeNotification(payload BoldBridgePayload) {
	log.Printf(
		"[qr-pagos] push Bold recibida app=%q titulo=%q mensaje=%q",
		strings.TrimSpace(payload.App),
		payload.Titulo,
		payload.Mensaje,
	)
}

// extractCOPFromMessage intenta extraer el monto COP de una
// notificación push. Rechaza silenciosamente mensajes con negadores
// (ver copMessageNegators). Devuelve (amount, true) sólo si:
//   - encuentra un match de dinero,
//   - el monto normalizado es un entero positivo,
//   - no hay negadores en el texto.
func extractCOPFromMessage(mensaje string) (int64, bool) {
	s := strings.ToLower(strings.TrimSpace(mensaje))
	if s == "" {
		return 0, false
	}
	for _, n := range copMessageNegators {
		if strings.Contains(s, n) {
			return 0, false
		}
	}
	m := copFromMessageRegex.FindStringSubmatch(s)
	if len(m) < 2 {
		return 0, false
	}
	return parseCOPToken(m[1])
}

// parseCOPToken parsea un token numérico con posibles separadores de
// miles (`.` o `,`) y centavos (`.XX` o `,XX`). Mismas reglas que
// `parseCOPToken` del helper del frontend para que el comportamiento
// sea idéntico de los dos lados.
//
// Devuelve (amount, true) si:
//   - todos los separadores agrupan en 3 dígitos (todos son miles), o
//   - el último grupo tiene 1..2 dígitos (centavos descartados).
//   - amount > 0.
//
// En cualquier otro caso devuelve (0, false) para no inventar.
func parseCOPToken(token string) (int64, bool) {
	s := strings.TrimSpace(token)
	if s == "" {
		return 0, false
	}
	parts := strings.FieldsFunc(s, func(r rune) bool { return r == '.' || r == ',' })
	// Pre-chequeo: todas las partes deben ser dígitos.
	for _, p := range parts {
		if p == "" {
			return 0, false
		}
		for _, r := range p {
			if r < '0' || r > '9' {
				return 0, false
			}
		}
	}
	var integerDigits string
	switch len(parts) {
	case 0:
		return 0, false
	case 1:
		integerDigits = parts[0]
	default:
		last := parts[len(parts)-1]
		everyGroupThree := true
		for _, p := range parts[1:] {
			if len(p) != 3 {
				everyGroupThree = false
				break
			}
		}
		if everyGroupThree {
			integerDigits = strings.Join(parts, "")
		} else if len(last) <= 2 {
			integerDigits = strings.Join(parts[:len(parts)-1], "")
		} else {
			return 0, false
		}
	}
	if integerDigits == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(integerDigits, 10, 64)
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

func (s *QrPaymentService) secondsUntil(target time.Time) int {
	d := target.Sub(s.clock())
	if d <= 0 {
		return 0
	}
	// Redondea hacia arriba.
	return int((d + time.Second - time.Nanosecond) / time.Second)
}

func (s *QrPaymentService) toSnapshot(intent *models.QrPaymentIntent) *SnapshotOutput {
	if intent == nil {
		return nil
	}
	return &SnapshotOutput{
		VentaTempID:       intent.VentaTempID,
		Status:            intent.Status,
		StreamStatus:      models.MapIntentStatusToStream(intent.Status),
		AmountCOP:         intent.AmountCOP,
		ExpiresAt:         intent.ExpiresAt,
		ApprovedAt:        intent.ApprovedAt,
		ApprovedReference: intent.ApprovedReference,
		ApprovedSource:    intent.ApprovedSource,
	}
}

func (s *QrPaymentService) publishIntentSnapshot(intent *models.QrPaymentIntent) {
	if s.hub == nil || intent == nil {
		return
	}
	event := sse.QREvent{
		Status:    models.MapIntentStatusToStream(intent.Status),
		Reference: intent.ApprovedReference,
		ExpiresAt: intent.ExpiresAt.UTC().Format(time.RFC3339),
	}
	if intent.ApprovedAt != nil {
		event.ApprovedAt = intent.ApprovedAt.UTC().Format(time.RFC3339)
	}
	// ApprovedVia replica approved_source cuando el estado llegó a
	// APROBADO/CONFIRMADA_MANUAL; para los demás status permanece
	// vacío (omitempty lo quita del frame SSE).
	if intent.ApprovedSource != "" &&
		(intent.Status == models.QRIntentStatusApproved ||
			intent.Status == models.QRIntentStatusConfirmedManual) {
		event.ApprovedVia = intent.ApprovedSource
	}
	// Sólo exponemos saleId/amountCop en el frame APROBADO que
	// publica el dispatcher DESPUÉS del commit de CreateSale.
	// Nunca antes: emitir saleId sin venta cerrada rompería el
	// contrato con el modal (que dispara impresión y bandeja al
	// recibirlo).
	if intent.RelatedSaleID != nil && *intent.RelatedSaleID > 0 &&
		(intent.Status == models.QRIntentStatusApproved ||
			intent.Status == models.QRIntentStatusConfirmedManual) {
		event.SaleID = *intent.RelatedSaleID
		event.AmountCOP = intent.AmountCOP
	}
	s.hub.Publish(intent.VentaTempID, event)
}

func (s *QrPaymentService) publishWebhookOutcome(outcome *repositories.IngestWebhookOutcome) {
	if s.hub == nil || outcome == nil {
		return
	}
	// Caso APROBADO: una sola intención matcheada → NO publicamos
	// aún al stream/modal ni al tray. El contrato de la 027 es:
	// APPROVED se emite SÓLO después de que SaleService.CreateSale
	// haya commiteado y MarkFinalizationSucceeded haya vinculado
	// related_sale_id (ver pos_qr_async_dispatcher.go). Si
	// publicáramos acá, un cliente podría cerrar la venta en caja
	// antes de que exista en `sales` — exactamente el bug que la
	// 027 vino a cerrar.
	if outcome.MatchedIntent != nil {
		s.triggerAutoSale(outcome.MatchedIntent)
		return
	}
	// Caso AMBIGUOUS: hint a cada venta pendiente candidata. CRÍTICO:
	// jamás se dispara DispatchAutoSale aquí (cero facturación
	// automática ante monto ambiguo).
	if outcome.Event != nil && outcome.Event.ProcessedStatus == models.QRWebhookStatusAmbiguous {
		reason := fmt.Sprintf("Múltiples cobros al mismo monto (%d candidatos). Confirme manualmente.", len(outcome.Pending))
		for i := range outcome.Pending {
			s.hub.Publish(outcome.Pending[i].VentaTempID, sse.QREvent{
				Status: models.QRStreamStatusAmbiguous,
				Reason: reason,
			})
			s.publishTrayFromIntent(&outcome.Pending[i], models.QRTrayKindAmbiguous, reason)
		}
		return
	}
	// Caso UNMATCHED/INVALID: no hay venta_temp_id a quién avisar.
}

// publishTrayFromIntent construye un QRTrayEvent desde una intención y
// lo publica al canal de la caja. Nunca bloquea.
func (s *QrPaymentService) publishTrayFromIntent(intent *models.QrPaymentIntent, kind, reason string) {
	if s.hub == nil || intent == nil {
		return
	}
	if !models.IsValidQRTrayKind(kind) {
		return
	}
	evt := sse.QRTrayEvent{
		Kind:        kind,
		VentaTempID: intent.VentaTempID,
		IntentID:    intent.ID,
		CajaID:      intent.CajaID,
		AmountCOP:   intent.AmountCOP,
		Reference:   intent.ApprovedReference,
		ApprovedVia: intent.ApprovedSource,
		Reason:      reason,
		CashierName: intent.CashierName,
		OccurredAt:  s.clock().UTC().Format(time.RFC3339),
	}
	if intent.ApprovedAt != nil {
		evt.ApprovedAt = intent.ApprovedAt.UTC().Format(time.RFC3339)
	}
	if intent.RelatedSaleID != nil {
		evt.SaleID = *intent.RelatedSaleID
	}
	s.hub.PublishToCaja(intent.CajaID, evt)
}

// triggerAutoSale lanza DispatchAutoSale en background con recover.
// Se separa en método para que los tests puedan mockear el camino.
func (s *QrPaymentService) triggerAutoSale(intent *models.QrPaymentIntent) {
	if s == nil || s.saleService == nil || intent == nil {
		return
	}
	// Copia defensiva del intent (evitamos data races con el repo).
	i := *intent
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[qr-pagos] DispatchAutoSale panic recuperado intent=%d: %v", i.ID, r)
			}
		}()
		dispatchCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		s.DispatchAutoSale(dispatchCtx, &i)
	}()
}

// sanitize quita caracteres de control y limita el ancho para
// evitar inyección en logs/BD. Mantiene ASCII imprimible y acentos.
func sanitize(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\t", " ")
	s = strings.TrimSpace(s)
	// Elimina controles bajos sin tocar Unicode válido.
	var b strings.Builder
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func truncate(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	return s[:max]
}

// derefTime devuelve el valor del puntero o el cero cuando es nil.
// (Mantener `wipeString` en este archivo generaría una redeclaración
// con la que vive en cash_drawer_otp_service.go — ambos usan la misma
// semántica, así que reusamos la del paquete.)
func derefTime(t *time.Time) time.Time {
	if t == nil {
		return time.Time{}
	}
	return *t
}

// =========================================================================
// SameAmountPending — contador para /iniciar y /encolar
// =========================================================================

// CountSameAmountPending expone el conteo de intenciones PENDIENTE
// vivas con el MISMO monto, excluyendo la propia (si `excludeIntentID
// > 0`). Soporta la respuesta `sameAmountPending:int` que /iniciar y
// /encolar añaden al frontend para avisar al cajero: si hay otro QR
// vivo del mismo monto, el matcher caerá en AMBIGUOUS cuando llegue
// la notificación.
//
// Nunca retorna error con status 500: para una lectura liviana
// preferimos degradar a 0 que romper el UX del cajero. El llamador
// decide qué hacer con el error que devolvemos (hoy el handler lo
// trata como "no sé, 0").
func (s *QrPaymentService) CountSameAmountPending(ctx context.Context, amountCOP int64, excludeIntentID uint64) (int, error) {
	if !models.IsValidQRAmountCOP(amountCOP) {
		return 0, ErrQRInvalidInput
	}
	count, err := s.repo.CountPendingLiveByAmount(ctx, amountCOP, excludeIntentID, s.clock())
	if err != nil {
		if errors.Is(err, repositories.ErrQRInvalidInput) {
			return 0, ErrQRInvalidInput
		}
		log.Printf("[qr-pagos] CountPendingLiveByAmount falló (monto=%d): %v", amountCOP, err)
		return 0, fmt.Errorf("qr: contar pendientes falló")
	}
	return count, nil
}

// =========================================================================
// Listado de eventos sin asignar (/pagos-sin-asignar)
// =========================================================================

// UnassignedEvent es el shape expuesto al handler. El `Status` queda
// como string del enum (AMBIGUOUS | UNMATCHED) para no acoplar al
// cliente a los literales de la BD; el `Resumen` viene del campo
// `note` que persistió el ingest (saneado y sin token).
type UnassignedEvent struct {
	EventID    uint64
	AmountCOP  int64
	ReceivedAt time.Time
	Status     string
	Resumen    string
	Source     string
}

// ListUnassignedWebhookEvents responde al endpoint /pagos-sin-asignar.
// `minutos` debe estar en [QRUnassignedMinutosMin, QRUnassignedMinutosMax];
// el service lo valida acá para que el handler no replique la lógica.
func (s *QrPaymentService) ListUnassignedWebhookEvents(ctx context.Context, minutos int) ([]UnassignedEvent, error) {
	if minutos < models.QRUnassignedMinutosMin || minutos > models.QRUnassignedMinutosMax {
		return nil, ErrQRInvalidInput
	}
	since := s.clock().Add(-time.Duration(minutos) * time.Minute)
	rows, err := s.repo.ListUnassignedEvents(ctx, since, 50)
	if err != nil {
		if errors.Is(err, repositories.ErrQRInvalidInput) {
			return nil, ErrQRInvalidInput
		}
		log.Printf("[qr-pagos] ListUnassignedEvents falló: %v", err)
		return nil, fmt.Errorf("qr: listar sin asignar falló")
	}
	out := make([]UnassignedEvent, 0, len(rows))
	for _, r := range rows {
		out = append(out, UnassignedEvent{
			EventID:    r.ID,
			AmountCOP:  r.AmountCOP,
			ReceivedAt: r.ReceivedAt,
			Status:     r.ProcessedStatus,
			Resumen:    r.Note,
			Source:     r.Source,
		})
	}
	return out, nil
}

// =========================================================================
// Asignación manual evento → intención (/asignar)
// =========================================================================

// =========================================================================
// QR en edición (A2): validación temprana de editSaleId
// =========================================================================

// ErrQREditUnavailable: el materializador no está cableado (tests o
// arranque parcial); no se puede garantizar que la edición se aplique.
var ErrQREditUnavailable = errors.New("la edición de ventas por QR no está disponible en este servidor")

// ValidateQREditTarget comprueba, al crear la intención, que la venta
// `editSaleID` exista, no esté anulada y que `actorDNI` (DNI del JWT, que
// queda como created_by_dni) pueda editarla. El dispatcher revalida al
// aprobarse. Devuelve errores en español listos para un 400.
func (s *QrPaymentService) ValidateQREditTarget(editSaleID uint64, actorDNI string) error {
	if editSaleID == 0 {
		return nil
	}
	if s == nil || s.saleService == nil {
		return ErrQREditUnavailable
	}
	_, err := s.saleService.CheckQREditTarget(uint(editSaleID), actorDNI)
	return err
}

// AssignEventInput parametriza /asignar.
type AssignEventInput struct {
	VentaTempID string
	EventID     uint64
	ActorDNI    string
	ActorName   string
	// ActorIsAdmin extiende la ventana de asignación. Un cajero
	// regular sólo puede asignar eventos recibidos en los últimos
	// `QRAssignmentWindow` minutos (60 min por default). Un
	// admin/administrador/superadmin accede a `QRAssignmentWindowAdmin`
	// (24 h) para enlazar un pago huérfano del día — por ejemplo,
	// cuando el dueño está corrigiendo una venta anterior y necesita
	// asignarle un cobro que entró horas antes. El handler obtiene
	// este flag con `actorIsAdmin(c)` (lee el rol del JWT, nunca del
	// body).
	ActorIsAdmin bool
	IP           string
	Device       string
}

// assignmentWindowFor devuelve la ventana de asignación aplicable al
// actor. `QRAssignmentWindow` (60 min) para cajeros regulares y
// `QRAssignmentWindowAdmin` (24 h) para admins. Centraliza la regla
// para que el repo siga agnóstico del rol: la decisión se toma en el
// servicio y viaja al repo como `MaxAge`.
func assignmentWindowFor(actorIsAdmin bool) time.Duration {
	if actorIsAdmin {
		return models.QRAssignmentWindowAdmin
	}
	return models.QRAssignmentWindow
}

// AssignEventOutput es lo que el handler devuelve al modal/bandeja
// tras la asignación.
type AssignEventOutput struct {
	IntentID          uint64
	VentaTempID       string
	EventID           uint64
	AmountCOP         int64
	Status            string
	StreamStatus      string
	ApprovedAt        time.Time
	ApprovedReference string
	ApprovedVia       string
}

// AssignEventToIntent empareja manualmente un evento AMBIGUOUS/UNMATCHED
// con una intención PENDIENTE del mismo monto. Flujo:
//
//  1. Delegar al repo, que ejecuta la tx completa con advisory lock,
//     SELECT ... FOR UPDATE del evento y de la intención, chequeo de
//     monto y UPDATEs atómicos.
//  2. Post-commit: audit log, publicación SSE (snapshot APROBADO al
//     stream del venta_temp_id + QRTrayEvent al canal de la caja) y
//     disparo del materializador asíncrono (idempotente, usa
//     ClientTxId reservado al emitir la intención — así, dos entregas
//     del dispatcher producen una sola venta).
//
// El DNI del actor siempre viene del contexto del handler, NUNCA del
// body (contrato explícito del dueño).
func (s *QrPaymentService) AssignEventToIntent(ctx context.Context, in AssignEventInput) (*AssignEventOutput, error) {
	if !models.IsValidQRVentaTempID(in.VentaTempID) {
		return nil, ErrQRInvalidInput
	}
	if strings.TrimSpace(in.ActorDNI) == "" {
		return nil, ErrQRInvalidInput
	}
	if in.EventID == 0 {
		return nil, ErrQRInvalidInput
	}

	outcome, err := s.repo.AssignEventToIntent(ctx, repositories.AssignEventOptions{
		VentaTempID: in.VentaTempID,
		EventID:     in.EventID,
		ActorDNI:    in.ActorDNI,
		MaxAge:      assignmentWindowFor(in.ActorIsAdmin),
		Now:         s.clock,
	})
	if err != nil {
		// Paid error se propaga tal cual: el handler extrae el
		// SaleID con errors.As(err, &paidErr) para responder 409
		// QR_INTENT_ALREADY_PAID con `saleId`.
		var paidErr *IntentAlreadyPaidError
		if errors.As(err, &paidErr) {
			return nil, paidErr
		}
		switch {
		case errors.Is(err, repositories.ErrQRInvalidInput):
			return nil, ErrQRInvalidInput
		case errors.Is(err, repositories.ErrQREventNotFound):
			return nil, ErrQREventNotFound
		case errors.Is(err, repositories.ErrQREventAlreadyAssigned):
			return nil, ErrQREventAlreadyAssigned
		case errors.Is(err, repositories.ErrQRIntentNotFound):
			return nil, ErrQRIntentNotFound
		case errors.Is(err, repositories.ErrQRIntentExpired):
			return nil, ErrQRIntentExpired
		case errors.Is(err, repositories.ErrQRIntentNotPending):
			return nil, ErrQRIntentNotPending
		case errors.Is(err, repositories.ErrQRAmountMismatch):
			return nil, ErrQRAmountMismatch
		}
		log.Printf("[qr-pagos] AssignEventToIntent falló (venta=%s event=%d): %v", in.VentaTempID, in.EventID, err)
		return nil, fmt.Errorf("qr: asignar falló")
	}

	intent := outcome.Intent
	event := outcome.Event

	// Auditoría crítica con DNI del contexto. Mismo patrón que
	// ConfirmManual: el DNI jamás llega del body.
	if s.audit != nil {
		windowSecs := int(assignmentWindowFor(in.ActorIsAdmin) / time.Second)
		details := fmt.Sprintf("venta=%s intentId=%d eventId=%d monto=%d actorIsAdmin=%t windowSecs=%d",
			intent.VentaTempID, intent.ID, event.ID, intent.AmountCOP, in.ActorIsAdmin, windowSecs)
		human := fmt.Sprintf("Asignación manual de evento %d a cobro QR de $%d (venta temp %s).",
			event.ID, intent.AmountCOP, intent.VentaTempID)
		changes, _ := json.Marshal(map[string]interface{}{
			"before": map[string]string{
				"intentStatus": models.QRIntentStatusPending,
				"eventStatus":  "AMBIGUOUS|UNMATCHED",
			},
			"after": map[string]interface{}{
				"intentStatus":      models.QRIntentStatusApproved,
				"eventStatus":       models.QRWebhookStatusApproved,
				"approvedReference": intent.ApprovedReference,
				"approvedSource":    intent.ApprovedSource,
				"eventSource":       event.Source,
				"assignedByDni":     in.ActorDNI,
			},
			"deltas": map[string]interface{}{
				"intentId":     intent.ID,
				"eventId":      event.ID,
				"amountCop":    intent.AmountCOP,
				"actorIsAdmin": in.ActorIsAdmin,
				"windowSecs":   windowSecs,
			},
		})
		s.audit.Log(in.ActorDNI, in.ActorName, "ASSIGN_EVENT", "POS_QR",
			details, human, string(changes), in.IP, in.Device, true)
	}

	// SSE post-commit: snapshot APROBADO al stream del venta_temp_id
	// y evento QRTrayKindApproved al canal de la caja.
	s.publishIntentSnapshot(intent)
	s.publishTrayFromIntent(intent, models.QRTrayKindApproved, "")

	// Disparar materializador asíncrono (idempotente). Si la intención
	// no tiene snapshot (flujo legacy sincrónico), el dispatcher sale
	// silenciosamente — el cajero resolverá la venta canónica con el
	// flujo original de /sales/register.
	s.triggerAutoSale(intent)

	approvedAt := time.Time{}
	if intent.ApprovedAt != nil {
		approvedAt = *intent.ApprovedAt
	}
	return &AssignEventOutput{
		IntentID:          intent.ID,
		VentaTempID:       intent.VentaTempID,
		EventID:           event.ID,
		AmountCOP:         intent.AmountCOP,
		Status:            intent.Status,
		StreamStatus:      models.MapIntentStatusToStream(intent.Status),
		ApprovedAt:        approvedAt,
		ApprovedReference: intent.ApprovedReference,
		ApprovedVia:       intent.ApprovedSource,
	}, nil
}
