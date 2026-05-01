package handlers

import (
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"

	"github.com/gin-gonic/gin"
)

type OrderHandler struct {
	inventoryService     *services.InventoryService
	orderService         *services.PurchaseOrderService
	expectedOrderService *services.ExpectedOrderService
	telegramService      *services.TelegramService
	auditService         *services.AuditService
}

func NewOrderHandler(inv *services.InventoryService, ord *services.PurchaseOrderService, expOrd *services.ExpectedOrderService, tg *services.TelegramService, a *services.AuditService) *OrderHandler {
	return &OrderHandler{
		inventoryService:     inv,
		orderService:         ord,
		expectedOrderService: expOrd,
		telegramService:      tg,
		auditService:         a,
	}
}

func (h *OrderHandler) GetSuggestedOrders(c *gin.Context) {
	supplierIDStr := c.Query("supplier_id")

	// Si es "global", retornar todos los productos en riesgo (Radar Global)
	if supplierIDStr == "global" {
		suggested, err := h.inventoryService.GetGlobalRestockSuggestions()
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

	suggested, err := h.inventoryService.GetSuggestedOrders(uint(supplierID))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, suggested)
}

// GetGlobalRestockSuggestions - Endpoint para Radar Global (productos sin proveedor o con bajo stock)
func (h *OrderHandler) GetGlobalRestockSuggestions(c *gin.Context) {
	log.Printf("[Radar Global] Iniciando solicitud de restock global...")

	suggested, err := h.inventoryService.GetGlobalRestockSuggestions()
	if err != nil {
		log.Printf("[Radar Global] ERROR en servicio: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Error interno al obtener sugerencias de restock",
			"details": err.Error(),
		})
		return
	}

	log.Printf("[Radar Global] Éxito: %d productos devueltos", len(suggested))
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
	if supplierIDStr != "" {
		supplierID, err := strconv.ParseUint(supplierIDStr, 10, 32)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid supplier_id"})
			return
		}
		orders, err := h.orderService.GetPendingOrdersBySupplier(uint(supplierID))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		// SPRINT: También incluir "ExpectedOrders" (preventas/pedidos informales)
		expected, err := h.expectedOrderService.GetExpectedOrdersBySupplier(uint(supplierID))
		if err == nil {
			for _, eo := range expected {
				// Mapear ExpectedOrder a una estructura que el frontend entienda (PurchaseOrder dummy)
				// El frontend espera .orderItems.length para mostrar el conteo
				dummyItems := make([]models.PurchaseOrderItem, eo.ItemCount)
				
				orders = append(orders, models.PurchaseOrder{
					ID:            eo.ID,
					SupplierID:    eo.SupplierID,
					EstimatedCost: eo.TotalEstimated,
					Status:        models.PurchaseOrderPending,
					OrderDate:     eo.CreatedAt,
					OrderItems:    dummyItems,
				})
			}
		}

		c.JSON(http.StatusOK, orders)
		return
	}

	orders, err := h.orderService.GetAllOrders()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, orders)
}

// SendDeliverySummaryToTelegram - Envía resumen completo de entregas del día a Telegram
func (h *OrderHandler) SendDeliverySummaryToTelegram(c *gin.Context) {
	log.Printf("[Telegram] Generando resumen de entregas para hoy...")

	// Obtener pedidos pendientes para hoy
	orders, err := h.orderService.GetPendingOrdersByDeliveryDate(time.Now())
	if err != nil {
		log.Printf("[Telegram] Error obteniendo pedidos: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Error al obtener pedidos", "details": err.Error()})
		return
	}

	if len(orders) == 0 {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"message": "No hay entregas programadas para hoy",
		})
		return
	}

	// Calcular total y construir lista de proveedores
	var totalCash float64
	var supplierList strings.Builder

	for i, o := range orders {
		supplierList.WriteString(fmt.Sprintf("• *%s*: $%s COP\n", o.Supplier.Name, formatMoney(o.EstimatedCost)))
		totalCash += o.EstimatedCost
		if i >= 9 { // Limitar a 10 proveedores para no exceder límites de Telegram
			supplierList.WriteString(fmt.Sprintf("\n_Y %d proveedores más..._\n", len(orders)-10))
			break
		}
	}

	// Construir mensaje formateado
	message := fmt.Sprintf(
		"🚚 *RESUMEN DE ENTREGAS ESPERADAS - HOY*\n"+
			"📅 *Fecha:* %s\n\n"+
			"💰 *Total a Pagar:* $%s COP\n"+
			"📦 *Proveedores en fila (%d):*\n\n"+
			"%s\n"+
			"─────────────────────────\n"+
			"_Sistema POS - Logística Automática_",
		time.Now().Format("02/01/2006"),
		formatMoney(totalCash),
		len(orders),
		supplierList.String(),
	)

	// Enviar mensaje vía Telegram
	h.telegramService.SendAlert(message)

	log.Printf("[Telegram] Resumen enviado: %d proveedores, total $%s", len(orders), formatMoney(totalCash))

	c.JSON(http.StatusOK, gin.H{
		"success":     true,
		"message":     "Resumen enviado a Telegram",
		"ordersCount": len(orders),
		"totalAmount": totalCash,
	})
}

// formatMoney formatea un valor float a string con 2 decimales
func formatMoney(amount float64) string {
	return fmt.Sprintf("%.2f", amount)
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

	// Crear el pedido esperado
	order, err := h.expectedOrderService.CreateExpectedOrderFromRequest(
		req.SupplierID,
		req.SupplierName,
		expectedDate,
		req.TotalEstimated,
		req.ItemCount,
		dni,
		name,
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

	// Auditoría de Preventa
	h.auditService.Log(dni, name, "CREATE_EXPECTED_ORDER", "LOGISTICS", 
		fmt.Sprintf("Preventa registrada: %s ($%.2f)", req.SupplierName, req.TotalEstimated),
		fmt.Sprintf("Se registró una preventa para %s por $%s", req.SupplierName, fmt.Sprintf("%.2f", req.TotalEstimated)),
		"", c.ClientIP(), c.Request.UserAgent(), false)
}

// GetExpectedOrdersToday - GET /orders/expected-today
// Obtiene los pedidos esperados para el día actual
// BLINDAJE DEFENSIVO: Nunca retorna 500, siempre 200 OK (array vacío si hay error)
func (h *OrderHandler) GetExpectedOrdersToday(c *gin.Context) {
	orders, err := h.expectedOrderService.GetExpectedOrdersToday()
	if err != nil {
		// BLINDAJE DEFENSIVO: Loggear error pero retornar 200 OK con array vacío
		fmt.Println("🔥 ERROR CRÍTICO EN DB (expected-today):", err)
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
