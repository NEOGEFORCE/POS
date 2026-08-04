package handlers

import (
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"

	"backPOS-go/internal/infrastructure/sse"
	"github.com/gin-gonic/gin"
)

type OrderHandler struct {
	inventoryService     *services.InventoryService
	orderService         *services.PurchaseOrderService
	expectedOrderService *services.ExpectedOrderService
	telegramService      *services.TelegramService
	auditService         *services.AuditService
	restockService       *services.RestockService
	expenseService       *services.ExpenseService
}

func NewOrderHandler(inv *services.InventoryService, ord *services.PurchaseOrderService, expOrd *services.ExpectedOrderService, tg *services.TelegramService, a *services.AuditService, rs *services.RestockService, es *services.ExpenseService) *OrderHandler {
	return &OrderHandler{
		inventoryService:     inv,
		orderService:         ord,
		expectedOrderService: expOrd,
		telegramService:      tg,
		auditService:         a,
		restockService:       rs,
		expenseService:       es,
	}
}

func (h *OrderHandler) GetSuggestedOrders(c *gin.Context) {
	supplierIDStr := c.Query("supplier_id")

	// Si es "global", retornar todos los productos en riesgo (Radar Global) agrupados por proveedor
	if supplierIDStr == "global" {
		ignoreStock := c.Query("all") == "true"
		suggested, err := h.inventoryService.GetGlobalRestockSuggestionsGrouped(ignoreStock)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, suggested)
		return
	}

	if supplierIDStr == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "supplier_id is required"})
		return
	}

	supplierID, err := strconv.ParseUint(supplierIDStr, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid supplier_id"})
		return
	}

	ignoreStock := c.Query("all") == "true"
	suggested, err := h.inventoryService.GetSuggestedOrders(uint(supplierID), ignoreStock)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, suggested)
}

// GetGlobalRestockSuggestions - Endpoint para Radar Global (productos sin proveedor o con bajo stock) agrupados por proveedor
func (h *OrderHandler) GetGlobalRestockSuggestions(c *gin.Context) {
	log.Printf("[Radar Global] Iniciando solicitud de restock global...")

	ignoreStock := c.Query("all") == "true"
	suggested, err := h.inventoryService.GetGlobalRestockSuggestionsGrouped(ignoreStock)
	if err != nil {
		log.Printf("[Radar Global] ERROR en servicio: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Error interno al obtener sugerencias de restock",
			"details": err.Error(),
		})
		return
	}

	log.Printf("[Radar Global] Éxito: %d grupos de proveedor devueltos", len(suggested))
	c.JSON(http.StatusOK, suggested)
}

func (h *OrderHandler) CreateOrder(c *gin.Context) {
	var order models.PurchaseOrder
	if err := c.ShouldBindJSON(&order); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Set creator from context if available (assuming auth middleware sets it)
	if creatorDNI, exists := c.Get("userDni"); exists {
		order.CreatedByDNI = creatorDNI.(string)
	}

	if err := h.orderService.CreateOrder(&order); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, order)

	// AVISO GLOBAL: Nueva orden de compra
	go sse.GetSSEService().BroadcastDashboardUpdate()

	// Auditoría de Pedido
	dniEmployee, _ := c.Get("dni")
	name, _ := c.Get("userName")
	h.auditService.Log(fmt.Sprintf("%v", dniEmployee), fmt.Sprintf("%v", name), "CREATE_ORDER", "LOGISTICS", 
		fmt.Sprintf("Nuevo pedido a proveedor ID: %d", order.SupplierID),
		fmt.Sprintf("Se generó una orden de compra para el proveedor ID #%d por $%s", order.SupplierID, fmt.Sprintf("%.2f", order.EstimatedCost)),
		"", c.ClientIP(), c.Request.UserAgent(), false)
}

