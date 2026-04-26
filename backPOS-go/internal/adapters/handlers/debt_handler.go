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
	debts, err := h.saleService.ListPendingDebts()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Error al recuperar cartera"})
		return
	}
	c.JSON(http.StatusOK, debts)
}

func (h *DebtHandler) RegisterPayment(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID de deuda inválido"})
		return
	}

	var paymentData struct {
		Amount float64 `json:"amount"`
		Method string  `json:"method"`
	}

	if err := c.ShouldBindJSON(&paymentData); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Datos de pago inválidos"})
		return
	}

	// Recuperar DNI del empleado del contexto (inyectado por AuthMiddleware)
	employeeDNI, _ := c.Get("dni")
	empDNIStr, ok := employeeDNI.(string)
	if !ok {
		empDNIStr = "SISTEMA"
	}

	if err := h.saleService.RegisterDebtPayment(uint(id), paymentData.Amount, paymentData.Method, empDNIStr); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "¡Abono registrado con éxito!"})
}
