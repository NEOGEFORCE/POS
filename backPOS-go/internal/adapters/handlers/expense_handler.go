package handlers

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/core/services"
	"backPOS-go/internal/infrastructure/sse"

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

	// AVISO GLOBAL: Nuevo gasto registrado (Actualiza Dashboard)
	go sse.GetSSEService().BroadcastExpenseUpdate(expense)

	// Auditoría de Egreso
	name, _ := c.Get("userName")
	h.auditService.Log(expense.CreatedByDNI, fmt.Sprintf("%v", name), "CREATE_EXPENSE", "FINANCES", 
		fmt.Sprintf("Nuevo egreso: %s ($%.2f)", expense.Description, expense.Amount),
		fmt.Sprintf("Se registró un egreso por %s de $%s", expense.Description, fmt.Sprintf("%.2f", expense.Amount)),
		"", c.ClientIP(), c.Request.UserAgent(), true)

	go sse.GetSSEService().BroadcastDashboardUpdate()
}

func normalizeExpensesForFrontend(expenses []models.Expense) {
	for i := range expenses {
		e := &expenses[i]
		if e.CashAmount > 0 || e.NequiAmount > 0 || e.DaviplataAmount > 0 || e.FondoAmount > 0 {
			var parts []string
			if e.CashAmount > 0 { parts = append(parts, "CAJA") }
			if e.NequiAmount > 0 { parts = append(parts, "NEQUI") }
			if e.DaviplataAmount > 0 { parts = append(parts, "DAVIPLATA") }
			if e.FondoAmount > 0 { parts = append(parts, "FONDO") }
			if len(parts) > 1 {
				e.PaymentSource = strings.Join(parts, " + ")
			} else if len(parts) == 1 {
				e.PaymentSource = parts[0]
			}
		} else {
			src := strings.ToUpper(e.PaymentSource)
			if strings.Contains(src, "/") && strings.Contains(src, "$") {
				// Fallback para strings antiguos de MIXTO (ej: "NEQUI: $1000 / CAJA: $1000")
				cleanSrc := strings.ReplaceAll(src, "EFECTIVO", "CAJA")
				cleanSrc = strings.ReplaceAll(cleanSrc, "CASH", "CAJA")
				// Extraer solo los nombres de los canales
				var parts []string
				if strings.Contains(cleanSrc, "NEQUI") { parts = append(parts, "NEQUI") }
				if strings.Contains(cleanSrc, "DAVIPLATA") { parts = append(parts, "DAVIPLATA") }
				if strings.Contains(cleanSrc, "CAJA") { parts = append(parts, "CAJA") }
				if strings.Contains(cleanSrc, "FONDO") { parts = append(parts, "FONDO") }
				if len(parts) > 1 {
					e.PaymentSource = strings.Join(parts, " + ")
				} else {
					e.PaymentSource = "MIXTO" // Fallback fallback
				}
			} else {
				if src == "CAJA" || src == "" { e.PaymentSource = "CAJA" }
				if src == "EFECTIVO" { e.PaymentSource = "CAJA" }
				if src == "PREST." || src == "DEUDA" { e.PaymentSource = "PRESTAMO" }
			}
		}
	}
}

func (h *ExpenseHandler) GetAll(c *gin.Context) {
	supplier := c.Query("supplier")
	concept := c.Query("concept")

	expenses, err := h.service.GetAllExpenses(supplier, concept)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener gastos", err)
		return
	}
	normalizeExpensesForFrontend(expenses)
	c.JSON(http.StatusOK, expenses)
}

func (h *ExpenseHandler) GetPaginated(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("pageSize", "50"))
	supplier := c.Query("supplier")
	concept := c.Query("concept")

	filter := ports.ExpenseFilter{
		Page:     page,
		PageSize: pageSize,
		Supplier: supplier,
		Concept:  concept,
	}

	expenses, total, err := h.service.GetExpensesPaginated(filter)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Error fetching paginated expenses", err)
		return
	}

	normalizeExpensesForFrontend(expenses)

	c.JSON(http.StatusOK, gin.H{
		"items": expenses,
		"total": total,
	})
}

func (h *ExpenseHandler) Delete(c *gin.Context) {
	idStr := c.Param("id")
	id, _ := strconv.ParseUint(idStr, 10, 32)
	if err := h.service.DeleteExpense(uint(id)); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al eliminar gasto", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Gasto eliminado correctamente"})

	// AVISO GLOBAL: Gasto eliminado (Actualiza Dashboard)
	go sse.GetSSEService().BroadcastDashboardUpdate()

	// Auditoría de Eliminación de Egreso
	dni, _ := c.Get("dni")
	name, _ := c.Get("userName")
	h.auditService.Log(dni.(string), name.(string), "DELETE_EXPENSE", "FINANCES", 
		fmt.Sprintf("Eliminado egreso ID: %d", id),
		fmt.Sprintf("Se eliminó permanentemente el egreso con ID #%d", id),
		"", c.ClientIP(), c.Request.UserAgent(), true)

	go sse.GetSSEService().BroadcastDashboardUpdate()
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
	go sse.GetSSEService().BroadcastDashboardUpdate()
	c.JSON(http.StatusOK, expense)

	// AVISO GLOBAL: Gasto saldado (Actualiza Dashboard)
	go sse.GetSSEService().BroadcastExpenseUpdate(expense)
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

	// AVISO GLOBAL: Actualizar Dashboard, Gastos e Inventario
	go sse.GetSSEService().BroadcastExpenseUpdate(expense)

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
		PaymentSource string  `json:"paymentSource" binding:"required"`
		Amount        float64 `json:"amount"` // Added for partial payments
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Datos inválidos", err)
		return
	}

	val, _ := c.Get("dni")
	updaterDNI := fmt.Sprintf("%v", val)

	expense, err := h.service.SettleExpense(uint(id), req.PaymentSource, updaterDNI, req.Amount)
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

	go sse.GetSSEService().BroadcastDashboardUpdate()
}
