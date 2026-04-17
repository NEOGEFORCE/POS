package services

import (
	"fmt"
	"log"
	"os"

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
	msg.ParseMode = "MarkdownV2" // Can be HTML too

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
	}
}
