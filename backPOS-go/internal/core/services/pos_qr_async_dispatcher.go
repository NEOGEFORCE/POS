// Materializador asíncrono del flujo QR Bold/Bre-B (migración 027).
//
// Separado del `pos_qr_service.go` para que:
//
//   - El guardián estático `pos_qr_service_secrets_test.go` pueda
//     escanear este archivo específicamente buscando concatenaciones
//     de BOLD_BRIDGE_TOKEN / BOLD_SECRET_KEY hacia finalization_last_error
//     o cualquier log.
//
//   - El import ciclo entre QrPaymentService y SaleService quede
//     delineado: el dispatcher recibe el SaleService ya construido
//     vía setter (`WithSaleService`), por lo que ninguno depende del
//     otro al momento de construcción.
//
//   - Los tests puedan ejercer el dispatcher sin montar todo el
//     servicio (sólo repo + hub + un SaleService mínimo).
//
// Reglas:
//
//   - DispatchAutoSale se invoca SIEMPRE post-commit del webhook. Nunca
//     dentro de la tx del repo (riesgo de deadlock contra
//     `stock_movements` que ya es la tabla hot path del venta).
//
//   - La materialización usa SaleService.CreateSale, cuya idempotencia
//     por ClientTxId es la única fuente de verdad: dos entregas del
//     webhook (replay) terminan con exactamente 1 venta.
//
//   - Al fallar, el error se trunca a 200 chars Y pasa por un filtro
//     regex que detecta BOLD_BRIDGE_TOKEN / BOLD_SECRET_KEY aunque
//     accidentalmente queden en el mensaje. Si el filtro los
//     encuentra, los reemplaza con "[REDACTED]" ANTES de persistir.
//
//   - El sweeper levanta las APROBADAS/CONFIRMADAS_MANUAL con
//     finalization_status IN (NOT_STARTED, FAILED cuyo retry_at pasó,
//     IN_PROGRESS atascado > QRFinalizationStuckAfter) y las despacha.
package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"regexp"
	"strings"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/sse"
)

// =========================================================================
// Snapshot JSON shapes (contrato con el frontend)
// =========================================================================

// qrSaleCartItem es el shape mínimo que el service persistió como
// cart_snapshot. Mantener los nombres JSON alineados con el frontend
// (sale/new/page.tsx construye el payload). Si el frontend cambia el
// shape, hay que migrar al adapter: NO rebajar aquí.
type qrSaleCartItem struct {
	Barcode   string  `json:"barcode"`
	Quantity  float64 `json:"quantity"`
	UnitPrice float64 `json:"unitPrice"`
	CostPrice float64 `json:"costPrice"`
	Subtotal  float64 `json:"subtotal"`
}

// qrSaleTotals carga datos de pago y totales.
//
// EditTargetSaleID (opcional) habilita el flujo "QR en edición":
// cuando el frontend abre un cobro QR sobre una venta ya registrada
// (modo /sales/new?Factura EDIT-<id>), persiste este campo dentro
// del `totals` snapshot. Al aprobarse, DispatchAutoSale invoca
// SaleService.UpdateSaleFromQR(editSaleID, …) en lugar de CreateSale,
// de modo que la venta #editSaleID queda ACTUALIZADA (nuevo total,
// nuevo desglose) y no se crea una venta hermana. related_sale_id de
// la intención queda vinculado a `editSaleID`.
//
// Valor 0 (omitempty) = flujo normal CreateSale. Es un entero JSON;
// evitamos string para que un typo del cliente no se confunda con un
// barcode u otro identificador.
type qrSaleTotals struct {
	TotalAmount       float64 `json:"totalAmount"`
	AmountPaid        float64 `json:"amountPaid"`
	Change            float64 `json:"change"`
	CashAmount        float64 `json:"cashAmount"`
	TransferAmount    float64 `json:"transferAmount"`
	TransferNequi     float64 `json:"transferNequi"`
	TransferDaviplata float64 `json:"transferDaviplata"`
	CreditAmount      float64 `json:"creditAmount"`
	DebtPending       float64 `json:"debtPending"`
	TransferSource    string  `json:"transferSource"`
	PaymentMethod     string  `json:"paymentMethod"`
	EmployeeDNI       string  `json:"employeeDni"`
	EditTargetSaleID  uint64  `json:"editSaleId,omitempty"`
	// LinkPaymentOnly (enlace de pago a venta existente): con editSaleId,
	// sólo se reemplaza el desglose de pago; productos y stock no se tocan.
	// Lo arma SIEMPRE el servidor (LinkEventToSale), nunca el cliente.
	LinkPaymentOnly bool `json:"linkPaymentOnly,omitempty"`
}

