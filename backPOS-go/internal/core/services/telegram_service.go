package services

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"backPOS-go/internal/core/ports"

	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

type QueuedTelegramMessage struct {
	ID        string
	Type      string // "MARKDOWN", "HTML", "TEXT", "DOCUMENT", "PHOTO"
	Message   string
	Filename  string
	Data      []byte
	Caption   string
	CreatedAt time.Time
	Attempts  int
}

type TelegramService struct {
	bot        *tgbotapi.BotAPI
	token      string
	chatID     int64
	active     bool
	queue      []QueuedTelegramMessage
	queueMutex sync.Mutex
}

func NewTelegramService() *TelegramService {
	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	chatIDStr := os.Getenv("TELEGRAM_CHAT_ID")

	if token == "" || chatIDStr == "" {
		log.Println("⚠️ Telegram Bot Token or Chat ID not found in .env. Telegram service disabled.")
		return &TelegramService{active: false}
	}

	var chatID int64
	_, err := fmt.Sscanf(chatIDStr, "%d", &chatID)
	if err != nil {
		log.Printf("❌ Invalid TELEGRAM_CHAT_ID: %v", err)
		return &TelegramService{active: false}
	}

	svc := &TelegramService{
		token:  token,
		chatID: chatID,
		active: false,
		queue:  make([]QueuedTelegramMessage, 0),
	}

	bot, err := tgbotapi.NewBotAPI(token)
	if err != nil {
		log.Printf("⚠️ Telegram Bot no pudo conectar al iniciar (¿Sin internet?): %v. Se activó COLA DE TAREAS OFFLINE.", err)
	} else {
		tgbotapi.SetLogger(log.New(io.Discard, "", 0))
		log.Printf("✅ Telegram Bot Initialized: %s", bot.Self.UserName)
		svc.bot = bot
		svc.active = true
	}

	// Iniciar el worker de cola offline para reintentar envíos automáticamente al volver el internet
	svc.startQueueWorker()

	return svc
}

func (s *TelegramService) enqueue(item QueuedTelegramMessage) {
	s.queueMutex.Lock()
	defer s.queueMutex.Unlock()
	item.CreatedAt = time.Now()
	s.queue = append(s.queue, item)
	log.Printf("📥 [Telegram Queue] Mensaje encolado offline (%s). Total pendientes en cola: %d", item.Type, len(s.queue))
}

func (s *TelegramService) startQueueWorker() {
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()

		for range ticker.C {
			// 1. Si el bot no ha sido inicializado por falta de internet al arrancar, reintentar conexión
			if s.bot == nil && s.token != "" && s.chatID != 0 {
				bot, err := tgbotapi.NewBotAPI(s.token)
				if err == nil {
					tgbotapi.SetLogger(log.New(io.Discard, "", 0))
					s.bot = bot
					s.active = true
					log.Printf("✅ [Telegram Worker] Conexión restablecida con el Bot de Telegram (@%s)!", bot.Self.UserName)
				} else {
					continue
				}
			}

			// 2. Procesar cola de mensajes pendientes
			s.queueMutex.Lock()
			if len(s.queue) == 0 || s.bot == nil {
				s.queueMutex.Unlock()
				continue
			}

			item := s.queue[0]
			s.queueMutex.Unlock()

			var sendErr error
			switch item.Type {
			case "MARKDOWN":
				msg := tgbotapi.NewMessage(s.chatID, item.Message)
				msg.ParseMode = "Markdown"
				_, sendErr = s.bot.Send(msg)
				if sendErr != nil {
					msg.ParseMode = ""
					_, sendErr = s.bot.Send(msg)
				}
			case "HTML":
				msg := tgbotapi.NewMessage(s.chatID, item.Message)
				msg.ParseMode = "HTML"
				_, sendErr = s.bot.Send(msg)
				if sendErr != nil {
					msg.ParseMode = ""
					_, sendErr = s.bot.Send(msg)
				}
			case "TEXT":
				msg := tgbotapi.NewMessage(s.chatID, item.Message)
				_, sendErr = s.bot.Send(msg)
			case "DOCUMENT":
				fileObj := tgbotapi.FileBytes{
					Name:  item.Filename,
					Bytes: item.Data,
				}
				doc := tgbotapi.NewDocument(s.chatID, fileObj)
				doc.Caption = item.Caption
				_, sendErr = s.bot.Send(doc)
			case "PHOTO":
				photoObj := tgbotapi.FileBytes{
					Name:  item.Caption,
					Bytes: item.Data,
				}
				photo := tgbotapi.NewPhoto(s.chatID, photoObj)
				photo.Caption = item.Caption
				_, sendErr = s.bot.Send(photo)
			}

			if sendErr == nil {
				s.queueMutex.Lock()
				if len(s.queue) > 0 {
					s.queue = s.queue[1:]
					log.Printf("✅ [Telegram Queue] Tarea offline enviada exitosamente (Restantes en cola: %d)", len(s.queue))
				}
				s.queueMutex.Unlock()
			} else {
				log.Printf("⏳ [Telegram Queue] Reintento fallido (%v). Manteniendo %d tareas en cola...", sendErr, len(s.queue))
			}
		}
	}()
}

