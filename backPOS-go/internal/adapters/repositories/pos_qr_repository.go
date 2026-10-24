// Repositorio del flujo QR Bold/Bre-B (migración 026).
//
// Responsabilidades:
//
//   - Emitir una intención PENDIENTE: cancela cualquier PENDIENTE vivo
//     del mismo venta_temp_id, barre expirados del mismo cajero y
//     persiste la nueva fila; todo en UNA transacción.
//
//   - Resolver un webhook (BOLD_OFFICIAL o BRIDGE_NOTIFICATION) con
//     match "cero/uno/múltiple" dentro de UNA transacción:
//     1. `pg_advisory_xact_lock('qr_match:' || amount_cop)` para
//     serializar aprobaciones concurrentes del mismo monto.
//     2. Dedupe por external_id (si hay bold_code) y por fingerprint.
//     Si colisiona, se registra DUPLICATE y la tx se cierra limpia.
//     3. SELECT ... FOR UPDATE sobre todas las PENDIENTES vivas al
//     mismo amount_cop. Si count=0 → UNMATCHED. Si count>1 →
//     AMBIGUOUS. Si count=1 → APPROVED: transiciona el intent y
//     persiste el evento con matched_intent_id.
//     4. INSERT del evento con processed_status y matched_intent_id
//     coherente con la biyección del CHECK ck_pqwe_matched_only_if_approved.
//
//   - Confirmar manualmente una intención: SELECT ... FOR UPDATE sobre
//     el intent, verifica vigencia, transita a CONFIRMADA_MANUAL con
//     manual_confirmed_by_dni poblado.
//
//   - Cancelar una intención PENDIENTE: SELECT ... FOR UPDATE, verifica
//     vigencia, transita a CANCELADA con cancelled_* poblado.
//
//   - Barrido de expiración: UPDATE acotado por expires_at <= now sobre
//     PENDIENTES. Idempotente.
//
//   - ListPendingLive: SELECT de PENDIENTES vigentes al arranque, para
//     que el servicio repopule su caché en memoria.
//
// Decisiones clave:
//
//   - Un error desde el callback de `Transaction` provoca ROLLBACK. Lo
//     usamos SOLO en caminos "sin cambios durables" (NotFound,
//     WrongActor, ...). Los caminos UNMATCHED/AMBIGUOUS SÍ deben
//     persistir el evento: por eso devolvemos el "error de negocio"
//     tras el COMMIT, en una variable local.
//
//   - Nada en este archivo loguea el token BOLD_BRIDGE_TOKEN, la
//     firma HMAC ni el payload crudo. Un guardián estático (en el test
//     del paquete) verifica que no haya log.Printf/fmt.Println.
package repositories

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// =========================================================================
// Repositorio
// =========================================================================

// QrPaymentRepository encapsula la persistencia del flujo QR.
type QrPaymentRepository struct {
	db *gorm.DB
}

// NewQrPaymentRepository construye el repositorio.
func NewQrPaymentRepository(db *gorm.DB) *QrPaymentRepository {
	return &QrPaymentRepository{db: db}
}

// =========================================================================
// Errores sentinela del dominio
// =========================================================================

var (
	// ErrQRIntentNotFound: no existe una intención viva para el
	// venta_temp_id consultado, o la intención fue purgada.
	ErrQRIntentNotFound = errors.New("qr intent: no encontrada")

	// ErrQRIntentNotPending: la intención existe pero su status NO es
	// PENDIENTE (ya fue APROBADA/CONFIRMADA_MANUAL/EXPIRADA/CANCELADA).
	ErrQRIntentNotPending = errors.New("qr intent: no está en PENDIENTE")

	// ErrQRIntentExpired: la fila está en PENDIENTE pero expires_at ya
	// pasó. El repo normaliza a EXPIRADA en el mismo COMMIT antes de
	// retornar este error.
	ErrQRIntentExpired = errors.New("qr intent: expirada")

	// ErrQRInvalidInput: alguna validación básica no pasó (DNI vacío,
	// amount fuera de rango, etc.). El servicio ya debe filtrar la
	// mayoría; este error es defensa en profundidad.
	ErrQRInvalidInput = errors.New("qr intent: input inválido")

	// ErrQRWebhookDuplicate: el evento llegó con (source, external_id)
	// o (source, fingerprint) duplicado. El handler responde 200 OK
	// idempotente.
	ErrQRWebhookDuplicate = errors.New("qr webhook: evento duplicado")

	// ErrQRFinalizationAlreadyClaimed: otro worker ya reclamó la fila
	// (finalization_status pasó de NOT_STARTED/FAILED a IN_PROGRESS).
	// El llamador debe salir silenciosamente.
	ErrQRFinalizationAlreadyClaimed = errors.New("qr finalization: ya reclamada")

	// ErrQRFinalizationNotEligible: la intención no está en un estado
	// apto para arrancar la materialización (p.ej. status != APROBADA,
	// snapshot NULL). El llamador debe salir sin reintentar.
	ErrQRFinalizationNotEligible = errors.New("qr finalization: no apta")

	// ErrQREventNotFound: el evento referenciado en /asignar no existe.
	ErrQREventNotFound = errors.New("qr event: no encontrado")

	// ErrQREventAlreadyAssigned: el evento ya tiene matched_intent_id,
	// está en estado terminal distinto de AMBIGUOUS/UNMATCHED, o quedó
	// fuera de la ventana QRAssignmentWindow (60 min por default).
	// El handler lo traduce a 409.
	ErrQREventAlreadyAssigned = errors.New("qr event: ya asignado o fuera de ventana")

	// ErrQRAmountMismatch: en /asignar, el monto del evento no empata
	// con el monto de la intención. El handler lo traduce a 409.
	ErrQRAmountMismatch = errors.New("qr event: monto no coincide con la intención")

	// ErrQRIntentAlreadyPaid: existe una intención APROBADA o
	// CONFIRMADA_MANUAL para el venta_temp_id. Nunca se abre un nuevo
	// cobro, ni se adjuntan snapshots, ni se marca queued_at para una
	// venta que ya quedó pagada. Igualmente bloquea /asignar: no se
	// re-aprueba un cobro ya cerrado. El error carga el SaleID
	// (related_sale_id) para que el handler pueda devolverlo al
	// frontend y éste redirija al ticket real. Es un error de negocio,
	// no de infraestructura: nunca viaja a 500.
	ErrQRIntentAlreadyPaid = errors.New("qr intent: venta ya pagada")
)

// IntentAlreadyPaidError envuelve ErrQRIntentAlreadyPaid con el SaleID
// y el monto exacto de la intención aprobada. Permite al handler
// responder al frontend con `saleId` para que redirija al ticket y
// cierre el modal/bandeja. `errors.Is(err, ErrQRIntentAlreadyPaid)`
// sigue funcionando porque implementa `Is`.
type IntentAlreadyPaidError struct {
	IntentID  uint64
	SaleID    uint64
	AmountCOP int64
	// Status es "APROBADA" o "CONFIRMADA_MANUAL", el valor real de la
	// fila paid. El servicio lo expone al frontend para que un cliente
	// de auditoría distinga ambas vías sin inferirlo.
	Status string
}

// Error implementa la interfaz error con un mensaje estable y sin
// filtrar secretos (no incluye tokens, HMAC ni snapshots).
func (e *IntentAlreadyPaidError) Error() string {
	if e == nil {
		return ErrQRIntentAlreadyPaid.Error()
	}
	return fmt.Sprintf("qr intent: venta ya pagada (intentId=%d saleId=%d)", e.IntentID, e.SaleID)
}

// Is permite que `errors.Is(err, ErrQRIntentAlreadyPaid)` acepte un
// *IntentAlreadyPaidError. El servicio puede matchear por sentinel y
// el handler puede extraer el SaleID con errors.As.
func (e *IntentAlreadyPaidError) Is(target error) bool {
	return target == ErrQRIntentAlreadyPaid
}

// =========================================================================
// Opciones y resultados
// =========================================================================

// InitiateIntentOptions parametriza la emisión.
type InitiateIntentOptions struct {
	VentaTempID  string
	CajaID       string
	CreatedByDNI string
	AmountCOP    int64
	TTL          time.Duration // 0 → models.QRPaymentIntentDefaultTTL
	Now          func() time.Time

	// Agregados por el flujo asíncrono (migración 027). Todos son
	// opcionales: si todos vienen vacíos la fila queda compatible con
	// el flujo sincrónico legacy.
	//
	// NO existen columnas `cashier_name` ni `client_dni` en la 027:
	// el nombre del cajero viaja sólo por SSE (tray event) y los
	// datos del cliente viven dentro de `client_snapshot` (JSONB).
	SaleClientTxID string
	CartSnapshot   []byte // JSON ya serializado
	ClientSnapshot []byte
	TotalsSnapshot []byte
	// MarkQueued=true setea queued_at=now como parte del mismo INSERT
	// y, cuando reusa una PENDIENTE con el mismo monto, dispara el
	// adjunto atómico de snapshots+clientTxId+queued_at si estaban
	// vacíos. /encolar la usa; /iniciar la deja en false.
	MarkQueued bool
}