// snapshotIsLinkPaymentOnly lee el flag linkPaymentOnly del totals snapshot.
func snapshotIsLinkPaymentOnly(intent *models.QrPaymentIntent) bool {
	if intent == nil || strings.TrimSpace(intent.TotalsSnapshot) == "" {
		return false
	}
	var t qrSaleTotals
	if err := json.Unmarshal([]byte(intent.TotalsSnapshot), &t); err != nil {
		return false
	}
	return t.LinkPaymentOnly
}

// qrSaleClient congela DNI y nombre; si viene vacío la venta queda sin
// cliente formal (0000 por default a cliente anónimo).
type qrSaleClient struct {
	DNI  string `json:"dni"`
	Name string `json:"name"`
}

// =========================================================================
// Dispatcher
// =========================================================================

// DispatchAutoSale es la entrada principal del materializador:
//
//  1. ClaimForFinalization (SELECT ... FOR UPDATE + transición
//     atómica NOT_STARTED/FAILED → IN_PROGRESS). Si falla con
//     ErrQRFinalizationAlreadyClaimed, salimos silenciosamente.
//  2. Decodifica snapshots → models.Sale con ClientTxId del snapshot.
//  3. Invoca saleService.CreateSale(&sale). Idempotente natural.
//  4. En éxito: MarkFinalizationSucceeded + emisión SSE a stream +
//     tray + MarkCashierNotified.
//  5. En fallo: MarkFinalizationFailed con backoff + tray ERROR.
//
// Nunca propaga panics (recover arriba, en triggerAutoSale).
func (s *QrPaymentService) DispatchAutoSale(ctx context.Context, intent *models.QrPaymentIntent) {
	if s == nil || intent == nil || s.saleService == nil {
		return
	}
	if intent.ID == 0 || strings.TrimSpace(intent.VentaTempID) == "" {
		return
	}

	// Paso 1: Claim.
	claimed, err := s.repo.ClaimForFinalization(ctx, intent.ID, s.clock)
	if err != nil {
		if errors.Is(err, repositories.ErrQRFinalizationAlreadyClaimed) {
			// Otro worker ya está materializando o ya terminó.
			return
		}
		if errors.Is(err, repositories.ErrQRFinalizationNotEligible) {
			// Snapshot NULL o pago no aprobado. Nada que hacer.
			log.Printf("[qr-pagos] DispatchAutoSale intent=%d no apto: %v", intent.ID, err)
			return
		}
		if errors.Is(err, repositories.ErrQRIntentNotFound) {
			return
		}
		log.Printf("[qr-pagos] DispatchAutoSale claim falló intent=%d: %v", intent.ID, err)
		return
	}
	if claimed == nil {
		return
	}

	// Paso 2: decodificar snapshots → models.Sale.
	sale, editTargetSaleID, err := buildSaleFromSnapshots(claimed)
	if err != nil {
		msg := sanitizeFinalizationError(err.Error())
		if markErr := s.repo.MarkFinalizationFailed(ctx, claimed.ID, msg, s.clock); markErr != nil {
			log.Printf("[qr-pagos] MarkFinalizationFailed snapshot intent=%d: %v", claimed.ID, markErr)
		}
		s.publishTrayFromIntent(claimed, models.QRTrayKindError, "No se pudo decodificar el carrito del QR.")
		return
	}

	// Paso 3: materializar la venta.
	//
	// Dos ramas:
	//
	//   a) editTargetSaleID == 0 (flujo normal): CreateSale canónico.
	//      Idempotente por ClientTxId (migración 009).
	//
	//   b) editTargetSaleID > 0 (QR en edición): UpdateSaleFromQR reemplaza
	//      el desglose de la venta #editTargetSaleID. Idempotencia la
	//      aporta ClaimForFinalization: dos entregas del webhook pelean
	//      por el claim y una sola gana. related_sale_id queda vinculado
	//      a editTargetSaleID (NO al clientTxId de un INSERT nuevo).
	var saleID uint64
	if editTargetSaleID > 0 {
		var applyErr error
		if snapshotIsLinkPaymentOnly(claimed) {
			applyErr = s.saleService.ApplyQRPaymentToSale(uint(editTargetSaleID), sale, strings.TrimSpace(claimed.CreatedByDNI))
		} else {
			applyErr = s.saleService.UpdateSaleFromQR(uint(editTargetSaleID), sale, strings.TrimSpace(claimed.CreatedByDNI))
		}
		if err := applyErr; err != nil {
			msg := sanitizeFinalizationError(err.Error())
			if markErr := s.repo.MarkFinalizationFailed(ctx, claimed.ID, msg, s.clock); markErr != nil {
				log.Printf("[qr-pagos] MarkFinalizationFailed update intent=%d sale=%d: %v", claimed.ID, editTargetSaleID, markErr)
			}
			s.publishTrayFromIntent(claimed, models.QRTrayKindError, "Fallo al actualizar la venta editada. El cajero puede reintentar desde la bandeja.")
			return
		}
		saleID = editTargetSaleID
	} else {
		if err := s.saleService.CreateSale(sale); err != nil {
			msg := sanitizeFinalizationError(err.Error())
			if markErr := s.repo.MarkFinalizationFailed(ctx, claimed.ID, msg, s.clock); markErr != nil {
				log.Printf("[qr-pagos] MarkFinalizationFailed intent=%d: %v", claimed.ID, markErr)
			}
			s.publishTrayFromIntent(claimed, models.QRTrayKindError, "Fallo al materializar la venta. El cajero puede reintentar desde la bandeja.")
			return
		}
		if sale.SaleID == 0 {
			msg := "CreateSale devolvió saleId=0"
			if markErr := s.repo.MarkFinalizationFailed(ctx, claimed.ID, msg, s.clock); markErr != nil {
				log.Printf("[qr-pagos] MarkFinalizationFailed saleId=0 intent=%d: %v", claimed.ID, markErr)
			}
			s.publishTrayFromIntent(claimed, models.QRTrayKindError, "Resultado de venta inconsistente.")
			return
		}
		saleID = uint64(sale.SaleID)
	}

	// Paso 4: SUCCEEDED + emisión SSE.
	if err := s.repo.MarkFinalizationSucceeded(ctx, claimed.ID, saleID, s.clock); err != nil {
		// La venta YA se materializó (CreateSale/UpdateSaleFromQR commiteó).
		// Si falla la marca, lo logueamos y seguimos: el próximo barrido lo
		// recomputará, y como ambos caminos son idempotentes
		// (ClientTxId en CreateSale, ClaimForFinalization en UpdateSaleFromQR),
		// no habrá doble venta ni doble aplicación.
		log.Printf("[qr-pagos] MarkFinalizationSucceeded intent=%d sale=%d: %v (venta ya cerrada, no se duplica)", claimed.ID, saleID, err)
	}

	// Hidratar el intent con el saleId para los eventos SSE.
	claimed.RelatedSaleID = &saleID
	if claimed.ApprovedAt == nil {
		now := s.clock()
		claimed.ApprovedAt = &now
	}
	// Publicar APROBADO al stream del venta_temp_id (si el modal
	// sigue abierto en algún PC).
	s.publishIntentSnapshot(claimed)
	// Publicar al tray de la caja.
	s.publishTrayFromIntent(claimed, models.QRTrayKindApproved, "")

	// MarkCashierNotified (timestamp, no cambia venta/stock).
	if err := s.repo.MarkCashierNotified(ctx, claimed.ID, s.clock); err != nil {
		log.Printf("[qr-pagos] MarkCashierNotified intent=%d: %v", claimed.ID, err)
	}
}

