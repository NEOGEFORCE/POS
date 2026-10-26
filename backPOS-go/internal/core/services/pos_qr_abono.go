package services

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/sse"
)

// =========================================================================
// Abono de fiado por QR / llave Daviplata
// =========================================================================
//
// El cliente abona su cuenta de fiado pagando por QR o llave. El frontend
// abre el cobro QR con un snapshot {abonoClientDni, totalAmount=monto} y un
// carrito simbólico (una línea "ABONO"). Cuando llega el SMS de Daviplata y
// la intención se aprueba, el materializador NO crea una venta: registra el
// abono con ClientService.PayCredit (transferencia DAVIPLATA), que reparte el
// monto sobre las ventas fiadas más antiguas y baja la cartera del cliente.
//
// related_sale_id de la intención guarda el ID del ABONO (credit_payments.id),
// no una venta: es el identificador que el modal muestra al confirmar.
//
// Idempotencia: ClaimForFinalization evita dos ejecuciones simultáneas; si un
// reintento llega después de guardar el abono (p.ej. falló la marca de éxito),
// FindQrAbonoPayment detecta el abono ya registrado y no lo duplica.

// WithAbonos habilita el abono de fiado por QR.
func (s *QrPaymentService) WithAbonos(clientService *ClientService, saleRepo ports.SaleRepository) *QrPaymentService {
	s.clientService = clientService
	s.abonoSaleRepo = saleRepo
	return s
}

// snapshotAbonoClientDNI lee el DNI del cliente si el cobro QR es un abono.
func snapshotAbonoClientDNI(intent *models.QrPaymentIntent) string {
	if intent == nil || strings.TrimSpace(intent.TotalsSnapshot) == "" {
		return ""
	}
	var t qrSaleTotals
	if err := json.Unmarshal([]byte(intent.TotalsSnapshot), &t); err != nil {
		return ""
	}
	dni := strings.TrimSpace(t.AbonoClientDNI)
	if dni == "0" || dni == "0000" {
		return ""
	}
	return dni
}

// dispatchAbono registra el abono de un cobro QR aprobado.
func (s *QrPaymentService) dispatchAbono(ctx context.Context, claimed *models.QrPaymentIntent, clientDNI string) {
	fail := func(msg, trayMsg string) {
		if markErr := s.repo.MarkFinalizationFailed(ctx, claimed.ID, sanitizeFinalizationError(msg), s.clock); markErr != nil {
			log.Printf("[qr-pagos] MarkFinalizationFailed abono intent=%d: %v", claimed.ID, markErr)
		}
		s.publishTrayFromIntent(claimed, models.QRTrayKindError, trayMsg)
	}
	if s.clientService == nil || s.abonoSaleRepo == nil {
		fail("abono por QR no habilitado en el servidor", "No se pudo registrar el abono por QR.")
		return
	}
	amount := float64(claimed.AmountCOP)
	employee := strings.TrimSpace(claimed.CreatedByDNI)

	paymentID, err := s.repo.FindQrAbonoPayment(ctx, clientDNI, amount, claimed.CreatedAt)
	if err != nil {
		fail(fmt.Sprintf("verificar abono existente: %v", err), "No se pudo registrar el abono por QR.")
		return
	}
	var updatedClient *models.Client
	if paymentID == 0 {
		payment := &models.CreditPayment{
			ClientDNI:      clientDNI,
			EmployeeDNI:    employee,
			PaymentDate:    s.clock(),
			AmountTransfer: amount,
			TransferSource: "DAVIPLATA",
			TotalPaid:      amount,
		}
		updatedClient, err = s.clientService.PayCredit(payment, s.abonoSaleRepo)
		if err != nil {
			fail(err.Error(), "No se pudo registrar el abono: "+err.Error())
			return
		}
		paymentID = uint64(payment.ID)
		if s.audit != nil {
			s.audit.Log(employee, "", "PAY_CREDIT", "FINANCES",
				fmt.Sprintf("Abono crédito por QR Daviplata: %s ($%.2f) intent=%d", clientDNI, amount, claimed.ID),
				fmt.Sprintf("Se registró un abono de $%.0f por QR/llave Daviplata para el cliente %s", amount, clientDNI),
				"", "", "", true)
		}
	}

	if err := s.repo.MarkFinalizationSucceeded(ctx, claimed.ID, paymentID, s.clock); err != nil {
		log.Printf("[qr-pagos] MarkFinalizationSucceeded abono intent=%d pago=%d: %v (abono ya registrado, no se duplica)", claimed.ID, paymentID, err)
	}
	claimed.RelatedSaleID = &paymentID
	if claimed.ApprovedAt == nil {
		now := s.clock()
		claimed.ApprovedAt = &now
	}
	s.publishIntentSnapshot(claimed)
	s.publishTrayFromIntent(claimed, models.QRTrayKindApproved, "")
	if err := s.repo.MarkCashierNotified(ctx, claimed.ID, s.clock); err != nil {
		log.Printf("[qr-pagos] MarkCashierNotified abono intent=%d: %v", claimed.ID, err)
	}
	go func() {
		defer func() { _ = recover() }()
		if updatedClient != nil {
			sse.GetSSEService().BroadcastCustomerUpdate(updatedClient)
		}
		sse.GetSSEService().BroadcastDashboardUpdate()
	}()
}

// ensure time import used even if refactors drop it.
var _ = time.Second