// InitiateIntentOutcome informa el resultado de /iniciar:
//
//   - Reused=true si ya había un PENDIENTE vigente para ese
//     venta_temp_id con el mismo monto; se retorna la fila existente
//     (idempotente).
//   - Reused=false si se creó una fila nueva (cancela cualquier
//     PENDIENTE previo del mismo venta_temp_id con otro monto).
//   - AlreadyPaid=true si existe una intención APROBADA /
//     CONFIRMADA_MANUAL para el venta_temp_id. En ese caso NO se crea
//     fila nueva, NO se adjuntan snapshots y NO se marca queued_at:
//     la intención paid se devuelve tal cual (Reused también queda en
//     true por consistencia con el contrato del handler). CANCELADA y
//     EXPIRADA NO disparan AlreadyPaid — un cobro fallido/expirado SÍ
//     admite reintento.
type InitiateIntentOutcome struct {
	Intent      *models.QrPaymentIntent
	Reused      bool
	AlreadyPaid bool
}

// =========================================================================
// Lookup
// =========================================================================

// GetLiveByVentaTempID devuelve la intención viva (status=PENDIENTE y
// no expirada) por venta_temp_id. ErrQRIntentNotFound si no hay nada.
// Lookup read-only, sin lock. Útil para /estado y para el snapshot
// inicial del SSE.
func (r *QrPaymentRepository) GetLiveByVentaTempID(ctx context.Context, ventaTempID string) (*models.QrPaymentIntent, error) {
	id := strings.TrimSpace(ventaTempID)
	if id == "" {
		return nil, ErrQRIntentNotFound
	}
	var row models.QrPaymentIntent
	err := r.db.WithContext(ctx).
		Where("venta_temp_id = ? AND status = ?", id, models.QRIntentStatusPending).
		Order("id DESC").
		First(&row).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrQRIntentNotFound
		}
		return nil, err
	}
	return &row, nil
}

// GetLatestByVentaTempID devuelve la última intención por venta_temp_id
// SIN filtrar por estado. Útil para /estado cuando la UI pierde el SSE
// y necesita saber si la intención terminó.
func (r *QrPaymentRepository) GetLatestByVentaTempID(ctx context.Context, ventaTempID string) (*models.QrPaymentIntent, error) {
	id := strings.TrimSpace(ventaTempID)
	if id == "" {
		return nil, ErrQRIntentNotFound
	}
	var row models.QrPaymentIntent
	err := r.db.WithContext(ctx).
		Where("venta_temp_id = ?", id).
		Order("id DESC").
		First(&row).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrQRIntentNotFound
		}
		return nil, err
	}
	return &row, nil
}

