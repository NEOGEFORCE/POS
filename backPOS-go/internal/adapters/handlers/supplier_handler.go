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

type SupplierHandler struct {
	service *services.SupplierService
}

func NewSupplierHandler(s *services.SupplierService) *SupplierHandler {
	return &SupplierHandler{service: s}
}

func (h *SupplierHandler) Create(c *gin.Context) {
	var supplier models.Supplier
	if err := c.ShouldBindJSON(&supplier); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	supplier.Name = strings.ToUpper(supplier.Name)
	dni, _ := c.Get("dni")
	dniStr := fmt.Sprintf("%v", dni)
	supplier.CreatedByDNI = dniStr
	supplier.UpdatedByDNI = dniStr

	if err := h.service.CreateSupplier(&supplier); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, supplier)
}

func (h *SupplierHandler) GetAll(c *gin.Context) {
	suppliers, err := h.service.GetAllSuppliers()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, suppliers)
}

func (h *SupplierHandler) GetByID(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.Atoi(idParam)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}

	supplier, err := h.service.GetSupplier(uint(id))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Proveedor no encontrado"})
		return
	}
	c.JSON(http.StatusOK, supplier)
}

func (h *SupplierHandler) Update(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.Atoi(idParam)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}

	var supplier models.Supplier
	if err := c.ShouldBindJSON(&supplier); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	supplier.Name = strings.ToUpper(supplier.Name)
	dni, _ := c.Get("dni")
	supplier.UpdatedByDNI = fmt.Sprintf("%v", dni)

	if err := h.service.UpdateSupplier(uint(id), &supplier); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, supplier)
}

func (h *SupplierHandler) Delete(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.Atoi(idParam)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID inválido"})
		return
	}

	if err := h.service.DeleteSupplier(uint(id)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Proveedor eliminado"})
}
