package middlewares

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

func normalizeRole(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "administrador":
		return "admin"
	case "employee":
		return "empleado"
	default:
		return strings.ToLower(strings.TrimSpace(role))
	}
}

func roleAllowed(userRole, requiredRole string) bool {
	userRole = normalizeRole(userRole)
	requiredRole = normalizeRole(requiredRole)
	if userRole == "superadmin" || userRole == "admin" {
		return true
	}
	return userRole != "" && userRole == requiredRole
}

func RoleMiddleware(requiredRole string) gin.HandlerFunc {
	return func(c *gin.Context) {
		value, exists := c.Get("role")
		userRole, ok := value.(string)
		if !exists || !ok || strings.TrimSpace(userRole) == "" {
			sendMiddlewareError(c, http.StatusForbidden, "ERR_FORBIDDEN", "Rol de usuario inválido en la sesión. Inicie sesión nuevamente.")
			c.Abort()
			return
		}
		if !roleAllowed(userRole, requiredRole) {
			sendMiddlewareError(c, http.StatusForbidden, "ERR_FORBIDDEN", "No tienes permisos para realizar esta acción")
			c.Abort()
			return
		}
		c.Next()
	}
}
