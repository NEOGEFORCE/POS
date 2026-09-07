package handlers

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// MergeHistoricalMarkerRequest es el payload del endpoint admin de fusión.
// realBarcode: el código actual del producto REAL en el catálogo.
// markerBarcode: el código ocupado por el producto marcador '[HISTORICO] ...'
// que se quiere liberar (y que el producto real tome).
type MergeHistoricalMarkerRequest struct {
	RealBarcode   string `json:"realBarcode" binding:"required"`
	MarkerBarcode string `json:"markerBarcode" binding:"required"`
}

// MergeHistoricalMarker (arreglo 5(b)): endpoint SÓLO ADMIN que libera un
// código de barras retenido por un producto marcador '[HISTORICO]' creado en
// su día por paquete_produccion\corregir_referencias.ps1 para tapar FKs
// huérfanas. Sin este endpoint no había forma de recuperar el código: el
// marcador es invisible en el catálogo (isActive=false) y su historial en
// kárdex impide borrarlo por RESTRICT.
//
// La operación va en una sola transacción: mueve historial al producto real,
// borra el marcador, y renombra al real usando ON UPDATE CASCADE (ver
// PostgresProductRepository.MergeHistoricalMarker). Se registra en auditoría
// como acción crítica.
func (h *ProductHandler) MergeHistoricalMarker(c *gin.Context) {
	var req MergeHistoricalMarkerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest,
			"Se requieren 'realBarcode' (código del producto real) y 'markerBarcode' (código del marcador histórico a liberar)", err)
		return
	}

	real := strings.ToUpper(strings.TrimSpace(req.RealBarcode))
	marker := strings.ToUpper(strings.TrimSpace(req.MarkerBarcode))

	dni, name := GetContextUser(c)

	if err := h.service.MergeHistoricalMarker(real, marker, dni, name); err != nil {
		// Distinguimos errores de validación (marcador no existe, no es
		// marcador, códigos iguales) de errores internos para devolver el
		// código HTTP adecuado.
		msg := strings.ToLower(err.Error())
		switch {
		case strings.Contains(msg, "no existe"),
			strings.Contains(msg, "no es un marcador"),
			strings.Contains(msg, "no pueden ser iguales"),
			strings.Contains(msg, "también es un marcador"),
			strings.Contains(msg, "códigos requeridos"):
			SendError(c, http.StatusBadRequest, ErrBadRequest, err.Error(), err)
		default:
			SendError(c, http.StatusInternalServerError, ErrInternalServer,
				"Fallo al fusionar marcador histórico con producto real", err)
		}
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":     "Marcador histórico fusionado. El producto real ahora usa el código liberado y el historial quedó consolidado.",
		"newBarcode":  marker,
		"oldBarcode":  real,
		"auditAction": "MERGE_HISTORICAL_MARKER",
	})
}