func (h *OrderHandler) GetAllOrders(c *gin.Context) {
	supplierIDStr := c.Query("supplier_id")
	
	// SPRINT: Unified list
	var unified []map[string]interface{}
	var hasSupplierFilter bool
	var targetSupplierID uint

	if supplierIDStr != "" {
		parsed, err := strconv.ParseUint(supplierIDStr, 10, 32)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid supplier_id"})
			return
		}
		targetSupplierID = uint(parsed)
		hasSupplierFilter = true
	}

	// 0. Native Purchase Orders
	var orders []models.PurchaseOrder
	var err error
	if hasSupplierFilter {
		orders, err = h.orderService.GetPendingOrdersBySupplier(targetSupplierID)
	} else {
		orders, err = h.orderService.GetAllOrders()
	}
	
	if err == nil {
		for _, o := range orders {
			unified = append(unified, map[string]interface{}{
				"id":            o.ID,
				"source":        "purchase_order",
				"supplierId":    o.SupplierID,
				"supplierName":  o.Supplier.Name,
				"estimatedCost": o.EstimatedCost,
				"createdAt":     o.OrderDate,
				"expectedDate":  o.OrderDate, // Fallback
				"status":        string(o.Status),
				"itemCount":     len(o.OrderItems),
				"orderItems":    o.OrderItems,
			})
		}
	}

	// 1. ExpectedOrders (Preventas/Pedidos Informales)
	var expected []models.ExpectedOrder
	if hasSupplierFilter {
		expected, err = h.expectedOrderService.GetExpectedOrdersBySupplier(targetSupplierID)
	} else {
		// Assuming we can get all if needed, but let's just get all expected orders
		expected, err = h.expectedOrderService.GetAllExpectedOrders()
	}
	if err == nil {
		for _, eo := range expected {
			unified = append(unified, map[string]interface{}{
				"id":            eo.ID,
				"source":        "expected",
				"supplierId":    eo.SupplierID,
				"supplierName":  eo.SupplierName,
				"estimatedCost": eo.TotalEstimated,
				"createdAt":     eo.CreatedAt,
				"expectedDate":  eo.ExpectedDate,
				"status":        eo.Status,
				"itemCount":     eo.ItemCount,
				"orderItems":    eo.Items,
			})
		}
	}

	// 2. ConfirmedOrders (Pedidos Inteligentes)
	var confirmed []models.ConfirmedOrder
	if hasSupplierFilter {
		confirmed, err = h.restockService.GetPendingOrdersBySupplier(targetSupplierID)
	} else {
		confirmed, err = h.restockService.GetPendingOrders()
	}
	if err == nil {
		for _, co := range confirmed {
			unified = append(unified, map[string]interface{}{
				"id":            co.ID,
				"source":        "confirmed",
				"supplierId":    co.SupplierID,
				"supplierName":  co.Supplier.Name,
				"estimatedCost": co.EstimatedTotal,
				"createdAt":     co.ConfirmedAt,
				"expectedDate":  co.ExpectedDate,
				"status":        co.Status,
				"invoiceRef":    co.InvoiceRef,
				"itemCount":     len(co.Items),
				"orderItems":    co.Items,
			})
		}
	}

	// 3. Expenses (Egresos a proveedores no restocked)
	// For expenses we only do it if supplier filter exists, since there's no GetPendingRestockExpenses global yet.
	if hasSupplierFilter {
		expenses, err := h.expenseService.GetPendingRestockExpensesBySupplier(targetSupplierID)
		if err == nil {
			for _, exp := range expenses {
				unified = append(unified, map[string]interface{}{
					"id":            exp.ID,
					"source":        "expense",
					"supplierId":    exp.SupplierID,
					"estimatedCost": exp.Amount,
					"createdAt":     exp.Date,
					"expectedDate":  exp.Date,
					"itemCount":     0,
					"orderItems":    []models.PurchaseOrderItem{},
				})
			}
		}
	}

	c.JSON(http.StatusOK, unified)
}

