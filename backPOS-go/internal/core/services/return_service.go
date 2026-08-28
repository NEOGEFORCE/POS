package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/sse"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type ReturnService struct {
	returnRepo   ports.ReturnRepository
	productRepo  ports.ProductRepository
	saleRepo     ports.SaleRepository
	movementRepo ports.StockMovementRepository
}

func NewReturnService(rr ports.ReturnRepository, pr ports.ProductRepository, sr ports.SaleRepository, mr ports.StockMovementRepository) *ReturnService {
	return &ReturnService{returnRepo: rr, productRepo: pr, saleRepo: sr, movementRepo: mr}
}

// ============================================================
// Helpers compartidos: política de devoluciones
// ============================================================
//
// REGLA DE NEGOCIO (ratificada en el sprint 2026-05-30):
//   - Solo se permite REFUND (devolución de dinero) si la venta original
//     fue pagada en EFECTIVO. Cualquier otro método (transferencia, fiado,
//     tarjeta, mixto, etc.) obliga a EXCHANGE: el cliente debe llevarse
//     producto por valor equivalente o mayor.
//   - El stock SIEMPRE se ajusta: items devueltos suman al inventario
//     (regresan a la góndola) e items de reemplazo restan (salen al cliente).
//   - El dinero solo se mueve si hay diferencia: en REFUND se crea un
//     Expense category=Devoluciones (egreso real de caja); en EXCHANGE con
//     chargeAmount > 0 se crea una mini-Sale (ingreso real de caja).

// isCashOnlyMethod verifica si el método de pago es estrictamente efectivo
// (única vía para permitir REFUND). Aplica normalización case-insensitive
// y trimspace para tolerar variantes del frontend.
func isCashOnlyMethod(method string) bool {
	m := strings.ToUpper(strings.TrimSpace(method))
	return m == "EFECTIVO" || m == "CASH"
}

// validateRefundAllowed retorna error si la venta original no permite REFUND.
// Centraliza la decisión para que tanto CreateReturn como ProcessAdvancedReturn
// apliquen la misma regla y el mensaje de error sea consistente.
func validateRefundAllowed(sale *models.Sale) error {
	if sale == nil {
		return errors.New("solo se permite reembolso con factura asociada (modo ciego no aplica)")
	}
	if !isCashOnlyMethod(sale.PaymentMethod) {
		return fmt.Errorf(
			"solo se permite reembolso en efectivo (esta venta fue pagada con %s) — usa EXCHANGE para que el cliente se lleve otro producto",
			sale.PaymentMethod,
		)
	}
	return nil
}

// validateItemsAgainstSale verifica que cada item solicitado para devolver
// (1) está en la venta original y (2) no excede la cantidad disponible
// (vendida menos la ya devuelta previamente). Esto previene:
//   - Devolver productos que NO fueron vendidos en esa factura.
//   - Devolver más de lo realmente comprado.
//   - Doble devolución del mismo item.
//
// La tolerancia de 0.001 evita falsos positivos por floats en productos
// pesables (kg, lb).
func validateItemsAgainstSale(sale *models.Sale, items []ports.ReturnItemReq) error {
	if sale == nil {
		return errors.New("no se puede validar items: venta original no encontrada")
	}
	available := make(map[string]float64)
	for _, det := range sale.SaleDetails {
		available[det.Barcode] += det.Quantity - det.ReturnedQty
	}
	for _, it := range items {
		if it.Qty <= 0 {
			continue
		}
		avail, ok := available[it.Barcode]
		if !ok {
			return fmt.Errorf("el producto %s no fue vendido en la factura #%d", it.Barcode, sale.SaleID)
		}
		if it.Qty > avail+0.001 {
			return fmt.Errorf(
				"cantidad %.2f de %s excede lo disponible para devolución (vendido pendiente: %.2f)",
				it.Qty, it.Barcode, avail,
			)
		}
		available[it.Barcode] = avail - it.Qty
	}
	return nil
}

// returnDetailsToItemReqs adapta los []ReturnDetail del flujo legacy
// CreateReturn al []ReturnItemReq usado por validateItemsAgainstSale.
// Solo considera items NO-IsExchange (los que el cliente está devolviendo);
// los IsExchange son productos de salida (reemplazos) y no aplican.
func returnDetailsToItemReqs(details []models.ReturnDetail) []ports.ReturnItemReq {
	out := make([]ports.ReturnItemReq, 0, len(details))
	for _, d := range details {
		if d.IsExchange {
			continue
		}
		out = append(out, ports.ReturnItemReq{Barcode: d.Barcode, Qty: d.Quantity})
	}
	return out
}

