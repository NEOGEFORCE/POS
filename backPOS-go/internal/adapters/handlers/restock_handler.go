package handlers

import (
	"fmt"
	"net/http"
	"strings"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"

	"github.com/gin-gonic/gin"
)

type RestockHandler struct {
	restockService   *services.RestockService
	inventoryService *services.InventoryService
	telegram         *services.TelegramService
	metricsRepo      *repositories.RestockMetricsRepository
}

func NewRestockHandler(
	rs *services.RestockService,
	is *services.InventoryService,
	tg *services.TelegramService,
	mr *repositories.RestockMetricsRepository,
) *RestockHandler {
	return &RestockHandler{
		restockService:   rs,
		inventoryService: is,
		telegram:         tg,
		metricsRepo:      mr,
	}
}

func (h *RestockHandler) GetSuggestions(c *gin.Context) {
	ignoreStock := c.Query("all") == "true"
	suggestions, err := h.inventoryService.GetGlobalRestockSuggestionsGrouped(ignoreStock)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, suggestions)
}

func (h *RestockHandler) GetCritical(c *gin.Context) {
	suggestions, err := h.inventoryService.GetGlobalRestockSuggestions(false)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var critical []services.SuggestedOrder
	for _, item := range suggestions {
		if item.Status == services.StockCritical || item.Stock <= item.MinStock {
			critical = append(critical, item)
		}
	}
	c.JSON(http.StatusOK, critical)
}

func (h *RestockHandler) GetPurchaseList(c *gin.Context) {
	list, err := h.restockService.GetActivePurchaseList()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, list)
}

type AddPurchaseListReq struct {
	ProductID  string  `json:"product_id"`
	SupplierID uint    `json:"supplier_id"`
	Quantity   float64 `json:"quantity"`
}

func (h *RestockHandler) AddToPurchaseList(c *gin.Context) {
	var req AddPurchaseListReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	item := &models.ActivePurchaseList{
		ProductID:  req.ProductID,
		SupplierID: req.SupplierID,
		Quantity:   req.Quantity,
	}

	err := h.restockService.AddPurchaseListItem(item)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Agregado a la lista de compra"})
}

func (h *RestockHandler) RemoveFromPurchaseList(c *gin.Context) {
	id := c.Param("id")
	err := h.restockService.RemovePurchaseListItem(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Removido de la lista"})
}

type ConfirmOrderItemReq struct {
	ProductID string  `json:"product_id"`
	Barcode   string  `json:"barcode"`
	Quantity  float64 `json:"quantity"`
	UnitCost  float64 `json:"unit_cost"`
}

type ConfirmOrderReq struct {
	SupplierID uint `json:"supplier_id"`

	ExpectedDate     string                `json:"expected_date"`
	InvoiceRef       string                `json:"invoice_ref"`
	Items            []ConfirmOrderItemReq `json:"items"`
	EstimatedTotal   float64               `json:"estimated_total"`
	RealInvoiceTotal float64               `json:"real_invoice_total"`
	ConfirmedBy      string                `json:"confirmed_by"`
	EditOrderID      string                `json:"edit_order_id"`
	AllowInTransit   bool                  `json:"allow_in_transit"`
}

func needsInTransitConfirmation(products []models.InTransitProduct, allowInTransit bool) bool {
	return len(products) > 0 && !allowInTransit
}

// declaredOrderValue devuelve el valor que el operador escribió a mano para el
// pedido, sin depender de que haya desglosado los productos.
//
// El frontend manda el mismo número en los dos campos cuando el pedido va sin
// desglose; se acepta cualquiera de los dos para no romper clientes viejos.
func declaredOrderValue(req ConfirmOrderReq) float64 {
	if req.RealInvoiceTotal > 0 {
		return req.RealInvoiceTotal
	}
	if req.EstimatedTotal > 0 {
		return req.EstimatedTotal
	}
	return 0
}

// validateConfirmOrder aplica las reglas mínimas para aceptar un pedido.
// Devuelve el mensaje de error para el operador, o "" si el pedido es válido.
//
// REGLA (agosto 2026, pedido del dueño): un pedido SIN productos desglosados es
// válido siempre que traiga un valor. El caso real es el preventista que pasa,
// acuerdan un pedido por un monto y el dueño no quiere sentarse a listar
// producto por producto: lo que necesita registrar es el compromiso con el
// proveedor y la fecha en que llega, para que la plata esté prevista.
//
// Lo que sigue siendo obligatorio:
//   - El proveedor. Sin proveedor el pedido no se puede atribuir a nadie.
//   - Que haya productos O un valor. Un pedido sin ninguna de las dos cosas no
//     registra nada y solo ensucia el historial.
func validateConfirmOrder(req ConfirmOrderReq) string {
	if req.SupplierID == 0 {
		return "El proveedor es obligatorio"
	}
	if len(req.Items) == 0 && declaredOrderValue(req) <= 0 {
		return "Agrega al menos un producto o escribe el valor del pedido"
	}
	return ""
}

func (h *RestockHandler) ConfirmOrder(c *gin.Context) {
	var req ConfirmOrderReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Datos de pedido inválidos"})
		return
	}
	if message := validateConfirmOrder(req); message != "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": message})
		return
	}

	productIDs := make([]string, 0, len(req.Items))
	items := make([]models.ConfirmedOrderItem, 0, len(req.Items))
	estimatedTotal := 0.0
	for _, reqItem := range req.Items {
		barcode := strings.TrimSpace(reqItem.Barcode)
		if barcode == "" || reqItem.Quantity <= 0 || reqItem.UnitCost < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Cada producto requiere código, cantidad positiva y costo válido"})
			return
		}
		productIDs = append(productIDs, barcode)
		items = append(items, models.ConfirmedOrderItem{
			ProductID:      barcode,
			Quantity:       reqItem.Quantity,
			EstimatedPrice: reqItem.UnitCost,
		})
		estimatedTotal += reqItem.Quantity * reqItem.UnitCost
	}

	// Pedido sin desglose: el valor declarado por el operador ES el estimado.
	// Sin esto el pedido quedaría guardado en cero y no serviría para prever la
	// plata, que es justamente para lo que se registra.
	if len(items) == 0 {
		estimatedTotal = declaredOrderValue(req)
	}

	conflicts, err := h.metricsRepo.FindInTransitProducts(c.Request.Context(), productIDs, req.EditOrderID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No se pudo verificar la mercancía en tránsito"})
		return
	}
	if needsInTransitConfirmation(conflicts, req.AllowInTransit) {
		c.JSON(http.StatusConflict, gin.H{
			"code":     "PRODUCTS_IN_TRANSIT_CONFIRMATION_REQUIRED",
			"error":    "Uno o más productos ya están en camino. Confirma si deseas pedir cantidad adicional",
			"products": conflicts,
		})
		return
	}

	_, confirmedBy := GetContextUser(c)
	realInvoiceTotal := req.RealInvoiceTotal
	if realInvoiceTotal <= 0 {
		realInvoiceTotal = estimatedTotal
	}
	if err := h.restockService.ConfirmOrder(
		req.SupplierID,
		req.ExpectedDate,
		req.InvoiceRef,
		items,
		estimatedTotal,
		realInvoiceTotal,
		confirmedBy,
		req.EditOrderID,
	); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No se pudo confirmar el pedido"})
		return
	}

	if estimatedTotal > 0 {
		diff := realInvoiceTotal - estimatedTotal
		if diff/estimatedTotal > 0.05 {
			// La alerta la lee una persona: va el NOMBRE del proveedor, no el
			// ID interno.
			label := supplierAlertLabel(req.SupplierID, h.metricsRepo.GetSupplierName(req.SupplierID))
			msg := fmt.Sprintf("⚠️ PEDIDO %s — estimado $%.0f, factura real $%.0f, diferencia +$%.0f — revisar precios en recepción",
				label, estimatedTotal, realInvoiceTotal, diff)
			h.telegram.SendAlert(msg)
		}
	}

	c.JSON(http.StatusOK, gin.H{"message": "Pedido confirmado"})
}

