package services

import (
	"fmt"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"errors"
	"strings"
	"time"
	"gorm.io/gorm"
	"backPOS-go/internal/infrastructure/cache"
)

type SaleService struct {
	saleRepo     ports.SaleRepository
	productRepo  ports.ProductRepository
	clientRepo   ports.ClientRepository
	movementRepo ports.StockMovementRepository
	creditRepo   ports.CreditPaymentRepository
	printService    *PrintService
	telegramService *TelegramService
}

func NewSaleService(sr ports.SaleRepository, pr ports.ProductRepository, cr ports.ClientRepository, mr ports.StockMovementRepository, ps *PrintService, cpr ports.CreditPaymentRepository, ts *TelegramService) *SaleService {
	return &SaleService{saleRepo: sr, productRepo: pr, clientRepo: cr, movementRepo: mr, printService: ps, creditRepo: cpr, telegramService: ts}
}
func (s *SaleService) CreateSale(sale *models.Sale) error {
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

	productCache := make(map[string]*models.Product)
	for i := range productsDB {
		productCache[productsDB[i].Barcode] = &productsDB[i]
	}

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
		targetBarcode := detail.Barcode

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
		detail.Subtotal = applyRounding(product.SalePrice * detail.Quantity)
		total += detail.Subtotal
	}

	sale.TotalAmount = total
	paidTotal := sale.CashAmount + sale.TransferAmount + sale.CreditAmount

	if paidTotal < (total - 5.0) {
		return fmt.Errorf("pago insuficiente: total calculado %.2f, pagado %.2f", total, paidTotal)
	}

	// Lógica de método de pago y crédito
	typeCount := 0
	if sale.CashAmount > 0 { typeCount++ }
	if sale.TransferAmount > 0 { typeCount++ }
	if sale.CreditAmount > 0 { typeCount++ }

	if typeCount > 1 {
		sale.PaymentMethod = "MIXTO"
	} else if sale.CreditAmount > 0 {
		sale.PaymentMethod = "FIADO"
	} else if sale.TransferAmount > 0 {
		source := strings.ToUpper(sale.TransferSource)
		if source == "" { source = "TRANSFERENCIA" }
		sale.PaymentMethod = source
	} else {
		sale.PaymentMethod = "EFECTIVO"
	}

	if sale.CreditAmount > 0 {
		sale.DebtPending = sale.CreditAmount
		if sale.ClientDNI == "0" || sale.ClientDNI == "" {
			return errors.New("debe seleccionar un cliente real para crédito")
		}
		client, err := s.clientRepo.GetByDNI(sale.ClientDNI)
		if err != nil {
			return errors.New("cliente no encontrado")
		}
		if client.CurrentCredit+sale.CreditAmount > client.CreditLimit {
			return errors.New("límite de crédito superado")
		}
		client.CurrentCredit += sale.CreditAmount
		_ = s.clientRepo.Update(client.DNI, client)
		sale.Status = "CREDIT"
	} else {
		sale.Status = "PAID"
	}

	sale.AmountPaid = paidTotal
	cashNeeded := total - sale.TransferAmount - sale.CreditAmount
	if cashNeeded < 0 { cashNeeded = 0 }
	sale.Change = sale.CashAmount - cashNeeded
	if sale.Change < 0 { sale.Change = 0 }

	// === INICIO DE TRANSACCIÓN ATÓMICA ULTRA-RÁPIDA ===
	rawInterface := s.saleRepo.GetDB()
	rawDB, ok := rawInterface.(*gorm.DB)
	if !ok {
		return fmt.Errorf("error de sistema: base de datos inválida")
	}

	tx := rawDB.Begin()
	if tx.Error != nil {
		return fmt.Errorf("error iniciando transacción: %w", tx.Error)
	}

	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
		}
	}()

	if err := s.saleRepo.CreateWithTx(tx, sale); err != nil {
		tx.Rollback()
		return fmt.Errorf("error guardando venta: %w", err)
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

			targetBarcode := detail.Barcode
			effectiveQty := detail.Quantity

			product := productCache[detail.Barcode]
			if product.IsPack && product.BaseProductBarcode != nil {
				targetBarcode = *product.BaseProductBarcode
				effectiveQty = detail.Quantity * float64(product.PackMultiplier)
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

	if err := tx.Commit().Error; err != nil {
		return fmt.Errorf("error aplicando transacción de venta: %w", err)
	}
	// === FIN DE TRANSACCIÓN ATÓMICA ===

	cache.InvalidateCache(cache.CacheKeyProducts)
	cache.InvalidateCache(cache.CacheKeyDashboardOverview)

	// 5. Tareas secundarias en Goroutine (Background)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				fmt.Printf("⚠️ [Sale-Background] Recovery from panic in sale #%d: %v\n", sale.SaleID, r)
			}
		}()
		
		// TAREA 1: Notificaciones Proactivas de "Agotamiento Crítico"
		for _, detail := range sale.SaleDetails {
			if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
				continue
			}

			// Usar el caché de memoria (evita consultar base de datos por producto)
			cachedProduct, exists := productCache[detail.Barcode]
			if !exists || cachedProduct == nil {
				continue
			}

			// TAREA 1.5: Alerta de Venta en Negativo
			// En productCache tenemos el stock ANTES de esta venta.
			newStock := cachedProduct.Quantity - detail.Quantity
			if newStock < 0 && cachedProduct.Quantity >= 0 {
				msgNeg := fmt.Sprintf("🚨 *ALERTA DE INVENTARIO (POS)*\n"+
					"El producto *%s* acaba de ser vendido, pero su stock en sistema quedó negativo (%.2f).\n"+
					"Acción: Verificar auditoría o registrar la factura de entrada faltante.",
					cachedProduct.ProductName, newStock)
				
				s.telegramService.SendMarkdownAlert(msgNeg)
			}

			// TAREA 1: Solo alertar si el producto tiene un proveedor asignado
			if cachedProduct.SupplierID != nil {
				// Cargar la relación del proveedor para ver su VisitFrequencyDays
				productWithSupplier, err := s.productRepo.GetByBarcodeWithPreloads(detail.Barcode, "Supplier")
				if err != nil || productWithSupplier == nil || productWithSupplier.Supplier.VisitFrequencyDays <= 0 {
					continue
				}

				// Solo si tiene frecuencia de visita calculamos las métricas pesadas
				avgDaily, err := s.productRepo.GetDailySalesAverage(detail.Barcode, 14)
				if err != nil || avgDaily <= 0 {
					continue
				}

				// Estimar días hasta la próxima visita
				lastMove, err := s.movementRepo.GetLastMovementByBarcodeAndReason(detail.Barcode, "RECEPTION")
				
				daysUntilVisit := float64(productWithSupplier.Supplier.VisitFrequencyDays)
				if err == nil && lastMove != nil {
					elapsed := time.Since(lastMove.Date).Hours() / 24
					daysUntilVisit = float64(productWithSupplier.Supplier.VisitFrequencyDays) - elapsed
				}

				// Si los días hasta la visita son mayores que los días que aguanta el stock -> ALERTA
				stockSurvivalDays := newStock / avgDaily
				if daysUntilVisit > 0 && stockSurvivalDays < daysUntilVisit {
					msg := fmt.Sprintf("🚨 *¡ALERTA DE AGOTAMIENTO!*\n\n"+
						"El producto *%s* se está vendiendo rápido.\n\n"+
						"📦 *Stock Actual:* %.2f\n"+
						"📈 *Venta Diaria:* %.2f\n"+
						"⏳ *Próximo pedido en:* %.1f días\n\n"+
						"💡 _Sugerencia: Surtir externamente para no perder ventas._",
						cachedProduct.ProductName, newStock, avgDaily, daysUntilVisit)
					
					s.telegramService.SendMarkdownAlert(msg)
				}
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

	// Validar stock y preparar deducciones
	for i := range newDetails {
		detail := &newDetails[i]
		if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
			additionalTotal += detail.Subtotal
			continue
		}

		product, err := s.productRepo.GetByBarcodeWithPreloads(detail.Barcode, "BaseProduct")
		if err != nil {
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
		detail.Subtotal = applyRounding(product.SalePrice * detail.Quantity)
		additionalTotal += detail.Subtotal
	}

	// Validar stock total requerido
	for barcode := range deductions {
		_, err := s.productRepo.GetByBarcode(barcode)
		if err != nil {
			return fmt.Errorf("stock insuficiente: producto base %s no existe", barcode)
		}
		// Validación eliminada a petición del usuario para permitir vender en negativo
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
	if cashNeeded < 0 { cashNeeded = 0 }
	sale.Change = sale.CashAmount - cashNeeded
	if sale.Change < 0 { sale.Change = 0 }

	// Recalcular tipo de pago
	typeCount := 0
	if sale.CashAmount > 0 { typeCount++ }
	if sale.TransferAmount > 0 { typeCount++ }
	if sale.CreditAmount > 0 { typeCount++ }

	if typeCount > 1 {
		sale.PaymentMethod = "MIXTO"
	} else if sale.CreditAmount > 0 {
		sale.PaymentMethod = "FIADO"
	} else if sale.TransferAmount > 0 {
		source := strings.ToUpper(sale.TransferSource)
		if source == "" { source = "TRANSFERENCIA" }
		sale.PaymentMethod = source
	} else {
		sale.PaymentMethod = "EFECTIVO"
	}

	rawInterface := s.saleRepo.GetDB()
	rawDB, ok := rawInterface.(*gorm.DB)
	if !ok {
		return fmt.Errorf("error obteniendo db: tipo incorrecto")
	}
	
	// Actualizar venta
	if err := rawDB.Save(sale).Error; err != nil {
		return fmt.Errorf("error actualizando venta: %w", err)
	}

	// Insertar o actualizar detalles
	for _, detail := range newDetails {
		var existingDetail models.SaleDetail
		err := rawDB.Where("saleId = ? AND barcode = ?", sale.SaleID, detail.Barcode).First(&existingDetail).Error
		
		if err == nil && existingDetail.ID != 0 {
			existingDetail.Quantity += detail.Quantity
			existingDetail.Subtotal += detail.Subtotal
			rawDB.Save(&existingDetail)
		} else {
			detail.SaleID = sale.SaleID
			rawDB.Create(&detail)
		}
	}

	if len(deductions) > 0 {
		if err := s.productRepo.BatchAdjustQuantitiesWithTx(rawDB, deductions); err != nil {
			return fmt.Errorf("error ajustando inventario: %w", err)
		}

		for _, detail := range newDetails {
			if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" { continue }

			targetBarcode := detail.Barcode
			effectiveQty := detail.Quantity
			
			product, _ := s.productRepo.GetByBarcodeWithPreloads(detail.Barcode, "BaseProduct")
			if product != nil && product.IsPack && product.BaseProductBarcode != nil {
				targetBarcode = *product.BaseProductBarcode
				effectiveQty = detail.Quantity * float64(product.PackMultiplier)
			}

			m := &models.StockMovement{
				Date:         time.Now(),
				Barcode:      targetBarcode,
				Quantity:     effectiveQty,
				Type:         "OUT",
				Reason:       "EDIT_SALE_ADD",
				ReferenceID:  fmt.Sprintf("SALE-%d", sale.SaleID),
				EmployeeDNI:  employeeDNI,
				EmployeeName: "CAJERO",
			}
			_ = s.movementRepo.SaveWithTx(rawDB, m)
		}
	}

	cache.InvalidateCache(cache.CacheKeyProducts)
	cache.InvalidateCache(cache.CacheKeyDashboardOverview)

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
	sale, err := s.saleRepo.GetByID(id)
	if err != nil {
		return err
	}

	// 1. Restaurar Stock
	stockAdjustments := make(map[string]float64)
	for _, detail := range sale.SaleDetails {
		if strings.HasPrefix(detail.Barcode, "MISC-") || detail.Barcode == "0000" {
			continue
		}

		product, err := s.productRepo.GetByBarcodeWithPreloads(detail.Barcode, "BaseProduct")
		if err == nil {
			effectiveQty := detail.Quantity
			targetBarcode := detail.Barcode

			// Lógica de Packs (Invertida)
			if product.IsPack && product.BaseProduct != nil && product.PackMultiplier > 0 {
				targetBarcode = *product.BaseProductBarcode
				effectiveQty = detail.Quantity * float64(product.PackMultiplier)
			}

			// Acumular ajuste negativo de stock (para que al restar en el repo, se sume: quantity - (-qty))
			stockAdjustments[targetBarcode] -= effectiveQty
			
			// Registrar movimiento de entrada por anulación
			movement := &models.StockMovement{
				Date:         time.Now(),
				Barcode:      detail.Barcode,
				Quantity:     detail.Quantity,
				Type:         "IN",
				Reason:       "VOID_SALE",
				ReferenceID:  fmt.Sprintf("VOID-SALE-%d", sale.SaleID),
				EmployeeDNI:  employeeDNI,
				EmployeeName: "ADMIN/SUPERADMIN",
			}
			_ = s.movementRepo.Save(movement)
		}
	}

	if len(stockAdjustments) > 0 {
		_ = s.productRepo.BatchAdjustQuantities(stockAdjustments)
	}

	// 2. Revertir Crédito si aplica
	if sale.CreditAmount > 0 && sale.ClientDNI != "" && sale.ClientDNI != "0" {
		client, err := s.clientRepo.GetByDNI(sale.ClientDNI)
		if err == nil {
			client.CurrentCredit -= sale.DebtPending
			if client.CurrentCredit < 0 {
				client.CurrentCredit = 0
			}
			_ = s.clientRepo.Update(client.DNI, client)
		}
	}

	// 3. Borrado Lógico en Repo
	err = s.saleRepo.Delete(id, reason, employeeDNI)
	if err == nil {

		// 4. Notificar a Telegram
		if s.telegramService != nil {
			msg := fmt.Sprintf("🚨 *VENTA ANULADA*\n\n"+
				"*Venta:* #%d\n"+
				"*Monto:* $%s\n"+
				"*Motivo:* %s\n"+
				"*Autor:* %s\n"+
				"*Fecha:* %s",
				sale.SaleID,
				fmt.Sprintf("%.2f", sale.TotalAmount),
				reason,
				employeeDNI,
				time.Now().Format("2006-01-02 15:04:05"))
			s.telegramService.SendMarkdownAlert(msg)
		}
	}
	return err
}

func (s *SaleService) UpdateSalePayment(id uint, paymentUpdate *models.Sale) error {
	existing, err := s.saleRepo.GetByID(id)
	if err != nil {
		return errors.New("venta no encontrada")
	}

	// Validar que el pago cubre el total
	paidTotal := paymentUpdate.CashAmount + paymentUpdate.TransferAmount + paymentUpdate.CreditAmount
	if paidTotal < existing.TotalAmount {
		return errors.New("el pago actualizado no cubre el total de la venta")
	}

	paymentUpdate.AmountPaid = paidTotal
	// Cambio solo sobre efectivo (transferencia no devuelve)
	cashForGoods := existing.TotalAmount - paymentUpdate.TransferAmount - paymentUpdate.CreditAmount
	if cashForGoods < 0 {
		cashForGoods = 0
	}
	paymentUpdate.Change = paymentUpdate.CashAmount - cashForGoods
	if paymentUpdate.Change < 0 {
		paymentUpdate.Change = 0
	}

	// Calcular Método de Pago automáticamente
	typeCount := 0
	if paymentUpdate.CashAmount > 0 { typeCount++ }
	if paymentUpdate.TransferAmount > 0 { typeCount++ }
	if paymentUpdate.CreditAmount > 0 { typeCount++ }

	if typeCount > 1 {
		paymentUpdate.PaymentMethod = "MIXTO"
	} else if paymentUpdate.CreditAmount > 0 {
		paymentUpdate.PaymentMethod = "FIADO"
	} else if paymentUpdate.TransferAmount > 0 {
		source := strings.ToUpper(paymentUpdate.TransferSource)
		if source == "" {
			source = "TRANSFERENCIA"
		}
		paymentUpdate.PaymentMethod = source
	} else {
		paymentUpdate.PaymentMethod = "EFECTIVO"
	}

	err = s.saleRepo.UpdatePayment(id, paymentUpdate)
	return err
}

func (s *SaleService) ListPendingDebts() ([]models.Sale, error) {
	return s.saleRepo.FindPendingDebts()
}

func (s *SaleService) RegisterDebtPayment(saleID uint, amount float64, method string, employeeDNI string) error {
	sale, err := s.saleRepo.GetByID(saleID)
	if err != nil {
		return errors.New("venta no encontrada")
	}

	if sale.DebtPending <= 0 {
		return errors.New("esta venta no tiene saldo pendiente")
	}

	if amount > sale.DebtPending {
		amount = sale.DebtPending // No permitir pagar más de la deuda
	}

	// 1. Actualizar Saldo de la Venta
	newDebt := sale.DebtPending - amount
	if err := s.saleRepo.UpdateDebt(saleID, newDebt); err != nil {
		return err
	}

	// 2. Actualizar Crédito del Cliente
	if sale.ClientDNI != "" && sale.ClientDNI != "0" {
		client, err := s.clientRepo.GetByDNI(sale.ClientDNI)
		if err == nil {
			client.CurrentCredit -= amount
			if client.CurrentCredit < 0 {
				client.CurrentCredit = 0
			}
			client.UpdatedByDNI = employeeDNI
			_ = s.clientRepo.Update(client.DNI, client)

			// 3. Registrar en Historial de Abonos (CreditPayment)
			payment := &models.CreditPayment{
				ClientDNI:      sale.ClientDNI,
				EmployeeDNI:    employeeDNI,
				TotalPaid:      amount,
				PaymentDate:    time.Now(),
			}
			if method == "EFECTIVO" {
				payment.AmountCash = amount
			} else {
				payment.AmountTransfer = amount
				payment.TransferSource = method
			}
			
			_ = s.creditRepo.Save(payment)
		}
	}

	// El repositorio ya se encarga de la sincronización
	return nil
}