// ListPendingLive devuelve todas las intenciones PENDIENTES cuyo
// expires_at > now. El servicio llama a este método al arrancar para
// repopular el cache en memoria y lanzar los timers de expiración.
func (r *QrPaymentRepository) ListPendingLive(ctx context.Context, now time.Time) ([]models.QrPaymentIntent, error) {
	var rows []models.QrPaymentIntent
	err := r.db.WithContext(ctx).
		Where("status = ? AND expires_at > ?", models.QRIntentStatusPending, now).
		Order("expires_at ASC").
		Find(&rows).Error
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// =========================================================================
// Emisión
// =========================================================================

// Initiate persiste una nueva intención PENDIENTE para la venta
// temporal. Flujo transaccional:
//
//  1. Lock de serialización por venta_temp_id (advisory_xact_lock
//     sobre hashtext('qr_iniciar:' || venta_temp_id)): evita que dos
//     pestañas que hagan POST /iniciar al mismo tiempo creen dos
//     filas con el mismo venta_temp_id.
//
//  2. Barrer stale: UPDATE a EXPIRADA sobre PENDIENTES cuyo
//     expires_at ya pasó (acotado al venta_temp_id).
//
//  3. ¿Hay un PENDIENTE viviente con el MISMO amount_cop? Entonces
//     devolver la fila existente (Reused=true). El dueño pide que
//     recrear el modal con el mismo monto no genere intenciones
//     duplicadas.
//
//  4. ¿Hay un PENDIENTE viviente con otro amount_cop? Cancelar la
//     anterior (CANCELADA, cancel_reason='reiniciada por nueva
//     intención') y seguir al INSERT.
//
//  5. INSERT con status=PENDIENTE y expires_at = now + TTL.
//
// La BD y el servicio comparten la verdad: el UNIQUE parcial
// ux_pqpi_live_by_venta_temp impide que haya >1 PENDIENTE vivo para
// un venta_temp_id. Si una carrera gana al advisory lock por el
// motivo que sea, el INSERT falla por UNIQUE y el error se traduce.
func (r *QrPaymentRepository) Initiate(ctx context.Context, opts InitiateIntentOptions) (*InitiateIntentOutcome, error) {
	ventaTemp := strings.TrimSpace(opts.VentaTempID)
	caja := strings.TrimSpace(opts.CajaID)
	dni := strings.TrimSpace(opts.CreatedByDNI)
	if ventaTemp == "" || caja == "" || dni == "" {
		return nil, ErrQRInvalidInput
	}
	if !models.IsValidQRAmountCOP(opts.AmountCOP) {
		return nil, ErrQRInvalidInput
	}
	ttl := opts.TTL
	if ttl <= 0 {
		ttl = models.QRPaymentIntentDefaultTTL
	}
	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}

	var outcome InitiateIntentOutcome
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1) Advisory lock por venta_temp_id.
		if err := tx.Exec("SELECT pg_advisory_xact_lock(hashtext(?))",
			"qr_iniciar:"+ventaTemp).Error; err != nil {
			return fmt.Errorf("advisory lock iniciar: %w", err)
		}
		currentNow := now()

		// 2) Short-circuit: ¿ya existe una intención APROBADA o
		// CONFIRMADA_MANUAL para este venta_temp_id?
		//
		// Si sí, NO creamos nueva, NO cancelamos la PENDIENTE previa
		// (si hubiera), NO adjuntamos snapshots ni queued_at: la
		// venta ya está pagada. Devolvemos la fila paid con
		// AlreadyPaid=true para que /iniciar responda alreadyPaid:true
		// y el handler cierre el modal; /encolar y /asignar lo
		// traducirán a 409 QR_INTENT_ALREADY_PAID.
		//
		// Decisión: SIN FOR UPDATE. APROBADA/CONFIRMADA_MANUAL son
		// terminales: la BD nunca los revierte, así que un lock
		// adicional sólo serializaría contra lectores sin ganar
		// consistencia. El advisory lock por venta_temp_id ya protege
		// contra dos /iniciar simultáneos para la misma V. El webhook
		// que aprueba una PENDIENTE usa un lock distinto
		// (qr_match:<amount>): si ese webhook commitea entre nuestro
		// paid-check y el INSERT, se cuela como PENDIENTE→APROBADA en
		// el SELECT FOR UPDATE del paso 3 (que no encuentra fila con
		// status=PENDIENTE) y caemos al INSERT. Esa carrera queda
		// cubierta por el paid-check #2 que insertamos justo antes
		// del INSERT.
		{
			var paid models.QrPaymentIntent
			perr := tx.Where("venta_temp_id = ? AND status IN ?",
				ventaTemp,
				[]string{
					models.QRIntentStatusApproved,
					models.QRIntentStatusConfirmedManual,
				}).
				Order("id DESC").
				First(&paid).Error
			if perr == nil {
				outcome = InitiateIntentOutcome{
					Intent:      &paid,
					Reused:      true,
					AlreadyPaid: true,
				}
				return nil
			}
			if !errors.Is(perr, gorm.ErrRecordNotFound) {
				return fmt.Errorf("verificar paid: %w", perr)
			}
		}

		// 3) Barrer stale del mismo venta_temp_id.
		if err := tx.Model(&models.QrPaymentIntent{}).
			Where("venta_temp_id = ? AND status = ? AND expires_at <= ?",
				ventaTemp, models.QRIntentStatusPending, currentNow).
			Update("status", models.QRIntentStatusExpired).Error; err != nil {
			return fmt.Errorf("barrido stale: %w", err)
		}

		// 3) ¿Existe un PENDIENTE vigente con el mismo monto?
		var existing models.QrPaymentIntent
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("venta_temp_id = ? AND status = ? AND expires_at > ?",
				ventaTemp, models.QRIntentStatusPending, currentNow).
			Order("id DESC").
			First(&existing).Error
		if err == nil {
			if existing.AmountCOP == opts.AmountCOP {
				// Reuse: la intención ya existe. Si el llamador trae
				// datos del flujo asíncrono (snapshots + clientTxId) y
				// la fila existente aún no los tiene, los adjuntamos
				// ATÓMICAMENTE dentro de la misma transacción. Esto
				// permite que /iniciar (sin snapshots) + /encolar
				// (con snapshots) reutilicen la MISMA intención —
				// cumple la invariante "una venta temp ↔ una
				// intención" sin crear filas duplicadas.
				attachments := map[string]interface{}{}
				if strings.TrimSpace(opts.SaleClientTxID) != "" &&
					strings.TrimSpace(existing.SaleClientTxID) == "" {
					attachments["sale_client_tx_id"] = strings.TrimSpace(opts.SaleClientTxID)
				}
				if len(opts.CartSnapshot) > 0 && strings.TrimSpace(existing.CartSnapshot) == "" {
					attachments["cart_snapshot"] = string(opts.CartSnapshot)
				}
				if len(opts.ClientSnapshot) > 0 && strings.TrimSpace(existing.ClientSnapshot) == "" {
					attachments["client_snapshot"] = string(opts.ClientSnapshot)
				}
				if len(opts.TotalsSnapshot) > 0 && strings.TrimSpace(existing.TotalsSnapshot) == "" {
					attachments["totals_snapshot"] = string(opts.TotalsSnapshot)
				}
				if opts.MarkQueued && existing.QueuedAt == nil {
					attachments["queued_at"] = currentNow
				}
				if len(attachments) > 0 {
					res := tx.Model(&models.QrPaymentIntent{}).
						Where("id = ? AND status = ?",
							existing.ID, models.QRIntentStatusPending).
						Updates(attachments)
					if res.Error != nil {
						return fmt.Errorf("adjuntar snapshot a reuse: %w", res.Error)
					}
					// Reflejar en la fila que devolvemos (idempotente
					// a nivel memoria también).
					if v, ok := attachments["sale_client_tx_id"].(string); ok {
						existing.SaleClientTxID = v
					}
					if v, ok := attachments["cart_snapshot"].(string); ok {
						existing.CartSnapshot = v
					}
					if v, ok := attachments["client_snapshot"].(string); ok {
						existing.ClientSnapshot = v
					}
					if v, ok := attachments["totals_snapshot"].(string); ok {
						existing.TotalsSnapshot = v
					}
					if v, ok := attachments["queued_at"].(time.Time); ok {
						t := v
						existing.QueuedAt = &t
					}
				}
				outcome = InitiateIntentOutcome{Intent: &existing, Reused: true}
				return nil
			}
			// Otro monto: cancelar el anterior.
			cancelReason := "reiniciada_por_nueva_intencion"
			if err := tx.Model(&models.QrPaymentIntent{}).
				Where("id = ? AND status = ?", existing.ID, models.QRIntentStatusPending).
				Updates(map[string]interface{}{
					"status":           models.QRIntentStatusCancelled,
					"cancelled_at":     currentNow,
					"cancelled_by_dni": dni,
					"cancel_reason":    cancelReason,
				}).Error; err != nil {
				return fmt.Errorf("cancelar previo: %w", err)
			}
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return fmt.Errorf("buscar previo: %w", err)
		}

		// 3bis) Paid-check defensivo pre-INSERT.
		//
		// Entre el paid-check #1 (al inicio de la tx) y aquí pudo
		// commitear un webhook que aprobó una PENDIENTE de este
		// venta_temp_id (el webhook corre con lock `qr_match:<amount>`,
		// no `qr_iniciar:V`, por lo que no se serializa contra nosotros
		// vía advisory lock). En read-committed, el SELECT FOR UPDATE
		// de arriba filtra `status=PENDIENTE` y no la ve, por lo que
		// caíamos al INSERT y creábamos una fila fantasma. Repetimos
		// el paid-check justo antes del INSERT para cerrar esa ventana.
		{
			var paid models.QrPaymentIntent
			perr := tx.Where("venta_temp_id = ? AND status IN ?",
				ventaTemp,
				[]string{
					models.QRIntentStatusApproved,
					models.QRIntentStatusConfirmedManual,
				}).
				Order("id DESC").
				First(&paid).Error
			if perr == nil {
				outcome = InitiateIntentOutcome{
					Intent:      &paid,
					Reused:      true,
					AlreadyPaid: true,
				}
				return nil
			}
			if !errors.Is(perr, gorm.ErrRecordNotFound) {
				return fmt.Errorf("verificar paid pre-insert: %w", perr)
			}
		}

		// 4) INSERT nuevo PENDIENTE.
		//
		// IMPORTANTE: NO existen columnas `cashier_name` ni
		// `client_dni` en la migración 027. Sólo seleccionamos los
		// campos que SÍ corresponden a columnas reales; GORM aplica
		// NULL a los demás, lo que satisface ck_pqpi_approval_coherent
		// (todos los campos de aprobación/cancelación NULL en una
		// fila PENDIENTE).
		row := models.QrPaymentIntent{
			VentaTempID:  ventaTemp,
			CajaID:       caja,
			CreatedByDNI: dni,
			AmountCOP:    opts.AmountCOP,
			Status:       models.QRIntentStatusPending,
			CreatedAt:    currentNow,
			ExpiresAt:    currentNow.Add(ttl),
			// Finalization defaults coherentes con la rama NOT_STARTED
			// del CHECK ck_pqpi_finalization_coherent (todos NULL).
			FinalizationStatus: models.QRFinalizationStatusNotStarted,
		}
		selectCols := []string{
			"VentaTempID",
			"CajaID",
			"CreatedByDNI",
			"AmountCOP",
			"Status",
			"CreatedAt",
			"ExpiresAt",
			"FinalizationStatus",
		}
		if v := strings.TrimSpace(opts.SaleClientTxID); v != "" {
			row.SaleClientTxID = v
			selectCols = append(selectCols, "SaleClientTxID")
		}
		if len(opts.CartSnapshot) > 0 {
			row.CartSnapshot = string(opts.CartSnapshot)
			selectCols = append(selectCols, "CartSnapshot")
		}
		if len(opts.ClientSnapshot) > 0 {
			row.ClientSnapshot = string(opts.ClientSnapshot)
			selectCols = append(selectCols, "ClientSnapshot")
		}
		if len(opts.TotalsSnapshot) > 0 {
			row.TotalsSnapshot = string(opts.TotalsSnapshot)
			selectCols = append(selectCols, "TotalsSnapshot")
		}
		if opts.MarkQueued {
			nowCopy := currentNow
			row.QueuedAt = &nowCopy
			selectCols = append(selectCols, "QueuedAt")
		}
		// Seleccionamos exclusivamente las columnas obligatorias. Los campos
		// opcionales del modelo son `string` por compatibilidad de lectura;
		// si GORM los incluye por su valor cero, PostgreSQL recibe '' en vez
		// de NULL y ck_pqpi_approval_coherent rechaza una PENDIENTE.
		if err := tx.Select(selectCols).Create(&row).Error; err != nil {
			if isUniqueViolationErr(err) {
				// Carrera: alguien insertó un PENDIENTE con el
				// mismo venta_temp_id entre nuestro barrido y el
				// INSERT. Devolver la fila existente como "reused".
				var winner models.QrPaymentIntent
				if ferr := tx.Where("venta_temp_id = ? AND status = ?",
					ventaTemp, models.QRIntentStatusPending).
					Order("id DESC").
					First(&winner).Error; ferr == nil {
					outcome = InitiateIntentOutcome{Intent: &winner, Reused: true}
					return nil
				}
			}
			return fmt.Errorf("insert intent: %w", err)
		}
		outcome = InitiateIntentOutcome{Intent: &row, Reused: false}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &outcome, nil
}

// =========================================================================
// Cancelación
// =========================================================================

// Cancel transita una intención PENDIENTE vigente a CANCELADA. Idempotente
// en el sentido de que si ya está CANCELADA, retorna la fila sin error;
// si está en otro terminal (APROBADA/CONFIRMADA_MANUAL/EXPIRADA), devuelve
// ErrQRIntentNotPending — el frontend lo trata como "ya fue".
func (r *QrPaymentRepository) Cancel(ctx context.Context, ventaTempID, actorDNI, reason string, now func() time.Time) (*models.QrPaymentIntent, error) {
	id := strings.TrimSpace(ventaTempID)
	dni := strings.TrimSpace(actorDNI)
	if id == "" || dni == "" {
		return nil, ErrQRInvalidInput
	}
	if now == nil {
		now = time.Now
	}
	trimmedReason := strings.TrimSpace(reason)
	if len(trimmedReason) > 64 {
		trimmedReason = trimmedReason[:64]
	}
	if trimmedReason == "" {
		trimmedReason = "cancelacion_cajero"
	}

	var out models.QrPaymentIntent
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row models.QrPaymentIntent
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("venta_temp_id = ?", id).
			Order("id DESC").
			First(&row).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrQRIntentNotFound
			}
			return err
		}
		switch row.Status {
		case models.QRIntentStatusCancelled:
			out = row
			return nil
		case models.QRIntentStatusApproved,
			models.QRIntentStatusConfirmedManual,
			models.QRIntentStatusExpired:
			return ErrQRIntentNotPending
		case models.QRIntentStatusPending:
			// OK: transiciona
		default:
			return ErrQRIntentNotPending
		}

		currentNow := now()
		updates := map[string]interface{}{
			"status":           models.QRIntentStatusCancelled,
			"cancelled_at":     currentNow,
			"cancelled_by_dni": dni,
			"cancel_reason":    trimmedReason,
		}
		res := tx.Model(&models.QrPaymentIntent{}).
			Where("id = ? AND status = ?", row.ID, models.QRIntentStatusPending).
			Updates(updates)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			// Carrera: alguien transitó entre el SELECT FOR UPDATE
			// y el UPDATE. Aborta la tx.
			return ErrQRIntentNotPending
		}
		row.Status = models.QRIntentStatusCancelled
		row.CancelledAt = &currentNow
		row.CancelledByDNI = dni
		row.CancelReason = trimmedReason
		out = row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// =========================================================================
// Confirmación manual
// =========================================================================

