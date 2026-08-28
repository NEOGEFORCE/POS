package services

import (
	"errors"
	"fmt"
	"log"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type SaleService struct {
	saleRepo        ports.SaleRepository
	productRepo     ports.ProductRepository
	clientRepo      ports.ClientRepository
	movementRepo    ports.StockMovementRepository
	creditRepo      ports.CreditPaymentRepository
	printService    *PrintService
	telegramService *TelegramService
	recentSales     map[string]time.Time
	recentMu        sync.Mutex
}

func NewSaleService(sr ports.SaleRepository, pr ports.ProductRepository, cr ports.ClientRepository, mr ports.StockMovementRepository, ps *PrintService, cpr ports.CreditPaymentRepository, ts *TelegramService) *SaleService {
	return &SaleService{
		saleRepo:        sr,
		productRepo:     pr,
		clientRepo:      cr,
		movementRepo:    mr,
		printService:    ps,
		creditRepo:      cpr,
		telegramService: ts,
		recentSales:     make(map[string]time.Time),
	}
}

func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return errors.Is(err, gorm.ErrDuplicatedKey) ||
		strings.Contains(message, "23505") ||
		strings.Contains(message, "duplicate key") ||
		strings.Contains(message, "unique constraint")
}

func buildProductLookup(products []models.Product) map[string]*models.Product {
	lookup := make(map[string]*models.Product, len(products)*2)
	for i := range products {
		product := &products[i]
		lookup[product.Barcode] = product
		for _, alternate := range strings.Split(product.AlternateCodes, ",") {
			if code := strings.TrimSpace(alternate); code != "" {
				lookup[code] = product
			}
		}
		if product.BaseProduct != nil && product.BaseProduct.Barcode != "" {
			lookup[product.BaseProduct.Barcode] = product.BaseProduct
		}
	}
	return lookup
}

