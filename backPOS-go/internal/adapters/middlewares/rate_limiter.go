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

func RateLimitMiddleware(maxTokens float64, refillRate float64) gin.HandlerFunc {
	limiter := &RateLimiter{clients: make(map[string]*ClientLimiter)}

	// Cada invocación tiene buckets independientes (auth y API protegida no
	// comparten cuota). La limpieza evita retener IPs inactivas indefinidamente.
	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			limiter.mu.Lock()
			cutoff := time.Now().Add(-5 * time.Minute)
			for ip, cl := range limiter.clients {
				if cl.lastRefill.Before(cutoff) {
					delete(limiter.clients, ip)
				}
			}
			limiter.mu.Unlock()
		}
	}()

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
