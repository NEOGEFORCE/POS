package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
)

// =========================================================================
// Enlazar un pago QR sin asignar a una venta YA registrada
// =========================================================================
//
// Flujo (sólo admin, sin migración):
//
//  1. ListSaleCandidatesForEvent sugiere ventas del ±12 h alrededor del
//     pago cuyo efectivo neto cubre el monto (exactas primero, luego por
//     cercanía de hora).
//  2. LinkEventToSale arma EN EL SERVIDOR una intención con snapshot
//     {editSaleId, linkPaymentOnly, efectivo − monto, Bold + monto} y la
//     empareja con el evento por el camino canónico AssignEventToIntent
//     (lock, chequeo de monto, auditoría, SSE). El materializador aplica
//     ApplyQRPaymentToSale: cambia sólo el pago, nunca productos ni stock.

// QRLinkCandidateWindow es la ventana de búsqueda alrededor del pago.
const QRLinkCandidateWindow = 12 * time.Hour

var (
	// ErrQRLinkForbidden: enlazar a ventas existentes es sólo para admin.
	ErrQRLinkForbidden = errors.New("sólo un administrador puede enlazar pagos a ventas registradas")
	// ErrQRLinkSaleNotFound: la venta no existe o está anulada.
	ErrQRLinkSaleNotFound = errors.New("la venta no existe o está anulada")
	// ErrQRLinkInsufficientCash: la venta no tiene efectivo que pasar a Bold.
	ErrQRLinkInsufficientCash = errors.New("la venta no tiene suficiente efectivo para pasar ese monto a Bold; use Corregir pago")
)

// SaleCandidateOut es lo que la bandeja muestra por cada venta sugerida.
type SaleCandidateOut struct {
	SaleID         uint      `json:"saleId"`
	SaleDate       time.Time `json:"saleDate"`
	TotalAmount    float64   `json:"totalAmount"`
	CashNet        float64   `json:"cashAmount"`
	TransferAmount float64   `json:"transferAmount"`
	PaymentMethod  string    `json:"paymentMethod"`
	EmployeeName   string    `json:"employeeName,omitempty"`
	ClientName     string    `json:"clientName,omitempty"`
	// MinutesFromPayment: minutos entre la venta y el pago (negativo =
	// la venta fue antes del pago).
	MinutesFromPayment int  `json:"minutesFromPayment"`
	ExactAmount        bool `json:"exactAmount"`
}

// loadUnassignedEvent valida que el evento exista y siga sin asignar.
func (s *QrPaymentService) loadUnassignedEvent(ctx context.Context, eventID uint64) (*models.QrWebhookEvent, error) {
	if s == nil || s.repo == nil {
		return nil, ErrQRInvalidInput
	}
	ev, err := s.repo.GetWebhookEventByID(ctx, eventID)
	if err != nil {
		if errors.Is(err, repositories.ErrQREventNotFound) {
			return nil, ErrQREventNotFound
		}
		if errors.Is(err, repositories.ErrQRInvalidInput) {
			return nil, ErrQRInvalidInput
		}
		return nil, fmt.Errorf("qr: leer evento falló: %w", err)
	}
	if ev.MatchedIntentID != nil ||
		(ev.ProcessedStatus != models.QRWebhookStatusUnmatched && ev.ProcessedStatus != models.QRWebhookStatusAmbiguous) {
		return nil, ErrQREventAlreadyAssigned
	}
	return ev, nil
}

// ListSaleCandidatesForEvent sugiere ventas para un pago sin asignar.
func (s *QrPaymentService) ListSaleCandidatesForEvent(ctx context.Context, eventID uint64, actorIsAdmin bool) ([]SaleCandidateOut, error) {
	if !actorIsAdmin {
		return nil, ErrQRLinkForbidden
	}
	ev, err := s.loadUnassignedEvent(ctx, eventID)
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.ListSaleCandidates(ctx, ev.AmountCOP, ev.ReceivedAt, QRLinkCandidateWindow, 10)
	if err != nil {
		return nil, fmt.Errorf("qr: buscar ventas candidatas falló: %w", err)
	}
	out := make([]SaleCandidateOut, 0, len(rows))
	for _, r := range rows {
		out = append(out, SaleCandidateOut{
			SaleID:             r.SaleID,
			SaleDate:           r.SaleDate,
			TotalAmount:        r.TotalAmount,
			CashNet:            r.CashNet,
			TransferAmount:     r.TransferAmount,
			PaymentMethod:      r.PaymentMethod,
			EmployeeName:       r.EmployeeName,
			ClientName:         r.ClientName,
			MinutesFromPayment: int(math.Round(r.SaleDate.Sub(ev.ReceivedAt).Minutes())),
			ExactAmount:        math.Abs(r.TotalAmount-float64(ev.AmountCOP)) < 1,
		})
	}
	return out, nil
}

// LinkEventToSaleInput parametriza el enlace.
type LinkEventToSaleInput struct {
	EventID      uint64
	SaleID       uint
	ActorDNI     string
	ActorName    string
	ActorIsAdmin bool
	IP           string
	Device       string
}