func (s *SaleService) CreateSale(sale *models.Sale) (err error) {
	rawInterface := s.saleRepo.GetDB()
	rawDB, ok := rawInterface.(*gorm.DB)
	if !ok {
		return fmt.Errorf("error de sistema: base de datos inválida")
	}

	// Idempotencia: una venta anulada también conserva su ClientTxId para que
	// un reintento offline tardío nunca la resucite como una venta nueva.
	if sale.ClientTxId != "" {
		var existing models.Sale
		lookupErr := rawDB.Unscoped().Where("\"clientTxId\" = ?", sale.ClientTxId).First(&existing).Error
		if lookupErr == nil {
			*sale = existing
			log.Printf("[IDEMPOTENCIA] ClientTxId=%s ya corresponde a venta #%d", sale.ClientTxId, sale.SaleID)
			return nil
		}
		if !errors.Is(lookupErr, gorm.ErrRecordNotFound) {
			return fmt.Errorf("error verificando idempotencia: %w", lookupErr)
		}
	}

	// Compatibilidad con clientes antiguos sin ClientTxId. El frontend actual
	// siempre envía ClientTxId; esta firma sólo reduce duplicados legacy.
	var legacySignature string
	if sale.ClientTxId == "" {
		var detailsSb strings.Builder
		for _, d := range sale.SaleDetails {
			detailsSb.WriteString(fmt.Sprintf("%s:%.2f;", d.Barcode, d.Quantity))
		}
		legacySignature = fmt.Sprintf("%s_%.2f_%.2f_%s_%s", sale.ClientDNI, sale.AmountPaid, sale.TotalAmount, sale.PaymentMethod, detailsSb.String())

		s.recentMu.Lock()
		if lastTime, exists := s.recentSales[legacySignature]; exists && time.Since(lastTime) < 5*time.Minute {
			s.recentMu.Unlock()
			return errors.New("venta duplicada detectada; recargue el historial antes de reintentar")
		}
		s.recentMu.Unlock()
	}

	var total float64
	// 1. Obtener todos los barcodes únicos para consulta masiva
	uniqueBarcodes := make([]string, 0)
	barcodeSet := make(map[string]bool)
	for _, d := range sale.SaleDetails {
		if !strings.HasPrefix(d.Barcode, "MISC-") && d.Barcode != "0000" && !barcodeSet[d.Barcode] {
			uniqueBarcodes = append(uniqueBarcodes, d.Barcode)
			barcodeSet[d.Barcode] = true
		}
	}

	// 2. Carga masiva de productos (1 sola consulta vs N consultas)
	var productsDB []models.Product
	if len(uniqueBarcodes) > 0 {
		var err error
		productsDB, err = s.productRepo.GetByBarcodes(uniqueBarcodes)
		if err != nil {
			return fmt.Errorf("error cargando productos: %v", err)
		}
	}

	productCache := buildProductLookup(productsDB)

	deductions := make(map[string]float64)

	// Validar que todos existan y preparar deducciones
	for _, detail := range sale.SaleDetails {
		if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
			continue
		}
		product, ok := productCache[detail.Barcode]
		if !ok {
			return errors.New("producto no encontrado: " + detail.Barcode)
		}

		effectiveQty := detail.Quantity
		targetBarcode := product.Barcode

		if product.IsPack && product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" {
			targetBarcode = *product.BaseProductBarcode
			effectiveQty = detail.Quantity * float64(product.PackMultiplier)
		}

		deductions[targetBarcode] += effectiveQty
	}

	// 3. Validar stock total requerido
	for barcode := range deductions {
		_, ok := productCache[barcode]
		if !ok {
			base, err := s.productRepo.GetByBarcode(barcode)
			if err != nil {
				return fmt.Errorf("stock insuficiente: producto base %s no existe", barcode)
			}
			productCache[barcode] = base
		}
		// Validación eliminada a petición del usuario para permitir vender en negativo
	}

	// 4. Calcular totales
	for i := range sale.SaleDetails {
		detail := &sale.SaleDetails[i]
		if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
			total += detail.Subtotal
			continue
		}

		product := productCache[detail.Barcode]
		detail.UnitPrice = product.SalePrice
		detail.CostPrice = product.PurchasePrice
		detail.Subtotal = roundSaleLineSubtotal(product.SalePrice, detail.Quantity)
		total += detail.Subtotal
	}

	sale.TotalAmount = total
	paidTotal := sale.CashAmount + sale.TransferAmount + sale.CreditAmount

	if paidTotal < (total - 5.0) {
		return fmt.Errorf("pago insuficiente: total calculado %.2f, pagado %.2f", total, paidTotal)
	}

	// Lógica de método de pago y crédito
	typeCount := 0
	if sale.CashAmount > 0 {
		typeCount++
	}
	if sale.TransferAmount > 0 {
		typeCount++
	}
	if sale.CreditAmount > 0 {
		typeCount++
	}

	if sale.TransferAmount > 0 {
		source := strings.ToUpper(sale.TransferSource)
		if source == "" {
			source = "TRANSFERENCIA"
		}
		if sale.TransferNequi == 0 && sale.TransferDaviplata == 0 {
			if strings.Contains(source, "NEQUI") {
				sale.TransferNequi = sale.TransferAmount
			} else if strings.Contains(source, "DAVIPLATA") || strings.Contains(source, "DAVI") {
				sale.TransferDaviplata = sale.TransferAmount
			}
		}
	}

	if sale.PaymentMethod == "" || strings.ToUpper(sale.PaymentMethod) == "MIXTO" {
		methods := []string{}
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
			source := strings.ToUpper(sale.TransferSource)
			if source == "" {
				source = "TRANSFERENCIA"
			}
			methods = append(methods, source)
		}
		if sale.CreditAmount > 0 {
			methods = append(methods, "FIADO")
		}

		if len(methods) > 0 {
			sale.PaymentMethod = strings.Join(methods, " + ")
		} else {
			sale.PaymentMethod = "EFECTIVO"
		}
	}

	if sale.CreditAmount > 0 {
		sale.DebtPending = sale.CreditAmount
		if sale.ClientDNI == "0" || sale.ClientDNI == "" {
			return errors.New("debe seleccionar un cliente real para crédito")
		}
		sale.Status = "CREDIT"
	} else {
		sale.DebtPending = 0
		sale.Status = "PAID"
	}

	sale.AmountPaid = paidTotal
	cashNeeded := total - sale.TransferAmount - sale.CreditAmount
	if cashNeeded < 0 {
		cashNeeded = 0
	}
	sale.Change = sale.CashAmount - cashNeeded
	if sale.Change < 0 {
		sale.Change = 0
	}

	// === INICIO DE TRANSACCIÓN ATÓMICA ===
	tx := rawDB.Begin()
	if tx.Error != nil {
		return fmt.Errorf("error iniciando transacción: %w", tx.Error)
	}

	defer func() {
		if recovered := recover(); recovered != nil {
			_ = tx.Rollback().Error
			log.Printf("[CreateSale] panic revertido: %v\n%s", recovered, debug.Stack())
			err = fmt.Errorf("error interno creando venta; transacción revertida")
		}
	}()

	if sale.ClientTxId != "" {
		if lockErr := tx.Exec("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", sale.ClientTxId).Error; lockErr != nil {
			tx.Rollback()
			return fmt.Errorf("error bloqueando idempotencia de venta: %w", lockErr)
		}
		var concurrentExisting models.Sale
		lookupErr := tx.Unscoped().Where("\"clientTxId\" = ?", sale.ClientTxId).First(&concurrentExisting).Error
		if lookupErr == nil {
			tx.Rollback()
			*sale = concurrentExisting
			return nil
		}
		if !errors.Is(lookupErr, gorm.ErrRecordNotFound) {
			tx.Rollback()
			return fmt.Errorf("error revalidando idempotencia: %w", lookupErr)
		}
	}

	if sale.CreditAmount > 0 {
		var client models.Client
		if txErr := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("dni = ?", sale.ClientDNI).First(&client).Error; txErr != nil {
			tx.Rollback()
			if errors.Is(txErr, gorm.ErrRecordNotFound) {
				return errors.New("cliente no encontrado")
			}
			return fmt.Errorf("error bloqueando cliente: %w", txErr)
		}
		if client.CurrentCredit+sale.CreditAmount > client.CreditLimit {
			tx.Rollback()
			return errors.New("límite de crédito superado")
		}
		if txErr := tx.Model(&models.Client{}).Where("dni = ?", sale.ClientDNI).Updates(map[string]interface{}{
			"currentCredit": client.CurrentCredit + sale.CreditAmount,
			"updatedByDni":  sale.EmployeeDNI,
		}).Error; txErr != nil {
			tx.Rollback()
			return fmt.Errorf("error actualizando crédito del cliente: %w", txErr)
		}
	}

	if txErr := s.saleRepo.CreateWithTx(tx, sale); txErr != nil {
		tx.Rollback()
		if sale.ClientTxId != "" && isUniqueViolation(txErr) {
			var existing models.Sale
			if lookupErr := rawDB.Unscoped().Where("\"clientTxId\" = ?", sale.ClientTxId).First(&existing).Error; lookupErr == nil {
				*sale = existing
				return nil
			}
		}
		return fmt.Errorf("error guardando venta: %w", txErr)
	}

	if len(deductions) > 0 {
		// Ajuste de stock masivo en la misma transacción (1 QUERY)
		if err := s.productRepo.BatchAdjustQuantitiesWithTx(tx, deductions); err != nil {
			tx.Rollback()
			return fmt.Errorf("error ajustando inventario: %w", err)
		}

		movements := make([]models.StockMovement, 0, len(sale.SaleDetails))
		for i := range sale.SaleDetails {
			detail := sale.SaleDetails[i]
			if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
				continue
			}

			product := productCache[detail.Barcode]
			targetBarcode := detail.Barcode
			effectiveQty := detail.Quantity
			if product != nil {
				targetBarcode = product.Barcode
				if product.IsPack && product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" {
					targetBarcode = *product.BaseProductBarcode
					effectiveQty = detail.Quantity * float64(product.PackMultiplier)
				}
			}

			movements = append(movements, models.StockMovement{
				Date:         sale.SaleDate,
				Barcode:      targetBarcode,
				Quantity:     effectiveQty,
				Type:         "OUT",
				Reason:       "SALE",
				ReferenceID:  fmt.Sprintf("SALE-%d", sale.SaleID),
				EmployeeDNI:  sale.EmployeeDNI,
				EmployeeName: sale.Employee.Name,
			})
		}

		if len(movements) > 0 {
			if err := s.movementRepo.BatchSaveWithTx(tx, movements); err != nil {
				tx.Rollback()
				return fmt.Errorf("error guardando movimientos: %w", err)
			}
		}
	}

	if commitErr := tx.Commit().Error; commitErr != nil {
		return fmt.Errorf("error aplicando transacción de venta: %w", commitErr)
	}
	// === FIN DE TRANSACCIÓN ATÓMICA ===

	if legacySignature != "" {
		s.recentMu.Lock()
		s.recentSales[legacySignature] = time.Now()
		for key, createdAt := range s.recentSales {
			if time.Since(createdAt) > 10*time.Minute {
				delete(s.recentSales, key)
			}
		}
		s.recentMu.Unlock()
	}

	cache.InvalidateCache(cache.CacheKeyProducts)
	if sale.CreditAmount > 0 {
		cache.InvalidateCache(cache.CacheKeyClients)
		cache.InvalidateCache(fmt.Sprintf("client_dni_%s", sale.ClientDNI))
	}
	s.saleRepo.AfterCommit()

	// 5. Tareas secundarias en Goroutine (Background)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				fmt.Printf("⚠️ [Sale-Background] Recovery from panic in sale #%d: %v\n", sale.SaleID, r)
			}
		}()

		// TAREA 1: Notificaciones Proactivas de "Agotamiento Crítico"
		//
		// Las líneas se agrupan por código: si el mismo producto viene en varias
		// líneas de la venta, se evalúa una sola vez con la cantidad total. Antes
		// se emitía una alerta por línea y cada una calculaba el stock desde el
		// valor previo a la venta, lo que producía mensajes repetidos.
		soldByBarcode := make(map[string]float64, len(sale.SaleDetails))
		alertOrder := make([]string, 0, len(sale.SaleDetails))
		for _, detail := range sale.SaleDetails {
			if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
				continue
			}
			if _, seen := soldByBarcode[detail.Barcode]; !seen {
				alertOrder = append(alertOrder, detail.Barcode)
			}
			soldByBarcode[detail.Barcode] += detail.Quantity
		}

		for _, barcode := range alertOrder {
			soldQuantity := soldByBarcode[barcode]

			// Usar el caché de memoria (evita consultar base de datos por producto)
			cachedProduct, exists := productCache[barcode]
			if !exists || cachedProduct == nil {
				continue
			}

			// TAREA 1.5: Alerta de Venta en Negativo
			// En productCache tenemos el stock ANTES de esta venta.
			newStock := cachedProduct.Quantity - soldQuantity
			negativeAlertSent := false
			if newStock < 0 && cachedProduct.Quantity >= 0 {
				msgNeg := fmt.Sprintf("🚨 *ALERTA DE INVENTARIO (POS)*\n"+
					"El producto *%s* acaba de ser vendido, pero su stock en sistema quedó negativo (%.2f).\n"+
					"Acción: Verificar auditoría o registrar la factura de entrada faltante.",
					cachedProduct.ProductName, newStock)

				s.telegramService.SendMarkdownAlert(msgNeg)
				negativeAlertSent = true
			}

			// TAREA 1: Alertar únicamente cuando el producto llegó a cero o quedó
			// en negativo. Antes bastaba con que el stock no alcanzara hasta la
			// próxima visita del proveedor, lo que generaba avisos con existencias
			// suficientes (por ejemplo 4 unidades para 39 días).
			if newStock <= 0 && !negativeAlertSent && cachedProduct.SupplierID != nil {
				// Cargar la relación del proveedor para conocer sus días de visita
				productWithSupplier, err := s.productRepo.GetByBarcodeWithPreloads(barcode, "Supplier")
				if err != nil || productWithSupplier == nil {
					continue
				}

				avgDaily, _ := s.productRepo.GetDailySalesAverage(barcode, 14)

				msg := fmt.Sprintf("🚨 *¡PRODUCTO AGOTADO!*\n\n"+
					"El producto *%s* llegó a cero.\n\n"+
					"📦 *Stock Actual:* %.2f\n"+
					"📈 *Venta Diaria:* %.2f\n"+
					"%s\n\n"+
					"💡 _Sugerencia: Surtir externamente para no perder ventas._",
					cachedProduct.ProductName, newStock, avgDaily,
					describeNextSupplierVisit(productWithSupplier.Supplier))

				s.telegramService.SendMarkdownAlert(msg)
			}

			// TAREA 1.6: Alerta de Min Estante
			if cachedProduct.MinShelfStock > 0 && newStock <= cachedProduct.MinShelfStock && newStock >= 0 {
				supplierText := "💡 _Pide más cantidad pronto._"

				msgMin := fmt.Sprintf("🚨 *¡ALERTA DE STOCK BAJO (MIN. ESTANTE)!*\n\n"+
					"El producto *%s* ha caído a su nivel de alerta en estante.\n\n"+
					"📦 *Stock Actual:* %.2f\n"+
					"📉 *Mínimo Permitido:* %.2f\n\n"+
					"%s",
					cachedProduct.ProductName, newStock, cachedProduct.MinShelfStock, supplierText)

				s.telegramService.SendMarkdownAlert(msgMin)
			}
		}

		// Impresión de recibo
		fullSale, err := s.saleRepo.GetByID(sale.SaleID)
		if err == nil {
			_ = s.printService.PrintReceipt(fullSale)
		}

		// Notificaciones o Webhooks adicionales podrían ir aquí
	}()

	return nil
}

