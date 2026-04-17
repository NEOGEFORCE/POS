package middlewares

import (
	"github.com/gin-gonic/gin"
)

// MiddlewareError define el formato estándar de errores para el frontend
// Compatible con el formato de handlers.SendError
type MiddlewareError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details string `json:"details,omitempty"`
}

type MiddlewareErrorResponse struct {
	Error MiddlewareError `json:"error"`
}

// sendMiddlewareError centraliza la respuesta de errores en middlewares
// Mantiene la misma estructura que handlers.SendError para que el frontend
// pueda parsear todos los errores con extractApiError de forma uniforme.
func sendMiddlewareError(c *gin.Context, status int, code, message string) {
	c.JSON(status, MiddlewareErrorResponse{
		Error: MiddlewareError{
			Code:    code,
			Message: message,
		},
	})
}
