package handlers

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"backPOS-go/internal/core/services"

	"github.com/gin-gonic/gin"
)

type NotificationHandler struct {
	telegramService *services.TelegramService
}

func NewNotificationHandler(telegramService *services.TelegramService) *NotificationHandler {
	return &NotificationHandler{
		telegramService: telegramService,
	}
}

// SendTelegramPDF recibe un archivo PDF y lo envía vía Telegram Bot
func (h *NotificationHandler) SendTelegramPDF(c *gin.Context) {
	// Obtener el archivo del form-data
	file, err := c.FormFile("document")
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Archivo no proporcionado", err)
		return
	}

	// Validar extensión
	if filepath.Ext(file.Filename) != ".pdf" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Solo se permiten archivos PDF", nil)
		return
	}

	// Validar tamaño (máximo 10MB para Telegram)
	if file.Size > 10*1024*1024 {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Archivo excede 10MB límite de Telegram", nil)
		return
	}

	// Abrir el archivo
	openedFile, err := file.Open()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Error al abrir archivo", err)
		return
	}
	defer openedFile.Close()

	// Obtener caption opcional
	caption := c.PostForm("caption")
	if caption == "" {
		caption = "📄 Reporte del Sistema POS"
	}

	// 1. Guardar una copia local en el servidor (Solicitud del usuario)
	reportsDir := "reportsd"
	if _, err := os.Stat(reportsDir); os.IsNotExist(err) {
		os.MkdirAll(reportsDir, 0755)
	}
	
	localPath := filepath.Join(reportsDir, file.Filename)
	localFile, err := os.Create(localPath)
	if err == nil {
		// Volver al inicio del archivo para copiarlo
		openedFile.Seek(0, 0)
		io.Copy(localFile, openedFile)
		localFile.Close()
		// Volver al inicio de nuevo para Telegram
		openedFile.Seek(0, 0)
	}

	// Enviar documento vía Telegram
	err = h.telegramService.SendDocument(openedFile, file.Filename, caption)
	if err != nil {
		// Si el servicio no está configurado, devolver error específico
		if err.Error() == "telegram service not configured" {
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error":   "Telegram no configurado",
				"message": "Las variables TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no están configuradas",
			})
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Error al enviar a Telegram", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success":  true,
		"message":  "PDF enviado exitosamente vía Telegram",
		"filename": file.Filename,
	})
}

// HealthCheck verifica el estado del servicio de notificaciones
func (h *NotificationHandler) HealthCheck(c *gin.Context) {
	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	chatID := os.Getenv("TELEGRAM_CHAT_ID")

	isConfigured := token != "" && chatID != ""

	c.JSON(http.StatusOK, gin.H{
		"service":       "notifications",
		"telegram":      isConfigured,
		"configured":    isConfigured,
		"timestamp":     fmt.Sprintf("%d", os.Getpid()),
	})
}
