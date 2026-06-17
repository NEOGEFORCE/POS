package handlers

import (
	"net/http"
	"github.com/gin-gonic/gin"
)

func (h *ProductHandler) GetStats(c *gin.Context) {
	stats, err := h.service.GetProductStats()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener estadisticas de productos", err)
		return
	}
	c.JSON(http.StatusOK, stats)
}
