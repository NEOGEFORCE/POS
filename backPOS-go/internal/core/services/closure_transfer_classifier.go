package services

import (
	"strings"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================================
// Clasificación de TRANSFERENCIAS para el cierre runtime (DTO services.CashierClosure).
// =============================================================================
//
// Esta función pura es la fuente única del "a qué bolsillo del cierre va cada
// transferencia" que se consume en dashboard_service.GetCashierClosure.
//
// Regla B1 (2026-10-23): Bold QR / Bre-B viaja como TransferSource='BOLD_QR'
// desde el materializador asíncrono (ver pos_qr_async_dispatcher.go). El
// handler de cierres (dashboard_handler.go líneas ~108 y ~485) sólo copia
// `TotalOtherTransfer` al modelo persistente (models.CashierClosure NO tiene
// `TotalBoldQr`). Antes de este fix, cuando una venta/abono viajaba por
// BOLD_QR, el service lo acumulaba SÓLO en `TotalBoldQr` y lo descartaba de
// `TotalOtherTransfer`, así que al persistir el cierre:
//
//   • closure_metrics.DigitalIncome (NEQUI+DAVI+CARD+BANCOL+OtherTransfer)
//     perdía el QR;
//   • dashboard_service.ShiftIngresosDigitales lo mismo;
//   • el PDF y el mensaje de Telegram perdían el canal;
//   • audited_income.go también.
//
// El fix sin migración es tratar `TotalBoldQr` como SUBCONJUNTO INFORMATIVO:
// se SIGUE sumando a `TotalOtherTransfer` (así los consumidores legacy ven la
// plata) y además se expone en `TotalBoldQr` para que el dashboard pueda
// pintar la tarjeta "Bold QR" por separado. Ningún consumidor suma
// TotalOtherTransfer + TotalBoldQr, así que no hay doble conteo.

// classifyTransferToClosure clasifica un monto de transferencia (ya sea una
// venta o un abono) en el bolsillo correspondiente del cierre runtime.
//
// El parámetro `closure` se muta in-place: igual que lo hacía el switch
// inline original, pero centralizado para que ventas y abonos usen la misma
// clasificación y sea testeable sin BD.
//
// Si amount <= 0 la función es no-op (defensa contra abonos con monto 0 o
// transferAmount negativo).
func classifyTransferToClosure(transferSource string, amount float64, closure *CashierClosure) {
	if closure == nil {
		return
	}
	if amount <= 0 {
		return
	}
	switch strings.ToUpper(strings.TrimSpace(transferSource)) {
	case "NEQUI":
		closure.TotalNequi += amount
	case "DAVIPLATA":
		closure.TotalDaviplata += amount
	case "BANCOLOMBIA":
		closure.TotalBancolombia += amount
	case "TARJETA":
		closure.TotalCard += amount
	default:
		// Bold QR / Bre-B viaja como TransferSource="BOLD_QR" (ver
		// pos_qr_async_dispatcher.go). models.IsBoldQRSaleTransferSource
		// exige la marca "BOLD" para no capturar descripciones genéricas
		// con la palabra "QR".
		//
		// NOTA (B1): siempre sumamos a TotalOtherTransfer. Si además es
		// Bold QR, acumulamos el subconjunto informativo en TotalBoldQr.
		// Esto preserva DigitalIncome y ShiftIngresosDigitales
		// (closure_metrics.go:253 y dashboard_service.go:1081) sin
		// migración; TotalBoldQr existe sólo en el DTO runtime
		// (models.CashierClosure persistido NO lo tiene) y por eso ningún
		// consumidor suma TotalOtherTransfer + TotalBoldQr.
		closure.TotalOtherTransfer += amount
		if models.IsBoldQRSaleTransferSource(transferSource) {
			closure.TotalBoldQr += amount
		}
	}
}

// classifySaleTransferToClosure clasifica la transferencia de una VENTA.
//
// Para ventas Bold QR con pago mixto (QR + Nequi y/o Daviplata), el
// TransferAmount agrupa los tres canales; clasificarlo entero por
// TransferSource contaría el Nequi/Daviplata como Bold. Aquí se separa:
// Nequi → TotalNequi, Daviplata → TotalDaviplata, y sólo la porción
// genérica (la parte QR) va a OtherTransfer + TotalBoldQr.
//
// Para cualquier otra fuente se conserva exactamente el comportamiento
// histórico (todo el TransferAmount por TransferSource), para no alterar
// cierres de ventas legacy MIXTO/NEQUI/DAVIPLATA.
func classifySaleTransferToClosure(sale models.Sale, closure *CashierClosure) {
	if closure == nil || sale.TransferAmount <= 0 {
		return
	}
	if !models.IsBoldQRSaleTransferSource(sale.TransferSource) {
		classifyTransferToClosure(sale.TransferSource, sale.TransferAmount, closure)
		return
	}
	nequi := sale.TransferNequi
	if nequi < 0 {
		nequi = 0
	}
	davi := sale.TransferDaviplata
	if davi < 0 {
		davi = 0
	}
	classifyTransferToClosure("NEQUI", nequi, closure)
	classifyTransferToClosure("DAVIPLATA", davi, closure)
	classifyTransferToClosure(sale.TransferSource, genericTransferPortion(&sale), closure)
}
