package utils

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
)

// SendAuditAlert envía un mensaje de alerta a Telegram sin bloqueos ni dependencias cíclicas
func SendAuditAlert(message string) {
	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	chatID := os.Getenv("TELEGRAM_CHAT_ID")

	if token == "" || chatID == "" {
		return // Telegram no configurado
	}

	url := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", token)

	payload := map[string]interface{}{
		"chat_id": chatID,
		"text":    message,
	}

	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return
	}

	// Solicitud POST simple
	resp, err := http.Post(url, "application/json", bytes.NewBuffer(jsonPayload))
	if err != nil {
		return
	}
	defer resp.Body.Close()
}
