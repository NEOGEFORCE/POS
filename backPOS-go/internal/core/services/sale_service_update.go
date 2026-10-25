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

	// Nota: la restricción histórica que impedía reducir el total de una
	// venta cobrada en efectivo o transferencia se eliminó al rediseñar
	// el flujo de edición (/sales/new modo Factura EDIT-<id>). Hoy el
	// cajero puede quitar un ítem que entró por error y re-cobrar el
	// total nuevo con todos los métodos (incluido QR Bold). El flujo
	// REEMPLAZA el desglose de pago enviado y sigue restringido a
	// administradores (admin/administrador/superadmin). Las guardas de
	// crédito ya aplicado y de cambio de cliente con abonos se
	// mantienen más abajo.
	_ = oldSale.CashAmount
	_ = oldSale.TransferAmount

	newSale.TotalAmount = newTotal
	paidTotal := newSale.CashAmount + newSale.TransferAmount + newSale.CreditAmount
	if paidTotal < newTotal-5.0 {
		return fmt.Errorf("pago insuficiente: calculado %.2f, pagado %.2f", newTotal, paidTotal)
	}
	newSale.AmountPaid = paidTotal
	newSale.PaymentMethod = deriveSalePaymentMethod(newSale)

	// Fiado con abonos: el reemplazo revierte el saldo pendiente y lo
	// reaplica; si ya hay abonos registrados, reconstruir el desglose
	// desalinearía la cartera del cliente. Error claro y sin mutación.
	alreadyPaidCredit := oldSale.CreditAmount - oldSale.DebtPending
	if alreadyPaidCredit < 0 {
		alreadyPaidCredit = 0
	}
	if alreadyPaidCredit > 0.001 {
		return fmt.Errorf("la venta tiene abonos de fiado registrados por $%.0f; no se puede editar su pago, registre una devolución o ajuste la cartera", alreadyPaidCredit)
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

		// Sólo se bloquean/actualizan los clientes cuyo fiado cambia: el
		// de la venta original si tenía saldo pendiente (se revierte) y el
		// nuevo si queda saldo (se reaplica). Una venta de contado (p.ej.
		// cliente anónimo "0000" re-cobrada por QR) no toca clientes.
		clientIDs := make([]string, 0, 2)
		seen := map[string]bool{}
		for _, cand := range []struct {
			dni  string
			debt float64
		}{{oldSale.ClientDNI, oldSale.DebtPending}, {newSale.ClientDNI, newSale.DebtPending}} {
			if cand.debt > 0 && cand.dni != "" && cand.dni != "0" && !seen[cand.dni] {
				seen[cand.dni] = true
				clientIDs = append(clientIDs, cand.dni)
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

// =============================================================================
// UpdateSaleFromQR — camino de edición disparado por el dispatcher QR Bold
// =============================================================================

// UpdateSaleFromQR es el punto de entrada del materializador asíncrono para
// el flujo "QR en edición". Recibe un `editSaleID` referenciado por el
// snapshot del QR (totals.editSaleId), valida permisos y delega al mismo
// UpdateSale canónico (A1). Devuelve errores en español listos para
// surfacear a la bandeja.
//
// Reglas:
//
//  1. La venta #editSaleID debe existir en la BD (soft-deleted se trata
//     como "anulada": no se puede editar).
//  2. El autor de la intención (`createdByDNI`, poblado desde el JWT en
//     /iniciar y /encolar) debe tener rol admin/administrador/superadmin,
//     la misma regla de `PUT /sales/update/:id` (ver CheckQREditTarget).
//  3. Delegamos a UpdateSale con isAdmin=true porque la autorización ya
//     se chequeó aquí; UpdateSale sigue imponiendo la OCC guard, el
//     cambio de cliente con abonos, los abonos ya pagados, etc.
//
// Idempotencia:
//
//   - El dispatcher gatea con ClaimForFinalization (NOT_STARTED/FAILED/
//     IN_PROGRESS atascado → IN_PROGRESS). Dos entregas del webhook
//     pelean por el claim: una gana y aplica UpdateSale, la otra sale
//     silenciosamente con ErrQRFinalizationAlreadyClaimed.
//   - UpdateSale usa un lock row-level (SELECT ... FOR UPDATE) con OCC
//     por TotalAmount/CreditAmount/DebtPending. Si alguien editó la
//     venta entre que la UI construyó el payload y el webhook aprobó,
//     devolvemos "la venta cambió mientras se editaba" y el dispatcher
//     marca FAILED para reintento con backoff.
func (s *SaleService) UpdateSaleFromQR(editSaleID uint, newSale *models.Sale, actorDNI string) error {
	if editSaleID == 0 {
		return errors.New("venta a editar inválida")
	}
	if newSale == nil {
		return errors.New("datos de venta vacíos")
	}

	actor, err := s.CheckQREditTarget(editSaleID, actorDNI)
	if err != nil {
		return err
	}
	// Delegación: isAdmin=true porque el permiso ya se validó. UpdateSale
	// sigue imponiendo la OCC guard y las guardas de crédito/cliente.
	return s.UpdateSale(editSaleID, newSale, actor, true)
}

// CheckQREditTarget valida que `editSaleID` sea editable por `actorDNI`
// desde el flujo QR. Se usa en dos momentos:
//
//   - Al crear la intención (/iniciar, /encolar): falla temprano con 400
//     para que el cajero no cobre un QR que luego no podrá aplicarse.
//   - Al materializar (UpdateSaleFromQR): revalida porque entre ambos
//     momentos la venta pudo anularse o el rol del actor cambiar.
//
// Reglas (mismas que PUT /sales/update/:id): la venta existe, no está
// anulada y el actor tiene rol admin/administrador/superadmin. Devuelve el
// DNI normalizado del actor.
func (s *SaleService) CheckQREditTarget(editSaleID uint, actorDNI string) (string, error) {
	if editSaleID == 0 {
		return "", errors.New("venta a editar inválida")
	}
	actor := strings.TrimSpace(actorDNI)
	if actor == "" {
		return "", errors.New("se requiere DNI del autor de la intención para editar")
	}
	rawDB, ok := s.saleRepo.GetDB().(*gorm.DB)
	if !ok {
		return "", errors.New("error de sistema: base de datos inválida")
	}

	// Unscoped para distinguir "anulada" (soft delete) de "no existe".
	var target models.Sale
	if err := rawDB.Unscoped().Where("\"saleId\" = ?", editSaleID).First(&target).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", fmt.Errorf("la venta #%d a editar no existe", editSaleID)
		}
		return "", fmt.Errorf("error consultando venta a editar: %w", err)
	}
	if target.DeletedAt.Valid {
		return "", fmt.Errorf("la venta #%d está anulada; no se puede re-cobrar", editSaleID)
	}

	canEdit, roleErr := actorCanEditSale(rawDB, actor)
	if roleErr != nil {
		return "", roleErr
	}
	if !canEdit {
		return "", errors.New("sólo los administradores pueden editar ventas")
	}
	return actor, nil
}

// actorCanEditSale replica la regla de PUT /sales/update/:id: sólo
// admin/administrador/superadmin editan ventas registradas. El rol se lee de
// `employees` (fuente durable), nunca del snapshot del cliente.
func actorCanEditSale(db *gorm.DB, actorDNI string) (bool, error) {
	var role string
	if err := db.Table("employees").
		Where("dni = ? AND deleted_at IS NULL", actorDNI).
		Select("role").
		Scan(&role).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		return false, fmt.Errorf("error consultando rol del actor: %w", err)
	}
	return isAdminRole(role), nil
}