// GetOrderItems devuelve el detalle de productos de un pedido por su ID
func (h *OrderHandler) GetOrderItems(c *gin.Context) {
	idStr := c.Param("id")
	sourceType := c.Query("source") // optional: purchase_order, confirmed, expected

	// Try as confirmed order first (ConfirmedOrder = Pedido Inteligente)
	if sourceType == "" || sourceType == "confirmed" {
		orders, err := h.restockService.GetPendingOrders()
		if err == nil {
			for _, co := range orders {
				if fmt.Sprintf("%v", co.ID) == idStr {
					type ItemDetail struct {
						ProductName string  `json:"productName"`
						Barcode     string  `json:"barcode"`
						Quantity    float64 `json:"quantity"`
						UnitCost    float64 `json:"unitCost"`
					}
					items := make([]ItemDetail, 0, len(co.Items))
					for _, item := range co.Items {
						name := item.ProductID
						if item.Product.ProductName != "" {
							name = item.Product.ProductName
						}
						items = append(items, ItemDetail{
							ProductName: name,
							Barcode:     item.ProductID,
							Quantity:    float64(item.Quantity),
							UnitCost:    item.EstimatedPrice,
						})
					}
					c.JSON(http.StatusOK, items)
					return
				}
			}
		}
	}

	// Try as purchase order
	if sourceType == "" || sourceType == "purchase_order" {
		allOrders, err := h.orderService.GetAllOrders()
		if err == nil {
			for _, po := range allOrders {
				if fmt.Sprintf("%v", po.ID) == idStr {
					type ItemDetail struct {
						ProductName string  `json:"productName"`
						Barcode     string  `json:"barcode"`
						Quantity    float64 `json:"quantity"`
						UnitCost    float64 `json:"unitCost"`
					}
					items := make([]ItemDetail, 0, len(po.OrderItems))
					for _, item := range po.OrderItems {
						name := item.ProductBarcode
						if item.Product.ProductName != "" {
							name = item.Product.ProductName
						}
						items = append(items, ItemDetail{
							ProductName: name,
							Barcode:     item.ProductBarcode,
							Quantity:    float64(item.Quantity),
							UnitCost:    item.UnitPrice,
						})
					}
					c.JSON(http.StatusOK, items)
					return
				}
			}
		}
	}

	// Try as expected order (preventa)
	if sourceType == "" || sourceType == "expected" {
		expectedOrders, err := h.expectedOrderService.GetAllExpectedOrders()
		if err == nil {
			for _, eo := range expectedOrders {
				if fmt.Sprintf("%v", eo.ID) == idStr {
					type ItemDetail struct {
						ProductName string  `json:"productName"`
						Barcode     string  `json:"barcode"`
						Quantity    float64 `json:"quantity"`
						UnitCost    float64 `json:"unitCost"`
					}
					items := make([]ItemDetail, 0, len(eo.Items))
					for _, item := range eo.Items {
						items = append(items, ItemDetail{
							ProductName: item.ProductName,
							Barcode:     item.Barcode,
							Quantity:    float64(item.ExpectedQuantity),
							UnitCost:    0,
						})
					}
					c.JSON(http.StatusOK, items)
					return
				}
			}
		}
	}

	// Not found — return empty array (no error, el modal lo maneja)
	c.JSON(http.StatusOK, []interface{}{})
}

type DismissOrderRequest struct {
	ID   interface{} `json:"id" binding:"required"`
	Type string      `json:"type" binding:"required"` // "purchase_order", "expected", "confirmed", "expense"
}

func (h *OrderHandler) DismissOrder(c *gin.Context) {
	var req DismissOrderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	dniEmployee, _ := c.Get("dni")
	
	switch req.Type {
	case "purchase_order":
		idStr := fmt.Sprintf("%v", req.ID)
		idUint, _ := strconv.ParseUint(idStr, 10, 32)
		err := h.orderService.UpdateOrderStatus(uint(idUint), "dismissed")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	case "expected":
		idStr := fmt.Sprintf("%v", req.ID)
		idUint, _ := strconv.ParseUint(idStr, 10, 32)
		err := h.expectedOrderService.MarkAsReceived(uint(idUint))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	case "confirmed":
		err := h.restockService.UpdateOrderStatus(fmt.Sprintf("%v", req.ID), "dismissed", fmt.Sprintf("%v", dniEmployee))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	case "expense":
		idStr := fmt.Sprintf("%v", req.ID)
		idUint, _ := strconv.ParseUint(idStr, 10, 32)
		exp, err := h.expenseService.GetByID(uint(idUint))
		if err == nil {
			exp.IsRestocked = true
			err = h.expenseService.UpdateExpense(uint(idUint), exp)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid order type"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Order dismissed successfully"})
}