// =========================================================================
// Sweeper de finalización
// =========================================================================

// StartFinalizationSweeper arranca un ticker periódico que levanta las
// intenciones APROBADAS cuya materialización no está cerrada
// (NOT_STARTED, FAILED con retry listo, IN_PROGRESS atascado) y las
// despacha. Idempotente respecto a ClaimForFinalization: dos sweepers
// en paralelo pelean por la fila y uno pierde silenciosamente.
//
// El ticker se detiene cuando ctx se cancela. Pensado para
// `go posQrService.StartFinalizationSweeper(serverCtx)` al arranque.
func (s *QrPaymentService) StartFinalizationSweeper(ctx context.Context) {
	if s == nil || s.saleService == nil {
		return
	}
	ticker := time.NewTicker(models.QRFinalizationSweepInterval)
	defer ticker.Stop()
	// Primera corrida inmediata para cubrir reinicios recientes.
	s.sweepFinalizationOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sweepFinalizationOnce(ctx)
		}
	}
}

// sweepFinalizationOnce ejecuta una pasada del sweeper. Pensado para
// que los tests lo puedan invocar sin arrancar el ticker.
func (s *QrPaymentService) sweepFinalizationOnce(ctx context.Context) {
	if s == nil || s.saleService == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[qr-pagos] sweeper panic recuperado: %v", r)
		}
	}()
	batch, err := s.repo.ListPendingFinalization(ctx, s.clock(), 50)
	if err != nil {
		log.Printf("[qr-pagos] sweeper ListPendingFinalization: %v", err)
		return
	}
	for i := range batch {
		intent := batch[i]
		s.DispatchAutoSale(ctx, &intent)
	}
}