func (s *SaleService) AddItemsToSale(saleID uint, newDetails []models.SaleDetail, cashAmount, transferAmount float64, transferSource, employeeDNI string) error {
	sale, err := s.saleRepo.GetByID(saleID)
	if err != nil {
		return errors.New("venta no encontrada")
	}

	if sale.Status != "PAID" && sale.Status != "CREDIT" {
		return errors.New("no se puede editar esta venta")
	}

	var additionalTotal float64
	deductions := make(map[string]float64)
	uniqueBarcodes := make([]string, 0, len(newDetails))
	seenBarcodes := make(map[string]struct{}, len(newDetails))
	for _, detail := range newDetails {
		if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
			continue
		}
		if _, seen := seenBarcodes[detail.Barcode]; !seen {
			seenBarcodes[detail.Barcode] = struct{}{}
			uniqueBarcodes = append(uniqueBarcodes, detail.Barcode)
		}
	}

	var productsDB []models.Product
	if len(uniqueBarcodes) > 0 {
		productsDB, err = s.productRepo.GetByBarcodes(uniqueBarcodes)
		if err != nil {
			return fmt.Errorf("error cargando productos: %w", err)
		}
	}
	productCache := buildProductLookup(productsDB)

	// Validar stock y preparar deducciones.
	for i := range newDetails {
		detail := &newDetails[i]
		if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
			additionalTotal += detail.Subtotal
			continue
		}

		product, ok := productCache[detail.Barcode]
		if !ok {
			return fmt.Errorf("producto no encontrado: %s", detail.Barcode)
		}

		effectiveQty := detail.Quantity
		targetBarcode := detail.Barcode
		if product.IsPack && product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" {
			targetBarcode = *product.BaseProductBarcode
			effectiveQty = detail.Quantity * float64(product.PackMultiplier)
		}

		deductions[targetBarcode] += effectiveQty
		detail.UnitPrice = product.SalePrice
		detail.CostPrice = product.PurchasePrice
		detail.Subtotal = roundSaleLineSubtotal(product.SalePrice, detail.Quantity)
		additionalTotal += detail.Subtotal
	}

	// Validar que los productos base existan; la venta en negativo sigue permitida.
	for barcode := range deductions {
		if _, ok := productCache[barcode]; ok {
			continue
		}
		base, err := s.productRepo.GetByBarcode(barcode)
		if err != nil {
			return fmt.Errorf("stock insuficiente: producto base %s no existe", barcode)
		}
		productCache[barcode] = base
	}

	// Actualizar los métodos de pago de la venta
	paidExtra := cashAmount + transferAmount
	if paidExtra < (additionalTotal - 5.0) {
		return fmt.Errorf("pago adicional insuficiente: total extra %.2f, pagado extra %.2f", additionalTotal, paidExtra)
	}

	sale.TotalAmount += additionalTotal
	sale.CashAmount += cashAmount
	sale.TransferAmount += transferAmount
	if transferSource != "" {
		sale.TransferSource = transferSource
	}

	sale.AmountPaid += paidExtra

	// Recalcular cambio solo sobre efectivo
	cashNeeded := sale.TotalAmount - sale.TransferAmount - sale.CreditAmount
	if cashNeeded < 0 {
		cashNeeded = 0
	}
	sale.Change = sale.CashAmount - cashNeeded
	if sale.Change < 0 {
		sale.Change = 0
	}

	// Recalcular tipo de pago
	typeCount := 0
	if sale.CashAmount > 0 {
		typeCount++
	}
	if sale.TransferAmount > 0 {
		typeCount++
	}
	if sale.CreditAmount > 0 {
		typeCount++
	}

	if typeCount > 1 {
		sale.PaymentMethod = "MIXTO"
	} else if sale.CreditAmount > 0 {
		sale.PaymentMethod = "FIADO"
	} else if sale.TransferAmount > 0 {
		source := strings.ToUpper(sale.TransferSource)
		if source == "" {
			source = "TRANSFERENCIA"
		}
		sale.PaymentMethod = source
	} else {
		sale.PaymentMethod = "EFECTIVO"
	}

	rawInterface := s.saleRepo.GetDB()
	rawDB, ok := rawInterface.(*gorm.DB)
	if !ok {
		return fmt.Errorf("error obteniendo db: tipo incorrecto")
	}

	if err := rawDB.Transaction(func(tx *gorm.DB) error {
		var lockedSale models.Sale
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("\"saleId\" = ?", sale.SaleID).First(&lockedSale).Error; err != nil {
			return fmt.Errorf("error bloqueando venta: %w", err)
		}
		lockedSale.TotalAmount += additionalTotal
		lockedSale.CashAmount += cashAmount
		lockedSale.TransferAmount += transferAmount
		if transferSource != "" {
			lockedSale.TransferSource = transferSource
		}
		lockedSale.AmountPaid += paidExtra
		cashNeeded := lockedSale.TotalAmount - lockedSale.TransferAmount - lockedSale.CreditAmount
		if cashNeeded < 0 {
			cashNeeded = 0
		}
		lockedSale.Change = lockedSale.CashAmount - cashNeeded
		if lockedSale.Change < 0 {
			lockedSale.Change = 0
		}
		lockedSale.PaymentMethod = deriveSalePaymentMethod(&lockedSale)
		*sale = lockedSale

		if err := tx.Model(&models.Sale{}).Where("\"saleId\" = ?", sale.SaleID).Updates(map[string]interface{}{
			"totalAmount":    sale.TotalAmount,
			"cashAmount":     sale.CashAmount,
			"transferAmount": sale.TransferAmount,
			"transferSource": sale.TransferSource,
			"amountPaid":     sale.AmountPaid,
			"change":         sale.Change,
			"paymentMethod":  sale.PaymentMethod,
		}).Error; err != nil {
			return fmt.Errorf("error actualizando venta: %w", err)
		}

		for _, detail := range newDetails {
			var existingDetail models.SaleDetail
			queryErr := tx.Where("\"saleId\" = ? AND barcode = ?", sale.SaleID, detail.Barcode).First(&existingDetail).Error
			switch {
			case queryErr == nil:
				existingDetail.Quantity += detail.Quantity
				existingDetail.Subtotal += detail.Subtotal
				if err := tx.Save(&existingDetail).Error; err != nil {
					return fmt.Errorf("error acumulando detalle %s: %w", detail.Barcode, err)
				}
			case errors.Is(queryErr, gorm.ErrRecordNotFound):
				detail.SaleID = sale.SaleID
				if err := tx.Create(&detail).Error; err != nil {
					return fmt.Errorf("error creando detalle %s: %w", detail.Barcode, err)
				}
			default:
				return fmt.Errorf("error consultando detalle %s: %w", detail.Barcode, queryErr)
			}
		}

		if len(deductions) == 0 {
			return nil
		}
		if err := s.productRepo.BatchAdjustQuantitiesWithTx(tx, deductions); err != nil {
			return fmt.Errorf("error ajustando inventario: %w", err)
		}

		movements := make([]models.StockMovement, 0, len(newDetails))
		for _, detail := range newDetails {
			if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
				continue
			}
			product, ok := productCache[detail.Barcode]
			if !ok {
				return fmt.Errorf("error resolviendo producto %s para kárdex", detail.Barcode)
			}
			targetBarcode := detail.Barcode
			effectiveQty := detail.Quantity
			if product.IsPack && product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" {
				targetBarcode = *product.BaseProductBarcode
				effectiveQty = detail.Quantity * float64(product.PackMultiplier)
			}
			movements = append(movements, models.StockMovement{
				Date:         time.Now(),
				Barcode:      targetBarcode,
				Quantity:     effectiveQty,
				Type:         models.MovementTypeOut,
				Reason:       models.MovementReasonEditApply,
				ReferenceID:  fmt.Sprintf("SALE-%d", sale.SaleID),
				EmployeeDNI:  employeeDNI,
				EmployeeName: "CAJERO",
			})
		}
		if len(movements) > 0 {
			if err := s.movementRepo.BatchSaveWithTx(tx, movements); err != nil {
				return fmt.Errorf("error guardando kárdex: %w", err)
			}
		}
		return nil
	}); err != nil {
		return err
	}

	cache.InvalidateCache(cache.CacheKeyProducts)
	s.saleRepo.AfterCommit()

	go func() {
		defer func() { recover() }()
		if s.telegramService != nil {
			msg := fmt.Sprintf("✏️ *VENTA EDITADA (Productos Añadidos)*\n\n"+
				"*Venta:* #%d\n"+
				"*Monto Adicional:* $%.2f\n"+
				"*Cajero:* %s\n"+
				"*Items Nuevos:* %d",
				sale.SaleID, additionalTotal, employeeDNI, len(newDetails))
			s.telegramService.SendMarkdownAlert(msg)
		}
	}()

	return nil
}

