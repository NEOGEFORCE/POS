package handlers

import (
	"net/http"
	"strconv"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
)

type OrderHandler struct {
	inventoryService *services.InventoryService
	orderService     *services.PurchaseOrderService
}

func NewOrderHandler(inv *services.InventoryService, ord *services.PurchaseOrderService) *OrderHandler {
	return &OrderHandler{
		inventoryService: inv,
		orderService:     ord,
	}
}

func (h *OrderHandler) GetSuggestedOrders(c *gin.Context) {
	supplierIDStr := c.Query("supplier_id")
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
}

func (h *OrderHandler) GetAllOrders(c *gin.Context) {
	orders, err := h.orderService.GetAllOrders()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, orders)
}
