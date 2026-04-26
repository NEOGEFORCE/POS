package handlers

import (
	"backPOS-go/internal/core/services"
	"net/http"

	"github.com/gin-gonic/gin"
)

type DashboardReportHandler struct {
	service      *services.DashboardService
	auditService *services.AuditService
}

func NewDashboardReportHandler(s *services.DashboardService, a *services.AuditService) *DashboardReportHandler {
	return &DashboardReportHandler{service: s, auditService: a}
}

func (h *DashboardReportHandler) GetRankingReport(c *gin.Context) {
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

func (h *DashboardReportHandler) GetCategoryReport(c *gin.Context) {
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

func (h *DashboardReportHandler) GetVIPClientsReport(c *gin.Context) {
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

func (h *DashboardReportHandler) GetVoidsReport(c *gin.Context) {
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

func (h *DashboardReportHandler) GetPnLReport(c *gin.Context) {
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

func (h *DashboardReportHandler) GetInventoryMovements(c *gin.Context) {
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