// supplierAlertLabel arma la etiqueta con la que un proveedor aparece en
// mensajes dirigidos a personas (alertas de Telegram).
//
// Prefiere el nombre. Si no se pudo resolver (proveedor borrado, fallo de
// consulta, nombre en blanco) cae a "PROVEEDOR #<id>" para no perder la
// trazabilidad: es peor una alerta sin identificar que una con el ID crudo.
func supplierAlertLabel(supplierID uint, name string) string {
	if n := strings.TrimSpace(name); n != "" {
		return n
	}
	return fmt.Sprintf("PROVEEDOR #%d", supplierID)
}

func (h *RestockHandler) GetPendingOrders(c *gin.Context) {
	orders, err := h.restockService.GetPendingOrders()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, orders)
}

func (h *RestockHandler) CancelPendingOrder(c *gin.Context) {
	id := c.Param("id")
	userDni, _ := c.Get("dni")

	err := h.restockService.UpdateOrderStatus(id, "CANCELED", userDni.(string))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Error al cancelar el pedido"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Pedido cancelado exitosamente"})
}

func (h *RestockHandler) MarkOrderAsReceived(c *gin.Context) {
	id := c.Param("id")
	userDni, _ := c.Get("dni")
	dniStr := ""
	if userDni != nil {
		dniStr = fmt.Sprintf("%v", userDni)
	}

	err := h.restockService.UpdateOrderStatus(id, "RECEIVED", dniStr)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Error al marcar el pedido como recibido"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Pedido marcado como recibido exitosamente"})
}

func (h *RestockHandler) GetPendingOrder(c *gin.Context) {
	id := c.Param("id")
	order, err := h.restockService.GetOrderByID(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Pedido no encontrado"})
		return
	}
	c.JSON(http.StatusOK, order)
}

func (h *RestockHandler) GetOrdersHistory(c *gin.Context) {
	// El tope sale de MaxPageSize (pagination.go), no de un número escrito aquí.
	limit := QueryPageSize(c, "limit", 10)
	offset := QueryOffset(c, "offset")

	filters := make(map[string]interface{})
	if supplier := c.Query("supplier_id"); supplier != "" {
		filters["supplier_id"] = supplier
	}
	if status := c.Query("status"); status != "" {
		filters["status"] = status
	}

	orders, total, err := h.restockService.GetOrdersHistory(limit, offset, filters)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"data":  orders,
		"total": total,
	})
}