// buildLinkSnapshots arma (pura) los snapshots de la intención de enlace:
// mismos productos de la venta y el pago con `amount` movido de efectivo a
// Bold. Los demás canales (Nequi, Daviplata, fiado) se conservan.
func buildLinkSnapshots(sale *models.Sale, amount int64, actorDNI string) (cart, totals, client []byte, err error) {
	if sale == nil || sale.SaleID == 0 {
		return nil, nil, nil, ErrQRLinkSaleNotFound
	}
	if amount <= 0 {
		return nil, nil, nil, ErrQRInvalidInput
	}
	cashNet := sale.CashAmount - sale.Change
	if cashNet+1 < float64(amount) {
		return nil, nil, nil, ErrQRLinkInsufficientCash
	}
	newCash := cashNet - float64(amount)
	if newCash < 0.5 {
		newCash = 0
	}
	items := make([]qrSaleCartItem, 0, len(sale.SaleDetails))
	for _, d := range sale.SaleDetails {
		if strings.TrimSpace(d.Barcode) == "" || d.Quantity <= 0 {
			continue
		}
		items = append(items, qrSaleCartItem{
			Barcode: d.Barcode, Quantity: d.Quantity, UnitPrice: d.UnitPrice,
			CostPrice: d.CostPrice, Subtotal: d.Subtotal,
		})
	}
	if len(items) == 0 {
		return nil, nil, nil, errors.New("la venta no tiene productos registrados")
	}
	t := qrSaleTotals{
		TotalAmount:       sale.TotalAmount,
		AmountPaid:        newCash + sale.TransferAmount + float64(amount) + sale.CreditAmount,
		CashAmount:        newCash,
		TransferAmount:    sale.TransferAmount + float64(amount),
		TransferNequi:     sale.TransferNequi,
		TransferDaviplata: sale.TransferDaviplata,
		CreditAmount:      sale.CreditAmount,
		TransferSource:    "DAVIPLATA",
		EmployeeDNI:       strings.TrimSpace(actorDNI),
		EditTargetSaleID:  uint64(sale.SaleID),
		LinkPaymentOnly:   true,
	}
	if cart, err = json.Marshal(items); err != nil {
		return nil, nil, nil, err
	}
	if totals, err = json.Marshal(t); err != nil {
		return nil, nil, nil, err
	}
	client, err = json.Marshal(qrSaleClient{DNI: sale.ClientDNI})
	return cart, totals, client, err
}

func randomLinkTxID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("link-%d", time.Now().UnixNano())
	}
	return "link-" + hex.EncodeToString(b)
}

// LinkEventToSale enlaza el pago `EventID` a la venta `SaleID`.
func (s *QrPaymentService) LinkEventToSale(ctx context.Context, in LinkEventToSaleInput) (*AssignEventOutput, error) {
	if !in.ActorIsAdmin {
		return nil, ErrQRLinkForbidden
	}
	if in.EventID == 0 || in.SaleID == 0 || strings.TrimSpace(in.ActorDNI) == "" {
		return nil, ErrQRInvalidInput
	}
	if s.saleService == nil {
		return nil, ErrQREditUnavailable
	}
	ev, err := s.loadUnassignedEvent(ctx, in.EventID)
	if err != nil {
		return nil, err
	}
	if s.clock().Sub(ev.ReceivedAt) > models.QRAssignmentWindowAdmin {
		return nil, ErrQREventAlreadyAssigned
	}
	sale, err := s.saleService.GetSale(in.SaleID)
	if err != nil || sale == nil || sale.SaleID == 0 {
		return nil, ErrQRLinkSaleNotFound
	}
	if _, err := s.saleService.CheckQREditTarget(in.SaleID, in.ActorDNI); err != nil {
		return nil, err
	}
	cart, totals, client, err := buildLinkSnapshots(sale, ev.AmountCOP, in.ActorDNI)
	if err != nil {
		return nil, err
	}
	ventaTemp := fmt.Sprintf("enlace-%d-%d-%d", ev.ID, sale.SaleID, s.clock().Unix())
	if _, err := s.InitiateWithSnapshot(ctx, InitiateWithSnapshotInput{
		VentaTempID:    ventaTemp,
		CajaID:         "ENLACE-QR",
		ActorDNI:       in.ActorDNI,
		AmountCOP:      ev.AmountCOP,
		ClientTxID:     randomLinkTxID(),
		CartSnapshot:   cart,
		ClientSnapshot: client,
		TotalsSnapshot: totals,
	}); err != nil {
		return nil, err
	}
	return s.AssignEventToIntent(ctx, AssignEventInput{
		VentaTempID:  ventaTemp,
		EventID:      ev.ID,
		ActorDNI:     in.ActorDNI,
		ActorName:    in.ActorName,
		ActorIsAdmin: true,
		IP:           in.IP,
		Device:       in.Device,
	})
}