func (s *SaleService) ListSales(filter ports.SaleFilter) ([]models.Sale, int64, error) {
	if filter.Page <= 0 {
		filter.Page = 1
	}
	if filter.PageSize <= 0 {
		filter.PageSize = 10
	}
	return s.saleRepo.FindAll(filter)
}

func (s *SaleService) GetSale(id uint) (*models.Sale, error) {
	return s.saleRepo.GetByID(id)
}

func (s *SaleService) DeleteSale(id uint, reason string, employeeDNI string) error {
	rawDB, ok := s.saleRepo.GetDB().(*gorm.DB)
	if !ok {
		return errors.New("error de sistema: base de datos inválida")
	}

	var sale models.Sale
	err := rawDB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Preload("SaleDetails.Product.BaseProduct").
			Where("\"saleId\" = ?", id).First(&sale).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errors.New("venta no encontrada o ya anulada")
			}
			return fmt.Errorf("error bloqueando venta: %w", err)
		}

		stockAdjustments := make(map[string]float64)
		movements := make([]models.StockMovement, 0, len(sale.SaleDetails))
		for _, detail := range sale.SaleDetails {
			if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
				continue
			}
			targetBarcode := detail.Barcode
			effectiveQty := detail.Quantity
			if detail.Product.IsPack && detail.Product.BaseProductBarcode != nil && *detail.Product.BaseProductBarcode != "" {
				targetBarcode = *detail.Product.BaseProductBarcode
				effectiveQty = detail.Quantity * float64(detail.Product.PackMultiplier)
			}
			stockAdjustments[targetBarcode] -= effectiveQty
			movements = append(movements, models.StockMovement{
				Date:           time.Now(),
				Barcode:        targetBarcode,
				Quantity:       effectiveQty,
				Type:           models.MovementTypeIn,
				Reason:         models.MovementReasonVoidSale,
				ReferenceID:    fmt.Sprintf("VOID-SALE-%d", sale.SaleID),
				EmployeeDNI:    employeeDNI,
				EmployeeName:   "ADMIN/SUPERADMIN",
				AnnulledReason: reason,
			})
		}

		if len(stockAdjustments) > 0 {
			if err := s.productRepo.BatchAdjustQuantitiesWithTx(tx, stockAdjustments); err != nil {
				return fmt.Errorf("error restaurando inventario: %w", err)
			}
		}
		if len(movements) > 0 {
			if err := s.movementRepo.BatchSaveWithTx(tx, movements); err != nil {
				return fmt.Errorf("error guardando reverso en kárdex: %w", err)
			}
		}

		now := time.Now()
		if err := tx.Model(&models.StockMovement{}).
			Where("reference_id = ?", fmt.Sprintf("SALE-%d", sale.SaleID)).
			Updates(map[string]interface{}{
				"annulled_by":     employeeDNI,
				"annulled_at":     &now,
				"annulled_reason": reason,
			}).Error; err != nil {
			return fmt.Errorf("error marcando kárdex original: %w", err)
		}

		if sale.DebtPending > 0 && sale.ClientDNI != "" && sale.ClientDNI != "0" {
			var client models.Client
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("dni = ?", sale.ClientDNI).First(&client).Error; err != nil {
				return fmt.Errorf("error bloqueando cliente de la venta: %w", err)
			}
			newCredit := client.CurrentCredit - sale.DebtPending
			if newCredit < 0 {
				newCredit = 0
			}
			if err := tx.Model(&models.Client{}).Where("dni = ?", sale.ClientDNI).Updates(map[string]interface{}{
				"currentCredit": newCredit,
				"updatedByDni":  employeeDNI,
			}).Error; err != nil {
				return fmt.Errorf("error revirtiendo crédito: %w", err)
			}
		}

		if err := tx.Model(&models.Sale{}).Where("\"saleId\" = ?", id).Updates(map[string]interface{}{
			"deletedReason": reason,
			"deletedByDni":  employeeDNI,
		}).Error; err != nil {
			return fmt.Errorf("error registrando motivo de anulación: %w", err)
		}
		if err := tx.Delete(&sale).Error; err != nil {
			return fmt.Errorf("error anulando venta: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}

	cache.InvalidateCache(cache.CacheKeyProducts)
	if sale.ClientDNI != "" && sale.ClientDNI != "0" {
		cache.InvalidateCache(cache.CacheKeyClients)
		cache.InvalidateCache(fmt.Sprintf("client_dni_%s", sale.ClientDNI))
	}
	s.saleRepo.AfterCommit()

	if s.telegramService != nil {
		msg := fmt.Sprintf("🚨 *VENTA ANULADA*\n\n*Venta:* #%d\n*Monto:* $%.2f\n*Motivo:* %s\n*Autor:* %s\n*Fecha:* %s",
			sale.SaleID, sale.TotalAmount, reason, employeeDNI, time.Now().Format("2006-01-02 15:04:05"))
		s.telegramService.SendMarkdownAlert(msg)
	}
	return nil
}

func (s *SaleService) UpdateSalePayment(id uint, paymentUpdate *models.Sale) error {
	rawDB, ok := s.saleRepo.GetDB().(*gorm.DB)
	if !ok {
		return errors.New("error de sistema: base de datos inválida")
	}

	var affectedClients []string
	err := rawDB.Transaction(func(tx *gorm.DB) error {
		var existing models.Sale
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("\"saleId\" = ?", id).First(&existing).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errors.New("venta no encontrada")
			}
			return fmt.Errorf("error bloqueando venta: %w", err)
		}

		paidTotal := paymentUpdate.CashAmount + paymentUpdate.TransferAmount + paymentUpdate.CreditAmount
		if paidTotal < existing.TotalAmount-0.001 {
			return errors.New("el pago actualizado no cubre el total de la venta")
		}
		alreadyPaidCredit := existing.CreditAmount - existing.DebtPending
		if alreadyPaidCredit < 0 {
			alreadyPaidCredit = 0
		}
		if paymentUpdate.CreditAmount+0.001 < alreadyPaidCredit {
			return errors.New("el nuevo crédito no puede ser menor que los abonos ya registrados")
		}
		if alreadyPaidCredit > 0 && paymentUpdate.ClientDNI != existing.ClientDNI {
			return errors.New("no se puede cambiar el cliente de una venta con abonos")
		}
		newDebt := paymentUpdate.CreditAmount - alreadyPaidCredit
		if newDebt < 0.001 {
			newDebt = 0
		}
		if newDebt > 0 && (paymentUpdate.ClientDNI == "" || paymentUpdate.ClientDNI == "0") {
			return errors.New("debe seleccionar un cliente real para el crédito")
		}

		clientIDs := []string{}
		if existing.ClientDNI != "" && existing.ClientDNI != "0" {
			clientIDs = append(clientIDs, existing.ClientDNI)
		}
		if paymentUpdate.ClientDNI != "" && paymentUpdate.ClientDNI != "0" && paymentUpdate.ClientDNI != existing.ClientDNI {
			clientIDs = append(clientIDs, paymentUpdate.ClientDNI)
		}
		clients := make(map[string]*models.Client, len(clientIDs))
		for _, dni := range clientIDs {
			var client models.Client
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("dni = ?", dni).First(&client).Error; err != nil {
				return fmt.Errorf("cliente %s no encontrado: %w", dni, err)
			}
			clients[dni] = &client
		}
		if existing.DebtPending > 0 && clients[existing.ClientDNI] != nil {
			clients[existing.ClientDNI].CurrentCredit -= existing.DebtPending
			if clients[existing.ClientDNI].CurrentCredit < 0 {
				clients[existing.ClientDNI].CurrentCredit = 0
			}
		}
		if newDebt > 0 {
			client := clients[paymentUpdate.ClientDNI]
			if client == nil {
				var loaded models.Client
				if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("dni = ?", paymentUpdate.ClientDNI).First(&loaded).Error; err != nil {
					return fmt.Errorf("cliente no encontrado: %w", err)
				}
				client = &loaded
				clients[paymentUpdate.ClientDNI] = client
			}
			client.CurrentCredit += newDebt
			if client.CurrentCredit > client.CreditLimit {
				return errors.New("límite de crédito superado")
			}
		}
		for dni, client := range clients {
			if err := tx.Model(&models.Client{}).Where("dni = ?", dni).Update("currentCredit", client.CurrentCredit).Error; err != nil {
				return fmt.Errorf("error actualizando cartera de %s: %w", dni, err)
			}
			affectedClients = append(affectedClients, dni)
		}

		paymentUpdate.AmountPaid = paidTotal
		paymentUpdate.DebtPending = newDebt
		paymentUpdate.PaymentMethod = deriveSalePaymentMethod(paymentUpdate)
		cashForGoods := existing.TotalAmount - paymentUpdate.TransferAmount - paymentUpdate.CreditAmount
		if cashForGoods < 0 {
			cashForGoods = 0
		}
		paymentUpdate.Change = paymentUpdate.CashAmount - cashForGoods
		if paymentUpdate.Change < 0 {
			paymentUpdate.Change = 0
		}
		status := "PAID"
		if paymentUpdate.CreditAmount > 0 {
			status = "CREDIT"
		}
		return tx.Model(&models.Sale{}).Where("\"saleId\" = ?", id).Updates(map[string]interface{}{
			"clientDni": paymentUpdate.ClientDNI, "paymentMethod": paymentUpdate.PaymentMethod,
			"cashAmount": paymentUpdate.CashAmount, "transferAmount": paymentUpdate.TransferAmount,
			"transferNequi": paymentUpdate.TransferNequi, "transferDaviplata": paymentUpdate.TransferDaviplata,
			"transferSource": paymentUpdate.TransferSource, "creditAmount": paymentUpdate.CreditAmount,
			"amountPaid": paymentUpdate.AmountPaid, "change": paymentUpdate.Change,
			"debtPending": paymentUpdate.DebtPending, "status": status,
		}).Error
	})
	if err != nil {
		return err
	}
	cache.InvalidateCache(cache.CacheKeyClients)
	for _, dni := range affectedClients {
		cache.InvalidateCache(fmt.Sprintf("client_dni_%s", dni))
	}
	s.saleRepo.AfterCommit()
	return nil
}

