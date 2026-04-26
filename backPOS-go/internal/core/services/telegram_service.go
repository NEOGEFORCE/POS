package services

import (
	"fmt"
	"io"
	"log"
	"os"
	"strings"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

type TelegramService struct {
	bot    *tgbotapi.BotAPI
	chatID int64
	active bool
}

func NewTelegramService() *TelegramService {
	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	chatIDStr := os.Getenv("TELEGRAM_CHAT_ID")

	if token == "" || chatIDStr == "" {
		log.Println("⚠️ Telegram Bot Token or Chat ID not found in .env. Telegram service disabled.")
		return &TelegramService{active: false}
	}

	bot, err := tgbotapi.NewBotAPI(token)
	if err != nil {
		log.Printf("❌ Failed to initialize Telegram Bot: %v", err)
		return &TelegramService{active: false}
	}

	// Simple check to see if chatID is valid (should be int64)
	var chatID int64
	_, err = fmt.Sscanf(chatIDStr, "%d", &chatID)
	if err != nil {
		log.Printf("❌ Invalid TELEGRAM_CHAT_ID: %v", err)
		return &TelegramService{active: false}
	}

	log.Printf("✅ Telegram Bot Initialized: %s", bot.Self.UserName)

	return &TelegramService{
		bot:    bot,
		chatID: chatID,
		active: true,
	}
}

func (s *TelegramService) SendMarkdownAlert(message string) {
	if !s.active {
		return
	}

	msg := tgbotapi.NewMessage(s.chatID, message)
	msg.ParseMode = "Markdown" // Use standard Markdown (V1) for better compatibility

	_, err := s.bot.Send(msg)
	if err != nil {
		log.Printf("❌ Failed to send Telegram alert: %v", err)
	}
}

func (s *TelegramService) SendAlert(message string) {
	if !s.active {
		return
	}

	msg := tgbotapi.NewMessage(s.chatID, message)
	_, err := s.bot.Send(msg)
	if err != nil {
		log.Printf("❌ Failed to send Telegram alert: %v", err)
		// Detectar error 404 (chat no encontrado) y sugerir iniciar conversación
		if strings.Contains(err.Error(), "404") || strings.Contains(err.Error(), "Not Found") {
			log.Printf("⚠️  Asegúrate de haber iniciado el chat con el bot en Telegram enviando /start")
		}
	}
}

// SendDocument envía un archivo documento al chat configurado
func (s *TelegramService) SendDocument(reader io.Reader, filename string, caption string) error {
	if !s.active {
		return fmt.Errorf("telegram service not configured")
	}

	// Crear el documento a partir del reader
	fileBytes, err := io.ReadAll(reader)
	if err != nil {
		return fmt.Errorf("failed to read document: %w", err)
	}

	// Crear FileBytes para Telegram
	fileObj := tgbotapi.FileBytes{
		Name:  filename,
		Bytes: fileBytes,
	}

	// Crear mensaje de documento
	doc := tgbotapi.NewDocument(s.chatID, fileObj)
	doc.Caption = caption

	// Enviar documento
	_, err = s.bot.Send(doc)
	if err != nil {
		return fmt.Errorf("failed to send document: %w", err)
	}

	log.Printf("✅ Document sent to Telegram: %s", filename)
	return nil
}
