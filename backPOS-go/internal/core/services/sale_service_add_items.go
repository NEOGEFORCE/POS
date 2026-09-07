package services

import (
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/cache"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ============================================================================
// EDICIÓN DIRECTA DE VENTAS (SUMAR Y RESTAR PRODUCTOS)
// ============================================================================
//
// El endpoint /sales/add-items/:id ya no es sólo "agregar". El dueño autorizó
// que también permita RESTAR productos sin redirigir a devoluciones:
//
//   * items[].quantity es FIRMADA: positivo agrega, negativo quita.
//   * cashAmount, transferAmount, transferNequi, transferDaviplata,
//     creditAmount llegan como magnitudes POSITIVAS elegidas en el modal.
//     Este servicio determina el signo aplicado según el delta monetario
//     neto (agrega o reembolsa).
//
// TODA la mutación (detalles + venta + stock + crédito) ocurre dentro de UNA
// sola transacción con SELECT FOR UPDATE sobre la venta. Se elimina la doble
// mutación pre-tx del código anterior; la venta bloqueada es la fuente de
// verdad y todos los deltas se aplican sobre ella.
// ============================================================================

// SaleEditSummary es el resumen devuelto al handler para auditoría,
// notificación por Telegram y SSE del dashboard.
type SaleEditSummary struct {
	SaleID         uint
	Direction      string  // "add", "subtract", "zero"
	MonetaryDelta  float64 // firmado
	NewTotal       float64
	ClientDNI      string
	LinesAdded     int
	LinesReduced   int
	LinesRemoved   int
	CashDelta      float64
	TransferDelta  float64
	NequiDelta     float64
	DaviplataDelta float64
	CreditDelta    float64
	// TransferSource conserva el usado al final (útil para el mensaje neutro).
	TransferSource string
	// PaymentMethod recalculado tras el edit.
	PaymentMethod string
	// EmployeeDNI del cajero que ejecutó la edición.
	EmployeeDNI string
}

// applySaleEdit ejecuta la mutación transaccional de una edición firmada.
//
// Errores de negocio (que el handler debe traducir a HTTP 400):
//   - Venta sin estado válido para editar.
//   - Producto no encontrado.
//   - Cantidad final negativa.
//   - Reembolso insuficiente por canal.
//   - Reducción de crédito debajo de abonos ya registrados.
//   - Aumento de crédito por encima del límite.
//   - Delta neto cero con pagos.
func (s *SaleService) applySaleEdit(
	saleID uint,
	items []SaleEditItemInput,
	req PaymentEditRequest,
	employeeDNI string,
) (*SaleEditSummary, error) {
	if len(items) == 0 {
		return nil, errors.New("no hay items para procesar")
	}

	rawDB, ok := s.saleRepo.GetDB().(*gorm.DB)
	if !ok {
		return nil, errors.New("error de sistema: base de datos inválida")
	}

	// Precargar catálogo para las líneas nuevas (barcode no MISC).
	uniqueBarcodes := make([]string, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, it := range items {
		if strings.HasPrefix(it.Barcode, "MISC-") || it.Barcode == "0000" {
			continue
		}
		if _, dup := seen[it.Barcode]; dup {
			continue
		}
		seen[it.Barcode] = struct{}{}
		uniqueBarcodes = append(uniqueBarcodes, it.Barcode)
	}
	var productsDB []models.Product
	if len(uniqueBarcodes) > 0 {
		var err error
		productsDB, err = s.productRepo.GetByBarcodes(uniqueBarcodes)
		if err != nil {
			return nil, fmt.Errorf("error cargando productos: %w", err)
		}
	}
	productLookup := buildProductLookup(productsDB)

	summary := &SaleEditSummary{SaleID: saleID, EmployeeDNI: employeeDNI}

	txErr := rawDB.Transaction(func(tx *gorm.DB) error {
		// SELECT FOR UPDATE de la venta y sus detalles. Es la fuente de verdad
		// del edit: cualquier cambio se aplica sobre este snapshot bloqueado.
		var sale models.Sale
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Preload("SaleDetails.Product.BaseProduct").
			Where("\"saleId\" = ?", saleID).First(&sale).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errors.New("venta no encontrada")
			}
			return fmt.Errorf("error bloqueando venta: %w", err)
		}
		if sale.Status != "PAID" && sale.Status != "CREDIT" {
			return errors.New("no se puede editar esta venta: estado " + sale.Status)
		}

		// Enriquecer el productLookup con los productos referenciados por
		// detalles existentes (por si tenemos que ajustar packs de líneas
		// que no llegaron en el request).
		for i := range sale.SaleDetails {
			d := &sale.SaleDetails[i]
			if d.Product.Barcode != "" {
				if _, ok := productLookup[d.Product.Barcode]; !ok {
					clone := d.Product
					productLookup[d.Product.Barcode] = &clone
				}
			}
		}

		plan, err := BuildSaleEditPlan(sale.SaleDetails, items, productLookup)
		if err != nil {
			return err
		}
		if len(plan.Lines) == 0 {
			return errors.New("no hay cambios que aplicar")
		}

		summary.ClientDNI = sale.ClientDNI

		// Preparar el estado del cliente (solo si hay ajuste de crédito).
		var lockedClient *models.Client
		needsCreditLock := req.CreditAmount > 0.0001 && sale.ClientDNI != "" && sale.ClientDNI != "0"
		if needsCreditLock {
			var client models.Client
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("dni = ?", sale.ClientDNI).First(&client).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return errors.New("cliente no encontrado para ajuste de crédito")
				}
				return fmt.Errorf("error bloqueando cliente: %w", err)
			}
			lockedClient = &client
		}

		currentBalances := SaleChannelBalances{
			CashAmount:        sale.CashAmount,
			TransferAmount:    sale.TransferAmount,
			TransferNequi:     sale.TransferNequi,
			TransferDaviplata: sale.TransferDaviplata,
			CreditAmount:      sale.CreditAmount,
			DebtPending:       sale.DebtPending,
		}
		if lockedClient != nil {
			currentBalances.CreditLimit = lockedClient.CreditLimit
			currentBalances.CurrentCredit = lockedClient.CurrentCredit
		}

		payment, err := BuildPaymentEditPlan(plan.MonetaryDelta, req, currentBalances)
		if err != nil {
			return err
		}
		summary.MonetaryDelta = plan.MonetaryDelta
		summary.Direction = payment.Direction
		summary.CashDelta = payment.CashDelta
		summary.TransferDelta = payment.TransferDelta
		summary.NequiDelta = payment.NequiDelta
		summary.DaviplataDelta = payment.DaviplataDelta
		summary.CreditDelta = payment.CreditDelta

		// Aplicar los deltas a la venta.
		sale.TotalAmount += plan.MonetaryDelta
		if sale.TotalAmount < 0 {
			// Reducción inconsistente: los ítems dan negativo total.
			return fmt.Errorf("total de venta quedaría negativo: %.2f", sale.TotalAmount)
		}
		sale.CashAmount += payment.CashDelta
		sale.CreditAmount += payment.CreditDelta

		// --- TRANSFERENCIAS ---
		//
		// Invariante del modelo: sale.TransferAmount es el TOTAL, es decir
		// genérico + Nequi + Daviplata. payment.TransferDelta es el delta de
		// la porción GENÉRICA (Bancolombia/tarjeta/otros), NO del total.
		//
		// Se calcula la parte genérica ANTES de mutar el desglose para no
		// tener que "descompensar" los deltas después. Con esto el orden de
		// las asignaciones deja de ser significativo.
		genericBefore := sale.TransferAmount - sale.TransferNequi - sale.TransferDaviplata
		if genericBefore < 0 {
			// Dato histórico incoherente (total menor que el desglose). Se
			// trata como cero para no propagar el error hacia adelante.
			genericBefore = 0
		}
		genericAfter := genericBefore + payment.TransferDelta
		if genericAfter < 0 {
			return errors.New("canal TRANSFERENCIA insuficiente")
		}

		sale.TransferNequi += payment.NequiDelta
		sale.TransferDaviplata += payment.DaviplataDelta
		sale.TransferAmount = genericAfter + sale.TransferNequi + sale.TransferDaviplata

		// Validar saldos finales (no negativos): defense-in-depth. Ya se validó
		// en BuildPaymentEditPlan, pero la aritmética con floats puede dejar
		// residuos.
		if sale.CashAmount < -0.01 {
			return errors.New("saldo final de EFECTIVO negativo")
		}
		if sale.TransferAmount < -0.01 {
			return errors.New("saldo final de TRANSFERENCIA negativo")
		}
		if sale.TransferNequi < -0.01 {
			return errors.New("saldo final de NEQUI negativo")
		}
		if sale.TransferDaviplata < -0.01 {
			return errors.New("saldo final de DAVIPLATA negativo")
		}
		if sale.CreditAmount < -0.01 {
			return errors.New("saldo final de CRÉDITO negativo")
		}
		// Snap residuos a 0.
		if sale.CashAmount < 0 {
			sale.CashAmount = 0
		}
		if sale.TransferAmount < 0 {
			sale.TransferAmount = 0
		}
		if sale.TransferNequi < 0 {
			sale.TransferNequi = 0
		}
		if sale.TransferDaviplata < 0 {
			sale.TransferDaviplata = 0
		}
		if sale.CreditAmount < 0 {
			sale.CreditAmount = 0
		}

		if payment.TransferSource != "" {
			sale.TransferSource = payment.TransferSource
		}

		// AmountPaid refleja el total efectivamente registrado.
		sale.AmountPaid = sale.CashAmount + sale.TransferAmount + sale.CreditAmount
		sale.Change = RecalculateSaleCash(sale.TotalAmount, sale.CashAmount, sale.TransferAmount, sale.CreditAmount)

		// Ajustar crédito y CurrentCredit del cliente bajo lock.
		if payment.CreditDelta != 0 {
			// El nuevo DebtPending = CreditAmount - alreadyPaid.
			// alreadyPaid se preserva (no se toca por edición).
			alreadyPaid := currentBalances.CreditAmount - currentBalances.DebtPending
			if alreadyPaid < 0 {
				alreadyPaid = 0
			}
			newDebt := sale.CreditAmount - alreadyPaid
			if newDebt < 0.01 {
				newDebt = 0
			}
			debtDelta := newDebt - currentBalances.DebtPending
			sale.DebtPending = newDebt

			// Refrescar el estado del cliente:
			//   currentCredit += debtDelta
			if lockedClient == nil {
				return errors.New("ajuste de crédito requiere cliente asignado")
			}
			newCurrent := lockedClient.CurrentCredit + debtDelta
			if newCurrent < 0 {
				newCurrent = 0
			}
			if lockedClient.CreditLimit > 0 && newCurrent > lockedClient.CreditLimit+0.01 {
				return fmt.Errorf("límite de crédito superado: nuevo saldo $%.2f > límite $%.2f", newCurrent, lockedClient.CreditLimit)
			}
			if err := tx.Model(&models.Client{}).Where("dni = ?", sale.ClientDNI).Updates(map[string]interface{}{
				"currentCredit": newCurrent,
				"updatedByDni":  employeeDNI,
			}).Error; err != nil {
				return fmt.Errorf("error actualizando crédito del cliente: %w", err)
			}
		}

		// Estado de venta: CREDIT si aún hay DebtPending, PAID en caso contrario.
		if sale.DebtPending > 0.01 {
			sale.Status = "CREDIT"
		} else {
			sale.Status = "PAID"
			sale.DebtPending = 0
		}
		sale.PaymentMethod = deriveSalePaymentMethod(&sale)
		summary.PaymentMethod = sale.PaymentMethod
		summary.TransferSource = sale.TransferSource
		summary.NewTotal = sale.TotalAmount

		// Persistir cambios en la fila de la venta.
		if err := tx.Model(&models.Sale{}).Where("\"saleId\" = ?", sale.SaleID).Updates(map[string]interface{}{
			"totalAmount":       sale.TotalAmount,
			"cashAmount":        sale.CashAmount,
			"transferAmount":    sale.TransferAmount,
			"transferNequi":     sale.TransferNequi,
			"transferDaviplata": sale.TransferDaviplata,
			"transferSource":    sale.TransferSource,
			"creditAmount":      sale.CreditAmount,
			"debtPending":       sale.DebtPending,
			"amountPaid":        sale.AmountPaid,
			"change":            sale.Change,
			"paymentMethod":     sale.PaymentMethod,
			"status":            sale.Status,
		}).Error; err != nil {
			return fmt.Errorf("error actualizando venta: %w", err)
		}

		// Persistir cambios en sale_details.
		for _, line := range plan.Lines {
			switch {
			case line.DeleteDetail:
				if err := tx.Where("\"saleId\" = ? AND barcode = ?", sale.SaleID, line.Barcode).
					Delete(&models.SaleDetail{}).Error; err != nil {
					return fmt.Errorf("error eliminando detalle %s: %w", line.Barcode, err)
				}
				summary.LinesRemoved++
			case line.CreateDetail:
				newDetail := models.SaleDetail{
					SaleID:    sale.SaleID,
					Barcode:   line.Barcode,
					Quantity:  line.FinalQuantity,
					UnitPrice: line.UnitPrice,
					CostPrice: line.CostPrice,
					Subtotal:  line.NewSubtotal,
				}
				if err := tx.Create(&newDetail).Error; err != nil {
					return fmt.Errorf("error creando detalle %s: %w", line.Barcode, err)
				}
				summary.LinesAdded++
			default:
				// Actualización en sitio: solo cantidad y subtotal, NUNCA precio.
				if err := tx.Model(&models.SaleDetail{}).
					Where("\"saleId\" = ? AND barcode = ?", sale.SaleID, line.Barcode).
					Updates(map[string]interface{}{
						"quantity": line.FinalQuantity,
						"subtotal": line.NewSubtotal,
					}).Error; err != nil {
					return fmt.Errorf("error actualizando detalle %s: %w", line.Barcode, err)
				}
				if line.Delta > 0 {
					summary.LinesAdded++
				} else {
					summary.LinesReduced++
				}
			}
		}

		// Ajustar stock (BatchAdjust: quantity = quantity - delta; delta positivo
		// descuenta y negativo repone).
		if len(plan.StockDelta) > 0 {
			if err := s.productRepo.BatchAdjustQuantitiesWithTx(tx, plan.StockDelta); err != nil {
				return fmt.Errorf("error ajustando inventario: %w", err)
			}
		}

		// Kárdex: un movimiento por línea afectada.
		movements := make([]models.StockMovement, 0, len(plan.Lines))
		for _, line := range plan.Lines {
			if line.IsMISC || line.EffectiveStockDelta == 0 {
				continue
			}
			m := models.StockMovement{
				Date:         time.Now(),
				Barcode:      line.StockBarcode,
				ReferenceID:  fmt.Sprintf("SALE-%d", sale.SaleID),
				EmployeeDNI:  employeeDNI,
				EmployeeName: "CAJERO",
				Reason:       models.MovementReasonEditApply,
			}
			if line.EffectiveStockDelta > 0 {
				m.Type = models.MovementTypeOut
				m.Quantity = line.EffectiveStockDelta
			} else {
				m.Type = models.MovementTypeIn
				m.Quantity = math.Abs(line.EffectiveStockDelta)
			}
			movements = append(movements, m)
		}
		if len(movements) > 0 {
			if err := s.movementRepo.BatchSaveWithTx(tx, movements); err != nil {
				return fmt.Errorf("error guardando kárdex: %w", err)
			}
		}

		return nil
	})
	if txErr != nil {
		return nil, txErr
	}

	// Post-commit: invalidaciones y notificaciones.
	if summary.ClientDNI != "" && summary.ClientDNI != "0" {
		cache.InvalidateCache(cache.CacheKeyClients)
		cache.InvalidateCache(fmt.Sprintf("client_dni_%s", summary.ClientDNI))
	}
	s.saleRepo.AfterCommit()

	// Telegram: mensaje NEUTRAL que informa suma o resta.
	go func() {
		defer func() { recover() }()
		if s.telegramService == nil {
			return
		}
		signSymbol := "+"
		if summary.Direction == "subtract" {
			signSymbol = "-"
		} else if summary.Direction == "zero" {
			signSymbol = "="
		}
		msg := fmt.Sprintf("✏️ *VENTA EDITADA* %s\n\n"+
			"*Venta:* #%d\n"+
			"*Delta:* $%s%.2f\n"+
			"*Cajero:* %s\n"+
			"*Líneas +:* %d · *Líneas -:* %d · *Eliminadas:* %d",
			signSymbol, summary.SaleID,
			signSymbol, math.Abs(summary.MonetaryDelta),
			summary.EmployeeDNI,
			summary.LinesAdded, summary.LinesReduced, summary.LinesRemoved)
		s.telegramService.SendMarkdownAlert(msg)
	}()

	log.Printf("[AddItemsToSale] venta #%d edit dir=%s delta=$%.2f cash=$%.2f nequi=$%.2f davi=$%.2f transfer=$%.2f credit=$%.2f",
		summary.SaleID, summary.Direction, summary.MonetaryDelta,
		summary.CashDelta, summary.NequiDelta, summary.DaviplataDelta,
		summary.TransferDelta, summary.CreditDelta)

	return summary, nil
}

// AddItemsToSaleV2 es el punto de entrada del servicio para /sales/add-items/:id.
//
// Contrato:
//   - items[]: cada item lleva quantity FIRMADA no cero.
//   - cashAmount, transferAmount, transferNequi, transferDaviplata,
//     creditAmount: magnitudes POSITIVAS del modal.
//   - transferSource: string canal para transferencia genérica.
//   - employeeDNI: DNI del cajero autorizado.
//
// Devuelve un SaleEditSummary con la información que el handler necesita para
// auditoría, SSE del dashboard y mensaje Telegram.
func (s *SaleService) AddItemsToSaleV2(
	saleID uint,
	items []SaleEditItemInput,
	cashAmount, transferAmount, transferNequi, transferDaviplata, creditAmount float64,
	transferSource, employeeDNI string,
) (*SaleEditSummary, error) {
	req := PaymentEditRequest{
		CashAmount:        cashAmount,
		TransferAmount:    transferAmount,
		TransferNequi:     transferNequi,
		TransferDaviplata: transferDaviplata,
		TransferSource:    transferSource,
		CreditAmount:      creditAmount,
	}
	return s.applySaleEdit(saleID, items, req, employeeDNI)
}
