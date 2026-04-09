package handlers

import (
	"net/http"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
	"fmt"
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
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) GetCashierClosure(c *gin.Context) {
	data, err := h.service.GetCashierClosure()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *DashboardHandler) SaveClosure(c *gin.Context) {
	var closure models.CashierClosure
	if err := c.ShouldBindJSON(&closure); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Get user from context (AuthMiddleware)
	dni, _ := c.Get("dni")
	closure.ClosedByDNI = fmt.Sprintf("%v", dni)
	
	err := h.service.SaveClosure(&closure)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Cierre de caja guardado correctamente", "id": closure.ID})
}

func (h *DashboardHandler) GetClosuresHistory(c *gin.Context) {
	data, err := h.service.GetClosuresHistory()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, data)
}