// ConfirmManualInput parametriza la confirmación manual.
type ConfirmManualInput struct {
	VentaTempID string
	ActorDNI    string
	Note        string
	Reference   string
	Now         func() time.Time
}

// ConfirmManual transita una PENDIENTE viva a CONFIRMADA_MANUAL con
// autoría DNI explícita. El servicio garantiza que el actor tiene rol
// adecuado antes de llamar; aquí sólo revisamos el estado.
//
// approved_reference se puebla con la nota corta del cajero (p.ej.
// "Nequi 350..."). Si viene vacío, caemos a un placeholder estable
// "MANUAL_<ventaTemp>" para no violar la biyección de
// ck_pqpi_approval_coherent.
func (r *QrPaymentRepository) ConfirmManual(ctx context.Context, in ConfirmManualInput) (*models.QrPaymentIntent, error) {
	id := strings.TrimSpace(in.VentaTempID)
	dni := strings.TrimSpace(in.ActorDNI)
	if id == "" || dni == "" {
		return nil, ErrQRInvalidInput
	}
	now := in.Now
	if now == nil {
		now = time.Now
	}
	note := strings.TrimSpace(in.Note)
	ref := strings.TrimSpace(in.Reference)
	if ref == "" {
		ref = "MANUAL_" + id
	}
	if len(ref) > 128 {
		ref = ref[:128]
	}

	var out models.QrPaymentIntent
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row models.QrPaymentIntent
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("venta_temp_id = ?", id).
			Order("id DESC").
			First(&row).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrQRIntentNotFound
			}
			return err
		}
		if row.Status != models.QRIntentStatusPending {
			switch row.Status {
			case models.QRIntentStatusExpired:
				return ErrQRIntentExpired
			default:
				return ErrQRIntentNotPending
			}
		}
		currentNow := now()
		if !currentNow.Before(row.ExpiresAt) {
			// Normalizamos a EXPIRADA y devolvemos el error tras el
			// COMMIT para que la transición quede durable.
			if err := tx.Model(&models.QrPaymentIntent{}).
				Where("id = ? AND status = ?", row.ID, models.QRIntentStatusPending).
				Update("status", models.QRIntentStatusExpired).Error; err != nil {
				return err
			}
			return ErrQRIntentExpired
		}

		updates := map[string]interface{}{
			"status":                  models.QRIntentStatusConfirmedManual,
			"approved_at":             currentNow,
			"approved_source":         models.QRApprovalSourceManual,
			"approved_reference":      ref,
			"manual_confirmed_by_dni": dni,
			"manual_confirmed_note":   note,
		}
		res := tx.Model(&models.QrPaymentIntent{}).
			Where("id = ? AND status = ?", row.ID, models.QRIntentStatusPending).
			Updates(updates)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return ErrQRIntentNotPending
		}
		row.Status = models.QRIntentStatusConfirmedManual
		row.ApprovedAt = &currentNow
		row.ApprovedSource = models.QRApprovalSourceManual
		row.ApprovedReference = ref
		row.ManualConfirmedByDNI = dni
		row.ManualConfirmedNote = note
		out = row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// =========================================================================
// Procesamiento de webhook
// =========================================================================

// IngestWebhookInput parametriza el procesamiento de un evento. Lo
// consume tanto el handler oficial Bold como el bridge MacroDroid.
type IngestWebhookInput struct {
	// Source: BOLD_OFFICIAL o BRIDGE_NOTIFICATION.
	Source string
	// EventType: lo que Bold llame al evento (p.ej. SALE_APPROVED).
	// Para BRIDGE_NOTIFICATION queda vacío o con "PUSH_NOTIFICATION".
	EventType string
	// ExternalID: bold_code para BOLD_OFFICIAL. Vacío para bridge.
	ExternalID string
	// Fingerprint: hash determinístico ya calculado por el servicio.
	Fingerprint string
	// AmountCOP: monto exacto en COP, int64.
	AmountCOP int64
	// Note: comentario corto para auditoría. Nunca el token/firma.
	Note string
	// Now: reloj inyectable.
	Now func() time.Time
}

// IngestWebhookOutcome resume lo que el webhook produjo. Permite al
// handler decidir qué código SSE emitir (si corresponde) y qué
// responder al cliente (200 OK siempre que llegamos aquí).
type IngestWebhookOutcome struct {
	// Event es la fila persistida (nunca nil cuando err == nil).
	Event *models.QrWebhookEvent
	// MatchedIntent es la intención aprobada cuando ProcessedStatus=APPROVED.
	MatchedIntent *models.QrPaymentIntent
	// Pending son las intenciones PENDIENTES que coincidían con el
	// monto cuando el estado terminó en AMBIGUOUS. Se pasa al servicio
	// para que emita hints por SSE a cada una (sin aprobar).
	Pending []models.QrPaymentIntent
}

// IngestWebhook procesa un evento recibido:
//
//  1. Valida inputs duros (source, fingerprint, amount).
//  2. advisory_xact_lock por amount_cop para serializar aprobaciones.
//  3. Dedupe doble en una pasada: SELECT por (source, external_id) y
//     por (source, fingerprint). Si hay match, inserta la fila como
//     DUPLICATE (si la UNIQUE lo permite — pueden ser dos registros
//     distintos cuando sólo colisiona uno de los dos) o si colisiona
//     con la UNIQUE del INSERT, se traduce a ErrQRWebhookDuplicate.
//  4. SELECT ... FOR UPDATE sobre PENDIENTES vivas con amount_cop
//     igual. Count 0/1/N decide el ProcessedStatus.
//  5. INSERT del evento con el ProcessedStatus determinado y, si
//     count=1, UPDATE del intent a APROBADA con approved_* y
//     approved_event_id poblado.
//
// Para `count == 1`:
//   - processed_status = APPROVED
//   - matched_intent_id = intent.ID
//   - intent.status = APROBADA
//   - approved_source derivado del Source
//   - approved_reference = ExternalID (bold_code) para oficial, o
//     Fingerprint (los primeros 24 chars) para bridge
//   - approved_event_id = evento.ID
//
// Para `count == 0`:
//   - processed_status = UNMATCHED
//   - matched_intent_id = nil
//
// Para `count > 1`:
//   - processed_status = AMBIGUOUS
//   - matched_intent_id = nil
//   - Pending = las N intenciones candidatas (sin aprobar ninguna).
//
// Siempre devolvemos un Outcome con Event != nil (incluso en
// UNMATCHED/AMBIGUOUS) para que la auditoría quede completa. El error
// sólo se devuelve en caminos "sin cambios" (input inválido, replay
// pure dedupe, error de BD).
func (r *QrPaymentRepository) IngestWebhook(ctx context.Context, in IngestWebhookInput) (*IngestWebhookOutcome, error) {
	source := strings.TrimSpace(in.Source)
	if source != models.QRWebhookSourceOfficial && source != models.QRWebhookSourceBridge {
		return nil, ErrQRInvalidInput
	}
	fingerprint := strings.TrimSpace(in.Fingerprint)
	if len(fingerprint) < 8 || len(fingerprint) > 128 {
		return nil, ErrQRInvalidInput
	}
	externalID := strings.TrimSpace(in.ExternalID)
	if len(externalID) > 128 {
		externalID = externalID[:128]
	}
	eventType := strings.TrimSpace(in.EventType)
	if len(eventType) > 32 {
		eventType = eventType[:32]
	}
	note := strings.TrimSpace(in.Note)
	if len(note) > 255 {
		note = note[:255]
	}
	if !models.IsValidQRAmountCOP(in.AmountCOP) {
		return nil, ErrQRInvalidInput
	}
	now := in.Now
	if now == nil {
		now = time.Now
	}

	outcome := &IngestWebhookOutcome{}
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1) Lock de serialización por monto.
		if err := tx.Exec("SELECT pg_advisory_xact_lock(hashtext(?))",
			fmt.Sprintf("qr_match:%d", in.AmountCOP)).Error; err != nil {
			return fmt.Errorf("advisory lock match: %w", err)
		}

		// 2) Dedupe por external_id (si viene) — SELECT previo para
		// decidir sin disparar la UNIQUE violation.
		if externalID != "" {
			var dup models.QrWebhookEvent
			if err := tx.Where("source = ? AND external_id = ?", source, externalID).
				Order("id ASC").
				First(&dup).Error; err == nil {
				return ErrQRWebhookDuplicate
			} else if !errors.Is(err, gorm.ErrRecordNotFound) {
				return fmt.Errorf("dedupe external_id: %w", err)
			}
		}
		// Dedupe por fingerprint.
		{
			var dup models.QrWebhookEvent
			if err := tx.Where("source = ? AND fingerprint = ?", source, fingerprint).
				Order("id ASC").
				First(&dup).Error; err == nil {
				return ErrQRWebhookDuplicate
			} else if !errors.Is(err, gorm.ErrRecordNotFound) {
				return fmt.Errorf("dedupe fingerprint: %w", err)
			}
		}

		currentNow := now()

		// 3) Buscar PENDIENTES vigentes al mismo monto con lock.
		var candidates []models.QrPaymentIntent
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("amount_cop = ? AND status = ? AND expires_at > ?",
				in.AmountCOP, models.QRIntentStatusPending, currentNow).
			Order("created_at ASC").
			Find(&candidates).Error; err != nil {
			return fmt.Errorf("select candidates: %w", err)
		}

		// 4) Decidir estado del evento.
		var processedStatus string
		var matchedID *uint64
		var matchedIntent *models.QrPaymentIntent
		switch len(candidates) {
		case 0:
			processedStatus = models.QRWebhookStatusUnmatched
		case 1:
			processedStatus = models.QRWebhookStatusApproved
			matchedIntent = &candidates[0]
			idCopy := matchedIntent.ID
			matchedID = &idCopy
		default:
			processedStatus = models.QRWebhookStatusAmbiguous
			outcome.Pending = append([]models.QrPaymentIntent(nil), candidates...)
		}

		// 5) INSERT del evento. matched_intent_id respeta la biyección
		// ck_pqwe_matched_only_if_approved: nil cuando no APPROVED.
		//
		// IMPORTANTE: cuando externalID viene vacío (típico del bridge
		// MacroDroid, que no entrega id canónico), OMITIMOS la columna
		// external_id del INSERT para que PostgreSQL aplique NULL. Un
		// '' viola ck_pqwe_external_id_shape (NULL permitido o 1..128
		// chars), lo que haría ROLLBACK de toda la tx y perdería la
		// conciliación UNMATCHED/AMBIGUOUS. Mismo patrón que Initiate
		// con los campos opcionales.
		row := models.QrWebhookEvent{
			ReceivedAt:      currentNow,
			Source:          source,
			EventType:       eventType,
			Fingerprint:     fingerprint,
			AmountCOP:       in.AmountCOP,
			ProcessedAt:     &currentNow,
			ProcessedStatus: processedStatus,
			MatchedIntentID: matchedID,
			Note:            note,
		}
		eventCols := []string{
			"ReceivedAt",
			"Source",
			"EventType",
			"Fingerprint",
			"AmountCOP",
			"ProcessedAt",
			"ProcessedStatus",
			"MatchedIntentID",
			"Note",
		}
		if externalID != "" {
			row.ExternalID = externalID
			eventCols = append(eventCols, "ExternalID")
		}
		if err := tx.Select(eventCols).Create(&row).Error; err != nil {
			if isUniqueViolationErr(err) {
				// Carrera: otro webhook idéntico ganó el INSERT entre
				// nuestro SELECT y Create. Devolvemos duplicate.
				return ErrQRWebhookDuplicate
			}
			return fmt.Errorf("insert event: %w", err)
		}
		outcome.Event = &row

		// 6) Si APPROVED, transiciona la intención matcheada.
		if matchedIntent != nil {
			approvedSource := models.QRApprovalSourceBridge
			if source == models.QRWebhookSourceOfficial {
				approvedSource = models.QRApprovalSourceBoldOfficial
			}
			approvedRef := externalID
			if approvedRef == "" {
				approvedRef = fingerprint
				if len(approvedRef) > 32 {
					approvedRef = approvedRef[:32]
				}
			}
			if len(approvedRef) > 128 {
				approvedRef = approvedRef[:128]
			}
			eventIDForIntent := row.ID
			updates := map[string]interface{}{
				"status":             models.QRIntentStatusApproved,
				"approved_at":        currentNow,
				"approved_source":    approvedSource,
				"approved_reference": approvedRef,
				"approved_event_id":  eventIDForIntent,
			}
			res := tx.Model(&models.QrPaymentIntent{}).
				Where("id = ? AND status = ?", matchedIntent.ID, models.QRIntentStatusPending).
				Updates(updates)
			if res.Error != nil {
				return fmt.Errorf("update intent approved: %w", res.Error)
			}
			if res.RowsAffected != 1 {
				// Carrera imposible bajo FOR UPDATE pero defendido:
				// aborta la tx. El UNIQUE idempotency vuelve a hacer
				// que el próximo webhook con mismo fingerprint sea
				// DUPLICATE.
				return fmt.Errorf("update intent approved: filas afectadas=%d", res.RowsAffected)
			}
			matchedIntent.Status = models.QRIntentStatusApproved
			matchedIntent.ApprovedAt = &currentNow
			matchedIntent.ApprovedSource = approvedSource
			matchedIntent.ApprovedReference = approvedRef
			matchedIntent.ApprovedEventID = &eventIDForIntent
			outcome.MatchedIntent = matchedIntent
		}

		return nil
	})
	if err != nil {
		return nil, err
	}
	return outcome, nil
}

