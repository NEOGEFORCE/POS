package handlers

import (
	"net/http"
	"strconv"

	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
)

type DebtHandler struct {
	clientService *services.ClientService
	saleService   *services.SaleService
}

func NewDebtHandler(client *services.ClientService, sale *services.SaleService) *DebtHandler {
	return &DebtHandler{
		clientService: client,
		saleService:   sale,
	}
}

func (h *DebtHandler) GetPendingDebts(c *gin.Context) {
	// We'll reuse SaleService or move some logic to a new DebtService
	// For now, let's assume we can get them through the sale repository
	// Filter: paymentMethod == 'FIADO' and debtPending > 0
	
	// This would require a new logic in SaleService
	c.JSON(http.StatusNotImplemented, gin.H{"message": "Endpoint in development"})
}

func (h *DebtHandler) RegisterPayment(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid debt id"})
		return
	}

	var paymentData struct {
		Amount float64 `json:"amount"`
		Method string  `json:"method"`
	}

	if err := c.ShouldBindJSON(&paymentData); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Update logic would go here
	_ = id
	c.JSON(http.StatusNotImplemented, gin.H{"message": "Endpoint in development"})
}