// isAdminRole normaliza los tres alias de administrador del POS.
func isAdminRole(role string) bool {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "admin", "administrador", "superadmin":
		return true
	}
	return false
}

// deriveSalePaymentMethod construye el string descriptivo que se persiste en
// sales.paymentMethod. El orden recorrido garantiza una representacion
// ESTABLE: EFECTIVO -> NEQUI -> DAVIPLATA -> otras transferencias -> FIADO.
//
// Antes esta funcion devolvia el literal "MIXTO" cuando habia dos o mas
// canales, pero eso rompia la consistencia con CreateSale (que ya persiste
// "EFECTIVO + NEQUI", "NEQUI + DAVIPLATA", etc.). El historial, el ticket y
// los reportes mostraban "MIXTO" en vez de los canales reales tras cualquier
// correccion de pago. Ahora devolvemos el mismo formato unido por " + " y la
// palabra generica "MIXTO" deja de existir como string escrito por el
// sistema; se queda solo como fallback historico para ventas antiguas que
// vinieron asi desde la base.
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
	// "Otra transferencia" existe cuando TransferAmount cubre un monto que
	// no esta explicado por Nequi+Daviplata: transferencia pura (sin
	// desglose) o la parte Bold QR de un pago mixto (QR + Nequi, etc.).
	// Preserva el canal declarado en TransferSource si viene (p.ej.
	// "BANCOLOMBIA", "BOLD_QR"); si no, cae a "TRANSFERENCIA" neutra.
	if genericTransferPortion(sale) > 1.0 {
		source := strings.ToUpper(strings.TrimSpace(sale.TransferSource))
		if source == "" || source == "MIXTO" {
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
	return strings.Join(methods, " + ")
}

// genericTransferPortion devuelve la parte de TransferAmount que no es
// Nequi ni Daviplata (p.ej. Bold QR en un pago mixto). Nunca negativa.
func genericTransferPortion(sale *models.Sale) float64 {
	if sale == nil {
		return 0
	}
	generic := sale.TransferAmount - sale.TransferNequi - sale.TransferDaviplata
	if generic < 0 {
		return 0
	}
	return generic
}
