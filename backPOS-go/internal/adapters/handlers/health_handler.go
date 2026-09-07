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

// dbStatus hace ping a la base y devuelve el estado en el formato que el
// procedimiento de despliegue espera leer.
func (h *HealthHandler) dbStatus() string {
	if h.db == nil {
		return "DOWN (DB Not Configured)"
	}
	sqlDB, err := h.db.DB()
	if err != nil {
		return "DOWN (DB Connection Error)"
	}
	if err := sqlDB.Ping(); err != nil {
		return "DOWN (Ping Failed)"
	}
	return "UP"
}

// Check es el healthcheck PÚBLICO (sin autenticación).
//
// Expone lo mínimo que necesita un monitor externo: si el servicio responde y si
// la base contesta. Nada más.
//
// Antes publicaba hostname, versión de Go, sistema operativo, uso de memoria y
// número de goroutines a cualquiera que llegara al puerto. Eso es material de
// reconocimiento gratis: la versión de Go dice qué CVEs aplican, y las
// goroutines y la memoria delatan si un ataque de carga está funcionando.
// El detalle se movió a CheckDetailed, detrás de admin.
//
// CONTRATO: la clave "database.status" conserva EXACTAMENTE ese nombre y esos
// valores porque el procedimiento de despliegue (desplegar_a_produccion.ps1) los
// lee para decidir si promueve el release o hace rollback.
func (h *HealthHandler) Check(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status": "online",
		"database": gin.H{
			"status": h.dbStatus(),
		},
	})
}

// CheckDetailed es el healthcheck de diagnóstico. Va montado bajo el grupo de
// administración, así que exige token y rol admin.
//
// Mantiene la forma completa de la respuesta vieja (incluyendo "database.status")
// para que cualquier herramienta interna que la consumiera siga funcionando con
// sólo agregar las credenciales.
func (h *HealthHandler) CheckDetailed(c *gin.Context) {
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
			"status": h.dbStatus(),
		},
		"resources": gin.H{
			"memoryUsed":      m.Alloc / 1024 / 1024,
			"memoryTotal":     m.Sys / 1024 / 1024,
			"goroutinesCount": runtime.NumGoroutine(),
		},
	})
}