func (s *TelegramService) SendMarkdownAlert(message string) {
	if s.bot == nil || !s.active {
		s.enqueue(QueuedTelegramMessage{Type: "MARKDOWN", Message: message})
		return
	}

	go func() {
		msg := tgbotapi.NewMessage(s.chatID, message)
		msg.ParseMode = "Markdown"

		_, err := s.bot.Send(msg)
		if err != nil {
			log.Printf("❌ Failed to send Telegram alert (Markdown): %v. Encolando...", err)
			msg.ParseMode = ""
			if _, err2 := s.bot.Send(msg); err2 != nil {
				s.enqueue(QueuedTelegramMessage{Type: "MARKDOWN", Message: message})
			}
		}
	}()
}

func (s *TelegramService) SendHTMLAlert(message string) {
	if s.bot == nil || !s.active {
		s.enqueue(QueuedTelegramMessage{Type: "HTML", Message: message})
		return
	}

	go func() {
		msg := tgbotapi.NewMessage(s.chatID, message)
		msg.ParseMode = "HTML"

		_, err := s.bot.Send(msg)
		if err != nil {
			log.Printf("❌ Failed to send Telegram alert (HTML): %v. Encolando...", err)
			msg.ParseMode = ""
			if _, err2 := s.bot.Send(msg); err2 != nil {
				s.enqueue(QueuedTelegramMessage{Type: "HTML", Message: message})
			}
		}
	}()
}

func (s *TelegramService) SendAlert(message string) {
	if s.bot == nil || !s.active {
		s.enqueue(QueuedTelegramMessage{Type: "TEXT", Message: message})
		return
	}

	go func() {
		msg := tgbotapi.NewMessage(s.chatID, message)
		_, err := s.bot.Send(msg)
		if err != nil {
			log.Printf("❌ Failed to send Telegram alert: %v. Encolando...", err)
			s.enqueue(QueuedTelegramMessage{Type: "TEXT", Message: message})
		}
	}()
}

// SendDocument envía un archivo documento al chat configurado (o lo guarda en cola offline si no hay red)
func (s *TelegramService) SendDocument(reader io.Reader, filename string, caption string) error {
	fileBytes, err := io.ReadAll(reader)
	if err != nil {
		return fmt.Errorf("failed to read document: %w", err)
	}

	if s.bot == nil || !s.active {
		s.enqueue(QueuedTelegramMessage{
			Type:     "DOCUMENT",
			Filename: filename,
			Caption:  caption,
			Data:     fileBytes,
		})
		log.Printf("📥 [Telegram] Guardado reporte '%s' en cola offline.", filename)
		return nil
	}

	fileObj := tgbotapi.FileBytes{
		Name:  filename,
		Bytes: fileBytes,
	}

	doc := tgbotapi.NewDocument(s.chatID, fileObj)
	doc.Caption = caption

	_, err = s.bot.Send(doc)
	if err != nil {
		log.Printf("❌ Failed to send document to Telegram: %v. Guardando en cola offline...", err)
		s.enqueue(QueuedTelegramMessage{
			Type:     "DOCUMENT",
			Filename: filename,
			Caption:  caption,
			Data:     fileBytes,
		})
		return nil
	}

	log.Printf("✅ Document sent to Telegram: %s", filename)
	return nil
}

func (s *TelegramService) SendPhoto(imgBytes []byte, caption string) error {
	if s.bot == nil || !s.active {
		s.enqueue(QueuedTelegramMessage{
			Type:    "PHOTO",
			Caption: caption,
			Data:    imgBytes,
		})
		return nil
	}

	photoObj := tgbotapi.FileBytes{
		Name:  caption,
		Bytes: imgBytes,
	}

	photo := tgbotapi.NewPhoto(s.chatID, photoObj)
	photo.Caption = caption

	_, err := s.bot.Send(photo)
	if err != nil {
		log.Printf("❌ Failed to send photo: %v. Guardando en cola offline...", err)
		s.enqueue(QueuedTelegramMessage{
			Type:    "PHOTO",
			Caption: caption,
			Data:    imgBytes,
		})
		return nil
	}

	log.Printf("✅ Photo sent to Telegram: %s", caption)
	return nil
}

// StartListener inicia el bucle de escucha de comandos de Telegram
func (s *TelegramService) StartListener(invService *InventoryService, saleRepo ports.SaleRepository, dashService *DashboardService, prodService *ProductService, aiBotService *AIBotService) {
	if s.bot == nil || !s.active {
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