// =========================================================================
// Barrido de expiración
// =========================================================================

// ExpireStale actualiza todas las PENDIENTES cuyo expires_at ya pasó.
// Retorna cuántas filas se transicionaron (0 si no había nada que
// expirar). Idempotente; el servicio puede llamarlo en un ticker.
func (r *QrPaymentRepository) ExpireStale(ctx context.Context, now time.Time) (int64, error) {
	res := r.db.WithContext(ctx).
		Model(&models.QrPaymentIntent{}).
		Where("status = ? AND expires_at <= ?", models.QRIntentStatusPending, now).
		Update("status", models.QRIntentStatusExpired)
	if res.Error != nil {
		return 0, res.Error
	}
	return res.RowsAffected, nil
}

// GetExpiredByVentaTempIDAfter devuelve las intenciones cuyo venta_temp_id
// coincide y cuyo estado es EXPIRADA (resultado del barrido). El servicio
// las usa para emitir un último frame EXPIRADO por SSE a los suscriptores
// que aún están conectados.
func (r *QrPaymentRepository) GetExpiredByVentaTempIDAfter(ctx context.Context, cutoff time.Time) ([]models.QrPaymentIntent, error) {
	var rows []models.QrPaymentIntent
	if err := r.db.WithContext(ctx).
		Where("status = ? AND expires_at >= ?", models.QRIntentStatusExpired, cutoff).
		Order("expires_at ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// =========================================================================
// Flujo asíncrono — bandeja global y materializador (migración 027)
// =========================================================================

// MarkQueued setea queued_at=now sobre una intención PENDIENTE. Es la
// marca de "cajero pulsó Dejar en espera y seguir atendiendo". No
// cambia status (sigue en PENDIENTE); sólo deja la bandeja global
// consulte esta fila con el índice parcial ix_pqpi_queued_bandeja.
//
// Idempotente: dos llamadas con el mismo venta_temp_id resultan en una
// sola actualización. Si la intención ya terminó, devuelve
// ErrQRIntentNotPending y el servicio lo trata como "ya fue".
func (r *QrPaymentRepository) MarkQueued(ctx context.Context, ventaTempID string, now func() time.Time) (*models.QrPaymentIntent, error) {
	id := strings.TrimSpace(ventaTempID)
	if id == "" {
		return nil, ErrQRInvalidInput
	}
	if now == nil {
		now = time.Now
	}
	var out models.QrPaymentIntent
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row models.QrPaymentIntent
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("venta_temp_id = ?", id).
			Order("id DESC").
			First(&row).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrQRIntentNotFound
			}
			return err
		}
		if row.Status != models.QRIntentStatusPending {
			return ErrQRIntentNotPending
		}
		currentNow := now()
		// Idempotente: si ya tiene queued_at, no re-escribir.
		if row.QueuedAt != nil {
			out = row
			return nil
		}
		res := tx.Model(&models.QrPaymentIntent{}).
			Where("id = ? AND status = ?", row.ID, models.QRIntentStatusPending).
			Update("queued_at", currentNow)
		if res.Error != nil {
			return res.Error
		}
		row.QueuedAt = &currentNow
		out = row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// PendingByCajaItem es el shape que lee la bandeja global. NO expone
// snapshots (payload grande); sólo lo necesario para pintar la lista.
//
// Nota: la migración 027 NO define una columna `cashier_name`. El
// frontend resuelve el nombre humano a partir de `CreatedByDNI`
// consultando el catálogo local de empleados.
type PendingByCajaItem struct {
	ID           uint64     `gorm:"column:id"`
	VentaTempID  string     `gorm:"column:venta_temp_id"`
	CajaID       string     `gorm:"column:caja_id"`
	CreatedByDNI string     `gorm:"column:created_by_dni"`
	AmountCOP    int64      `gorm:"column:amount_cop"`
	CreatedAt    time.Time  `gorm:"column:created_at"`
	ExpiresAt    time.Time  `gorm:"column:expires_at"`
	QueuedAt     *time.Time `gorm:"column:queued_at"`
}

// ListPendingByCaja devuelve las intenciones PENDIENTES vivas (expires_at > now)
// que ya fueron encoladas (queued_at IS NOT NULL) para una caja.
// Ordenadas por queued_at DESC. El límite se acota a [1..50].
//
// Filtra con NOT EXISTS cualquier venta_temp_id que YA tenga una
// intención APROBADA o CONFIRMADA_MANUAL. Esto cierra el escenario
// legacy donde un bug previo creaba una PENDIENTE después de una
// APROBADA del mismo venta_temp_id: aunque esa PENDIENTE fantasma
// siga viva en BD, nunca aparece en la bandeja global y por tanto no
// se puede reabrir desde el frontend.
func (r *QrPaymentRepository) ListPendingByCaja(ctx context.Context, cajaID string, limit int, now time.Time) ([]PendingByCajaItem, error) {
	caja := strings.TrimSpace(cajaID)
	if caja == "" {
		return nil, ErrQRInvalidInput
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}
	var items []PendingByCajaItem
	err := r.db.WithContext(ctx).
		Table("pos_qr_payment_intents AS p").
		Select("p.id, p.venta_temp_id, p.caja_id, p.created_by_dni, p.amount_cop, p.created_at, p.expires_at, p.queued_at").
		Where("p.caja_id = ? AND p.status = ? AND p.queued_at IS NOT NULL AND p.expires_at > ?",
			caja, models.QRIntentStatusPending, now).
		Where("NOT EXISTS (SELECT 1 FROM pos_qr_payment_intents paid "+
			"WHERE paid.venta_temp_id = p.venta_temp_id AND paid.status IN ?)",
			[]string{
				models.QRIntentStatusApproved,
				models.QRIntentStatusConfirmedManual,
			}).
		Order("p.queued_at DESC").
		Limit(limit).
		Scan(&items).Error
	if err != nil {
		return nil, err
	}
	return items, nil
}

// ListPendingAll devuelve las intenciones PENDIENTES vivas encoladas de
// TODAS las cajas. Es la variante "scope=all" de la bandeja: la usa el
// handler sólo cuando el solicitante es admin/superadmin (chequeado en
// la capa HTTP). El shape de salida es idéntico al de ListPendingByCaja
// para que el frontend no tenga que ramificar su parser.
//
// Mismos filtros canónicos: PENDIENTE, queued_at NOT NULL, expires_at
// futuro, y descarta huérfanos (venta_temp_id que ya tiene aprobación).
// Mismo orden `queued_at DESC` y mismo límite [1..50].
func (r *QrPaymentRepository) ListPendingAll(ctx context.Context, limit int, now time.Time) ([]PendingByCajaItem, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}
	var items []PendingByCajaItem
	err := r.db.WithContext(ctx).
		Table("pos_qr_payment_intents AS p").
		Select("p.id, p.venta_temp_id, p.caja_id, p.created_by_dni, p.amount_cop, p.created_at, p.expires_at, p.queued_at").
		Where("p.status = ? AND p.queued_at IS NOT NULL AND p.expires_at > ?",
			models.QRIntentStatusPending, now).
		Where("NOT EXISTS (SELECT 1 FROM pos_qr_payment_intents paid "+
			"WHERE paid.venta_temp_id = p.venta_temp_id AND paid.status IN ?)",
			[]string{
				models.QRIntentStatusApproved,
				models.QRIntentStatusConfirmedManual,
			}).
		Order("p.queued_at DESC").
		Limit(limit).
		Scan(&items).Error
	if err != nil {
		return nil, err
	}
	return items, nil
}

