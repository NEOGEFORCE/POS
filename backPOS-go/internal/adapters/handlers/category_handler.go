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

type CategoryHandler struct {
	service *services.CategoryService
}

func NewCategoryHandler(s *services.CategoryService) *CategoryHandler {
	return &CategoryHandler{service: s}
}

func (h *CategoryHandler) Create(c *gin.Context) {
	var category models.Category
	if err := c.ShouldBindJSON(&category); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	// Mayúsculas y Metadatos
	category.Name = strings.ToUpper(category.Name)
	dni, _ := c.Get("dni")
	dniStr := fmt.Sprintf("%v", dni)
	category.CreatedByDNI = dniStr
	category.UpdatedByDNI = dniStr

	if err := h.service.CreateCategory(&category); err != nil {
		errStr := strings.ToLower(err.Error())
		if strings.Contains(errStr, "1062") || strings.Contains(errStr, "unique") || 
		   strings.Contains(errStr, "duplicate") || strings.Contains(errStr, "duplicada") {
			SendError(c, http.StatusConflict, ErrDuplicateEntry, "El nombre de la categoría ya existe", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al crear categoría", err)
		return
	}
	c.JSON(http.StatusCreated, category)
}

func (h *CategoryHandler) GetAll(c *gin.Context) {
	categories, err := h.service.GetAllCategories()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener categorías", err)
		return
	}
	// Log de depuración para verificar en la terminal si los conteos son > 0
	if len(categories) > 0 {
		fmt.Printf("API DEBUG: Primera categoría %s tiene ProductCount: %d\n", categories[0].Name, categories[0].ProductCount)
	}
	c.JSON(http.StatusOK, categories)
}

func (h *CategoryHandler) GetByID(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "ID inválido o mal formado", err)
		return
	}
	category, err := h.service.GetCategory(uint(id))
	if err != nil {
		SendError(c, http.StatusNotFound, ErrNotFound, "Categoría no encontrada", err)
		return
	}
	c.JSON(http.StatusOK, category)
}

func (h *CategoryHandler) Update(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "ID inválido o mal formado", err)
		return
	}
	var category models.Category
	if err := c.ShouldBindJSON(&category); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}
	if err := h.service.UpdateCategory(uint(id), &category); err != nil {
		errStr := strings.ToLower(err.Error())
		if strings.Contains(errStr, "not found") {
			SendError(c, http.StatusNotFound, ErrNotFound, "Categoría no encontrada", err)
			return
		}
		if strings.Contains(errStr, "1062") || strings.Contains(errStr, "unique") || 
		   strings.Contains(errStr, "duplicate") || strings.Contains(errStr, "duplicada") {
			SendError(c, http.StatusConflict, ErrDuplicateEntry, "El nuevo nombre ya existe en otra categoría", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al actualizar categoría", err)
		return
	}
	c.JSON(http.StatusOK, category)
}

func (h *CategoryHandler) Delete(c *gin.Context) {
	idStr := c.Param("id")
	id, err := strconv.ParseUint(idStr, 10, 32)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "ID inválido o mal formado", err)
		return
	}
	if err := h.service.DeleteCategory(uint(id)); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			SendError(c, http.StatusNotFound, ErrNotFound, "Categoría no encontrada", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al eliminar categoría", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Category deleted"})
}
