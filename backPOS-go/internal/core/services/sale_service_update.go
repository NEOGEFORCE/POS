package services

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
)

func (s *SaleService) UpdateSale(id uint, newSale *models.Sale, employeeDNI string, isAdmin bool) error {
	if !isAdmin {
		return errors.New("sólo los administradores pueden editar ventas")
	}

	oldSale, err := s.saleRepo.GetByID(id)
	if err != nil || oldSale == nil {
		return errors.New("venta original no encontrada")
	}

	if oldSale.CashAmount > 0 || oldSale.TransferAmount > 0 {
		var newTotal float64
		for _, d := range newSale.SaleDetails {
			if strings.HasPrefix(d.Barcode, "MISC-") || d.Barcode == "0000" {
				newTotal += d.Subtotal
			} else {
				prod, _ := s.productRepo.GetByBarcode(d.Barcode)
				if prod != nil {
					newTotal += applyRounding(prod.SalePrice * d.Quantity)
				}
			}
		}
		if newTotal < oldSale.TotalAmount {
			return errors.New("no se puede disminuir el total de una venta cobrada en Efectivo o Transferencia. Por favor añada productos para compensar la diferencia.")
		}
	}

	revertAdjustments := make(map[string]float64)
	for _, oldDetail := range oldSale.SaleDetails {
		if strings.HasPrefix(oldDetail.Barcode, "MISC-") || oldDetail.Barcode == "0000" {
			continue
		}
		targetBarcode := oldDetail.Barcode
		effectiveQty := oldDetail.Quantity
		if oldDetail.Product.IsPack && oldDetail.Product.BaseProductBarcode != nil && *oldDetail.Product.BaseProductBarcode != "" {
			targetBarcode = *oldDetail.Product.BaseProductBarcode
			effectiveQty = oldDetail.Quantity * float64(oldDetail.Product.PackMultiplier)
		}
		revertAdjustments[targetBarcode] -= effectiveQty
	}

	rawInterface := s.saleRepo.GetDB()
	rawDB, ok := rawInterface.(*gorm.DB)
	if !ok {
		return errors.New("error de sistema: db inválida")
	}

	tx := rawDB.Begin()
	if tx.Error != nil {
		return tx.Error
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	if err := s.productRepo.BatchAdjustQuantitiesWithTx(tx, revertAdjustments); err != nil {
		tx.Rollback()
		return fmt.Errorf("error restituyendo stock: %v", err)
	}

	for _, oldDetail := range oldSale.SaleDetails {
		if strings.HasPrefix(oldDetail.Barcode, "MISC-") || oldDetail.Barcode == "0000" {
			continue
		}
		targetBarcode := oldDetail.Barcode
		effectiveQty := oldDetail.Quantity
		if oldDetail.Product.IsPack && oldDetail.Product.BaseProductBarcode != nil && *oldDetail.Product.BaseProductBarcode != "" {
			targetBarcode = *oldDetail.Product.BaseProductBarcode
			effectiveQty = oldDetail.Quantity * float64(oldDetail.Product.PackMultiplier)
		}
		tx.Create(&models.StockMovement{
			Date:         time.Now(),
			Barcode:      targetBarcode,
			Quantity:     effectiveQty,
			Type:         "IN",
			Reason:       "EDIT_REVERT",
			ReferenceID:  fmt.Sprintf("SALE-%d", oldSale.SaleID),
			EmployeeDNI:  employeeDNI,
			EmployeeName: "Admin",
		})
	}

	if err := tx.Where("sale_id = ?", id).Delete(&models.SaleDetail{}).Error; err != nil {
		tx.Rollback()
		return fmt.Errorf("error borrando detalles antiguos: %v", err)
	}

	if oldSale.CreditAmount > 0 && oldSale.ClientDNI != "0" && oldSale.ClientDNI != "" {
		client, err := s.clientRepo.GetByDNI(oldSale.ClientDNI)
		if err == nil {
			client.CurrentCredit -= oldSale.CreditAmount
			if client.CurrentCredit < 0 {
				client.CurrentCredit = 0
			}
			s.clientRepo.Update(client.DNI, client)
		}
	}

	var newTotal float64
	applyAdjustments := make(map[string]float64)
	for i := range newSale.SaleDetails {
		d := &newSale.SaleDetails[i]
		if strings.HasPrefix(d.Barcode, "MISC-") || d.Barcode == "0000" {
			newTotal += d.Subtotal
			d.SaleID = id
			continue
		}
		prod, err := s.productRepo.GetByBarcode(d.Barcode)
		if err != nil {
			tx.Rollback()
			return fmt.Errorf("producto no encontrado: %s", d.Barcode)
		}
		d.UnitPrice = prod.SalePrice
		d.CostPrice = prod.PurchasePrice
		d.Subtotal = applyRounding(prod.SalePrice * d.Quantity)
		newTotal += d.Subtotal
		d.SaleID = id

		targetBarcode := d.Barcode
		effectiveQty := d.Quantity
		if prod.IsPack && prod.BaseProductBarcode != nil && *prod.BaseProductBarcode != "" {
			targetBarcode = *prod.BaseProductBarcode
			effectiveQty = d.Quantity * float64(prod.PackMultiplier)
		}
		applyAdjustments[targetBarcode] += effectiveQty
	}

	newSale.TotalAmount = newTotal
	paidTotal := newSale.CashAmount + newSale.TransferAmount + newSale.CreditAmount
	if paidTotal < (newTotal - 5.0) {
		tx.Rollback()
		return fmt.Errorf("pago insuficiente: calculado %.2f, pagado %.2f", newTotal, paidTotal)
	}

	typeCount := 0
	if newSale.CashAmount > 0 { typeCount++ }
	if newSale.TransferAmount > 0 { typeCount++ }
	if newSale.CreditAmount > 0 { typeCount++ }

	if typeCount > 1 {
		newSale.PaymentMethod = "MIXTO"
	} else if newSale.CreditAmount > 0 {
		newSale.PaymentMethod = "FIADO"
	} else if newSale.TransferAmount > 0 {
		source := strings.ToUpper(newSale.TransferSource)
		if source == "" { source = "TRANSFERENCIA" }
		newSale.PaymentMethod = source
	} else {
		newSale.PaymentMethod = "EFECTIVO"
	}

	if newSale.CreditAmount > 0 {
		newSale.DebtPending = newSale.CreditAmount
		if newSale.ClientDNI == "0" || newSale.ClientDNI == "" {
			tx.Rollback()
			return errors.New("debe seleccionar un cliente real para crédito")
		}
		client, err := s.clientRepo.GetByDNI(newSale.ClientDNI)
		if err != nil {
			tx.Rollback()
			return errors.New("cliente no encontrado")
		}
		if client.CurrentCredit+newSale.CreditAmount > client.CreditLimit {
			tx.Rollback()
			return errors.New("límite de crédito superado")
		}
		client.CurrentCredit += newSale.CreditAmount
		_ = s.clientRepo.Update(client.DNI, client)
		newSale.Status = "CREDIT"
	} else {
		newSale.Status = "PAID"
	}

	newSale.AmountPaid = paidTotal
	cashNeeded := newTotal - newSale.TransferAmount - newSale.CreditAmount
	if cashNeeded < 0 { cashNeeded = 0 }
	newSale.Change = newSale.CashAmount - cashNeeded
	if newSale.Change < 0 { newSale.Change = 0 }

	if err := s.productRepo.BatchAdjustQuantitiesWithTx(tx, applyAdjustments); err != nil {
		tx.Rollback()
		return fmt.Errorf("error aplicando nuevo stock: %v", err)
	}

	for targetBarcode, effectiveQty := range applyAdjustments {
		tx.Create(&models.StockMovement{
			Date:         time.Now(),
			Barcode:      targetBarcode,
			Quantity:     effectiveQty,
			Type:         "OUT",
			Reason:       "EDIT_APPLY",
			ReferenceID:  fmt.Sprintf("SALE-%d", id),
			EmployeeDNI:  employeeDNI,
			EmployeeName: "Admin",
		})
	}

	if err := tx.Create(&newSale.SaleDetails).Error; err != nil {
		tx.Rollback()
		return fmt.Errorf("error guardando nuevos detalles: %v", err)
	}

	if err := tx.Model(&models.Sale{}).Where("sale_id = ?", id).Updates(map[string]interface{}{
		"totalAmount":    newSale.TotalAmount,
		"cashAmount":     newSale.CashAmount,
		"transferAmount": newSale.TransferAmount,
		"creditAmount":   newSale.CreditAmount,
		"transferSource": newSale.TransferSource,
		"paymentMethod":  newSale.PaymentMethod,
		"amountPaid":     newSale.AmountPaid,
		"change":         newSale.Change,
		"debtPending":    newSale.DebtPending,
		"status":         newSale.Status,
		"clientDni":      newSale.ClientDNI,
	}).Error; err != nil {
		tx.Rollback()
		return fmt.Errorf("error actualizando venta: %v", err)
	}

	tx.Commit()

	return nil
}