// SendDeliverySummaryToTelegram - Envía resumen completo de entregas del día a Telegram
func (h *OrderHandler) SendDeliverySummaryToTelegram(c *gin.Context) {
	log.Printf("[Telegram] Generando resumen de entregas para hoy...")

	var req struct {
		Orders []struct {
			SupplierName   string  `json:"supplierName"`
			EstimatedCost  float64 `json:"estimatedCost"`
			TotalEstimated float64 `json:"totalEstimated"`
			InvoiceRef     string  `json:"invoiceRef"`
		} `json:"orders"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		log.Printf("[Telegram] Error parseando payload: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Payload inválido", "details": err.Error()})
		return
	}

	if len(req.Orders) == 0 {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"message": "No hay entregas programadas en el reporte",
		})
		return
	}

	// Agrupar y consolidar montos por proveedor
	type SupSummary struct {
		Name  string
		Total float64
	}
	supMap := make(map[string]*SupSummary)
	var supOrder []string

	for _, o := range req.Orders {
		supName := strings.TrimSpace(o.SupplierName)
		if supName == "" {
			supName = "PROVEEDOR VARIADO"
		}
		val := o.EstimatedCost
		if val == 0 {
			val = o.TotalEstimated
		}
		if o.InvoiceRef != "" {
			cleanInv := regexp.MustCompile(`[^0-9.]`).ReplaceAllString(o.InvoiceRef, "")
			if parsedInv, err := strconv.ParseFloat(cleanInv, 64); err == nil && parsedInv > 0 {
				val = parsedInv
			}
		}

		if existing, exists := supMap[supName]; exists {
			existing.Total += val
		} else {
			supMap[supName] = &SupSummary{Name: supName, Total: val}
			supOrder = append(supOrder, supName)
		}
	}

	var totalCash float64
	var supplierList strings.Builder

	for i, supName := range supOrder {
		item := supMap[supName]
		supplierList.WriteString(fmt.Sprintf("🚛 *%s*\n   💰 Valor: `$%s COP`\n\n", item.Name, formatMoney(item.Total)))
		totalCash += item.Total
		if i >= 19 {
			supplierList.WriteString(fmt.Sprintf("\n_Y %d proveedores más..._\n", len(supOrder)-20))
			break
		}
	}

	loc, err := time.LoadLocation("America/Bogota")
	if err != nil {
		loc = time.UTC
	}
	now := time.Now().In(loc)

	message := fmt.Sprintf(
		"📦 *PLAN DE ENTREGAS ESPERADAS*\n"+
			"📅 *Fecha:* `%s` ⏰ *%s*\n"+
			"➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖\n\n"+
			"💰 *INVERSIÓN TOTAL:* `$%s COP`\n"+
			"📋 *PROVEEDORES EN CAMINO:* `%d`\n\n"+
			"%s"+
			"➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖➖\n"+
			"🤖 _Sistema POS Pro Sincronizado_",
		now.Format("02/01/2006"),
		now.Format("03:04 PM"),
		formatMoney(totalCash),
		len(supOrder),
		supplierList.String(),
	)

	// Enviar mensaje vía Telegram
	h.telegramService.SendAlert(message)

	log.Printf("[Telegram] Resumen enviado: %d proveedores, total $%s", len(req.Orders), formatMoney(totalCash))

	c.JSON(http.StatusOK, gin.H{
		"success":     true,
		"message":     "Resumen enviado a Telegram",
		"ordersCount": len(req.Orders),
		"totalAmount": totalCash,
	})
}


// formatMoney formatea un valor numérico agregando puntos de miles (formato COP) sin decimales.
func formatMoney(amount float64) string {
	intAmt := int64(amount)
	s := fmt.Sprintf("%d", intAmt)
	
	// Si es negativo, guardamos el signo
	sign := ""
	if intAmt < 0 {
		sign = "-"
		s = s[1:]
	}

	var result []byte
	for i := 0; i < len(s); i++ {
		if i > 0 && (len(s)-i)%3 == 0 {
			result = append(result, '.')
		}
		result = append(result, s[i])
	}
	return sign + string(result)
}

// CreateExpectedOrder - POST /orders/expected
// Crea un nuevo pedido esperado. Si supplierId es 0, crea automáticamente el proveedor.
func (h *OrderHandler) CreateExpectedOrder(c *gin.Context) {
	var req struct {
		SupplierID     uint    `json:"supplierId"`
		SupplierName   string  `json:"supplierName"`
		ExpectedDate   string  `json:"expectedDate"`
		TotalEstimated float64 `json:"totalEstimated"`
		ItemCount      int     `json:"itemCount"`
		Items          []struct {
			Barcode          string  `json:"barcode"`
			ProductName      string  `json:"productName"`
			ExpectedQuantity float64 `json:"expectedQuantity"`
		} `json:"items"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		fmt.Println("🔥 ERROR CRÍTICO BINDING JSON (POST expected):", err)
		log.Printf("[CreateExpectedOrder] Error binding JSON: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{
			"error":    err.Error(),
			"message":  "Error al parsear JSON del request",
			"endpoint": "POST /orders/expected",
		})
		return
	}

	// Parsear fecha - soporta múltiples formatos
	var expectedDate time.Time
	var err error

	// Intentar formato ISO8601/RFC3339 completo
	expectedDate, err = time.Parse(time.RFC3339, req.ExpectedDate)
	if err != nil {
		// Intentar con formato datetime-local (HTML)
		expectedDate, err = time.Parse("2006-01-02T15:04", req.ExpectedDate)
		if err != nil {
			// Intentar con formato fecha simple YYYY-MM-DD (del frontend)
			expectedDate, err = time.Parse("2006-01-02", req.ExpectedDate)
			if err != nil {
				log.Printf("[CreateExpectedOrder] Error parseando fecha '%s': %v", req.ExpectedDate, err)
				c.JSON(http.StatusBadRequest, gin.H{"error": "Formato de fecha inválido. Use YYYY-MM-DD o ISO8601"})
				return
			}
		}
	}

	// Forzar la fecha a mediodía en la zona horaria de Colombia para evitar el desfase UTC
	loc, _ := time.LoadLocation("America/Bogota")
	expectedDate = time.Date(expectedDate.Year(), expectedDate.Month(), expectedDate.Day(), 12, 0, 0, 0, loc)

	// Obtener datos del creador del contexto (si está disponible)
	createdByDNI, _ := c.Get("userDni")
	createdByName, _ := c.Get("userName")

	dni := ""
	name := ""
	if createdByDNI != nil {
		dni = createdByDNI.(string)
	}
	if createdByName != nil {
		name = createdByName.(string)
	}

	// Convertir struct anónimo a modelos
	var expectedItems []models.ExpectedOrderItem
	for _, item := range req.Items {
		expectedItems = append(expectedItems, models.ExpectedOrderItem{
			Barcode:          item.Barcode,
			ProductName:      item.ProductName,
			ExpectedQuantity: item.ExpectedQuantity,
		})
	}

	// Crear el pedido esperado
	order, err := h.expectedOrderService.CreateExpectedOrderFromRequest(
		req.SupplierID,
		req.SupplierName,
		expectedDate,
		req.TotalEstimated,
		req.ItemCount,
		createdByDNI,
		createdByName,
		expectedItems,
	)
	if err != nil {
		fmt.Println("🔥 ERROR CRÍTICO CREANDO EXPECTED ORDER:", err)
		log.Printf("[CreateExpectedOrder] Error creando orden: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":    err.Error(),
			"message":  "Falla en base de datos al crear expected order",
			"endpoint": "POST /orders/expected",
		})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"success": true,
		"message": "Pedido esperado registrado correctamente",
		"order":   order,
	})

	// AVISO GLOBAL: Nueva preventa/pedido esperado
	go sse.GetSSEService().BroadcastDashboardUpdate()

	// Auditoría de Preventa
	h.auditService.Log(dni, name, "CREATE_EXPECTED_ORDER", "LOGISTICS", 
		fmt.Sprintf("Preventa registrada: %s ($%.2f)", req.SupplierName, req.TotalEstimated),
		fmt.Sprintf("Se registró una preventa para %s por $%s", req.SupplierName, fmt.Sprintf("%.2f", req.TotalEstimated)),
		"", c.ClientIP(), c.Request.UserAgent(), false)
}