// =========================================================================
// Helpers
// =========================================================================

// buildSaleFromSnapshots traduce los JSONB del intent a un models.Sale
// listo para SaleService.CreateSale. Valida que el ClientTxId esté
// presente y que el carrito tenga al menos un item.
//
// Devuelve también `editTargetSaleID`. Si > 0, el dispatcher debe
// invocar UpdateSaleFromQR(editTargetSaleID, …) en lugar de CreateSale
// — modo "QR en edición".
func buildSaleFromSnapshots(intent *models.QrPaymentIntent) (*models.Sale, uint64, error) {
	if intent == nil {
		return nil, 0, errors.New("intent nil")
	}
	cartRaw := strings.TrimSpace(intent.CartSnapshot)
	if cartRaw == "" {
		return nil, 0, errors.New("cart_snapshot vacío")
	}
	var cart []qrSaleCartItem
	if err := json.Unmarshal([]byte(cartRaw), &cart); err != nil {
		return nil, 0, fmt.Errorf("cart_snapshot inválido: %w", err)
	}
	if len(cart) == 0 {
		return nil, 0, errors.New("cart_snapshot sin items")
	}
	var totals qrSaleTotals
	if raw := strings.TrimSpace(intent.TotalsSnapshot); raw != "" {
		if err := json.Unmarshal([]byte(raw), &totals); err != nil {
			return nil, 0, fmt.Errorf("totals_snapshot inválido: %w", err)
		}
	}
	var client qrSaleClient
	if raw := strings.TrimSpace(intent.ClientSnapshot); raw != "" {
		// client_snapshot es opcional; si no parsea, log y continúa.
		if err := json.Unmarshal([]byte(raw), &client); err != nil {
			log.Printf("[qr-pagos] client_snapshot inválido intent=%d: %v", intent.ID, err)
		}
	}
	clientTx := strings.TrimSpace(intent.SaleClientTxID)
	if clientTx == "" {
		return nil, 0, errors.New("sale_client_tx_id vacío")
	}

	// Construir models.Sale canónico. EmployeeDNI viene de totals o del
	// created_by_dni como fallback para que CreateSale no lo rechace.
	employeeDNI := strings.TrimSpace(totals.EmployeeDNI)
	if employeeDNI == "" {
		employeeDNI = strings.TrimSpace(intent.CreatedByDNI)
	}
	clientDNI := strings.TrimSpace(client.DNI)
	if clientDNI == "" {
		clientDNI = "0000"
	}
	paymentMethod := strings.TrimSpace(totals.PaymentMethod)
	if paymentMethod == "" {
		paymentMethod = "BOLD_QR"
	}
	transferSource := strings.TrimSpace(totals.TransferSource)
	if transferSource == "" {
		transferSource = "BOLD_QR"
	}

	sale := &models.Sale{
		ClientTxId:        clientTx,
		SaleDate:          time.Now(),
		ClientDNI:         clientDNI,
		EmployeeDNI:       employeeDNI,
		TotalAmount:       totals.TotalAmount,
		PaymentMethod:     paymentMethod,
		AmountPaid:        totals.AmountPaid,
		CashAmount:        totals.CashAmount,
		TransferAmount:    totals.TransferAmount,
		TransferNequi:     totals.TransferNequi,
		TransferDaviplata: totals.TransferDaviplata,
		TransferSource:    transferSource,
		CreditAmount:      totals.CreditAmount,
		DebtPending:       totals.DebtPending,
		Change:            totals.Change,
		Status:            "PAID",
	}
	// Si totals viene vacío, al menos tenemos el amount del intent.
	if sale.TotalAmount == 0 {
		sale.TotalAmount = float64(intent.AmountCOP)
	}
	if sale.AmountPaid == 0 {
		sale.AmountPaid = float64(intent.AmountCOP)
	}
	if sale.TransferAmount == 0 && sale.CashAmount == 0 && sale.CreditAmount == 0 {
		sale.TransferAmount = float64(intent.AmountCOP)
	}
	// Pago mixto: transferAmount = Nequi + Daviplata + parte QR. Desde
	// 2026-10-26 el QR es de Daviplata: la parte QR se suma al bolsillo
	// Daviplata (cierre, dashboard y saldo la cuentan ahí, una sola vez).
	if generic := genericTransferPortion(sale); generic > 0.5 {
		sale.TransferDaviplata += generic
	}
	switch {
	case sale.TransferDaviplata > 0:
		sale.TransferSource = "DAVIPLATA"
	case sale.TransferNequi > 0:
		sale.TransferSource = "NEQUI"
	}
	// paymentMethod canónico derivado de los canales reales (el snapshot
	// es sólo una pista): "DAVIPLATA", "EFECTIVO + DAVIPLATA", etc.
	sale.PaymentMethod = deriveSalePaymentMethod(sale)

	details := make([]models.SaleDetail, 0, len(cart))
	for _, item := range cart {
		barcode := strings.TrimSpace(item.Barcode)
		if barcode == "" || item.Quantity <= 0 {
			return nil, 0, errors.New("cart item inválido")
		}
		sub := item.Subtotal
		if sub == 0 {
			sub = item.Quantity * item.UnitPrice
		}
		details = append(details, models.SaleDetail{
			Barcode:   barcode,
			Quantity:  item.Quantity,
			UnitPrice: item.UnitPrice,
			CostPrice: item.CostPrice,
			Subtotal:  sub,
		})
	}
	sale.SaleDetails = details
	return sale, totals.EditTargetSaleID, nil
}

