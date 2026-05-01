package handlers

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"

	"github.com/gin-gonic/gin"
)

type ExpenseHandler struct {
	service      *services.ExpenseService
	auditService *services.AuditService
}

func NewExpenseHandler(s *services.ExpenseService, a *services.AuditService) *ExpenseHandler {
	return &ExpenseHandler{service: s, auditService: a}
}

func (h *ExpenseHandler) Create(c *gin.Context) {
	var expense models.Expense
	if err := c.ShouldBindJSON(&expense); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}
	// Mayúsculas y Metadatos
	expense.Description = strings.ToUpper(strings.TrimSpace(expense.Description))

	val, exists := c.Get("dni")
	if exists {
		// Convertimos a string de forma segura según el tipo de dato en el JWT
		switch v := val.(type) {
		case string:
			expense.CreatedByDNI = strings.ToUpper(strings.TrimSpace(v))
		case float64:
			expense.CreatedByDNI = fmt.Sprintf("%.0f", v)
		default:
			expense.CreatedByDNI = strings.ToUpper(strings.TrimSpace(fmt.Sprintf("%v", v)))
		}
	}

	if err := h.service.CreateExpense(&expense); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al registrar gasto", err)
		return
	}
	c.JSON(http.StatusCreated, expense)

	// Auditoría de Egreso
	name, _ := c.Get("userName")
	h.auditService.Log(expense.CreatedByDNI, fmt.Sprintf("%v", name), "CREATE_EXPENSE", "FINANCES", 
		fmt.Sprintf("Nuevo egreso: %s ($%.2f)", expense.Description, expense.Amount),
		fmt.Sprintf("Se registró un egreso por %s de $%s", expense.Description, fmt.Sprintf("%.2f", expense.Amount)),
		"", c.ClientIP(), c.Request.UserAgent(), true)
}

func (h *ExpenseHandler) GetAll(c *gin.Context) {
	expenses, err := h.service.GetAllExpenses()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener gastos", err)
		return
	}
	c.JSON(http.StatusOK, expenses)
}

func (h *ExpenseHandler) Delete(c *gin.Context) {
	idStr := c.Param("id")
	id, _ := strconv.ParseUint(idStr, 10, 32)
	if err := h.service.DeleteExpense(uint(id)); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al eliminar gasto", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Gasto eliminado correctamente"})

	// Auditoría de Eliminación de Egreso
	dni, _ := c.Get("dni")
	name, _ := c.Get("userName")
	h.auditService.Log(dni.(string), name.(string), "DELETE_EXPENSE", "FINANCES", 
		fmt.Sprintf("Eliminado egreso ID: %d", id),
		fmt.Sprintf("Se eliminó permanentemente el egreso con ID #%d", id),
		"", c.ClientIP(), c.Request.UserAgent(), true)
}

func (h *ExpenseHandler) Update(c *gin.Context) {
	idStr := c.Param("id")
	id, _ := strconv.ParseUint(idStr, 10, 32)
	var expense models.Expense
	if err := c.ShouldBindJSON(&expense); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}
	if err := h.service.UpdateExpense(uint(id), &expense); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al actualizar gasto", err)
		return
	}
	c.JSON(http.StatusOK, expense)
}

// CreateLinked crea un egreso vinculado a una orden de compra pendiente
// Request body debe incluir: linkedOrderId (ID de la orden a vincular)
// Este endpoint:
// 1. Crea el egreso
// 2. Marca la orden como RECIBIDA
// 3. Actualiza el stock automáticamente según los items de la orden
func (h *ExpenseHandler) CreateLinked(c *gin.Context) {
	var req struct {
		models.Expense
		LinkedOrderID uint `json:"linkedOrderId" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido - linkedOrderId es requerido", err)
		return
	}

	// Mayúsculas y Metadatos
	req.Expense.Description = strings.ToUpper(strings.TrimSpace(req.Expense.Description))

	val, exists := c.Get("dni")
	if exists {
		switch v := val.(type) {
		case string:
			req.Expense.CreatedByDNI = strings.ToUpper(strings.TrimSpace(v))
		case float64:
			req.Expense.CreatedByDNI = fmt.Sprintf("%.0f", v)
		default:
			req.Expense.CreatedByDNI = strings.ToUpper(strings.TrimSpace(fmt.Sprintf("%v", v)))
		}
	}

	expense, err := h.service.CreateLinkedExpense(&req.Expense, req.LinkedOrderID)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, err.Error(), err)
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"message":       "Egreso registrado y stock actualizado correctamente",
		"expense":       expense,
		"linkedOrderId": req.LinkedOrderID,
	})

	// Auditoría de Egreso Vinculado
	name, _ := c.Get("userName")
	h.auditService.Log(req.Expense.CreatedByDNI, fmt.Sprintf("%v", name), "CREATE_LINKED_EXPENSE", "FINANCES", 
		fmt.Sprintf("Egreso vinculado (Orden #%d): %s ($%.2f)", req.LinkedOrderID, req.Expense.Description, req.Expense.Amount),
		fmt.Sprintf("Se registró un egreso de $%s vinculado a la orden #%d", fmt.Sprintf("%.2f", req.Expense.Amount), req.LinkedOrderID),
		"", c.ClientIP(), c.Request.UserAgent(), true)
}

func (h *ExpenseHandler) Settle(c *gin.Context) {
	idStr := c.Param("id")
	id, _ := strconv.ParseUint(idStr, 10, 32)

	var req struct {
		PaymentSource string `json:"paymentSource" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Fuente de pago requerida", err)
		return
	}

	val, _ := c.Get("dni")
	updaterDNI := fmt.Sprintf("%v", val)

	expense, err := h.service.SettleExpense(uint(id), req.PaymentSource, updaterDNI)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, err.Error(), err)
		return
	}

	c.JSON(http.StatusOK, expense)

	// Auditoría de Pago de Deuda
	name, _ := c.Get("userName")
	h.auditService.Log(updaterDNI, fmt.Sprintf("%v", name), "SETTLE_EXPENSE_DEBT", "FINANCES", 
		fmt.Sprintf("Deuda saldada ID: %d (%s)", id, expense.Description),
		fmt.Sprintf("Se pagó la deuda de $%s con %s", fmt.Sprintf("%.2f", expense.Amount), expense.PaymentSource),
		"", c.ClientIP(), c.Request.UserAgent(), true)
}