func (s *ReturnService) loadProductsForStockChanges(barcodes []string) (map[string]*models.Product, error) {
	unique := make([]string, 0, len(barcodes))
	seen := make(map[string]struct{}, len(barcodes))
	for _, barcode := range barcodes {
		if barcode == "" {
			continue
		}
		if _, exists := seen[barcode]; !exists {
			seen[barcode] = struct{}{}
			unique = append(unique, barcode)
		}
	}
	if len(unique) == 0 {
		return map[string]*models.Product{}, nil
	}

	products, err := s.productRepo.GetByBarcodes(unique)
	if err != nil {
		return nil, err
	}
	lookup := buildProductLookup(products)
	for _, barcode := range unique {
		if lookup[barcode] == nil {
			return nil, errors.New("producto no encontrado: " + barcode)
		}
	}
	return lookup, nil
}

func (s *ReturnService) appendReturnStockChange(
	products map[string]*models.Product,
	adjustments map[string]float64,
	movements *[]*models.StockMovement,
	barcode string,
	quantity float64,
	outgoing bool,
	referenceID string,
	employeeDNI string,
	employeeName string,
) error {
	if quantity <= 0 {
		return errors.New("la cantidad de devolución/cambio debe ser mayor que cero")
	}
	product := products[barcode]
	if product == nil {
		return errors.New("producto no encontrado: " + barcode)
	}
	targetBarcode := barcode
	effectiveQty := quantity
	available := product.Quantity
	if product.IsPack && product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" {
		targetBarcode = *product.BaseProductBarcode
		effectiveQty = quantity * float64(product.PackMultiplier)
		if product.BaseProduct != nil {
			available = product.BaseProduct.Quantity
		}
	}
	if outgoing && available < effectiveQty && !product.IsWeighted {
		return errors.New("insuficiente stock para cambio: " + product.ProductName)
	}
	delta := effectiveQty
	movementType := models.MovementTypeIn
	reason := models.MovementReasonReturn
	if outgoing {
		delta = -effectiveQty
		movementType = models.MovementTypeOut
		reason = models.MovementReasonExchangeOut
	}
	adjustments[targetBarcode] += delta
	*movements = append(*movements, &models.StockMovement{
		Date: time.Now(), Barcode: targetBarcode, Quantity: effectiveQty,
		Type: movementType, Reason: reason, ReferenceID: referenceID,
		EmployeeDNI: employeeDNI, EmployeeName: employeeName,
	})
	return nil
}

func (s *ReturnService) CreateReturn(ret *models.Return, employeeDNI string, employeeName string) error {
	originalSale, err := s.saleRepo.GetByID(ret.SaleID)
	if err != nil {
		return errors.New("venta no encontrada")
	}
	if strings.ToUpper(ret.ReturnType) == "REFUND" {
		if err := validateRefundAllowed(originalSale); err != nil {
			return err
		}
	}
	if err := validateItemsAgainstSale(originalSale, returnDetailsToItemReqs(ret.Details)); err != nil {
		return err
	}

	barcodes := make([]string, 0, len(ret.Details))
	for _, detail := range ret.Details {
		barcodes = append(barcodes, detail.Barcode)
	}
	products, err := s.loadProductsForStockChanges(barcodes)
	if err != nil {
		return err
	}

	stockAdjustments := make(map[string]float64)
	movements := make([]*models.StockMovement, 0, len(ret.Details))
	referenceID := fmt.Sprintf("RET-SALE-%d-%d", ret.SaleID, time.Now().UnixNano())
	for _, detail := range ret.Details {
		if err := s.appendReturnStockChange(products, stockAdjustments, &movements, detail.Barcode, detail.Quantity,
			detail.IsExchange, referenceID, employeeDNI, employeeName); err != nil {
			return err
		}
	}
	if err := s.returnRepo.CreateWithTransaction(ret, employeeDNI, employeeName, stockAdjustments, movements); err != nil {
		return err
	}
	cache.InvalidateCache(cache.CacheKeyDashboardOverview)
	sse.GetSSEService().BroadcastDashboardUpdate()
	return nil
}

func (s *ReturnService) ListReturns() ([]models.Return, error) {
	return s.returnRepo.GetAll()
}

func (s *ReturnService) DeleteReturn(id uint, adminDNI string, adminName string) error {
	return s.returnRepo.DeleteWithTransaction(id, adminDNI, adminName)
}

