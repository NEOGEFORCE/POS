package middlewares

import (
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type RateLimiter struct {
	clients map[string]*ClientLimiter
	mu      sync.Mutex
}

type ClientLimiter struct {
	tokens     float64
	maxTokens  float64
	refillRate float64
	lastRefill time.Time
}

var limiter = &RateLimiter{
	clients: make(map[string]*ClientLimiter),
}

func RateLimitMiddleware(maxTokens float64, refillRate float64) gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := c.ClientIP()

		limiter.mu.Lock()

		client, exists := limiter.clients[ip]
		if !exists {
			client = &ClientLimiter{
				tokens:     maxTokens,
				maxTokens:  maxTokens,
				refillRate: refillRate,
				lastRefill: time.Now(),
			}
			limiter.clients[ip] = client
		}

		now := time.Now()
		elapsed := now.Sub(client.lastRefill).Seconds()
		client.tokens = min(client.maxTokens, client.tokens+elapsed*client.refillRate)
		client.lastRefill = now

		if client.tokens < 1 {
			limiter.mu.Unlock()
			sendMiddlewareError(c, 429, "ERR_RATE_LIMIT", "Demasiadas solicitudes. Intenta de nuevo en unos segundos.")
			c.Abort()
			return
		}

		client.tokens--
		limiter.mu.Unlock()

		c.Next()
	}
}

func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