// GetByVentaTempID devuelve la fila completa, incluidos los snapshots.
// Pensado para que el materializador asíncrono lea los JSONB y los
// decodifique sin tener que ir al handler del webhook.
func (r *QrPaymentRepository) GetByVentaTempID(ctx context.Context, ventaTempID string) (*models.QrPaymentIntent, error) {
	id := strings.TrimSpace(ventaTempID)
	if id == "" {
		return nil, ErrQRIntentNotFound
	}
	var row models.QrPaymentIntent
	if err := r.db.WithContext(ctx).
		Where("venta_temp_id = ?", id).
		Order("id DESC").
		First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrQRIntentNotFound
		}
		return nil, err
	}
	return &row, nil
}

// GetLatestPaidByVentaTempID devuelve la intención APROBADA o
// CONFIRMADA_MANUAL más reciente para el venta_temp_id, o
// ErrQRIntentNotFound si no existe. Lectura read-only, sin FOR UPDATE:
// paid es terminal, no cambia. El servicio la usa para construir el
// snapshot inicial del SSE y los errores *IntentAlreadyPaidError
// cuando bloquea /encolar o /asignar.
func (r *QrPaymentRepository) GetLatestPaidByVentaTempID(ctx context.Context, ventaTempID string) (*models.QrPaymentIntent, error) {
	id := strings.TrimSpace(ventaTempID)
	if id == "" {
		return nil, ErrQRIntentNotFound
	}
	var row models.QrPaymentIntent
	err := r.db.WithContext(ctx).
		Where("venta_temp_id = ? AND status IN ?",
			id,
			[]string{
				models.QRIntentStatusApproved,
				models.QRIntentStatusConfirmedManual,
			}).
		Order("id DESC").
		First(&row).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrQRIntentNotFound
		}
		return nil, err
	}
	return &row, nil
}

// GetByID devuelve la fila completa por su primary key.
func (r *QrPaymentRepository) GetByID(ctx context.Context, intentID uint64) (*models.QrPaymentIntent, error) {
	if intentID == 0 {
		return nil, ErrQRIntentNotFound
	}
	var row models.QrPaymentIntent
	if err := r.db.WithContext(ctx).
		Where("id = ?", intentID).
		First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrQRIntentNotFound
		}
		return nil, err
	}
	return &row, nil
}

// ClaimForFinalization reclama una intención APROBADA/CONFIRMADA_MANUAL
// para la materialización asíncrona. Transición atómica:
//
//   - FROM: finalization_status IN ('NOT_STARTED', 'FAILED')
//   - TO:   finalization_status = 'IN_PROGRESS'
//     finalization_started_at = now
//     finalization_completed_at = NULL (puede venir desde FAILED, limpiar)
//     finalization_last_error = NULL
//     finalization_attempts = finalization_attempts + 1
//     finalization_next_retry_at = NULL
//
// Precondiciones:
//
//   - status IN ('APROBADA','CONFIRMADA_MANUAL') — sin pago aprobado,
//     no hay nada que materializar; devolvemos ErrQRFinalizationNotEligible.
//   - cart_snapshot IS NOT NULL — sin snapshot no hay forma de
//     reconstruir la venta canónica; se devuelve not eligible.
//   - finalization_attempts < QRFinalizationMaxAttempts — después de
//     esa cota paramos para no quemar reintentos infinitos; ErrQRFinalizationNotEligible.
//
// Si otro worker ya está en IN_PROGRESS o ya SUCCEEDED, devolvemos
// ErrQRFinalizationAlreadyClaimed. Es un error silencioso: el llamador
// no reintenta ni reporta error.
func (r *QrPaymentRepository) ClaimForFinalization(ctx context.Context, intentID uint64, now func() time.Time) (*models.QrPaymentIntent, error) {
	if intentID == 0 {
		return nil, ErrQRIntentNotFound
	}
	if now == nil {
		now = time.Now
	}
	var out models.QrPaymentIntent
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row models.QrPaymentIntent
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", intentID).
			First(&row).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrQRIntentNotFound
			}
			return err
		}
		// Precondición 1: pago aprobado.
		if row.Status != models.QRIntentStatusApproved &&
			row.Status != models.QRIntentStatusConfirmedManual {
			return ErrQRFinalizationNotEligible
		}
		// Precondición 2: ya terminado.
		if row.FinalizationStatus == models.QRFinalizationStatusSucceeded {
			return ErrQRFinalizationAlreadyClaimed
		}
		// Precondición 3: otro worker en progreso. Permitir claim si
		// el IN_PROGRESS está atascado (started_at hace mucho).
		if row.FinalizationStatus == models.QRFinalizationStatusInProgress {
			if row.FinalizationStartedAt != nil &&
				now().Sub(*row.FinalizationStartedAt) < models.QRFinalizationStuckAfter {
				return ErrQRFinalizationAlreadyClaimed
			}
			// Atascado: lo vamos a reclamar.
		}
		// Precondición 4: snapshot presente.
		if strings.TrimSpace(row.CartSnapshot) == "" ||
			strings.TrimSpace(row.SaleClientTxID) == "" {
			return ErrQRFinalizationNotEligible
		}
		// Precondición 5: no quemar reintentos.
		if row.FinalizationAttempts >= models.QRFinalizationMaxAttempts {
			return ErrQRFinalizationNotEligible
		}
		currentNow := now()
		updates := map[string]interface{}{
			"finalization_status":        models.QRFinalizationStatusInProgress,
			"finalization_started_at":    currentNow,
			"finalization_completed_at":  nil,
			"finalization_last_error":    nil,
			"finalization_attempts":      row.FinalizationAttempts + 1,
			"finalization_next_retry_at": nil,
		}
		res := tx.Model(&models.QrPaymentIntent{}).
			Where("id = ? AND finalization_status IN ?",
				row.ID,
				[]string{models.QRFinalizationStatusNotStarted, models.QRFinalizationStatusFailed, models.QRFinalizationStatusInProgress}).
			Updates(updates)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return ErrQRFinalizationAlreadyClaimed
		}
		row.FinalizationStatus = models.QRFinalizationStatusInProgress
		started := currentNow
		row.FinalizationStartedAt = &started
		row.FinalizationCompletedAt = nil
		row.FinalizationLastError = ""
		row.FinalizationAttempts++
		row.FinalizationNextRetryAt = nil
		out = row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// MarkFinalizationSucceeded transita la intención a SUCCEEDED y
