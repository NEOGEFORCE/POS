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
	service      *services.CategoryService
	auditService *services.AuditService
}

func NewCategoryHandler(s *services.CategoryService, a *services.AuditService) *CategoryHandler {
	return &CategoryHandler{service: s, auditService: a}
}

func (h *CategoryHandler) Create(c *gin.Context) {
	var category models.Category
	if err := c.ShouldBindJSON(&category); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	// Mayúsculas, Sanitización y Metadatos
	category.Name = strings.ToUpper(strings.TrimSpace(category.Name))
	
	// Verificar Duplicados
	if existing, err := h.service.GetCategoryByName(category.Name); err == nil && existing != nil {
		SendError(c, http.StatusConflict, ErrDuplicateEntry, "El nombre de la categoría ya existe en el sistema", gin.H{
			"id":     existing.ID,
			"name":   existing.Name,
			"active": existing.IsActive,
		})
		return
	}

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

	// Auditoría de Creación
	name, _ := c.Get("userName")
	h.auditService.Log(dniStr, name.(string), "CREATE_CATEGORY", "TAXONOMY", 
		fmt.Sprintf("Nueva categoría: %s", category.Name),
		fmt.Sprintf("Se registró la categoría: %s", category.Name),
		"", c.ClientIP(), c.Request.UserAgent(), false)
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
	category.Name = strings.ToUpper(strings.TrimSpace(category.Name))
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

	// Auditoría de Actualización
	dni, _ := c.Get("dni")
	name, _ := c.Get("userName")
	h.auditService.Log(fmt.Sprintf("%v", dni), name.(string), "UPDATE_CATEGORY", "TAXONOMY", 
		fmt.Sprintf("Actualizada categoría ID: %d (%s)", id, category.Name),
		fmt.Sprintf("Se modificó la categoría: %s (ID #%d)", category.Name, id),
		"", c.ClientIP(), c.Request.UserAgent(), false)
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

	// Auditoría de Eliminación
	dni, _ := c.Get("dni")
	name, _ := c.Get("userName")
	h.auditService.Log(fmt.Sprintf("%v", dni), name.(string), "DELETE_CATEGORY", "TAXONOMY", 
		fmt.Sprintf("Desactivada categoría ID: %d", id),
		fmt.Sprintf("Se desactivó la categoría con ID #%d", id),
		"", c.ClientIP(), c.Request.UserAgent(), true)
}
