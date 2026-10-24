package handlers

import (
	"strings"

	"github.com/gin-gonic/gin"
)

// actorName devuelve el nombre del usuario desde el contexto JWT. A
// diferencia de GetContextUser (que cae a "USUARIO" si no hay nada),
// actorName devuelve "" para que el caller sepa cuándo falta la
// identidad del header de sesión. Mantener la convención con
// actorDNI/actorIsAdmin (label_handler.go).
func actorName(c *gin.Context) string {
	if c == nil {
		return ""
	}
	v, exists := c.Get("userName")
	if exists {
		if s, ok := v.(string); ok {
			return strings.TrimSpace(s)
		}
	}
	return ""
}