// GetExpectedOrdersToday - GET /orders/expected-today
// Obtiene los pedidos esperados para el día actual o una fecha específica (?date=YYYY-MM-DD)
// BLINDAJE DEFENSIVO: Nunca retorna 500, siempre 200 OK (array vacío si hay error)
func (h *OrderHandler) GetExpectedOrdersToday(c *gin.Context) {
	dateStr := c.Query("date")
	
	var orders []models.ExpectedOrder
	var err error

	if dateStr != "" {
		orders, err = h.expectedOrderService.GetExpectedOrdersByDate(dateStr)
	} else {
		orders, err = h.expectedOrderService.GetExpectedOrdersToday()
	}

	if err != nil {
		// BLINDAJE DEFENSIVO: Loggear error pero retornar 200 OK con array vacío
		fmt.Printf("🔥 ERROR CRÍTICO EN DB (expected orders for %s): %v\n", dateStr, err)
		log.Printf("[GetExpectedOrdersToday] Error detallado (pero retornando 200 OK vacío): %v", err)
		// NUNCA retornar 500 - siempre devolver array vacío para que el frontend no colapse
		c.JSON(http.StatusOK, []models.ExpectedOrder{})
		return
	}

	// Si orders es nil, retornar array vacío explícito
	if orders == nil {
		orders = []models.ExpectedOrder{}
	}

	c.JSON(http.StatusOK, orders)
}
