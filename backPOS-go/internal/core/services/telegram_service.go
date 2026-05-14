package services

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"time"

	"backPOS-go/internal/core/ports"

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

	go func() {
		msg := tgbotapi.NewMessage(s.chatID, message)
		msg.ParseMode = "Markdown"

		_, err := s.bot.Send(msg)
		if err != nil {
			log.Printf("❌ Failed to send Telegram alert: %v", err)
		}
	}()
}

func (s *TelegramService) SendAlert(message string) {
	if !s.active {
		return
	}

	go func() {
		msg := tgbotapi.NewMessage(s.chatID, message)
		_, err := s.bot.Send(msg)
		if err != nil {
			log.Printf("❌ Failed to send Telegram alert: %v", err)
			if strings.Contains(err.Error(), "404") || strings.Contains(err.Error(), "Not Found") {
				log.Printf("⚠️  Asegúrate de haber iniciado el chat con el bot en Telegram enviando /start")
			}
		}
	}()
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
// StartListener inicia el bucle de escucha de comandos de Telegram
func (s *TelegramService) StartListener(invService *InventoryService, saleRepo ports.SaleRepository, dashService *DashboardService) {
	if !s.active {
		return
	}

	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("⚠️ [Telegram-Listener] Recovery from panic: %v", r)
			}
		}()

		u := tgbotapi.NewUpdate(0)
		u.Timeout = 60

		updates := s.bot.GetUpdatesChan(u)

		for update := range updates {
			if update.Message == nil || !update.Message.IsCommand() {
				continue
			}

			msg := tgbotapi.NewMessage(update.Message.Chat.ID, "")
			msg.ParseMode = "Markdown"

			switch update.Message.Command() {
			case "start":
				msg.Text = "🚀 *Cerberus POS Bot Activo*\n\nComandos disponibles:\n/inventario - Reporte de bajo stock\n/topventas - Top 5 productos hoy\n/nomina - Resumen de gastos hoy"
			case "inventario":
				msg.Text = s.handleInventario(invService)
			case "topventas":
				msg.Text = s.handleTopVentas(saleRepo)
			case "nomina":
				msg.Text = s.handleNomina(dashService)
			default:
				msg.Text = "Comando no reconocido. Usa /start para ver opciones."
			}

			_, _ = s.bot.Send(msg)
		}
	}()
}

func (s *TelegramService) handleInventario(invService *InventoryService) string {
	suggestions, err := invService.GetGlobalRestockSuggestions()
	if err != nil {
		return "❌ Error al obtener inventario: " + err.Error()
	}

	var critical []string
	var low []string

	for _, item := range suggestions {
		if item.Status == "CRITICAL" {
			critical = append(critical, fmt.Sprintf("• %s: %.2f", item.ProductName, item.Stock))
		} else if item.Status == "WARNING" {
			low = append(low, fmt.Sprintf("• %s: %.2f", item.ProductName, item.Stock))
		}
	}

	report := "📦 *REPORTE DE INVENTARIO*\n\n"
	if len(critical) > 0 {
		report += "🔴 *CRÍTICO (Agotado/Mínimo):*\n" + strings.Join(critical, "\n") + "\n\n"
	}
	if len(low) > 0 {
		report += "🟡 *BAJO STOCK:*\n" + strings.Join(low, "\n") + "\n\n"
	}

	if len(critical) == 0 && len(low) == 0 {
		report += "✅ Todo el stock está en niveles óptimos."
	}

	return report
}

func (s *TelegramService) handleTopVentas(saleRepo ports.SaleRepository) string {
	loc, _ := time.LoadLocation("America/Bogota")
	now := time.Now().In(loc)
	startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	endOfDay := startOfDay.Add(24 * time.Hour)

	top, err := saleRepo.GetTopSellingProducts(startOfDay, endOfDay, 5)
	if err != nil {
		return "❌ Error al obtener top ventas: " + err.Error()
	}

	if len(top) == 0 {
		return "📅 No hay ventas registradas el día de hoy."
	}

	report := "🏆 *TOP 5 VENTAS HOY*\n\n"
	for i, item := range top {
		report += fmt.Sprintf("%d. *%s*\n   Cantidad: %.2f | Total: $%s\n", i+1, item.Name, item.Quantity, fmt.Sprintf("%.2f", item.Total))
	}

	return report
}

func (s *TelegramService) handleNomina(dashService *DashboardService) string {
	overview, err := dashService.GetOverview(context.Background())
	if err != nil {
		return "❌ Error al obtener nómina/gastos: " + err.Error()
	}

	report := "💸 *RESUMEN FINANCIERO HOY*\n\n"
	report += fmt.Sprintf("💰 *Ventas:* $%s\n", fmt.Sprintf("%.2f", overview.TodaySalesAmount))
	report += fmt.Sprintf("🧾 *Gastos Caja:* $%s\n", fmt.Sprintf("%.2f", overview.TodayExpenses.Amount))
	report += fmt.Sprintf("🏢 *Gastos Fondo:* $%s\n", fmt.Sprintf("%.2f", overview.VaultExpenses))
	report += fmt.Sprintf("📉 *Utilidad Estimada:* $%s\n", fmt.Sprintf("%.2f", overview.TodayNetProfit))

	return report
}
