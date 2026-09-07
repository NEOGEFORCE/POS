package services

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/cache"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (s *SaleService) UpdateSale(id uint, newSale *models.Sale, employeeDNI string, isAdmin bool) error {
	if !isAdmin {
		return errors.New("sólo los administradores pueden editar ventas")
	}

	oldSale, err := s.saleRepo.GetByID(id)
	if err != nil || oldSale == nil {
		return errors.New("venta original no encontrada")
	}

	revertAdjustments := make(map[string]float64)
	for _, detail := range oldSale.SaleDetails {
		if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
			continue
		}
		targetBarcode := detail.Barcode
		effectiveQty := detail.Quantity
		if detail.Product.IsPack && detail.Product.BaseProductBarcode != nil && *detail.Product.BaseProductBarcode != "" {
			targetBarcode = *detail.Product.BaseProductBarcode
			effectiveQty = detail.Quantity * float64(detail.Product.PackMultiplier)
		}
		revertAdjustments[targetBarcode] -= effectiveQty
	}

	var newTotal float64
	applyAdjustments := make(map[string]float64)
	for i := range newSale.SaleDetails {
		detail := &newSale.SaleDetails[i]
		detail.SaleID = id
		if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
			newTotal += detail.Subtotal
			continue
		}
		product, productErr := s.productRepo.GetByBarcode(detail.Barcode)
		if productErr != nil || product == nil {
			return fmt.Errorf("producto no encontrado: %s", detail.Barcode)
		}
		detail.UnitPrice = product.SalePrice
		detail.CostPrice = product.PurchasePrice
		detail.Subtotal = roundSaleLineSubtotal(product.SalePrice, detail.Quantity)
		newTotal += detail.Subtotal

		targetBarcode := detail.Barcode
		effectiveQty := detail.Quantity
		if product.IsPack && product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" {
			targetBarcode = *product.BaseProductBarcode
			effectiveQty = detail.Quantity * float64(product.PackMultiplier)
		}
		applyAdjustments[targetBarcode] += effectiveQty
	}

	if (oldSale.CashAmount > 0 || oldSale.TransferAmount > 0) && newTotal < oldSale.TotalAmount {
		return errors.New("no se puede disminuir el total de una venta cobrada en efectivo o transferencia; use una devolución")
	}

	newSale.TotalAmount = newTotal
	paidTotal := newSale.CashAmount + newSale.TransferAmount + newSale.CreditAmount
	if paidTotal < newTotal-5.0 {
		return fmt.Errorf("pago insuficiente: calculado %.2f, pagado %.2f", newTotal, paidTotal)
	}
	newSale.AmountPaid = paidTotal
	newSale.PaymentMethod = deriveSalePaymentMethod(newSale)

	alreadyPaidCredit := oldSale.CreditAmount - oldSale.DebtPending
	if alreadyPaidCredit < 0 {
		alreadyPaidCredit = 0
	}
	if newSale.CreditAmount+0.001 < alreadyPaidCredit {
		return fmt.Errorf("el nuevo crédito %.2f no puede ser menor que los abonos ya registrados %.2f", newSale.CreditAmount, alreadyPaidCredit)
	}
	newSale.DebtPending = newSale.CreditAmount - alreadyPaidCredit
	if newSale.DebtPending < 0.001 {
		newSale.DebtPending = 0
	}
	if newSale.CreditAmount > 0 {
		if newSale.ClientDNI == "" || newSale.ClientDNI == "0" {
			return errors.New("debe seleccionar un cliente real para crédito")
		}
		if alreadyPaidCredit > 0 && newSale.ClientDNI != oldSale.ClientDNI {
			return errors.New("no se puede cambiar el cliente de una venta que ya tiene abonos")
		}
		newSale.Status = "CREDIT"
	} else {
		newSale.Status = "PAID"
		newSale.DebtPending = 0
	}

	cashNeeded := newTotal - newSale.TransferAmount - newSale.CreditAmount
	if cashNeeded < 0 {
		cashNeeded = 0
	}
	newSale.Change = newSale.CashAmount - cashNeeded
	if newSale.Change < 0 {
		newSale.Change = 0
	}

	rawDB, ok := s.saleRepo.GetDB().(*gorm.DB)
	if !ok {
		return errors.New("error de sistema: base de datos inválida")
	}

	err = rawDB.Transaction(func(tx *gorm.DB) error {
		var lockedSale models.Sale
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Preload("SaleDetails.Product.BaseProduct").Where("\"saleId\" = ?", id).First(&lockedSale).Error; err != nil {
			return fmt.Errorf("error bloqueando venta: %w", err)
		}
		if lockedSale.CreditAmount != oldSale.CreditAmount || lockedSale.DebtPending != oldSale.DebtPending || lockedSale.TotalAmount != oldSale.TotalAmount {
			return errors.New("la venta cambió mientras se editaba; recargue e intente nuevamente")
		}
		revertAdjustments = make(map[string]float64)
		for _, detail := range lockedSale.SaleDetails {
			if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
				continue
			}
			targetBarcode := detail.Barcode
			effectiveQty := detail.Quantity
			if detail.Product.IsPack && detail.Product.BaseProductBarcode != nil && *detail.Product.BaseProductBarcode != "" {
				targetBarcode = *detail.Product.BaseProductBarcode
				effectiveQty = detail.Quantity * float64(detail.Product.PackMultiplier)
			}
			revertAdjustments[targetBarcode] -= effectiveQty
		}

		if len(revertAdjustments) > 0 {
			if err := s.productRepo.BatchAdjustQuantitiesWithTx(tx, revertAdjustments); err != nil {
				return fmt.Errorf("error restituyendo stock anterior: %w", err)
			}
		}
		revertMovements := make([]models.StockMovement, 0, len(revertAdjustments))
		for barcode, delta := range revertAdjustments {
			revertMovements = append(revertMovements, models.StockMovement{
				Date: time.Now(), Barcode: barcode, Quantity: -delta,
				Type: models.MovementTypeIn, Reason: models.MovementReasonEditRevert,
				ReferenceID: fmt.Sprintf("SALE-%d", id), EmployeeDNI: employeeDNI, EmployeeName: "ADMIN",
			})
		}
		if len(revertMovements) > 0 {
			if err := s.movementRepo.BatchSaveWithTx(tx, revertMovements); err != nil {
				return fmt.Errorf("error guardando reverso de edición: %w", err)
			}
		}

		if err := tx.Where("\"saleId\" = ?", id).Delete(&models.SaleDetail{}).Error; err != nil {
			return fmt.Errorf("error borrando detalles anteriores: %w", err)
		}
		if len(applyAdjustments) > 0 {
			if err := s.productRepo.BatchAdjustQuantitiesWithTx(tx, applyAdjustments); err != nil {
				return fmt.Errorf("error aplicando nuevo stock: %w", err)
			}
		}
		applyMovements := make([]models.StockMovement, 0, len(applyAdjustments))
		for barcode, quantity := range applyAdjustments {
			applyMovements = append(applyMovements, models.StockMovement{
				Date: time.Now(), Barcode: barcode, Quantity: quantity,
				Type: models.MovementTypeOut, Reason: models.MovementReasonEditApply,
				ReferenceID: fmt.Sprintf("SALE-%d", id), EmployeeDNI: employeeDNI, EmployeeName: "ADMIN",
			})
		}
		if len(applyMovements) > 0 {
			if err := s.movementRepo.BatchSaveWithTx(tx, applyMovements); err != nil {
				return fmt.Errorf("error guardando nuevo kárdex: %w", err)
			}
		}

		clientIDs := make([]string, 0, 2)
		seen := map[string]bool{}
		for _, dni := range []string{oldSale.ClientDNI, newSale.ClientDNI} {
			if dni != "" && dni != "0" && !seen[dni] {
				seen[dni] = true
				clientIDs = append(clientIDs, dni)
			}
		}
		sort.Strings(clientIDs)
		clients := make(map[string]*models.Client, len(clientIDs))
		for _, dni := range clientIDs {
			var client models.Client
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("dni = ?", dni).First(&client).Error; err != nil {
				return fmt.Errorf("cliente %s no encontrado: %w", dni, err)
			}
			clients[dni] = &client
		}
		if oldSale.DebtPending > 0 && clients[oldSale.ClientDNI] != nil {
			clients[oldSale.ClientDNI].CurrentCredit -= oldSale.DebtPending
			if clients[oldSale.ClientDNI].CurrentCredit < 0 {
				clients[oldSale.ClientDNI].CurrentCredit = 0
			}
		}
		if newSale.DebtPending > 0 {
			client := clients[newSale.ClientDNI]
			client.CurrentCredit += newSale.DebtPending
			if client.CurrentCredit > client.CreditLimit {
				return errors.New("límite de crédito superado")
			}
		}
		for dni, client := range clients {
			if err := tx.Model(&models.Client{}).Where("dni = ?", dni).Updates(map[string]interface{}{
				"currentCredit": client.CurrentCredit,
				"updatedByDni":  employeeDNI,
			}).Error; err != nil {
				return fmt.Errorf("error actualizando crédito de %s: %w", dni, err)
			}
		}

		if len(newSale.SaleDetails) > 0 {
			if err := tx.Create(&newSale.SaleDetails).Error; err != nil {
				return fmt.Errorf("error guardando nuevos detalles: %w", err)
			}
		}
		if err := tx.Model(&models.Sale{}).Where("\"saleId\" = ?", id).Updates(map[string]interface{}{
			"totalAmount": newSale.TotalAmount, "cashAmount": newSale.CashAmount,
			"transferAmount": newSale.TransferAmount, "transferNequi": newSale.TransferNequi,
			"transferDaviplata": newSale.TransferDaviplata, "creditAmount": newSale.CreditAmount,
			"transferSource": newSale.TransferSource, "paymentMethod": newSale.PaymentMethod,
			"amountPaid": newSale.AmountPaid, "change": newSale.Change,
			"debtPending": newSale.DebtPending, "status": newSale.Status, "clientDni": newSale.ClientDNI,
		}).Error; err != nil {
			return fmt.Errorf("error actualizando venta: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}

	// Arreglo 2: editar una venta sólo mueve cantidades entre movimientos y
	// productos; el catálogo cacheado no depende de esto.
	cache.InvalidateCache(cache.CacheKeyClients)
	if oldSale.ClientDNI != "" {
		cache.InvalidateCache(fmt.Sprintf("client_dni_%s", oldSale.ClientDNI))
	}
	if newSale.ClientDNI != "" {
		cache.InvalidateCache(fmt.Sprintf("client_dni_%s", newSale.ClientDNI))
	}
	s.saleRepo.AfterCommit()
	return nil
}

func deriveSalePaymentMethod(sale *models.Sale) string {
	methods := make([]string, 0, 4)
	if sale.CashAmount > 0 {
		methods = append(methods, "EFECTIVO")
	}
	if sale.TransferNequi > 0 {
		methods = append(methods, "NEQUI")
	}
	if sale.TransferDaviplata > 0 {
		methods = append(methods, "DAVIPLATA")
	}
	if sale.TransferAmount > 0 && sale.TransferNequi == 0 && sale.TransferDaviplata == 0 {
		source := strings.ToUpper(strings.TrimSpace(sale.TransferSource))
		if source == "" {
			source = "TRANSFERENCIA"
		}
		methods = append(methods, source)
	}
	if sale.CreditAmount > 0 {
		methods = append(methods, "FIADO")
	}
	if len(methods) == 0 {
		return "EFECTIVO"
	}
	if len(methods) == 1 {
		return methods[0]
	}
	return "MIXTO"
}