func (s *ReturnService) GetSaleForReturn(refStr string) (*models.Sale, error) {
	id, err := strconv.ParseUint(refStr, 10, 32)
	if err != nil {
		return nil, errors.New("formato de id invalido")
	}
	sale, err := s.saleRepo.GetByID(uint(id))
	if err != nil {
		return nil, err
	}
	return sale, nil
}

func (s *ReturnService) GetBlindReturnData(barcode string) (map[string]interface{}, error) {
	// Find in recent sales using FindAll
	sales, _, err := s.saleRepo.FindAll(ports.SaleFilter{Page: 1, PageSize: 100})
	if err != nil {
		return nil, err
	}

	var productFound bool
	var totalValidQty float64
	var cashRefundable float64
	var lastSaleMethod string
	var lastSaleId uint
	var productName string
	var unitPrice float64

	for _, sale := range sales {
		for _, detail := range sale.SaleDetails {
			if detail.Barcode == barcode {
				productFound = true
				productName = detail.Product.ProductName
				unitPrice = detail.UnitPrice
				available := detail.Quantity - detail.ReturnedQty
				if available > 0 {
					totalValidQty += available
					if lastSaleId == 0 {
						lastSaleId = sale.SaleID
						lastSaleMethod = sale.PaymentMethod
					}
					// Proporcionalmente sumar efectivo
					if sale.CashAmount > 0 {
						cashRefundable += available * detail.UnitPrice // Simplificado, asumiendo que el efectivo cubrió esto
					}
				}
			}
		}
	}

	if !productFound || totalValidQty == 0 {
		return nil, errors.New("Este producto no fue vendido recientemente o ya fue devuelto completamente")
	}

	return map[string]interface{}{
		"barcode":           barcode,
		"productName":       productName,
		"unitPrice":         unitPrice,
		"validQty":          totalValidQty,
		"lastSaleId":        lastSaleId,
		"lastPaymentMethod": lastSaleMethod,
		"cashRefundable":    cashRefundable,
	}, nil
}

func (s *ReturnService) ProcessAdvancedReturn(req ports.ProcessReturnReq, employeeDNI string, employeeName string) (*models.Return, error) {
	var originalSale *models.Sale
	var err error
	if req.InvoiceRef > 0 {
		originalSale, err = s.saleRepo.GetByID(req.InvoiceRef)
		if err != nil {
			return nil, errors.New("venta original no encontrada")
		}
		if strings.ToUpper(req.Type) == "REFUND" {
			if err := validateRefundAllowed(originalSale); err != nil {
				return nil, err
			}
		}
		if err := validateItemsAgainstSale(originalSale, req.ReturnedItems); err != nil {
			return nil, err
		}
	} else if strings.ToUpper(req.Type) == "REFUND" {
		return nil, errors.New("modo ciego sin factura: solo se permite cambio por otro producto (EXCHANGE), no reembolso en efectivo")
	}

	barcodes := make([]string, 0, len(req.ReturnedItems)+len(req.ReplacementItems))
	for _, item := range req.ReturnedItems {
		barcodes = append(barcodes, item.Barcode)
	}
	for _, item := range req.ReplacementItems {
		barcodes = append(barcodes, item.Barcode)
	}
	products, err := s.loadProductsForStockChanges(barcodes)
	if err != nil {
		return nil, err
	}

	stockAdjustments := make(map[string]float64)
	movements := make([]*models.StockMovement, 0, len(req.ReturnedItems)+len(req.ReplacementItems))
	referenceID := fmt.Sprintf("RET-SALE-%d-%d", req.InvoiceRef, time.Now().UnixNano())
	for _, item := range req.ReturnedItems {
		if err := s.appendReturnStockChange(products, stockAdjustments, &movements, item.Barcode, item.Qty,
			false, referenceID, employeeDNI, employeeName); err != nil {
			return nil, err
		}
	}
	for _, item := range req.ReplacementItems {
		if err := s.appendReturnStockChange(products, stockAdjustments, &movements, item.Barcode, item.Qty,
			true, referenceID, employeeDNI, employeeName); err != nil {
			return nil, err
		}
	}
	ret, err := s.returnRepo.ProcessAdvancedReturnTransaction(req, originalSale, employeeDNI, employeeName, stockAdjustments, movements)
	if err != nil {
		return nil, err
	}
	cache.InvalidateCache(cache.CacheKeyDashboardOverview)
	sse.GetSSEService().BroadcastDashboardUpdate()
	return ret, nil
}
