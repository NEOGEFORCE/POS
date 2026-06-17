package handlers

import (
	"fmt"
	"io"
	"net/http"

	"backPOS-go/internal/infrastructure/sse"

	"github.com/gin-gonic/gin"
)

type SSEHandler struct{}

func NewSSEHandler() *SSEHandler {
	return &SSEHandler{}
}

// Stream maneja la conexión SSE persistente
func (h *SSEHandler) Stream(c *gin.Context) {
	// Configurar headers para SSE
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("Transfer-Encoding", "chunked")
	c.Writer.Header().Set("Access-Control-Allow-Origin", "*")

	// Suscribirse al servicio de eventos
	eventChan := sse.GetSSEService().Subscribe()
	defer sse.GetSSEService().Unsubscribe(eventChan)

	// Canal para detectar desconexión del cliente
	clientGone := c.Request.Context().Done()

	c.Stream(func(w io.Writer) bool {
		select {
		case <-clientGone:
			return false
		case event := <-eventChan:
			formatted, err := sse.FormatSSE(event)
			if err != nil {
				return true
			}
			fmt.Fprint(w, formatted)
			return true
		}
	})
}

// TestBroadcast envía un evento de prueba (Solo para desarrollo)
func (h *SSEHandler) TestBroadcast(c *gin.Context) {
	sse.GetSSEService().Broadcast("PING", "Ultra-Instinto Active")
	c.JSON(http.StatusOK, gin.H{"status": "broadcasted"})
}
