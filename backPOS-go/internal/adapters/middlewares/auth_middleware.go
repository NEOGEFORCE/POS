package middlewares

import (
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		tokenString := ""
		endpoint := c.Request.URL.Path

		if authHeader != "" {
			parts := strings.Split(authHeader, " ")
			if len(parts) == 2 && parts[0] == "Bearer" {
				tokenString = parts[1]
			}
		}

		// Fallback a query parameter para soporte SSE (EventSource)
		if tokenString == "" {
			tokenString = c.Query("token")
		}

		if tokenString == "" {
			fmt.Printf("🔥 AUTH ERROR en %s: No se encontró token en Header ni en Query\n", endpoint)
			sendMiddlewareError(c, http.StatusUnauthorized, "ERR_UNAUTHORIZED", "Sesión no proporcionada. Inicie sesión nuevamente.")
			c.Abort()
			return
		}

		token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
			if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
			}
			return []byte(os.Getenv("SECRET_KEY")), nil
		})

		if err != nil || !token.Valid {
			fmt.Printf("🔥 AUTH ERROR en %s: Token inválido o expirado. Error: %v\n", endpoint, err)
			sendMiddlewareError(c, http.StatusUnauthorized, "ERR_UNAUTHORIZED", "Sesión expirada o inválida. Inicie sesión nuevamente.")
			c.Abort()
			return
		}

		// Log exitoso para trazabilidad
		claims, _ := token.Claims.(jwt.MapClaims)
		fmt.Printf("✅ AUTH OK en %s: Usuario %v autenticado\n", endpoint, claims["dni"])
		c.Set("dni", claims["dni"])
		c.Set("role", claims["role"])
		c.Set("userDni", claims["dni"])   // CRITICAL FIX: Alias para compatibilidad con handlers
		c.Set("userName", claims["name"]) // CRITICAL FIX: Nombre del usuario para audit

		c.Next()
	}
}
