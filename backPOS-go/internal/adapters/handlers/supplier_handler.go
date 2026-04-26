package handlers

import (
	"fmt"
	"log"
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
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	supplier.Name = strings.ToUpper(supplier.Name)
	dni, _ := c.Get("dni")
	dniStr := fmt.Sprintf("%v", dni)
	supplier.CreatedByDNI = dniStr
	supplier.UpdatedByDNI = dniStr

	if err := h.service.CreateSupplier(&supplier); err != nil {
		errStr := strings.ToLower(err.Error())
		if strings.Contains(errStr, "1062") || strings.Contains(errStr, "unique") ||
			strings.Contains(errStr, "duplicate") || strings.Contains(errStr, "duplicada") {
			SendError(c, http.StatusConflict, ErrDuplicateEntry, "El nombre del proveedor ya existe", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al registrar proveedor", err)
		return
	}
	c.JSON(http.StatusCreated, supplier)
}

func (h *SupplierHandler) GetAll(c *gin.Context) {
	log.Printf("[Suppliers] Iniciando GetAll...")

	suppliers, err := h.service.GetAllSuppliers()
	if err != nil {
		log.Printf("[Suppliers] ERROR al obtener proveedores: %v", err)
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener proveedores", err)
		return
	}

	log.Printf("[Suppliers] Éxito: %d proveedores obtenidos", len(suppliers))
	c.JSON(http.StatusOK, suppliers)
}

func (h *SupplierHandler) GetByID(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.Atoi(idParam)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "ID de proveedor inválido", err)
		return
	}

	supplier, err := h.service.GetSupplier(uint(id))
	if err != nil {
		SendError(c, http.StatusNotFound, ErrNotFound, "Proveedor no encontrado", err)
		return
	}
	c.JSON(http.StatusOK, supplier)
}

func (h *SupplierHandler) Update(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.Atoi(idParam)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "ID de proveedor inválido", err)
		return
	}

	var supplier models.Supplier
	if err := c.ShouldBindJSON(&supplier); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	supplier.Name = strings.ToUpper(supplier.Name)
	dni, _ := c.Get("dni")
	supplier.UpdatedByDNI = fmt.Sprintf("%v", dni)

	if err := h.service.UpdateSupplier(uint(id), &supplier); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			SendError(c, http.StatusNotFound, ErrNotFound, "Proveedor no encontrado", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al actualizar proveedor", err)
		return
	}
	c.JSON(http.StatusOK, supplier)
}

func (h *SupplierHandler) Delete(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.Atoi(idParam)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "ID de proveedor inválido", err)
		return
	}

	if err := h.service.DeleteSupplier(uint(id)); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al eliminar proveedor", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Proveedor eliminado"})
}
