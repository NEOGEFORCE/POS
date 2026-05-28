const fs = require('fs');

const tgFile = 'c:/Users/jaide/OneDrive/Desktop/POS/backPOS-go/internal/core/services/telegram_service.go';
let tgContent = fs.readFileSync(tgFile, 'utf8');

// Imports in telegram_service.go
if (!tgContent.includes('"encoding/base64"')) {
    tgContent = tgContent.replace('"fmt"', '"encoding/base64"\n\t"fmt"\n\t"net/http"');
}

// Update StartListener in telegram_service.go
const imgCheck = `			if update.Message == nil {
				continue
			}

			// Si trae foto o documento
			if len(update.Message.Photo) > 0 || update.Message.Document != nil {
				if aiBotService != nil {
					s.handleImageMessage(update.Message, aiBotService)
				}
				continue
			}`;
tgContent = tgContent.replace(/if update\.Message == nil \{\n\t\t\t\tcontinue\n\t\t\t\}/, imgCheck);

// Add handleImageMessage in telegram_service.go
const handleImageFunc = `
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
`;
if (!tgContent.includes('func (s *TelegramService) handleImageMessage(')) {
    tgContent += handleImageFunc;
    fs.writeFileSync(tgFile, tgContent);
}

// ai_bot_service.go edits
const aiFile = 'c:/Users/jaide/OneDrive/Desktop/POS/backPOS-go/internal/core/services/ai_bot_service.go';
let aiContent = fs.readFileSync(aiFile, 'utf8');

// 1. Add "math" to imports in ai_bot_service.go
if (!aiContent.includes('"math"')) {
    aiContent = aiContent.replace('"log"', '"log"\n\t"math"');
}

// 2. Add System Prompt with image capabilities
const newPrompt = `
const systemPromptWithImageCapabilities = systemPrompt + \`

IMÁGENES Y FACTURAS:
Cuando el usuario mande una foto:
- Si es factura: lee TODOS los productos, muestra la lista completa y pregunta qué hacer
- Nunca ejecutes acciones sobre la factura sin que el usuario confirme primero
- Después de mostrar la lista pregunta: "¿Los ingreso al inventario, actualizo los precios, o las dos cosas?"
- Si el usuario dice "las dos" o "todo": primero actualiza precios, luego ingresa al inventario
- Si un producto de la factura no está en el sistema, avisa cuáles no encontraste y continúa con los que sí
- Los productos que no se encuentran por barcode los buscas por similitud de nombre\`
`;
if (!aiContent.includes('systemPromptWithImageCapabilities')) {
    aiContent = aiContent.replace('const systemPrompt =', newPrompt + '\nconst systemPrompt =');
}

