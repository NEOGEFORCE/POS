package handlers

import (
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type HealthHandler struct {
	db        *gorm.DB
	startTime time.Time
}

func NewHealthHandler(db *gorm.DB) *HealthHandler {
	return &HealthHandler{
		db:        db,
		startTime: time.Now(),
	}
}

func (h *HealthHandler) Check(c *gin.Context) {
	// 1. Verificar base de datos
	dbStatus := "UP"
	sqlDB, err := h.db.DB()
	if err != nil {
		dbStatus = "DOWN (DB Connection Error)"
	} else {
		err = sqlDB.Ping()
		if err != nil {
			dbStatus = "DOWN (Ping Failed)"
		}
	}

	// 2. Estadísticas de memoria
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	hostname, _ := os.Hostname()

	c.JSON(http.StatusOK, gin.H{
		"status": "online",
		"system": gin.H{
			"version":    "5.3.0",
			"uptime":     time.Since(h.startTime).String(),
			"serverTime": time.Now().Format(time.RFC3339),
			"hostname":   hostname,
			"goVersion":  runtime.Version(),
			"os":         runtime.GOOS,
		},
		"database": gin.H{
			"status": dbStatus,
		},
		"resources": gin.H{
			"memoryUsed":      m.Alloc / 1024 / 1024,
			"memoryTotal":     m.Sys / 1024 / 1024,
			"goroutinesCount": runtime.NumGoroutine(),
		},
	})
}
