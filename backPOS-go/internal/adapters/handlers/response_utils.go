package handlers

import (
	"github.com/gin-gonic/gin"
)

// APIError define el formato estándar de errores para el frontend
type APIError struct {
	Code     string `json:"code"`
	Message  string `json:"message"`
	Details  string `json:"details,omitempty"`
	Metadata any    `json:"metadata,omitempty"`
}

// ErrorResponse envuelve el APIError en un objeto "error" para fácil lectura
type ErrorResponse struct {
	Error APIError `json:"error"`
}

// SendError centraliza la respuesta de errores en el backend
func SendError(c *gin.Context, status int, code, message string, errOrMeta any) {
	details := ""
	var metadata any

	if errOrMeta != nil {
		if e, ok := errOrMeta.(error); ok {
			details = e.Error()
		} else {
			metadata = errOrMeta
		}
	}

	c.JSON(status, ErrorResponse{
		Error: APIError{
			Code:     code,
			Message:  message,
			Details:  details,
			Metadata: metadata,
		},
	})
}

// Códigos de error comunes
const (
	ErrBadRequest     = "ERR_BAD_REQUEST"
	ErrUnauthorized   = "ERR_UNAUTHORIZED"
	ErrForbidden      = "ERR_FORBIDDEN"
	ErrNotFound       = "ERR_NOT_FOUND"
	ErrDuplicateEntry = "ERR_DUPLICATE_ENTRY"
	ErrConflict       = "ERR_CONFLICT"
	ErrInternalServer = "ERR_INTERNAL_ERROR"
)