// 3. Add ProcessImageMessage and buildImagePrompt
const visionFuncs = `
func (s *AIBotService) ProcessImageMessage(chatID int64, imgBase64, mimeType, caption string) (string, error) {
	state := s.getOrCreateState(chatID)

	userContent := []map[string]interface{}{
		{
			"type": "image",
			"source": map[string]interface{}{
				"type":       "base64",
				"media_type": mimeType,
				"data":       imgBase64,
			},
		},
		{
			"type": "text",
			"text": buildImagePrompt(caption),
		},
	}

	state.ConversationHistory = append(state.ConversationHistory, ClaudeMessage{
		Role:    "user",
		Content: userContent,
	})

	req := ClaudeRequest{
		Model:     claudeModel,
		MaxTokens: 2048,
		System:    systemPromptWithImageCapabilities,
		Messages:  state.ConversationHistory,
		Tools:     s.getClaudeTools(),
	}

	resp, err := s.doClaudeRequest(req)
	if err != nil {
		return "", err
	}

	if resp.StopReason == "tool_use" {
		var toolBlock ClaudeBlock
		for _, block := range resp.Content {
			if block.Type == "tool_use" {
				toolBlock = block
			}
		}

		state.ConversationHistory = append(state.ConversationHistory, ClaudeMessage{
			Role:    "assistant",
			Content: resp.Content,
		})

		args, _ := toolBlock.Input.(map[string]interface{})
		result, err := s.executeFunction(chatID, toolBlock.Name, args)
		resultJSON, _ := json.Marshal(result)
		if err != nil {
			resultJSON = []byte(\`{"error":"\` + err.Error() + \`"}\`)
		}

		state.ConversationHistory = append(state.ConversationHistory, ClaudeMessage{
			Role: "user",
			Content: []map[string]interface{}{
				{
					"type":        "tool_result",
					"tool_use_id": toolBlock.ID,
					"content":     string(resultJSON),
				},
			},
		})

		req.Messages = state.ConversationHistory
		resp, err = s.doClaudeRequest(req)
		if err != nil {
			return "", err
		}
	}

	var finalText string
	for _, block := range resp.Content {
		if block.Type == "text" {
			finalText += block.Text
		}
	}

	state.ConversationHistory = append(state.ConversationHistory, ClaudeMessage{
		Role:    "assistant",
		Content: finalText,
	})

	if len(state.ConversationHistory) > 20 {
		state.ConversationHistory = state.ConversationHistory[len(state.ConversationHistory)-20:]
	}

	return finalText, nil
}

func buildImagePrompt(caption string) string {
	base := \`Analiza esta imagen. 

Si es una FACTURA DE PROVEEDOR:
1. Lee todos los productos, cantidades y precios
2. Muéstrame la lista completa en formato claro
3. Pregúntame qué quiero hacer: ¿ingresar a Carga Maestra, actualizar precios, o las dos cosas?
4. Espera mi respuesta antes de ejecutar cualquier acción

Si es una IMAGEN DE PRODUCTO (código de barras, producto):
- Identifica el producto si puedes
- Dime su stock actual y precio si está en el inventario

Si es otro tipo de imagen:
- Descríbela y pregunta cómo puedo ayudarte con ella\`

	if caption != "" {
		base += fmt.Sprintf("\n\nContexto adicional del usuario: %s", caption)
	}

	return base
}

// Helpes for pending state used by bulk
func (s *AIBotService) getPendingAction(chatID int64) string {
	state := s.getOrCreateState(chatID)
	return state.PendingAction
}

func (s *AIBotService) setPendingAction(chatID int64, action string, payload map[string]interface{}) {
	state := s.getOrCreateState(chatID)
	state.PendingAction = action
	state.PendingPayload = payload
}

func (s *AIBotService) clearPendingAction(chatID int64) {
	state := s.getOrCreateState(chatID)
	state.PendingAction = ""
	state.PendingPayload = nil
}
`;
if (!aiContent.includes('func (s *AIBotService) ProcessImageMessage(')) {
    aiContent += visionFuncs;
}

// 4. Add the 2 new tools to getClaudeTools
const bulkTools = `		{
			Name: "bulk_receive_from_invoice",
			Description: "Ingresa múltiples productos a la Carga Maestra después de leer una factura. Llama esta tool cuando el usuario confirme que quiere ingresar los productos leídos de la imagen.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"supplier_name": map[string]interface{}{"type": "string"},
					"items": map[string]interface{}{
						"type": "array",
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"product_name": map[string]interface{}{"type": "string"},
								"barcode":      map[string]interface{}{"type": "string"},
								"quantity":     map[string]interface{}{"type": "number"},
								"unit_price":   map[string]interface{}{"type": "number"},
							},
						},
					},
					"is_egreso": map[string]interface{}{
						"type":        "boolean",
						"description": "true = entra al inventario, false = solo actualiza precios",
					},
				},
				"required": []string{"items"},
			},
		},
		{
			Name: "bulk_update_prices_from_invoice",
			Description: "Actualiza los precios de múltiples productos después de leer una factura. Requiere confirmación previa.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"items": map[string]interface{}{
						"type": "array",
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"product_name": map[string]interface{}{"type": "string"},
								"barcode":      map[string]interface{}{"type": "string"},
								"new_cost":     map[string]interface{}{"type": "number"},
							},
						},
					},
				},
				"required": []string{"items"},
			},
		},
`;
if (!aiContent.includes('"bulk_receive_from_invoice"')) {
    aiContent = aiContent.replace(/\t\t\t\},\n\t\t\},\n\t\}\n\}/, '\t\t\t},\n\t\t},\n' + bulkTools + '\t}\n}');
}

