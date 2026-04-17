package handlers

import (
	"fmt"
	"net/http"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
)

type DashboardHandler struct {
	service *services.DashboardService
}

func NewDashboardHandler(s *services.DashboardService) *DashboardHandler {
	return &DashboardHandler{service: s}
}

func (h *DashboardHandler) GetOverview(c *gin.Context) {
	data, err := h.service.GetOverview()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener resumen del dashboard", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) GetCashierClosure(c *gin.Context) {
	data, err := h.service.GetCashierClosure()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener cierre de caja", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) SaveClosure(c *gin.Context) {
	var closure models.CashierClosure
	if err := c.ShouldBindJSON(&closure); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de cierre inválido", err)
		return
	}

	// Get user from context (AuthMiddleware)
	dni, _ := c.Get("dni")
	closure.ClosedByDNI = fmt.Sprintf("%v", dni)

	err := h.service.SaveClosure(&closure)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al guardar cierre de caja", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Cierre de caja guardado correctamente", "id": closure.ID})
}

func (h *DashboardHandler) GetClosuresHistory(c *gin.Context) {
	data, err := h.service.GetClosuresHistory()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener historial de cierres", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) GetRankingReport(c *gin.Context) {
	from := c.Query("from")
	to := c.Query("to")
	if from == "" || to == "" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Los parámetros 'from' y 'to' son obligatorios", nil)
		return
	}
	data, err := h.service.GetRankingReport(from, to)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al generar reporte de ranking", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) GetCategoryReport(c *gin.Context) {
	from := c.Query("from")
	to := c.Query("to")
	if from == "" || to == "" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Los parámetros 'from' y 'to' son obligatorios", nil)
		return
	}
	data, err := h.service.GetCategoryReport(from, to)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al generar reporte por categoría", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) GetVIPClientsReport(c *gin.Context) {
	from := c.Query("from")
	to := c.Query("to")
	if from == "" || to == "" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Los parámetros 'from' y 'to' son obligatorios", nil)
		return
	}
	data, err := h.service.GetVIPClientsReport(from, to)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al generar reporte de clientes VIP", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) GetVoidsReport(c *gin.Context) {
	from := c.Query("from")
	to := c.Query("to")
	if from == "" || to == "" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Los parámetros 'from' y 'to' son obligatorios", nil)
		return
	}
	data, err := h.service.GetVoidsReport(from, to)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al generar reporte de anulaciones", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) GetPnLReport(c *gin.Context) {
	from := c.Query("from")
	to := c.Query("to")
	if from == "" || to == "" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Los parámetros 'from' y 'to' son obligatorios", nil)
		return
	}
	data, err := h.service.GetPnLReport(from, to)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al generar reporte de P&L", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) GetInventoryMovements(c *gin.Context) {
	from := c.Query("from")
	to := c.Query("to")
	if from == "" || to == "" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Los parámetros 'from' y 'to' son obligatorios", nil)
		return
	}
	data, err := h.service.GetInventoryMovementsReport(from, to)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al generar reporte de movimientos de inventario", err)
		return
	}
	c.JSON(http.StatusOK, data)
}
