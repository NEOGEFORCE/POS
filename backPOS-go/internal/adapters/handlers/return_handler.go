package handlers

import (
	"net/http"
	"strings"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"

	"github.com/gin-gonic/gin"
)

type ReturnHandler struct {
	service *services.ReturnService
}

func NewReturnHandler(s *services.ReturnService) *ReturnHandler {
	return &ReturnHandler{service: s}
}

func (h *ReturnHandler) Create(c *gin.Context) {
	var ret models.Return
	if err := c.ShouldBindJSON(&ret); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	// Mayúsculas y Metadatos
	ret.Reason = strings.ToUpper(ret.Reason)
	ret.ReturnType = strings.ToUpper(ret.ReturnType)
	dni, _ := c.Get("dni")
	name, _ := c.Get("name")
	dniStr := dni.(string)
	nameStr := ""
	if name != nil {
		nameStr = name.(string)
	}
	ret.EmployeeDNI = dniStr

	if err := h.service.CreateReturn(&ret, dniStr, nameStr); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al registrar devolución", err)
		return
	}
	c.JSON(http.StatusCreated, ret)
}

func (h *ReturnHandler) GetAll(c *gin.Context) {
	returns, err := h.service.ListReturns()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener devoluciones", err)
		return
	}
	c.JSON(http.StatusOK, returns)
}