// 5. Add bulk handlers in executeFunction
const bulkCases = `	case "bulk_receive_from_invoice":
		items, _ := args["items"].([]interface{})
		supplierName, _ := args["supplier_name"].(string)
		isEgreso, _ := args["is_egreso"].(bool)
		
		if isEgreso && s.getPendingAction(chatID) != "bulk_receive_confirmed" {
			s.setPendingAction(chatID, "bulk_receive_confirmed", args)
			return map[string]interface{}{
				"status":           "pending_confirmation",
				"requires_confirm": true,
				"item_count":       len(items),
				"supplier":         supplierName,
			}, nil
		}
		
		s.clearPendingAction(chatID)
		
		var received []string
		var errors []string
		
		for _, item := range items {
			itemMap, _ := item.(map[string]interface{})
			barcode, _ := itemMap["barcode"].(string)
			productName, _ := itemMap["product_name"].(string)
			quantity, _ := itemMap["quantity"].(float64)
			unitPrice, _ := itemMap["unit_price"].(float64)
			
			var product models.Product
			result := s.db.Where("barcode = ?", barcode).First(&product)
			if result.Error != nil {
				s.db.Where("\"productName\" ILIKE ?", "%"+productName+"%").First(&product)
			}
			
			if product.ID == 0 {
				errors = append(errors, fmt.Sprintf("❌ No encontrado: %s", productName))
				continue
			}
			
			oldWAC := product.PurchasePrice
			oldStock := product.Quantity
			newStock := oldStock + quantity
			var newWAC float64
			if newStock > 0 {
				newWAC = (oldStock*oldWAC + quantity*unitPrice) / newStock
			} else {
				newWAC = unitPrice
			}
			
			s.db.Model(&product).Updates(map[string]interface{}{
				"Quantity":      newStock,
				"PurchasePrice": math.Round(newWAC*100) / 100,
			})
			
			s.db.Create(&models.StockMovement{
				Barcode:      product.Barcode,
				ProductName:  product.ProductName,
				Quantity:     quantity,
				Type:         "IN",
				Reason:       "RECEPTION_BOT",
				EmployeeName: "Bot Telegram",
				Reference:    "Ingresado desde factura vía bot",
			})
			
			received = append(received, fmt.Sprintf("✅ %s: +%.0f uds · WAC $%.0f → $%.0f", 
				product.ProductName, quantity, oldWAC, newWAC))
		}
		
		return map[string]interface{}{
			"received": received,
			"errors":   errors,
			"summary":  fmt.Sprintf("%d productos ingresados, %d no encontrados", len(received), len(errors)),
		}, nil

	case "bulk_update_prices_from_invoice":
		items, _ := args["items"].([]interface{})
		
		if s.getPendingAction(chatID) != "bulk_price_confirmed" {
			s.setPendingAction(chatID, "bulk_price_confirmed", args)
			return map[string]interface{}{
				"status":           "pending_confirmation",
				"requires_confirm": true,
				"item_count":       len(items),
			}, nil
		}
		
		s.clearPendingAction(chatID)
		var updated []string
		
		for _, item := range items {
			itemMap, _ := item.(map[string]interface{})
			barcode, _ := itemMap["barcode"].(string)
			productName, _ := itemMap["product_name"].(string)
			newCost, _ := itemMap["new_cost"].(float64)
			
			var product models.Product
			s.db.Where("barcode = ? OR \"productName\" ILIKE ?", barcode, "%"+productName+"%").First(&product)
			
			if product.ID == 0 {
				continue
			}
			
			oldPrice := product.PurchasePrice
			newMargin := ((product.SalePrice - newCost) / product.SalePrice) * 100
			
			s.db.Model(&product).Updates(map[string]interface{}{
				"PurchasePrice":    newCost,
				"MarginPercentage": math.Round(newMargin*100) / 100,
			})
			
			updated = append(updated, fmt.Sprintf("✅ %s: $%.0f → $%.0f (margen %.1f%%)",
				product.ProductName, oldPrice, newCost, newMargin))
		}
		
		return map[string]interface{}{
			"updated": updated,
			"summary": fmt.Sprintf("%d precios actualizados", len(updated)),
		}, nil
`;

if (!aiContent.includes('"bulk_receive_from_invoice":')) {
    aiContent = aiContent.replace(/switch name \{\n/, 'switch name {\n' + bulkCases + '\n');
}

fs.writeFileSync(aiFile, aiContent);
console.log('Update complete.');
