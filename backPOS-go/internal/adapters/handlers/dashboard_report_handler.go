package handlers

import (
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/core/services"
	"net/http"
	"time"
	_ "time/tzdata"

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
	fromDate, _ := parseDate(from)
	toDate, _ := parseDate(to)

	data, err := h.service.GetRankingReport(fromDate, toDate)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al generar reporte de ranking", err)
		return
	}
	if data == nil {
		data = []ports.ProductRankingItem{}
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
	fromDate, _ := parseDate(from)
	toDate, _ := parseDate(to)

	data, err := h.service.GetCategoryReport(fromDate, toDate)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al generar reporte por categoría", err)
		return
	}
	if data == nil {
		data = []services.CategoryReportItem{}
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
	fromDate, _ := parseDate(from)
	toDate, _ := parseDate(to)

	data, err := h.service.GetVIPClientsReport(fromDate, toDate)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al generar reporte de clientes VIP", err)
		return
	}
	if data == nil {
		data = []services.VIPClientItem{}
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
	fromDate, _ := parseDate(from)
	toDate, _ := parseDate(to)

	data, err := h.service.GetVoidsReport(fromDate, toDate)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al generar reporte de anulaciones", err)
		return
	}
	if data == nil {
		data = []services.VoidReportItem{}
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
	fromDate, _ := parseDate(from)
	toDate, _ := parseDate(to)

	data, err := h.service.GetPnLReport(fromDate, toDate)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al generar reporte de P&L", err)
		return
	}
	if data == nil {
		data = &services.PnLReport{}
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
	loc, err := time.LoadLocation("America/Bogota")
	if err != nil {
		loc = time.FixedZone("America/Bogota", -5*60*60)
	}
	fromDate, _ := time.ParseInLocation("2006-01-02", from, loc)
	startOfToDate, _ := time.ParseInLocation("2006-01-02", to, loc)
	toDate := startOfToDate.Add(24 * time.Hour).Add(-time.Nanosecond)

	data, err := h.service.GetInventoryMovementsReport(fromDate, toDate)
	if err != nil {
		// Devolver array vacío en lugar de error para que el frontend no quede en carga infinita
		c.JSON(http.StatusOK, []services.StockMovementReportItem{})
		return
	}
	if data == nil {
		data = []services.StockMovementReportItem{}
	}
	c.JSON(http.StatusOK, data)
}
func (h *DashboardReportHandler) GetCashFlowReport(c *gin.Context) {
	from := c.Query("from")
	to := c.Query("to")
	if from == "" || to == "" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Los parámetros 'from' y 'to' son obligatorios", nil)
		return
	}
	fromDate, _ := parseDate(from)
	toDate, _ := parseDate(to)

	data, err := h.service.GetCashFlowReport(fromDate, toDate)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al generar reporte de flujo de caja", err)
		return
	}
	c.JSON(http.StatusOK, data)
}
