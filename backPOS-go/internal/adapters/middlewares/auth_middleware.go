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

		parts := strings.Fields(authHeader)
		if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
			tokenString = parts[1]
		}
		if tokenString == "" {
			sendMiddlewareError(c, http.StatusUnauthorized, "ERR_UNAUTHORIZED", "Sesión no proporcionada. Inicie sesión nuevamente.")
			c.Abort()
			return
		}

		secret := strings.TrimSpace(os.Getenv("SECRET_KEY"))
		if secret == "" {
			fmt.Printf("🔥 AUTH CONFIG ERROR en %s: SECRET_KEY no está configurada\n", endpoint)
			sendMiddlewareError(c, http.StatusInternalServerError, "ERR_AUTH_CONFIG", "El servicio de autenticación no está configurado.")
			c.Abort()
			return
		}

		token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
			if token.Method.Alg() != jwt.SigningMethodHS256.Alg() {
				return nil, fmt.Errorf("algoritmo JWT no permitido: %s", token.Method.Alg())
			}
			return []byte(secret), nil
		}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
		if err != nil || !token.Valid {
			sendMiddlewareError(c, http.StatusUnauthorized, "ERR_UNAUTHORIZED", "Sesión expirada o inválida. Inicie sesión nuevamente.")
			c.Abort()
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			sendMiddlewareError(c, http.StatusUnauthorized, "ERR_UNAUTHORIZED", "Sesión inválida. Inicie sesión nuevamente.")
			c.Abort()
			return
		}
		dni, dniOK := claims["dni"].(string)
		role, roleOK := claims["role"].(string)
		name, _ := claims["name"].(string)
		if !dniOK || !roleOK || strings.TrimSpace(dni) == "" || strings.TrimSpace(role) == "" {
			sendMiddlewareError(c, http.StatusUnauthorized, "ERR_UNAUTHORIZED", "La sesión no contiene una identidad válida.")
			c.Abort()
			return
		}
		if strings.TrimSpace(name) == "" {
			name = "USUARIO"
		}

		c.Set("dni", dni)
		c.Set("role", role)
		c.Set("userDni", dni)
		c.Set("userName", name)
		c.Next()
	}
}
