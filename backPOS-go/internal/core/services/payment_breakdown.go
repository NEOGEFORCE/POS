package services

import (
	"sort"
	"strings"

	"backPOS-go/internal/core/domain/models"
)

// CalculatePaymentMethodsBreakdown agrupa los totales de un cierre por
// método de pago EXACTO (sin colapsar en un genérico "OTROS"). El nombre
// del método sale del campo TransferSource de cada venta o pago — tal
// como lo registró el cajero en el momento de la operación.
//
// Devuelve un slice ordenado de mayor a menor por monto total, ideal para
// renderizar en grids del frontend sin tarjetas estáticas.
//
// Reglas:
//   - Solo cuenta ventas en estado PAID o CREDIT (las CANCELLED se ignoran).
//   - Cash + Change neto se suma a EFECTIVO.
//   - TransferAmount se suma bajo el nombre normalizado de TransferSource.
//     Si TransferSource viene vacío, cae a "TRANSFERENCIA" como etiqueta
//     genérica (rara y solo legacy).
//   - CreditAmount se suma a FIADO.
//   - Pagos múltiples (campo MultiplePayments del Sale) se respetan si
//     vienen poblados — útil cuando una venta tuvo varios métodos.
//   - CreditPayments (abonos posteriores a fiados) también suman:
//     AmountCash a EFECTIVO y AmountTransfer al TransferSource del abono.
//   - Métodos con total ≤ 0 se descartan del slice final.
func CalculatePaymentMethodsBreakdown(
	sales []models.Sale,
	payments []models.CreditPayment,
) []models.PaymentMethodTotal {
	totals := make(map[string]float64)

	addToBucket := func(rawMethod string, amount float64, fallback string) {
		if amount <= 0 {
			return
		}
		method := strings.ToUpper(strings.TrimSpace(rawMethod))
		if method == "" {
			method = fallback
		}
		totals[method] += amount
	}

	for _, sale := range sales {
		status := strings.ToUpper(sale.Status)
		if status != "PAID" && status != "CREDIT" {
			continue
		}

		// Efectivo neto (cashAmount menos vuelto entregado).
		netCash := sale.CashAmount - sale.Change
		addToBucket("EFECTIVO", netCash, "EFECTIVO")

		// Transferencia con su origen específico.
		addToBucket(sale.TransferSource, sale.TransferAmount, "TRANSFERENCIA")

		// Crédito otorgado (fiado).
		addToBucket("FIADO", sale.CreditAmount, "FIADO")

		// Pagos múltiples (cuando el flujo de venta los llena explícitamente).
		for _, mp := range sale.MultiplePayments {
			addToBucket(mp.Method, mp.Amount, "OTRO")
		}
	}

	for _, p := range payments {
		addToBucket("EFECTIVO", p.AmountCash, "EFECTIVO")
		addToBucket(p.TransferSource, p.AmountTransfer, "TRANSFERENCIA")
	}

	breakdown := make([]models.PaymentMethodTotal, 0, len(totals))
	for method, total := range totals {
		if total <= 0 {
			continue
		}
		breakdown = append(breakdown, models.PaymentMethodTotal{
			Method: method,
			Total:  total,
		})
	}

	// Orden estable: primero los métodos con mayor total. Empate desempata
	// alfabéticamente para que el output sea determinista entre llamadas.
	sort.Slice(breakdown, func(i, j int) bool {
		if breakdown[i].Total != breakdown[j].Total {
			return breakdown[i].Total > breakdown[j].Total
		}
		return breakdown[i].Method < breakdown[j].Method
	})

	return breakdown
}
