package handlers

import (
	"backPOS-go/internal/core/services"
	"net/http"
	"strconv"

	"backPOS-go/internal/infrastructure/sse"
	"github.com/gin-gonic/gin"
)

type ReportHandler struct {
	service *services.ReportService
}

func NewReportHandler(s *services.ReportService) *ReportHandler {
	return &ReportHandler{service: s}
}

func (h *ReportHandler) RecordReport(c *gin.Context) {
	var body struct {
		Name     string `json:"name"`
		Type     string `json:"type"`
		Category string `json:"category"`
		URL      string `json:"url"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	createdBy := "SISTEMA"
	nameVal, _ := c.Get("userName")
	if nameVal != nil {
		createdBy = nameVal.(string)
	}

	err := h.service.RecordReport(body.Name, body.Type, body.Category, createdBy, body.URL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to record report"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Report recorded successfully"})

	// AVISO GLOBAL: Nuevo reporte disponible en el historial
	go sse.GetSSEService().BroadcastDashboardUpdate()
}

func (h *ReportHandler) GetHistory(c *gin.Context) {
	limitStr := c.DefaultQuery("limit", "50")
	limit, _ := strconv.Atoi(limitStr)

	history, err := h.service.GetHistory(limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to fetch report history"})
		return
	}

	c.JSON(http.StatusOK, history)
}

func (h *ReportHandler) DeleteReport(c *gin.Context) {
	idStr := c.Param("id")
	id, _ := strconv.ParseUint(idStr, 10, 32)

	err := h.service.DeleteReport(uint(id))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete report"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Report deleted successfully"})

	// AVISO GLOBAL: Reporte eliminado del historial
	go sse.GetSSEService().BroadcastDashboardUpdate()
}

func (h *ReportHandler) GetStats(c *gin.Context) {
	stats, err := h.service.GetReportStats()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to fetch report stats"})
		return
	}

	c.JSON(http.StatusOK, stats)
}
