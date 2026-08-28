package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

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
	file, err := c.FormFile("document")
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Archivo no proporcionado", err)
		return
	}
	if !strings.EqualFold(filepath.Ext(file.Filename), ".pdf") {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Solo se permiten archivos PDF", nil)
		return
	}
	if file.Size <= 0 || file.Size > 10*1024*1024 {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "El PDF debe pesar entre 1 byte y 10MB", nil)
		return
	}

	openedFile, err := file.Open()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Error al abrir archivo", err)
		return
	}
	defer func() {
		if closeErr := openedFile.Close(); closeErr != nil {
			log.Printf("[NOTIFICATIONS] cerrando PDF: %v", closeErr)
		}
	}()

	header := make([]byte, 512)
	readCount, readErr := openedFile.Read(header)
	if readErr != nil && readErr != io.EOF {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "No se pudo validar el PDF", readErr)
		return
	}
	if readCount < 5 || !strings.HasPrefix(string(header[:readCount]), "%PDF-") {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "El archivo no contiene un PDF válido", nil)
		return
	}
	if _, err := openedFile.Seek(0, io.SeekStart); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudo preparar el PDF", err)
		return
	}

	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudo generar nombre seguro", err)
		return
	}
	safeName := fmt.Sprintf("reporte_%s_%s.pdf", time.Now().Format("20060102_150405"), hex.EncodeToString(randomBytes))
	reportsDir, err := filepath.Abs("reportsd")
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudo resolver directorio de reportes", err)
		return
	}
	if err := os.MkdirAll(reportsDir, 0750); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudo crear directorio de reportes", err)
		return
	}
	localPath := filepath.Join(reportsDir, safeName)
	relativePath, err := filepath.Rel(reportsDir, localPath)
	if err != nil || relativePath == ".." || strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Ruta de reporte inválida", err)
		return
	}

	localFile, err := os.OpenFile(localPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0640)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudo guardar el reporte", err)
		return
	}
	if _, err := io.Copy(localFile, openedFile); err != nil {
		if closeErr := localFile.Close(); closeErr != nil {
			log.Printf("[NOTIFICATIONS] cerrando copia fallida: %v", closeErr)
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudo guardar el reporte", err)
		return
	}
	if err := localFile.Close(); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudo finalizar el reporte", err)
		return
	}
	if _, err := openedFile.Seek(0, io.SeekStart); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "No se pudo preparar el envío", err)
		return
	}

	caption := c.PostForm("caption")
	if strings.TrimSpace(caption) == "" {
		caption = "📄 Reporte del Sistema POS"
	}
	if err := h.telegramService.SendDocument(openedFile, safeName, caption); err != nil {
		if err.Error() == "telegram service not configured" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Telegram no configurado"})
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Error al enviar a Telegram", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"success":  true,
		"message":  "PDF enviado exitosamente vía Telegram",
		"filename": safeName,
	})
}

// HealthCheck verifica el estado del servicio de notificaciones
func (h *NotificationHandler) HealthCheck(c *gin.Context) {
	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	chatID := os.Getenv("TELEGRAM_CHAT_ID")

	isConfigured := token != "" && chatID != ""

	c.JSON(http.StatusOK, gin.H{
		"service":    "notifications",
		"telegram":   isConfigured,
		"configured": isConfigured,
		"timestamp":  fmt.Sprintf("%d", os.Getpid()),
	})
}

// SendTelegramMessage envía un mensaje de texto simple vía Telegram Bot
func (h *NotificationHandler) SendTelegramMessage(c *gin.Context) {
	var req struct {
		Message string `json:"message"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Cuerpo de mensaje inválido", err)
		return
	}

	if req.Message == "" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "El mensaje no puede estar vacío", nil)
		return
	}

	h.telegramService.SendMarkdownAlert(req.Message)

	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "Mensaje enviado exitosamente vía Telegram",
	})
}
