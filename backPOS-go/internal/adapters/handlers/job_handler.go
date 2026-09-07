package handlers

import (
	"errors"
	"net/http"

	"backPOS-go/internal/core/services"
	"backPOS-go/internal/infrastructure/orchestrator"

	"github.com/gin-gonic/gin"
)

// JobHandler expone el estado del orquestador de jobs. Todas sus rutas viven
// bajo el grupo de administración: revelan horarios, errores internos y
// permiten disparar tareas pesadas como el respaldo de la base.
type JobHandler struct {
	orchestrator *orchestrator.Orchestrator
	audit        *services.AuditService
}

func NewJobHandler(o *orchestrator.Orchestrator, audit *services.AuditService) *JobHandler {
	return &JobHandler{orchestrator: o, audit: audit}
}

// List devuelve cada job con su próximo disparo y el resultado de la última
// corrida. Es la vista que responde "¿se hizo el respaldo de anoche?".
func (h *JobHandler) List(c *gin.Context) {
	statuses, err := h.orchestrator.Status(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No se pudo consultar el estado de los jobs"})
		return
	}
	c.JSON(http.StatusOK, statuses)
}

// History devuelve las últimas corridas de un job concreto.
func (h *JobHandler) History(c *gin.Context) {
	key := c.Param("key")
	if key == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Falta la clave del job"})
		return
	}

	limit := QueryPageSize(c, "limit", 50)
	history, err := h.orchestrator.History(c.Request.Context(), key, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No se pudo consultar el historial del job"})
		return
	}
	c.JSON(http.StatusOK, history)
}

// RunNow dispara un job de inmediato. Queda registrado como 'manual' y con el
// usuario que lo pidió en la auditoría.
func (h *JobHandler) RunNow(c *gin.Context) {
	key := c.Param("key")
	if err := h.orchestrator.RunNow(key); err != nil {
		if errors.Is(err, orchestrator.ErrJobNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "El job solicitado no existe"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No se pudo disparar el job"})
		return
	}

	h.recordAudit(c, "EJECUTAR_JOB", key, "Se disparó manualmente el job programado "+key)
	c.JSON(http.StatusAccepted, gin.H{"message": "Job encolado", "key": key})
}

// SetEnabled enciende o apaga un job sin reiniciar el servicio.
func (h *JobHandler) SetEnabled(c *gin.Context) {
	key := c.Param("key")

	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.Enabled == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Se requiere el campo booleano 'enabled'"})
		return
	}

	if err := h.orchestrator.SetEnabled(c.Request.Context(), key, *body.Enabled); err != nil {
		if errors.Is(err, orchestrator.ErrJobNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "El job solicitado no existe"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No se pudo actualizar el job"})
		return
	}

	action := "DESHABILITAR_JOB"
	human := "Se deshabilitó el job programado " + key
	if *body.Enabled {
		action = "HABILITAR_JOB"
		human = "Se habilitó el job programado " + key
	}
	h.recordAudit(c, action, key, human)
	c.JSON(http.StatusOK, gin.H{"message": "Job actualizado", "key": key, "enabled": *body.Enabled})
}

func (h *JobHandler) recordAudit(c *gin.Context, action, key, human string) {
	if h.audit == nil {
		return
	}
	dni, name := GetContextUser(c)
	h.audit.Log(dni, name, action, "JOBS", "Job: "+key, human, "{}", c.ClientIP(), c.Request.UserAgent(), true)
}
