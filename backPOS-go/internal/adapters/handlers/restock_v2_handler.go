package handlers

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
)

type RestockV2Handler struct {
	metricsRepo *repositories.RestockMetricsRepository
	nightlySvc  *services.RestockNightlyService
}

func NewRestockV2Handler(
	mr *repositories.RestockMetricsRepository,
	ns *services.RestockNightlyService,
) *RestockV2Handler {
	return &RestockV2Handler{metricsRepo: mr, nightlySvc: ns}
}

func (h *RestockV2Handler) GetSuggestionsV2(c *gin.Context) {
	var supplierID *uint
	if value := c.Query("supplier_id"); value != "" && value != "0" {
		parsed, err := strconv.ParseUint(value, 10, 32)
		if err != nil || parsed == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "supplier_id inválido"})
			return
		}
		id := uint(parsed)
		supplierID = &id
	}

	suggestions, err := h.metricsRepo.GetSuggestions(c.Request.Context(), supplierID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "no se pudieron cargar las sugerencias"})
		return
	}
	c.JSON(http.StatusOK, suggestions)
}

func (h *RestockV2Handler) TriggerManualCalculation(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Minute)
	defer cancel()

	if err := h.nightlySvc.RunNightlyMetricsCalculation(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "falló el cálculo de restock"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Cálculo nocturno de restock completado"})
}
