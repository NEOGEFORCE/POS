package handlers

import (
	"fmt"
	"net/http"
	"strconv"

	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
)

type DebtHandler struct {
	clientService *services.ClientService
	saleService   *services.SaleService
	auditService  *services.AuditService
}

func NewDebtHandler(client *services.ClientService, sale *services.SaleService, a *services.AuditService) *DebtHandler {
	return &DebtHandler{
		clientService: client,
		saleService:   sale,
		auditService:  a,
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

	// Auditoría de Pago de Deuda
	userName, _ := c.Get("userName")
	h.auditService.Log(empDNIStr, fmt.Sprintf("%v", userName), "DEBT_PAYMENT", "FINANCES", 
		fmt.Sprintf("Abono a deuda ID: %d ($%.2f)", id, paymentData.Amount),
		fmt.Sprintf("Se registró un abono de $%s para la deuda con ID #%d usando el método %s", fmt.Sprintf("%.2f", paymentData.Amount), id, paymentData.Method),
		"", c.ClientIP(), c.Request.UserAgent(), true)
}
