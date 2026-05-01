package handlers

import (
	"fmt"
	"net/http"
	"strconv"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
)

type SaleHandler struct {
	service      *services.SaleService
	auditService *services.AuditService
	sseService   *services.SSEService
}

func NewSaleHandler(s *services.SaleService, a *services.AuditService, sse *services.SSEService) *SaleHandler {
	return &SaleHandler{service: s, auditService: a, sseService: sse}
}

func (h *SaleHandler) Create(c *gin.Context) {
	var sale models.Sale
	if err := c.ShouldBindJSON(&sale); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos de venta inválido", err)
		return
	}

	// Inyectar metadatos (DNI del empleado que vende) de forma segura
	dni, exists := c.Get("dni")
	if !exists {
		SendError(c, http.StatusUnauthorized, ErrUnauthorized, "Usuario no autenticado", nil)
		return
	}

	dniStr, ok := dni.(string)
	if !ok {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Error interno de autenticación", nil)
		return
	}
	sale.EmployeeDNI = dniStr

	if err := h.service.CreateSale(&sale); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al registrar venta", err)
		return
	}

	// ULTRA-INSTINTO: Broadcast SSE para actualización en tiempo real del Dashboard
	go h.sseService.BroadcastNewSale(sale)

	c.JSON(http.StatusCreated, sale)

	// Auditoría de Venta
	name, _ := c.Get("userName")
	h.auditService.Log(dniStr, name.(string), "CREATE_SALE", "SALES", 
		fmt.Sprintf("Venta registrada: #%d", sale.SaleID),
		fmt.Sprintf("Se registró una nueva venta (#%d) por valor de $%s", sale.SaleID, fmt.Sprintf("%.2f", sale.TotalAmount)),
		"", c.ClientIP(), c.Request.UserAgent(), false)
}

func (h *SaleHandler) GetAll(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("pageSize", "10"))
	from := c.Query("from")
	to := c.Query("to")
	clientDni := c.Query("clientDni")
	employeeDni := c.Query("employeeDni")
	minTotal, _ := strconv.ParseFloat(c.DefaultQuery("minTotal", "0"), 64)
	maxTotal, _ := strconv.ParseFloat(c.DefaultQuery("maxTotal", "0"), 64)

	filter := ports.SaleFilter{
		Page:        page,
		PageSize:    pageSize,
		From:        from,
		To:          to,
		ClientDNI:   clientDni,
		EmployeeDNI: employeeDni,
		MinTotal:    minTotal,
		MaxTotal:    maxTotal,
	}

	sales, total, err := h.service.ListSales(filter)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener ventas", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"items":    sales,
		"total":    total,
		"page":     page,
		"pageSize": pageSize,
	})
}

func (h *SaleHandler) GetByID(c *gin.Context) {
	idStr := c.Param("id")
	id, _ := strconv.ParseUint(idStr, 10, 32)
	sale, err := h.service.GetSale(uint(id))
	if err != nil {
		SendError(c, http.StatusNotFound, ErrNotFound, "Venta no encontrada", err)
		return
	}
	c.JSON(http.StatusOK, sale)
}

func (h *SaleHandler) Delete(c *gin.Context) {
	idStr := c.Param("id")
	id, _ := strconv.ParseUint(idStr, 10, 32)
	
	// Obtener datos de la venta antes de borrar
	sale, _ := h.service.GetSale(uint(id))

	if err := h.service.DeleteSale(uint(id)); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al eliminar venta", err)
		return
	}

	// Auditoría de Anulación de Venta (MUY CRÍTICO)
	dni, _ := c.Get("dni")
	name, _ := c.Get("userName")
	details := fmt.Sprintf("Venta #%d eliminada/anulada", id)
	human := fmt.Sprintf("Se eliminó/anuló permanentemente la venta #%d", id)
	if sale != nil {
		human = fmt.Sprintf("Se eliminó/anuló la venta #%d por valor de $%s (Cliente: %s)", id, fmt.Sprintf("%.2f", sale.TotalAmount), sale.ClientDNI)
	}

	h.auditService.Log(dni.(string), name.(string), "VOID_SALE", "SALES", details, human, "{}", c.ClientIP(), c.Request.UserAgent(), true)

	c.JSON(http.StatusOK, gin.H{"message": "Venta eliminada correctamente"})
}

func (h *SaleHandler) UpdatePayment(c *gin.Context) {
	idStr := c.Param("id")
	id, _ := strconv.ParseUint(idStr, 10, 32)
	var sale models.Sale
	if err := c.ShouldBindJSON(&sale); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos de pago inválido", err)
		return
	}
	if err := h.service.UpdateSalePayment(uint(id), &sale); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al actualizar pago", err)
		return
	}

	// Auditoría de Cambio de Pago
	dni, _ := c.Get("dni")
	name, _ := c.Get("userName")
	h.auditService.Log(dni.(string), name.(string), "UPDATE_PAYMENT", "SALES", 
		fmt.Sprintf("Actualizado pago venta #%d", id),
		fmt.Sprintf("Se modificó la información de pago para la venta #%d", id),
		"{}", c.ClientIP(), c.Request.UserAgent(), true)

	c.JSON(http.StatusOK, gin.H{"message": "Pago actualizado correctamente"})
}
