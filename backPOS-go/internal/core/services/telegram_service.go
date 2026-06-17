package services

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
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

	// Silenciar logs internos de la librería para evitar el spam de "Conflict"
	// si el bot ya está corriendo en otra instancia.
	tgbotapi.SetLogger(log.New(io.Discard, "", 0))
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
			log.Printf("❌ Failed to send Telegram alert (Markdown): %v", err)
			// Reintentar sin formato si falla
			msg.ParseMode = ""
			s.bot.Send(msg)
		}
	}()
}

func (s *TelegramService) SendHTMLAlert(message string) {
	if !s.active {
		return
	}

	go func() {
		msg := tgbotapi.NewMessage(s.chatID, message)
		msg.ParseMode = "HTML"

		_, err := s.bot.Send(msg)
		if err != nil {
			log.Printf("❌ Failed to send Telegram alert (HTML): %v", err)
			// Reintentar sin formato si falla
			msg.ParseMode = ""
			s.bot.Send(msg)
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

func (s *TelegramService) SendPhoto(imgBytes []byte, caption string) error {
	if !s.active {
		return fmt.Errorf("telegram service not configured")
	}

	photoObj := tgbotapi.FileBytes{
		Name:  caption,
		Bytes: imgBytes,
	}

	photo := tgbotapi.NewPhoto(s.chatID, photoObj)
	photo.Caption = caption

	_, err := s.bot.Send(photo)
	if err != nil {
		return fmt.Errorf("failed to send photo: %w", err)
	}

	log.Printf("✅ Photo sent to Telegram: %s", caption)
	return nil
}

// StartListener inicia el bucle de escucha de comandos de Telegram
func (s *TelegramService) StartListener(invService *InventoryService, saleRepo ports.SaleRepository, dashService *DashboardService, prodService *ProductService, aiBotService *AIBotService) {
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
			if update.CallbackQuery != nil {
				if aiBotService != nil {
					aiBotService.HandleCallbackQuery(update.CallbackQuery.Message.Chat.ID, update.CallbackQuery.Data)
				}
				// Responder al callback para quitar el "reloj" de cargando en el botón
				callback := tgbotapi.NewCallback(update.CallbackQuery.ID, "")
				s.bot.Request(callback)
				continue
			}

			if update.Message == nil {
				continue
			}

			if !update.Message.IsCommand() {
				// Mensaje de texto libre → pasar al AI service
				if aiBotService != nil {
					aiBotService.ProcessMessage(update.Message.Chat.ID, update.Message.Text)
				}
				continue
			}

			msg := tgbotapi.NewMessage(update.Message.Chat.ID, "")
			msg.ParseMode = "Markdown"

			switch update.Message.Command() {
			case "start":
				msg.Text = "🚀 *POS Pro Bot Activo*\n\nComandos disponibles:\n/inventario - Reporte de bajo stock\n/vendido_today - Ventas de hoy\n/top_semana - Top 10 productos semana\n/buscar [nombre] - Consultar precio/stock\n/nomina - Resumen financiero\n/cambios_hoy - Auditoría de precios hoy\n\n*También puedes hablarme naturalmente para pedir reportes, cambiar precios, o registrar egresos!*"
			case "inventario":
				msg.Text = s.handleInventario(invService)
			case "vendido_today":
				msg.Text = s.handleVendidoToday(dashService)
			case "top_semana":
				msg.Text = s.handleTopSemana(saleRepo)
			case "buscar":
				msg.Text = s.handleBuscar(prodService, update.Message.CommandArguments())
			case "nomina":
				msg.Text = s.handleNomina(dashService)
			case "cambios_hoy":
				msg.Text = s.handleCambiosHoy(prodService)
			default:
				msg.Text = "Comando no reconocido. Usa /start para ver opciones."
			}

			_, _ = s.bot.Send(msg)
		}
	}()
}

func (s *TelegramService) handleInventario(invService *InventoryService) string {
	suggestions, err := invService.GetGlobalRestockSuggestions(false)
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

func (s *TelegramService) handleVendidoToday(dashService *DashboardService) string {
	overview, err := dashService.GetOverview(context.Background(), "", "")
	if err != nil {
		return "❌ Error: " + err.Error()
	}

	report := "💰 *VENTAS DE HOY*\n\n"
	report += fmt.Sprintf("💵 *Total Bruto:* $%s\n", fmt.Sprintf("%.0f", overview.TodaySalesAmount))
	report += fmt.Sprintf("📊 *Transacciones:* %d\n", overview.TodaySalesCount)
	report += fmt.Sprintf("📉 *Utilidad Neta:* $%s\n", fmt.Sprintf("%.0f", overview.TodayNetProfit))
	
	if overview.TodaySalesCount > 0 {
		report += fmt.Sprintf("\n🎫 *Ticket Promedio:* $%s", fmt.Sprintf("%.0f", overview.TodaySalesAmount/float64(overview.TodaySalesCount)))
	}

	return report
}

func (s *TelegramService) handleTopSemana(saleRepo ports.SaleRepository) string {
	loc, _ := time.LoadLocation("America/Bogota")
	now := time.Now().In(loc)
	startOfWeek := now.AddDate(0, 0, -7)
	
	top, err := saleRepo.GetTopSellingProducts(startOfWeek, now, 10)
	if err != nil {
		return "❌ Error: " + err.Error()
	}

	if len(top) == 0 {
		return "📅 No hay ventas en los últimos 7 días."
	}

	report := "🏆 *TOP 10 SEMANAL*\n\n"
	for i, item := range top {
		report += fmt.Sprintf("%d. *%s*\n   Vendidos: %.0f | Total: $%s\n", i+1, item.Name, item.Quantity, fmt.Sprintf("%.0f", item.Total))
	}

	return report
}

func (s *TelegramService) handleBuscar(prodService *ProductService, query string) string {
	if query == "" {
		return "🔍 Por favor indica el nombre del producto. Ejemplo: `/buscar coca cola`"
	}

	product, err := prodService.GetProductByName(query)
	if err != nil {
		// Intentar por barcode si no es nombre
		product, err = prodService.GetProduct(query)
	}

	if err != nil || product == nil {
		return "❌ No encontré ningún producto que coincida con '" + query + "'"
	}

	report := fmt.Sprintf("🔎 *RESULTADO DE BÚSQUEDA*\n\n")
	report += fmt.Sprintf("📦 *Producto:* %s\n", product.ProductName)
	report += fmt.Sprintf("🏷️ *Código:* `%s`\n", product.Barcode)
	report += fmt.Sprintf("💰 *Precio Venta:* $%s\n", fmt.Sprintf("%.0f", product.SalePrice))
	report += fmt.Sprintf("📉 *Stock Actual:* %.2f\n", product.Quantity)
	
	if product.SupplierID != nil {
		report += fmt.Sprintf("🚚 *ID Proveedor:* %d\n", *product.SupplierID)
	}

	return report
}

func (s *TelegramService) handleNomina(dashService *DashboardService) string {
	overview, err := dashService.GetOverview(context.Background(), "", "")
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

func (s *TelegramService) handleCambiosHoy(prodService *ProductService) string {
	logs, err := prodService.GetPriceChangesToday()
	if err != nil {
		return "❌ Error al consultar cambios de precio: " + err.Error()
	}

	if len(logs) == 0 {
		return "✅ *No se han registrado cambios de precio el día de hoy.* Todo está al día."
	}

	report := "📋 *REPORTE DE CAMBIOS - HOY*\n"
	report += "Estos son los precios que se deben haber actualizado hoy:\n\n"

	for _, log := range logs {
		report += fmt.Sprintf("📍 *%s*: $%s (Era $%s)\n", 
			log.ProductName, 
			fmt.Sprintf("%.0f", log.NewPrice), 
			fmt.Sprintf("%.0f", log.OldPrice))
	}

	report += "\n⚠️ *Si falta alguno en góndola, cámbialo ya.*"

	return report
}

func (s *TelegramService) handleImageMessage(msg *tgbotapi.Message, aiBotService *AIBotService) {
	if msg.Chat.ID != s.chatID {
		s.bot.Send(tgbotapi.NewMessage(msg.Chat.ID, "No estás autorizado."))
		return
	}

	s.SendAlert("📷 Procesando imagen con IA...")

	var fileID string
	if len(msg.Photo) > 0 {
		photos := msg.Photo
		fileID = photos[len(photos)-1].FileID
	} else if msg.Document != nil {
		fileID = msg.Document.FileID
	}

	file, err := s.bot.GetFile(tgbotapi.FileConfig{FileID: fileID})
	if err != nil {
		s.SendAlert("❌ No pude descargar la imagen")
		return
	}

	fileURL := fmt.Sprintf("https://api.telegram.org/file/bot%s/%s", os.Getenv("TELEGRAM_BOT_TOKEN"), file.FilePath)

	resp, err := http.Get(fileURL)
	if err != nil {
		s.SendAlert("❌ Error al descargar la imagen")
		return
	}
	defer resp.Body.Close()
	imgBytes, _ := io.ReadAll(resp.Body)

	mimeType := "image/jpeg"
	if strings.HasSuffix(file.FilePath, ".png") {
		mimeType = "image/png"
	}
	if strings.HasSuffix(file.FilePath, ".pdf") {
		mimeType = "application/pdf"
	}

	imgBase64 := base64.StdEncoding.EncodeToString(imgBytes)

	caption := ""
	if msg.Caption != "" {
		caption = msg.Caption
	}

	response, err := aiBotService.ProcessImageMessage(msg.Chat.ID, imgBase64, mimeType, caption)
	if err != nil {
		s.SendAlert("❌ Error al analizar la imagen: " + err.Error())
		return
	}

	s.SendMarkdownAlert(response)
}
