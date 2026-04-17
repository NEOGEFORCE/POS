package handlers

import (
	"net/http"
	"strconv"
	"strings"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
)

type ExpenseHandler struct {
	service *services.ExpenseService
}

func NewExpenseHandler(s *services.ExpenseService) *ExpenseHandler {
	return &ExpenseHandler{service: s}
}

func (h *ExpenseHandler) Create(c *gin.Context) {
	var expense models.Expense
	if err := c.ShouldBindJSON(&expense); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}
	// Mayúsculas y Metadatos
	expense.Description = strings.ToUpper(expense.Description)
	dni, _ := c.Get("dni")
	expense.CreatedByDNI = dni.(string)

	if err := h.service.CreateExpense(&expense); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al registrar gasto", err)
		return
	}
	c.JSON(http.StatusCreated, expense)
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