// vincula related_sale_id. El llamador DEBE haber hecho ya el INSERT
// en sales y tener el saleID (SaleService.CreateSale es idempotente
// por ClientTxId, así que un reintento jamás creará dos ventas).
//
// Valida que el status esté APROBADA/CONFIRMADA_MANUAL (defensa en
// profundidad contra ck_pqpi_finalization_requires_approval) y que
// venga saleID != 0.
func (r *QrPaymentRepository) MarkFinalizationSucceeded(ctx context.Context, intentID uint64, saleID uint64, now func() time.Time) error {
	if intentID == 0 || saleID == 0 {
		return ErrQRInvalidInput
	}
	if now == nil {
		now = time.Now
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row models.QrPaymentIntent
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", intentID).
			First(&row).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrQRIntentNotFound
			}
			return err
		}
		if row.Status != models.QRIntentStatusApproved &&
			row.Status != models.QRIntentStatusConfirmedManual {
			// Defensa en profundidad: NUNCA SUCCEEDED sin pago aprobado.
			return ErrQRFinalizationNotEligible
		}
		if row.FinalizationStatus == models.QRFinalizationStatusSucceeded {
			// Idempotente: ya está. No reasignar related_sale_id.
			return nil
		}
		currentNow := now()
		updates := map[string]interface{}{
			"finalization_status":       models.QRFinalizationStatusSucceeded,
			"finalization_completed_at": currentNow,
			"finalization_last_error":   nil,
			"related_sale_id":           saleID,
		}
		res := tx.Model(&models.QrPaymentIntent{}).
			Where("id = ? AND finalization_status = ?",
				row.ID, models.QRFinalizationStatusInProgress).
			Updates(updates)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return ErrQRFinalizationAlreadyClaimed
		}
		return nil
	})
}

// MarkFinalizationFailed transita a FAILED con mensaje de error y
// programa el próximo reintento con backoff exponencial. El mensaje
// se trunca a QRFinalizationLastErrorMaxLen y se asume que el llamador
// ya filtró secretos (BOLD_BRIDGE_TOKEN, BOLD_SECRET_KEY, firma HMAC).
//
// Si attempts llegó al techo (QRFinalizationMaxAttempts), next_retry_at
// queda NULL para que el sweeper no vuelva a tocar la fila. El dueño
// debe resolver desde la bandeja.
func (r *QrPaymentRepository) MarkFinalizationFailed(ctx context.Context, intentID uint64, errMsg string, now func() time.Time) error {
	if intentID == 0 {
		return ErrQRInvalidInput
	}
	if now == nil {
		now = time.Now
	}
	msg := strings.TrimSpace(errMsg)
	if msg == "" {
		msg = "fallo sin mensaje"
	}
	if len(msg) > models.QRFinalizationLastErrorMaxLen {
		msg = msg[:models.QRFinalizationLastErrorMaxLen]
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row models.QrPaymentIntent
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", intentID).
			First(&row).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrQRIntentNotFound
			}
			return err
		}
		if row.FinalizationStatus != models.QRFinalizationStatusInProgress {
			// Otro worker ya resolvió (SUCCEEDED) o alguien ya marcó
			// FAILED. Idempotente: salimos silenciosamente.
			return nil
		}
		currentNow := now()
		backoff := models.QRFinalizationBaseBackoff << uint(row.FinalizationAttempts)
		if backoff > models.QRFinalizationMaxBackoff {
			backoff = models.QRFinalizationMaxBackoff
		}
		var nextRetry *time.Time
		if row.FinalizationAttempts < models.QRFinalizationMaxAttempts {
			t := currentNow.Add(backoff)
			nextRetry = &t
		}
		updates := map[string]interface{}{
			"finalization_status":        models.QRFinalizationStatusFailed,
			"finalization_completed_at":  currentNow,
			"finalization_last_error":    msg,
			"finalization_next_retry_at": nextRetry,
		}
		res := tx.Model(&models.QrPaymentIntent{}).
			Where("id = ? AND finalization_status = ?",
				row.ID, models.QRFinalizationStatusInProgress).
			Updates(updates)
		if res.Error != nil {
			return res.Error
		}
		// Si RowsAffected = 0 es porque otro worker llegó antes: ok.
		return nil
	})
}

// MarkCashierNotified setea cashier_notified_at=now. Idempotente al
// nivel de BD (se puede llamar varias veces; sólo actualiza timestamp).
// El frontend decide si repite el sonido con un token local.
func (r *QrPaymentRepository) MarkCashierNotified(ctx context.Context, intentID uint64, now func() time.Time) error {
	if intentID == 0 {
		return ErrQRInvalidInput
	}
	if now == nil {
		now = time.Now
	}
	currentNow := now()
	return r.db.WithContext(ctx).
		Model(&models.QrPaymentIntent{}).
		Where("id = ?", intentID).
		Update("cashier_notified_at", currentNow).Error
}