func (s *SaleService) ListPendingDebts() ([]models.Sale, error) {
	return s.saleRepo.FindPendingDebts()
}

func (s *SaleService) RegisterDebtPayment(saleID uint, amount float64, method string, employeeDNI string) error {
	if amount <= 0 {
		return errors.New("el monto del abono debe ser mayor que cero")
	}
	method = strings.ToUpper(strings.TrimSpace(method))
	if method == "" {
		return errors.New("debe indicar el método del abono")
	}

	rawDB, ok := s.saleRepo.GetDB().(*gorm.DB)
	if !ok {
		return errors.New("error de sistema: base de datos inválida")
	}

	var clientDNI string
	err := rawDB.Transaction(func(tx *gorm.DB) error {
		var sale models.Sale
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("\"saleId\" = ?", saleID).First(&sale).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errors.New("venta no encontrada")
			}
			return fmt.Errorf("error bloqueando venta: %w", err)
		}
		if sale.DebtPending <= 0 {
			return errors.New("esta venta no tiene saldo pendiente")
		}
		if sale.ClientDNI == "" || sale.ClientDNI == "0" {
			return errors.New("la venta a crédito no tiene un cliente válido")
		}
		if amount > sale.DebtPending {
			amount = sale.DebtPending
		}
		clientDNI = sale.ClientDNI

		var client models.Client
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("dni = ?", clientDNI).First(&client).Error; err != nil {
			return fmt.Errorf("error bloqueando cliente: %w", err)
		}
		newDebt := sale.DebtPending - amount
		if err := tx.Model(&models.Sale{}).Where("\"saleId\" = ?", saleID).Update("debtPending", newDebt).Error; err != nil {
			return fmt.Errorf("error actualizando deuda de venta: %w", err)
		}
		newCredit := client.CurrentCredit - amount
		if newCredit < 0 {
			newCredit = 0
		}
		if err := tx.Model(&models.Client{}).Where("dni = ?", clientDNI).Updates(map[string]interface{}{
			"currentCredit": newCredit,
			"updatedByDni":  employeeDNI,
		}).Error; err != nil {
			return fmt.Errorf("error actualizando cartera del cliente: %w", err)
		}

		payment := &models.CreditPayment{
			ClientDNI:   clientDNI,
			EmployeeDNI: employeeDNI,
			TotalPaid:   amount,
			PaymentDate: time.Now(),
		}
		if method == "EFECTIVO" || method == "CASH" {
			payment.AmountCash = amount
		} else {
			payment.AmountTransfer = amount
			payment.TransferSource = method
		}
		if err := tx.Omit("Client", "Employee").Create(payment).Error; err != nil {
			return fmt.Errorf("error guardando historial del abono: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}

	cache.InvalidateCache(cache.CacheKeyClients)
	cache.InvalidateCache(fmt.Sprintf("client_dni_%s", clientDNI))
	s.saleRepo.AfterCommit()
	return nil
}