// finalizationSecretsPattern detecta accidentes donde el token/firma
// pudiera quedar en el mensaje de error. Reemplaza por [REDACTED].
// Nunca loguea el valor interceptado — sólo marca que hubo redacción.
var finalizationSecretsPattern = regexp.MustCompile(
	`(?i)(BOLD_BRIDGE_TOKEN|BOLD_SECRET_KEY|X-Bridge-Token|X-Bold-Signature|X-Bold-Bridge-Token)\s*[:=]\s*[^\s"',]+`)

// sanitizeFinalizationError trunca el mensaje de error a 200 chars y
// aplica el filtro regex. También blanquea cualquier valor literal
// que coincida con la env var BOLD_BRIDGE_TOKEN o BOLD_SECRET_KEY si
// estuvieran accidentalmente concatenadas (defensa en profundidad).
func sanitizeFinalizationError(msg string) string {
	s := strings.TrimSpace(msg)
	if s == "" {
		s = "fallo sin mensaje"
	}
	// Filtro regex sobre patrones conocidos de keyvalue.
	s = finalizationSecretsPattern.ReplaceAllString(s, "$1=[REDACTED]")
	// Defensa en profundidad: si la env está presente, redactar literal.
	for _, env := range []string{"BOLD_BRIDGE_TOKEN", "BOLD_SECRET_KEY"} {
		if v := strings.TrimSpace(os.Getenv(env)); len(v) >= 8 {
			s = strings.ReplaceAll(s, v, "[REDACTED]")
		}
	}
	// Truncar a 200 chars operativos (el CHECK permite 255, dejamos
	// margen).
	const maxLen = 200
	if len(s) > maxLen {
		s = s[:maxLen]
	}
	return s
}

// Garantía estática de wiring: el dispatcher nunca se ejecuta si
// saleService o hub son nil. (Chequeos ya hechos en DispatchAutoSale,
// pero esta función explícita permite al handler sanity-check al
// arranque.)
func (s *QrPaymentService) AsyncDispatcherReady() bool {
	return s != nil && s.saleService != nil && s.hub != nil
}

// Suppress unused import check in test-only builds (sse referenced
// transitively through publishTrayFromIntent). Kept as reminder.
var _ = sse.QRTrayEvent{}