// ListPendingFinalization devuelve las intenciones APROBADAS cuyo
// finalization_status es NOT_STARTED o FAILED (con next_retry_at ya
// pasado). Pensado para el sweeper del servicio. El límite se acota
// a [1..100].
func (r *QrPaymentRepository) ListPendingFinalization(ctx context.Context, now time.Time, limit int) ([]models.QrPaymentIntent, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	var rows []models.QrPaymentIntent
	err := r.db.WithContext(ctx).
		Where(
			"status IN ? AND cart_snapshot IS NOT NULL AND sale_client_tx_id IS NOT NULL AND finalization_attempts < ? AND ("+
				"finalization_status = ? OR "+
				"(finalization_status = ? AND finalization_next_retry_at IS NOT NULL AND finalization_next_retry_at <= ?) OR "+
				"(finalization_status = ? AND finalization_started_at IS NOT NULL AND finalization_started_at <= ?)"+
				")",
			[]string{models.QRIntentStatusApproved, models.QRIntentStatusConfirmedManual},
			models.QRFinalizationMaxAttempts,
			models.QRFinalizationStatusNotStarted,
			models.QRFinalizationStatusFailed, now,
			models.QRFinalizationStatusInProgress, now.Add(-models.QRFinalizationStuckAfter),
		).
		Order("id ASC").
		Limit(limit).
		Find(&rows).Error
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// =========================================================================
// Conteo de PENDIENTES al mismo monto (soporte para `sameAmountPending`)
// =========================================================================

// CountPendingLiveByAmount devuelve cuántas intenciones viven
// (PENDIENTE + expires_at > now) con un `amount_cop` exacto, excluyendo
// opcionalmente la propia (useful cuando el llamador acaba de crear una
// y no quiere contarse a sí misma). excludeIntentID=0 significa "sin
// exclusión". Es una lectura liviana para alertar al cajero de que
// otro QR del mismo monto está en bandeja (riesgo AMBIGUOUS en el
// matcher).
func (r *QrPaymentRepository) CountPendingLiveByAmount(ctx context.Context, amountCOP int64, excludeIntentID uint64, now time.Time) (int, error) {
	if !models.IsValidQRAmountCOP(amountCOP) {
		return 0, ErrQRInvalidInput
	}
	q := r.db.WithContext(ctx).
		Model(&models.QrPaymentIntent{}).
		Where("amount_cop = ? AND status = ? AND expires_at > ?",
			amountCOP, models.QRIntentStatusPending, now)
	if excludeIntentID > 0 {
		q = q.Where("id <> ?", excludeIntentID)
	}
	var count int64
	if err := q.Count(&count).Error; err != nil {
		return 0, err
	}
	return int(count), nil
}

// =========================================================================
// Eventos sin asignar (bandeja de conciliación manual)
// =========================================================================

// UnassignedEventItem describe un evento AMBIGUOUS/UNMATCHED que un
// cajero puede resolver manualmente desde la bandeja. El `Note` se
// expone como `resumen` al handler: contiene el texto saneado que el
// servicio persistió al ingerir el evento. Nunca viajan secretos.
type UnassignedEventItem struct {
	ID              uint64    `gorm:"column:id"`
	AmountCOP       int64     `gorm:"column:amount_cop"`
	ReceivedAt      time.Time `gorm:"column:received_at"`
	ProcessedStatus string    `gorm:"column:processed_status"`
	Source          string    `gorm:"column:source"`
	Note            string    `gorm:"column:note"`
}

// ListUnassignedEvents devuelve los eventos de webhook sin asignar
// recibidos desde `since` (inclusive). Filtra por processed_status IN
// (UNMATCHED, AMBIGUOUS) y matched_intent_id NULL, ordena por
// received_at DESC y acota al límite [1..50].
func (r *QrPaymentRepository) ListUnassignedEvents(ctx context.Context, since time.Time, limit int) ([]UnassignedEventItem, error) {
	if since.IsZero() {
		return nil, ErrQRInvalidInput
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 50 {
		limit = 50
	}
	var items []UnassignedEventItem
	err := r.db.WithContext(ctx).
		Table("pos_qr_webhook_events").
		Select("id, amount_cop, received_at, processed_status, source, note").
		Where("matched_intent_id IS NULL AND processed_status IN ? AND received_at >= ?",
			[]string{models.QRWebhookStatusUnmatched, models.QRWebhookStatusAmbiguous},
			since).
		Order("received_at DESC").
		Limit(limit).
		Scan(&items).Error
	if err != nil {
		return nil, err
	}
	return items, nil
}

// =========================================================================
// Asignación manual de evento → intención (sin facturar automáticamente
// más allá del disparo canónico de materialización asíncrona)
// =========================================================================

// AssignEventOptions parametriza la asignación.
type AssignEventOptions struct {
	VentaTempID string
	EventID     uint64
	ActorDNI    string
	// MaxAge limita qué tan antiguo puede ser `received_at` del
	// evento. Default: models.QRAssignmentWindow (60 min).
	MaxAge time.Duration
	Now    func() time.Time
}

// AssignEventOutcome devuelve el evento y la intención después de la
// asignación. El llamador los usa para auditar, publicar al tray y
// disparar triggerAutoSale.
type AssignEventOutcome struct {
	Event  *models.QrWebhookEvent
	Intent *models.QrPaymentIntent
}

// AssignEventToIntent asocia un evento AMBIGUOUS/UNMATCHED a una
// intención PENDIENTE viva en UNA sola transacción:
//
//  1. advisory lock `qr_match:<amount>` para serializar aprobaciones
//     paralelas del mismo monto (idéntica semántica que IngestWebhook).
//  2. SELECT ... FOR UPDATE del evento. Validaciones:
//     - processed_status ∈ {AMBIGUOUS, UNMATCHED}.
//     - matched_intent_id IS NULL (sin asignación previa).
//     - received_at >= now - MaxAge (default 60 min).
//     De lo contrario → ErrQREventAlreadyAssigned (409).
//  3. SELECT ... FOR UPDATE de la intención por venta_temp_id. Debe
//     ser PENDIENTE, expires_at > now. De lo contrario →
//     ErrQRIntentNotFound/ErrQRIntentNotPending/ErrQRIntentExpired.
//  4. Chequeo defensivo: event.amount_cop == intent.amount_cop. Si
//     difieren → ErrQRAmountMismatch (409). Dos defensas: el servicio
//     también lo valida antes.
//  5. UPDATE evento: processed_status=APPROVED, matched_intent_id,
//     note con sufijo " | asignado:<dni>" recortado a 255 chars.
//  6. UPDATE intención: status=APROBADA, approved_source=<source del
//     evento>, approved_reference='ASIG-<eventId>', approved_event_id,
//     approved_at=now.
//
// RowsAffected debe ser 1 en cada UPDATE para evitar carreras
// (dos cajeros asignando el mismo evento a dos intenciones): si no
// coincide, se revierte la tx con ErrQREventAlreadyAssigned.
func (r *QrPaymentRepository) AssignEventToIntent(ctx context.Context, opts AssignEventOptions) (*AssignEventOutcome, error) {
	ventaTemp := strings.TrimSpace(opts.VentaTempID)
	dni := strings.TrimSpace(opts.ActorDNI)
	if ventaTemp == "" || dni == "" || opts.EventID == 0 {
		return nil, ErrQRInvalidInput
	}
	maxAge := opts.MaxAge
	if maxAge <= 0 {
		maxAge = models.QRAssignmentWindow
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	currentNow := now()

	var outcome AssignEventOutcome
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1) Cargar evento sin bloquear primero para conocer el monto
		//    (necesario para el advisory lock). Si no existe → 404.
		var event models.QrWebhookEvent
		if err := tx.Where("id = ?", opts.EventID).First(&event).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrQREventNotFound
			}
			return fmt.Errorf("buscar evento: %w", err)
		}

		// 2) Advisory lock por amount_cop. Serializa esta asignación
		//    contra IngestWebhook y contra otra asignación paralela.
		if err := tx.Exec("SELECT pg_advisory_xact_lock(hashtext(?))",
			fmt.Sprintf("qr_match:%d", event.AmountCOP)).Error; err != nil {
			return fmt.Errorf("advisory lock asignar: %w", err)
		}

		// 2bis) Short-circuit AlreadyPaid.
		//
		// Si el venta_temp_id ya tiene una intención APROBADA o
		// CONFIRMADA_MANUAL, NUNCA re-aprobamos un cobro cerrado,
		// aun si el cajero pide asignar un evento huérfano. El error
		// *IntentAlreadyPaidError carga el saleId para que el handler
		// responda 409 QR_INTENT_ALREADY_PAID con `saleId` y el modal
		// cierre sin reabrir.
		//
		// Chequeo antes de bloquear la fila "latest" por venta_temp_id
		// para no sorprender con un UPDATE de evento en el flujo
		// cuando la decisión ya está sellada.
		{
			var paid models.QrPaymentIntent
			perr := tx.Where("venta_temp_id = ? AND status IN ?",
				ventaTemp,
				[]string{
					models.QRIntentStatusApproved,
					models.QRIntentStatusConfirmedManual,
				}).
				Order("id DESC").
				First(&paid).Error
			if perr == nil {
				paidErr := &IntentAlreadyPaidError{
					IntentID:  paid.ID,
					AmountCOP: paid.AmountCOP,
					Status:    paid.Status,
				}
				if paid.RelatedSaleID != nil {
					paidErr.SaleID = *paid.RelatedSaleID
				}
				return paidErr
			}
			if !errors.Is(perr, gorm.ErrRecordNotFound) {
				return fmt.Errorf("verificar paid: %w", perr)
			}
		}

		// 3) Re-lee el evento con FOR UPDATE y vuelve a validar precondiciones.
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", opts.EventID).
			First(&event).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrQREventNotFound
			}
			return fmt.Errorf("lock evento: %w", err)
		}
		switch event.ProcessedStatus {
		case models.QRWebhookStatusAmbiguous, models.QRWebhookStatusUnmatched:
			// OK, candidato legal.
		default:
			return ErrQREventAlreadyAssigned
		}
		if event.MatchedIntentID != nil {
			return ErrQREventAlreadyAssigned
		}
		if event.ReceivedAt.Before(currentNow.Add(-maxAge)) {
			return ErrQREventAlreadyAssigned
		}

		// 4) Lock de la intención viva más reciente para el venta_temp_id.
		var intent models.QrPaymentIntent
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("venta_temp_id = ?", ventaTemp).
			Order("id DESC").
			First(&intent).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrQRIntentNotFound
			}
			return fmt.Errorf("lock intent: %w", err)
		}
		if intent.Status != models.QRIntentStatusPending {
			return ErrQRIntentNotPending
		}
		if !currentNow.Before(intent.ExpiresAt) {
			return ErrQRIntentExpired
		}

		// 5) Chequeo de monto. Nunca aprobar un cobro cuyo monto no
		//    corresponde al carrito, aun si el cajero lo pide.
		if intent.AmountCOP != event.AmountCOP {
			return ErrQRAmountMismatch
		}

		// 6) UPDATE del evento: APPROVED + matched_intent_id + note
		//    con sufijo auditable "| asignado:<dni>" recortado a 255.
		eventRef := event.ID
		intentID := intent.ID
		assignSuffix := " | asignado:" + dni
		newNote := event.Note
		if newNote == "" {
			newNote = strings.TrimLeft(assignSuffix, " |")
		} else {
			newNote = newNote + assignSuffix
		}
		if len(newNote) > 255 {
			newNote = newNote[:255]
		}
		if event.ProcessedAt == nil {
			event.ProcessedAt = &currentNow
		}
		resEvt := tx.Model(&models.QrWebhookEvent{}).
			Where("id = ? AND processed_status IN ? AND matched_intent_id IS NULL",
				event.ID,
				[]string{models.QRWebhookStatusAmbiguous, models.QRWebhookStatusUnmatched}).
			Updates(map[string]interface{}{
				"processed_status":  models.QRWebhookStatusApproved,
				"matched_intent_id": intentID,
				"processed_at":      currentNow,
				"note":              newNote,
			})
		if resEvt.Error != nil {
			return fmt.Errorf("update event: %w", resEvt.Error)
		}
		if resEvt.RowsAffected != 1 {
			return ErrQREventAlreadyAssigned
		}
		event.ProcessedStatus = models.QRWebhookStatusApproved
		event.MatchedIntentID = &intentID
		event.Note = newNote

		// 7) UPDATE de la intención: APROBADA con approved_source =
		//    source del evento, approved_reference 'ASIG-<eventId>'
		//    (<=128 chars), approved_event_id.
		approvedSource := models.QRApprovalSourceBridge
		if event.Source == models.QRWebhookSourceOfficial {
			approvedSource = models.QRApprovalSourceBoldOfficial
		}
		approvedRef := fmt.Sprintf("ASIG-%d", eventRef)
		if len(approvedRef) > 128 {
			approvedRef = approvedRef[:128]
		}
		resInt := tx.Model(&models.QrPaymentIntent{}).
			Where("id = ? AND status = ?", intent.ID, models.QRIntentStatusPending).
			Updates(map[string]interface{}{
				"status":             models.QRIntentStatusApproved,
				"approved_at":        currentNow,
				"approved_source":    approvedSource,
				"approved_reference": approvedRef,
				"approved_event_id":  eventRef,
			})
		if resInt.Error != nil {
			return fmt.Errorf("update intent approved: %w", resInt.Error)
		}
		if resInt.RowsAffected != 1 {
			return ErrQRIntentNotPending
		}
		intent.Status = models.QRIntentStatusApproved
		intent.ApprovedAt = &currentNow
		intent.ApprovedSource = approvedSource
		intent.ApprovedReference = approvedRef
		intent.ApprovedEventID = &eventRef

		outcome.Event = &event
		outcome.Intent = &intent
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &outcome, nil
}
