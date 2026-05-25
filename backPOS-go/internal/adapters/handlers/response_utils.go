package handlers

import (
	"github.com/gin-gonic/gin"
	"time"
)

// APIError define el formato estándar de errores para el frontend
type APIError struct {
	Code     string `json:"code"`
	Message  string `json:"message"`
	Details  string `json:"details,omitempty"`
	Metadata any    `json:"metadata,omitempty"`
}

// ErrorResponse envuelve el APIError y añade campos de éxito globales
type ErrorResponse struct {
	Success bool     `json:"success"`
	Message string   `json:"message"`
	Error   APIError `json:"error"`
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
		Success: false,
		Message: message,
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

func parseDate(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	// Try full format first
	t, err := time.Parse("2006-01-02 15:04:05", s)
	if err == nil {
		return t, nil
	}
	// Try datetime-local format from frontend
	t, err = time.Parse("2006-01-02T15:04", s)
	if err == nil {
		return t, nil
	}
	// Try ISO format with seconds
	t, err = time.Parse("2006-01-02T15:04:05", s)
	if err == nil {
		return t, nil
	}
	// Try date only
	return time.Parse("2006-01-02", s)
}
