package middlewares

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

func RoleMiddleware(requiredRole string) gin.HandlerFunc {
	return func(c *gin.Context) {
		userRoleVal, _ := c.Get("role")
		userRole, ok := userRoleVal.(string)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Formato de rol inválido"})
			c.Abort()
			return
		}

		userRole = strings.ToLower(userRole)

		if userRole != strings.ToLower(requiredRole) && userRole != "admin" && userRole != "administrador" && userRole != "auditor" { // admin bypass
			c.JSON(http.StatusForbidden, gin.H{"error": "No tienes permisos para realizar esta acción"})
			c.Abort()
			return
		}

		c.Next()
	}
}
