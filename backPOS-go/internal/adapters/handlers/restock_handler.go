package handlers

import (
	"net/http"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"

	"github.com/gin-gonic/gin"
)

type RestockHandler struct {
	restockService   *services.RestockService
	inventoryService *services.InventoryService
}

func NewRestockHandler(rs *services.RestockService, is *services.InventoryService) *RestockHandler {
	return &RestockHandler{
		restockService:   rs,
		inventoryService: is,
	}
}

func (h *RestockHandler) GetSuggestions(c *gin.Context) {
	suggestions, err := h.inventoryService.GetGlobalRestockSuggestionsGrouped()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, suggestions)
}

func (h *RestockHandler) GetCritical(c *gin.Context) {
	suggestions, err := h.inventoryService.GetGlobalRestockSuggestions()
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

type ConfirmOrderReq struct {
	SupplierID       uint    `json:"supplier_id"`
	EstimatedTotal   float64 `json:"estimated_total"`
	RealInvoiceTotal float64 `json:"real_invoice_total"`
	ConfirmedBy      string  `json:"confirmed_by"`
}

func (h *RestockHandler) ConfirmOrder(c *gin.Context) {
	var req ConfirmOrderReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	err := h.restockService.ConfirmOrder(req.SupplierID, req.EstimatedTotal, req.RealInvoiceTotal, req.ConfirmedBy)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Pedido confirmado"})
}
