package handlers

import (
	"net/http"
	"strconv"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
)

type SaleHandler struct {
	service *services.SaleService
}

func NewSaleHandler(s *services.SaleService) *SaleHandler {
	return &SaleHandler{service: s}
}

func (h *SaleHandler) Create(c *gin.Context) {
	var sale models.Sale
	if err := c.ShouldBindJSON(&sale); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Inyectar metadatos (DNI del empleado que vende) de forma segura
	dni, exists := c.Get("dni")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Usuario no autenticado"})
		return
	}

	dniStr, ok := dni.(string)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Error interno de autenticación"})
		return
	}
	sale.EmployeeDNI = dniStr

	if err := h.service.CreateSale(&sale); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, sale)
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
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
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
		c.JSON(http.StatusNotFound, gin.H{"error": "Venta no encontrada"})
		return
	}
	c.JSON(http.StatusOK, sale)
}

func (h *SaleHandler) Delete(c *gin.Context) {
	idStr := c.Param("id")
	id, _ := strconv.ParseUint(idStr, 10, 32)
	if err := h.service.DeleteSale(uint(id)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Venta eliminada correctamente"})
}

func (h *SaleHandler) UpdatePayment(c *gin.Context) {
	idStr := c.Param("id")
	id, _ := strconv.ParseUint(idStr, 10, 32)
	var sale models.Sale
	if err := c.ShouldBindJSON(&sale); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.service.UpdateSalePayment(uint(id), &sale); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Pago actualizado correctamente"})
}
