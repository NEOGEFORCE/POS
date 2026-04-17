package middlewares

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

func RoleMiddleware(requiredRole string) gin.HandlerFunc {
	return func(c *gin.Context) {
		userRoleVal, exists := c.Get("role")
		if !exists || userRoleVal == nil {
			sendMiddlewareError(c, http.StatusForbidden, "ERR_FORBIDDEN", "Rol de usuario no encontrado en la sesión. Inicie sesión nuevamente.")
			c.Abort()
			return
		}

		userRole, ok := userRoleVal.(string)
		if !ok {
			sendMiddlewareError(c, http.StatusForbidden, "ERR_FORBIDDEN", "Formato de rol inválido en la sesión. Inicie sesión nuevamente.")
			c.Abort()
			return
		}

		userRole = strings.ToLower(userRole)

		if userRole != strings.ToLower(requiredRole) && 
		   userRole != "admin" && 
		   userRole != "administrador" && 
		   userRole != "superadmin" &&
		   userRole != "auditor" { // admin/superadmin bypass
			sendMiddlewareError(c, http.StatusForbidden, "ERR_FORBIDDEN", "No tienes permisos para realizar esta acción")
			c.Abort()
			return
		}

		c.Next()
	}
}
