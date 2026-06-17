package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"bytes"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"net/url"
	"github.com/jung-kurt/gofpdf"
	"github.com/wcharczuk/go-chart/v2"
	"gorm.io/gorm"
)

// ============================================================
// Claude API Constants
// ============================================================

const claudeURL = "https://api.anthropic.com/v1/messages"
const claudeModel = "claude-sonnet-4-5"

// ============================================================
// Core Service
// ============================================================

type AIBotService struct {
	saleRepo ports.SaleRepository
	prodRepo ports.ProductRepository
	expRepo  ports.ExpenseRepository
	restRepo ports.RestockRepository
	telegram *TelegramService
	http     *http.Client
	db       *gorm.DB

	stateMap map[int64]*ConversationState
	mu       sync.Mutex
}

type ConversationState struct {
	PendingAction       string
	PendingPayload      map[string]interface{}
	LastMessageAt       time.Time
	ConversationHistory []ClaudeMessage
}

// ============================================================
// Claude Types
// ============================================================

type ClaudeMessage struct {
	Role    string      `json:"role"`
	Content interface{} `json:"content"`
}

type ClaudeRequest struct {
	Model     string          `json:"model"`
	MaxTokens int             `json:"max_tokens"`
	System    string          `json:"system"`
	Messages  []ClaudeMessage `json:"messages"`
	Tools     []ClaudeTool    `json:"tools,omitempty"`
}

type ClaudeTool struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema interface{} `json:"input_schema"`
}

type ClaudeResponse struct {
	ID         string        `json:"id"`
	Content    []ClaudeBlock `json:"content"`
	StopReason string        `json:"stop_reason"`
}

type ClaudeBlock struct {
	Type  string      `json:"type"`
	Text  string      `json:"text,omitempty"`
	ID    string      `json:"id,omitempty"`
	Name  string      `json:"name,omitempty"`
	Input interface{} `json:"input,omitempty"`
}

// ============================================================
// Constructor
// ============================================================

func NewAIBotService(sale ports.SaleRepository, prod ports.ProductRepository, exp ports.ExpenseRepository, rest ports.RestockRepository, telegram *TelegramService, db *gorm.DB) *AIBotService {
	return &AIBotService{
		saleRepo: sale,
		prodRepo: prod,
		expRepo:  exp,
		restRepo: rest,
		telegram: telegram,
		http:     &http.Client{Timeout: 60 * time.Second},
		db:       db,
		stateMap: make(map[int64]*ConversationState),
	}
}

func (s *AIBotService) getOrCreateState(chatID int64) *ConversationState {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, exists := s.stateMap[chatID]
	if !exists || time.Since(state.LastMessageAt) > 30*time.Minute {
		state = &ConversationState{
			ConversationHistory: make([]ClaudeMessage, 0),
		}
		s.stateMap[chatID] = state
	}
	state.LastMessageAt = time.Now()
	return state
}

// ============================================================
// System Prompt
// ============================================================


const systemPromptWithImageCapabilities = systemPrompt + `

IMÁGENES Y FACTURAS:
Cuando el usuario mande una foto:
- Si es factura: lee TODOS los productos, muestra la lista completa y pregunta qué hacer
- Nunca ejecutes acciones sobre la factura sin que el usuario confirme primero
- Después de mostrar la lista pregunta: "¿Los ingreso al inventario, actualizo los precios, o las dos cosas?"
- Si el usuario dice "las dos" o "todo": primero actualiza precios, luego ingresa al inventario
- Si un producto de la factura no está en el sistema, avisa cuáles no encontraste y continúa con los que sí
- Los productos que no se encuentran por barcode los buscas por similitud de nombre`

const systemPromptBase = `Eres el asistente personal de Sebastian, dueño de Surtifamiliar, un supermercado de barrio en Colombia.
Tienes acceso completo a la base de datos del POS mediante la tool query_database.

IMPORTANTE: Si el usuario te pregunta algo sobre el negocio que las tools específicas no cubren,
USA query_database para construir la consulta SQL necesaria y obtener la respuesta exacta.
Nunca digas "no tengo esa información" si se puede consultar en la base de datos.

Reglas:
- Responde siempre en español, directo y conciso
- Usa formato Telegram: *negrita*, no HTML
- Montos en pesos colombianos con puntos de miles: $1.250.000
- Para cambiar precios o registrar egresos, SIEMPRE confirma primero
- Si el usuario responde "sí", "dale", "confirma", ejecuta la acción
- Da el número importante primero, luego el detalle
- Nunca inventes datos — si la query no devuelve resultados, dilo claramente
- El negocio está en Colombia, usa horario de Bogotá (UTC-5)
- Cuando uses query_database, construye queries eficientes con filtros de fecha apropiados`

// Mantener const systemPrompt para compatibilidad con código existente que lo
// referencia. La inyección dinámica se hace vía buildSystemPrompt() abajo.
const systemPrompt = systemPromptBase

// Días de la semana en español (Date.Weekday() retorna 0=Sunday)
var spanishWeekdays = [7]string{
	"Domingo", "Lunes", "Martes", "Miércoles",
	"Jueves", "Viernes", "Sábado",
}

var spanishMonths = [12]string{
	"enero", "febrero", "marzo", "abril", "mayo", "junio",
	"julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
}

// buildSystemPrompt genera el system prompt con contexto temporal actual
// (Bogotá, UTC-5). Se llama en cada request a Claude para que el modelo
// SIEMPRE sepa qué día es hoy y no le pregunte al usuario.
func buildSystemPrompt(includeImageRules bool) string {
	loc, _ := time.LoadLocation("America/Bogota")
	if loc == nil {
		loc = time.FixedZone("COT", -5*3600)
	}
	now := time.Now().In(loc)
	dayName := spanishWeekdays[now.Weekday()]
	monthName := spanishMonths[now.Month()-1]
	formattedDate := fmt.Sprintf("%s, %d de %s de %d", dayName, now.Day(), monthName, now.Year())
	formattedTime := now.Format("15:04")

	temporalContext := fmt.Sprintf(`
CONTEXTO TEMPORAL — IMPORTANTE:
- Hoy es %s (%s).
- Hora actual en Bogotá: %s.
- Día de la semana actual (para filtros de proveedores): %s.
- NUNCA le preguntes al usuario qué día es. NUNCA asumas otra fecha.
- Cuando el usuario diga "hoy", "ayer", "esta semana", "este mes", calcula a partir de %s.
- Cuando consultes proveedores que vienen "hoy", filtra por día de visita = %s.
`, formattedDate, now.Format("2006-01-02"), formattedTime, dayName, now.Format("2006-01-02"), dayName)

	if includeImageRules {
		return systemPromptWithImageCapabilities + "\n" + temporalContext
	}
	return systemPromptBase + "\n" + temporalContext
}

// ============================================================
// ProcessMessage — Entry Point from Telegram
// ============================================================

func (s *AIBotService) ProcessMessage(chatID int64, text string) {
	// Seguridad
	authID := os.Getenv("AUTHORIZED_CHAT_ID")
	if fmt.Sprintf("%d", chatID) != authID {
		s.telegram.SendMarkdownAlert("No estás autorizado para usar este bot.")
		return
	}

	go func() {
		state := s.getOrCreateState(chatID)

		// Check for pending actions
		textLower := strings.ToLower(text)
		isConfirm := strings.Contains(textLower, "si") || strings.Contains(textLower, "sí") || strings.Contains(textLower, "dale") || strings.Contains(textLower, "confirma") || strings.Contains(textLower, "ok")
		if state.PendingAction != "" && isConfirm {
			result, err := s.executeDangerousAction(chatID, state.PendingAction, state.PendingPayload)
			var respMsg string
			if err != nil {
				respMsg = fmt.Sprintf("❌ Error al ejecutar acción: %v", err)
			} else {
				respMsg = fmt.Sprintf("✅ Acción ejecutada con éxito. %v", result)
			}
			state.PendingAction = ""
			state.PendingPayload = nil
			s.telegram.SendMarkdownAlert(respMsg)
			return
		}

		resp, err := s.callClaude(chatID, text)
		if err != nil {
			s.telegram.SendMarkdownAlert("❌ Error conectando con Claude: " + err.Error())
			return
		}

		if resp != "" {
			s.telegram.SendMarkdownAlert(resp)
		}
	}()
}

func (s *AIBotService) HandleCallbackQuery(chatID int64, data string) {
	authID := os.Getenv("AUTHORIZED_CHAT_ID")
	if fmt.Sprintf("%d", chatID) != authID {
		return
	}

	go func() {
		if strings.HasPrefix(data, "approve_restock_") {
			parts := strings.Split(data, "_")
			if len(parts) >= 3 {
				supplierIDStr := parts[2]
				supplierID, err := strconv.ParseUint(supplierIDStr, 10, 32)
				if err == nil {
					args := map[string]interface{}{"supplier_id": float64(supplierID), "supplier_name": "Proveedor"}
					res, err := s.executeFunction(chatID, "approve_restock_order", args)
					if err != nil {
						s.telegram.SendMarkdownAlert(fmt.Sprintf("❌ Error al aprobar pedido: %v", err))
					} else {
						s.telegram.SendMarkdownAlert(fmt.Sprintf("✅ Pedido aprobado. %v", res))
					}
				}
			}
		}
	}()
}

// ============================================================
// callClaude — Main AI Loop with Tool Use
//
// Iteración: Claude puede pedir múltiples tools en cadena.
// Mientras stop_reason == "tool_use" seguimos ejecutando localmente y
// devolviendo tool_result a la API, hasta que el modelo dé una respuesta
// natural ("end_turn"). Solo entonces se envía el texto al usuario, evitando
// que IDs internos como `toolu_...` se filtren a Telegram.
// ============================================================

const maxToolIterations = 6

func (s *AIBotService) callClaude(chatID int64, userMessage string) (string, error) {
	state := s.getOrCreateState(chatID)

	// Snapshot del historial ANTES de añadir nada. Sirve para rollback
	// limpio si: (a) se detecta acción peligrosa que requiere confirmación,
	// (b) la API responde con error de red, (c) se excede maxToolIterations.
	// Sin esto, una iteración intermedia (iter > 0) que detecta acción
	// peligrosa dejaría tool_use sin su tool_result siguiente y la próxima
	// request fallaría con "tool_use ids found without tool_result blocks".
	historyCheckpoint := len(state.ConversationHistory)

	// Agregar mensaje del usuario al historial
	state.ConversationHistory = append(state.ConversationHistory, ClaudeMessage{
		Role:    "user",
		Content: userMessage,
	})

	req := s.buildRequest(state, false)

	// Primera llamada
	resp, err := s.doClaudeRequest(req)
	if err != nil {
		state.ConversationHistory = state.ConversationHistory[:historyCheckpoint]
		return "", err
	}

	// Loop multi-step: maneja N iteraciones de tool_use hasta respuesta natural
	for iter := 0; iter < maxToolIterations && resp.StopReason == "tool_use"; iter++ {
		// Encontrar TODOS los bloques de tool use
		var toolBlocks []ClaudeBlock
		for _, block := range resp.Content {
			if block.Type == "tool_use" {
				toolBlocks = append(toolBlocks, block)
			}
		}
		if len(toolBlocks) == 0 {
			break
		}

		// Revisar si ALGUNA es peligrosa ANTES de ejecutar nada
		var dangerousBlock *ClaudeBlock
		var dangerousArgs map[string]interface{}
		for i, block := range toolBlocks {
			args, _ := block.Input.(map[string]interface{})
			if block.Name == "update_product_price" || block.Name == "register_expense" {
				dangerousBlock = &toolBlocks[i]
				dangerousArgs = args
				break
			}
		}

		// Acciones peligrosas requieren confirmación — interrumpir el loop
		// y devolver pregunta al usuario sin ejecutar nada.
		if dangerousBlock != nil {
			state.PendingAction = dangerousBlock.Name
			state.PendingPayload = dangerousArgs

			respText := "¿Confirmas que deseas ejecutar esta acción de modificación?"
			if dangerousBlock.Name == "update_product_price" {
				respText = fmt.Sprintf("¿Confirmas que quieres cambiar el precio de %v a $%v?", dangerousArgs["product_name"], dangerousArgs["new_price"])
			} else if dangerousBlock.Name == "register_expense" {
				respText = fmt.Sprintf("¿Confirmas que quieres registrar un egreso de $%v por concepto de '%v'?", dangerousArgs["amount"], dangerousArgs["concept"])
			}

			// IMPORTANTE: rollback completo al checkpoint para evitar dejar
			// tool_use huérfanos en el historial. Si esta iteración es > 0,
			// ya hay pares assistant(tool_use) + user(tool_result) acumulados;
			// borrar solo el último mensaje deja un tool_use sin tool_result
			// siguiente y la próxima request fallaría con error 400 de la API
			// ("tool_use ids were found without tool_result blocks").
			// Volvemos al estado previo a esta llamada a callClaude; el flujo
			// posterior (executeDangerousAction tras "sí" del usuario) ejecuta
			// la acción sin contaminar el historial conversacional.
			state.ConversationHistory = state.ConversationHistory[:historyCheckpoint]
			return respText, nil
		}

		// Agregar respuesta de Claude al historial (con TODOS los bloques originales)
		state.ConversationHistory = append(state.ConversationHistory, ClaudeMessage{
			Role:    "assistant",
			Content: resp.Content,
		})

		// Ejecutar todas las tools en orden y construir los resultados
		var toolResults []map[string]interface{}
		for _, block := range toolBlocks {
			args, _ := block.Input.(map[string]interface{})
			result, execErr := s.executeFunction(chatID, block.Name, args)
			
			var resultJSON []byte
			if execErr != nil {
				resultJSON = []byte(`{"error":"` + execErr.Error() + `"}`)
			} else {
				resultJSON, _ = json.Marshal(result)
			}

			toolResults = append(toolResults, map[string]interface{}{
				"type":        "tool_result",
				"tool_use_id": block.ID,
				"content":     string(resultJSON),
			})
		}

		// Agregar TODOS los resultados de la tool al historial en un único mensaje
		state.ConversationHistory = append(state.ConversationHistory, ClaudeMessage{
			Role:    "user",
			Content: toolResults,
		})

		// Próxima llamada — Claude redacta respuesta final O pide otra tool
		req.Messages = state.ConversationHistory
		resp, err = s.doClaudeRequest(req)
		if err != nil {
			state.ConversationHistory = state.ConversationHistory[:historyCheckpoint]
			return "", err
		}
	}

	// Si después de N iteraciones todavía pide tool_use, abortamos
	// limpiamente para no entrar en bucle infinito ni filtrar IDs.
	// Rollback al checkpoint para descartar la cadena fallida — mejor que
	// el usuario reformule sobre un historial limpio que sobre uno medio
	// completado que confunda al modelo en futuras interacciones.
	if resp.StopReason == "tool_use" {
		state.ConversationHistory = state.ConversationHistory[:historyCheckpoint]
		return "Disculpa, no pude completar tu solicitud (demasiadas tools encadenadas). Reformula la pregunta.", nil
	}

	// Extraer SOLO los bloques de texto de la respuesta final.
	// Cualquier bloque de otro tipo (tool_use, etc.) se ignora explícitamente
	// para evitar que IDs internos se filtren al chat.
	var finalText string
	for _, block := range resp.Content {
		if block.Type == "text" {
			finalText += block.Text
		}
	}

	if strings.TrimSpace(finalText) == "" {
		finalText = "(respuesta vacía del modelo)"
	}

	// Guardar respuesta en historial
	state.ConversationHistory = append(state.ConversationHistory, ClaudeMessage{
		Role:    "assistant",
		Content: finalText,
	})

	// Mantener máximo 20 mensajes
	if len(state.ConversationHistory) > 20 {
		state.ConversationHistory = state.ConversationHistory[len(state.ConversationHistory)-20:]
	}

	return finalText, nil
}

// ============================================================
// doClaudeRequest — HTTP Call to Anthropic API
// ============================================================

func (s *AIBotService) doClaudeRequest(req ClaudeRequest) (*ClaudeResponse, error) {
	key := os.Getenv("ANTHROPIC_API_KEY")
	if key == "" {
		return nil, fmt.Errorf("ANTHROPIC_API_KEY no configurado en .env")
	}

	jsonData, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequest("POST", claudeURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", key)
	httpReq.Header.Set("anthropic-version", "2023-06-01")

	resp, err := s.http.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := ioutil.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("claude api error %d: %s", resp.StatusCode, string(body))
	}

	var claudeResp ClaudeResponse
	if err := json.Unmarshal(body, &claudeResp); err != nil {
		return nil, err
	}

	return &claudeResp, nil
}

// ============================================================
// executeDangerousAction
// ============================================================

func (s *AIBotService) executeDangerousAction(chatID int64, name string, args map[string]interface{}) (map[string]interface{}, error) {
	return s.executeFunction(chatID, name, args)
}

// ============================================================
// Claude Tools — Same functions, Claude format (input_schema)
// ============================================================

func (s *AIBotService) getClaudeTools() []ClaudeTool {
	return []ClaudeTool{
		{
			Name:        "get_sales_report",
			Description: "Obtiene reporte de ventas de hoy, ayer, semana, mes o rango personalizado.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"period": map[string]interface{}{
						"type": "string",
						"enum": []string{"today", "yesterday", "week", "month", "custom"},
					},
					"date_from": map[string]interface{}{"type": "string"},
					"date_to":   map[string]interface{}{"type": "string"},
				},
				"required": []string{"period"},
			},
		},
		{
			Name:        "get_stock_status",
			Description: "Consulta estado del inventario. Filtra por producto específico, críticos o todos.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"filter": map[string]interface{}{
						"type": "string",
						"enum": []string{"all", "critical", "warning", "product"},
					},
					"product_name": map[string]interface{}{"type": "string"},
				},
				"required": []string{"filter"},
			},
		},
		{
			Name:        "get_expenses_report",
			Description: "Obtiene reporte de egresos con detalle por categoría.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"period": map[string]interface{}{
						"type": "string",
						"enum": []string{"today", "yesterday", "week", "month"},
					},
					"category": map[string]interface{}{"type": "string"},
				},
				"required": []string{"period"},
			},
		},
		{
			Name:        "get_restock_suggestions",
			Description: "Obtiene productos que necesitan pedirse según Smart Restock.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"supplier_name": map[string]interface{}{"type": "string"},
					"only_critical": map[string]interface{}{"type": "boolean"},
				},
			},
		},
		{
			Name:        "approve_restock_order",
			Description: "Aprueba y confirma un pedido de restock para un proveedor.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"supplier_id":   map[string]interface{}{"type": "integer"},
					"supplier_name": map[string]interface{}{"type": "string"},
				},
				"required": []string{"supplier_id", "supplier_name"},
			},
		},
		{
			Name:        "update_product_price",
			Description: "Actualiza el precio de venta de un producto. Siempre pide confirmación antes de ejecutar.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"product_name": map[string]interface{}{"type": "string"},
					"barcode":      map[string]interface{}{"type": "string"},
					"new_price":    map[string]interface{}{"type": "number"},
				},
				"required": []string{"new_price"},
			},
		},
		{
			Name:        "register_expense",
			Description: "Registra un egreso rápido en el sistema. Siempre pide confirmación antes de ejecutar.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"concept":        map[string]interface{}{"type": "string"},
					"amount":         map[string]interface{}{"type": "number"},
					"category":       map[string]interface{}{"type": "string", "enum": []string{"PROVEEDORES", "NOMINA", "SERVICIOS", "ARRIENDO", "OTROS"}},
					"payment_method": map[string]interface{}{"type": "string", "enum": []string{"EFECTIVO", "TRANSFERENCIA", "DAVIPLATA"}},
				},
				"required": []string{"concept", "amount", "category", "payment_method"},
			},
		},
		{
			Name:        "get_top_products",
			Description: "Obtiene los productos más vendidos en un período.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"period": map[string]interface{}{
						"type": "string",
						"enum": []string{"today", "week", "month"},
					},
					"limit": map[string]interface{}{"type": "integer"},
				},
				"required": []string{"period"},
			},
		},
		{
			Name:        "get_cash_summary",
			Description: "Obtiene resumen de caja del día: ventas, egresos, devoluciones y saldo neto.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"date": map[string]interface{}{"type": "string"},
				},
			},
		},
		{
			Name: "query_database",
			Description: `Ejecuta una consulta de lectura a la base de datos del POS para responder cualquier pregunta del negocio.
Úsala cuando las otras tools no cubran lo que el usuario necesita.
SOLO SELECT — nunca INSERT, UPDATE, DELETE.
Tablas disponibles:
- products (barcode, "productName", quantity, "salePrice", "purchasePrice", "minStock", "categoryId", "supplierID")
- sales (id, "totalAmount", "paymentMethod", "saleDate", "employeeDNI", "employeeName")
- sale_items (id, "saleId", barcode, "productName", quantity, "unitPrice", "totalPrice")
- expenses (id, description, amount, category, "paymentSource", date, status, "createdByDNI")
- confirmed_orders (id, "supplierID", status, "createdAt", "totalEstimated")
- confirmed_order_items (id, "orderId", barcode, "productName", quantity, "estimatedCost")
- stock_movements (id, barcode, "productName", quantity, type, reason, "createdAt", "employeeDNI")
- categories (id, name, "marginPercentage")
- suppliers (id, name, "visitDay", frequency)
NOTA: Los nombres de columnas en camelCase van entre comillas dobles en PostgreSQL.`,
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"sql": map[string]interface{}{
						"type":        "string",
						"description": "Query SQL de solo lectura (SELECT). Usar NOW() para fecha actual. Usar ILIKE para búsquedas de texto. Nombres camelCase entre comillas dobles.",
					},
					"description": map[string]interface{}{
						"type":        "string",
						"description": "Descripción breve de qué está consultando",
					},
				},
				"required": []string{"sql", "description"},
			},
		},
		{
			Name:        "get_credit_clients",
			Description: "Lista todos los clientes que tienen deuda pendiente (fiado). Puede filtrar por nombre específico o mostrar todos.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"client_name": map[string]interface{}{
						"type":        "string",
						"description": "Nombre parcial del cliente para filtrar, opcional",
					},
					"only_overdue": map[string]interface{}{
						"type":        "boolean",
						"description": "Solo clientes con deuda vencida",
					},
				},
			},
		},
		{
			Name:        "get_client_detail",
			Description: "Obtiene el detalle completo de un cliente: total que debe, historial de compras fiadas, abonos realizados y saldo actual.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"client_name": map[string]interface{}{
						"type":        "string",
						"description": "Nombre del cliente",
					},
					"client_id": map[string]interface{}{
						"type":        "integer",
						"description": "ID del cliente si se conoce",
					},
				},
			},
		},
		{
			Name:        "send_payment_reminder",
			Description: "Envía un mensaje de recordatorio de pago a un cliente por WhatsApp o Telegram. Requiere confirmación previa.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"client_name":  map[string]interface{}{"type": "string"},
					"client_phone": map[string]interface{}{"type": "string"},
					"amount_owed":  map[string]interface{}{"type": "number"},
					"message_tone": map[string]interface{}{
						"type":        "string",
						"enum":        []string{"amable", "formal", "urgente"},
						"description": "Tono del mensaje",
					},
				},
				"required": []string{"client_name", "amount_owed"},
			},
		},
		{
			Name:        "generate_report_pdf",
			Description: "Genera un PDF con reportes del negocio y lo envía por Telegram. Puede generar: reporte de ventas, reporte de egresos, estado de cuentas por cobrar, reporte de inventario crítico, cierre del día.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"report_type": map[string]interface{}{
						"type": "string",
						"enum": []string{"ventas", "egresos", "cuentas_cobrar", "inventario_critico", "cierre_dia"},
					},
					"period": map[string]interface{}{
						"type": "string",
						"enum": []string{"today", "yesterday", "week", "month"},
					},
				},
				"required": []string{"report_type"},
			},
		},
		{
			Name:        "generate_chart",
			Description: "Genera una gráfica como imagen y la envía por Telegram. Tipos: ventas_por_hora, ventas_por_metodo, top_productos, egresos_por_categoria.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"chart_type": map[string]interface{}{
						"type": "string",
						"enum": []string{"ventas_por_hora", "ventas_por_metodo", "top_productos", "egresos_por_categoria"},
					},
					"period": map[string]interface{}{
						"type": "string",
						"enum": []string{"today", "week", "month"},
					},
				},
				"required": []string{"chart_type"},
			},
		},
		{
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
		{
			Name: "get_today_suppliers",
			Description: "Devuelve los proveedores que vienen HOY (según día de la semana actual de Bogotá) " +
				"junto con sus productos en stock crítico (cantidad <= minStock). " +
				"Úsala cuando el usuario pregunte 'qué proveedores vienen hoy', 'qué tengo que pedir hoy', " +
				"'qué se acabó de los proveedores de hoy'. Filtra automáticamente por el día actual; no requiere argumentos.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"day_of_week": map[string]interface{}{
						"type":        "string",
						"description": "Opcional. Día específico en español (Lunes, Martes, ..., Domingo). Si se omite, usa el día actual de Bogotá.",
						"enum":        []string{"Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"},
					},
				},
			},
		},
	}
}

// ============================================================
// executeFunction — Business Logic (unchanged)
// ============================================================

func (s *AIBotService) executeFunction(chatID int64, name string, args map[string]interface{}) (map[string]interface{}, error) {
	loc, _ := time.LoadLocation("America/Bogota")
	now := time.Now().In(loc)

	switch name {
	case "bulk_receive_from_invoice":
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
			
			if product.Barcode == "" {
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
				Quantity:     quantity,
				Type:         "IN",
				Reason:       "RECEPTION_BOT",
				EmployeeName: "Bot Telegram",
				Metadata:     "Ingresado desde factura vía bot",
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
			
			if product.Barcode == "" {
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

	case "get_credit_clients":
		clientName, _ := args["client_name"].(string)
		
		nameFilter := ""
		if clientName != "" {
			nameFilter = fmt.Sprintf("AND UPPER(c.name) LIKE UPPER('%%%s%%')", clientName)
		}
		
		var clients []struct {
			ID          int     `json:"id"`
			Name        string  `json:"name"`
			Phone       string  `json:"phone"`
			TotalDebt   float64 `json:"totalDebt"`
			TotalPaid   float64 `json:"totalPaid"`
			Balance     float64 `json:"balance"`
			LastPurchase string  `json:"lastPurchase"`
			DaysSince   int     `json:"daysSince"`
		}
		
		s.db.Raw(fmt.Sprintf(`
			SELECT 
				c.id,
				c.name,
				c.phone,
				COALESCE(SUM(CASE WHEN s.payment_method = 'FIADO' THEN s.total_amount ELSE 0 END), 0) as total_debt,
				COALESCE(SUM(p.amount), 0) as total_paid,
				COALESCE(SUM(CASE WHEN s.payment_method = 'FIADO' THEN s.total_amount ELSE 0 END), 0) - COALESCE(SUM(p.amount), 0) as balance,
				MAX(s.created_at)::text as last_purchase,
				EXTRACT(DAY FROM NOW() - MAX(s.created_at))::int as days_since
			FROM clients c
			LEFT JOIN sales s ON s.client_id = c.id
			LEFT JOIN client_payments p ON p.client_id = c.id
			WHERE c.id IS NOT NULL %s
			GROUP BY c.id, c.name, c.phone
			HAVING COALESCE(SUM(CASE WHEN s.payment_method = 'FIADO' THEN s.total_amount ELSE 0 END), 0) - COALESCE(SUM(p.amount), 0) > 0
			ORDER BY balance DESC
		`, nameFilter)).Scan(&clients)
		
		var totalDeuda float64
		for _, c := range clients {
			totalDeuda += c.Balance
		}
		
		return map[string]interface{}{
			"clients":    clients,
			"count":      len(clients),
			"totalDeuda": totalDeuda,
		}, nil

	case "get_client_detail":
		clientName, _ := args["client_name"].(string)
		clientID, _ := args["client_id"].(float64)
		
		filter := ""
		if clientID > 0 {
			filter = fmt.Sprintf("WHERE c.id = %d", int(clientID))
		} else if clientName != "" {
			filter = fmt.Sprintf("WHERE UPPER(c.name) LIKE UPPER('%%%s%%')", clientName)
		}
		
		var client struct {
			ID    int    `json:"id"`
			Name  string `json:"name"`
			Phone string `json:"phone"`
		}
		s.db.Raw(fmt.Sprintf(`SELECT id, name, phone FROM clients %s LIMIT 1`, filter)).Scan(&client)
		
		var purchases []struct {
			Date   string  `json:"date"`
			Total  float64 `json:"total"`
			Items  string  `json:"items"`
		}
		s.db.Raw(`
			SELECT 
				s.created_at::date::text as date,
				s.total_amount as total,
				STRING_AGG(si.product_name || ' x' || si.quantity::text, ', ') as items
			FROM sales s
			LEFT JOIN sale_items si ON si.sale_id = s.id
			WHERE s.client_id = ? AND s.payment_method = 'FIADO'
			GROUP BY s.id, s.created_at, s.total_amount
			ORDER BY s.created_at DESC
			LIMIT 20
		`, client.ID).Scan(&purchases)
		
		var payments []struct {
			Date   string  `json:"date"`
			Amount float64 `json:"amount"`
			Method string  `json:"method"`
		}
		s.db.Raw(`
			SELECT 
				created_at::date::text as date,
				amount,
				payment_method as method
			FROM client_payments
			WHERE client_id = ?
			ORDER BY created_at DESC
		`, client.ID).Scan(&payments)
		
		var totalDebt, totalPaid float64
		for _, p := range purchases { totalDebt += p.Total }
		for _, p := range payments { totalPaid += p.Amount }
		
		return map[string]interface{}{
			"client":    client,
			"purchases": purchases,
			"payments":  payments,
			"totalDebt": totalDebt,
			"totalPaid": totalPaid,
			"balance":   totalDebt - totalPaid,
		}, nil

	case "send_payment_reminder":
		clientName, _ := args["client_name"].(string)
		clientPhone, _ := args["client_phone"].(string)
		amountOwed, _ := args["amount_owed"].(float64)
		tone, _ := args["message_tone"].(string)
		
		state := s.getOrCreateState(chatID)
		if state.PendingAction != "send_reminder" {
			state.PendingAction = "send_reminder"
			state.PendingPayload = args
			
			var msg string
			switch tone {
			case "urgente":
				msg = fmt.Sprintf("⚠️ *%s*, su cuenta en Surtifamiliar tiene un saldo pendiente de *$%s*. Por favor comuníquese a la brevedad para ponerse al día. Gracias.", clientName, formatCOP(amountOwed))
			case "formal":
				msg = fmt.Sprintf("Estimado/a *%s*, le recordamos que tiene un saldo pendiente de *$%s* en Surtifamiliar. Agradecemos su pronto pago.", clientName, formatCOP(amountOwed))
			default:
				msg = fmt.Sprintf("Hola *%s* 👋, le recordamos amablemente que tiene un saldo de *$%s* pendiente en Surtifamiliar. Cuando pueda nos colabora. ¡Gracias!", clientName, formatCOP(amountOwed))
			}
			
			return map[string]interface{}{
				"status":           "pending_confirmation",
				"message_preview":  msg,
				"requires_confirm": true,
			}, nil
		}
		
		state.PendingAction = ""
		if clientPhone != "" {
			waLink := fmt.Sprintf("https://wa.me/57%s?text=%s", 
				strings.ReplaceAll(clientPhone, " ", ""),
				url.QueryEscape(fmt.Sprintf("Hola %s, le recordamos su saldo de $%s en Surtifamiliar", clientName, formatCOP(amountOwed))))
			
			return map[string]interface{}{
				"status":   "sent",
				"wa_link":  waLink,
				"message":  "Recordatorio listo. Abre el link para enviarlo por WhatsApp.",
			}, nil
		}
		
		return map[string]interface{}{
			"status":  "no_phone",
			"message": fmt.Sprintf("El cliente %s no tiene teléfono registrado. Agrégalo en el POS para poder enviar mensajes.", clientName),
		}, nil

	case "generate_report_pdf":
		reportType, _ := args["report_type"].(string)
		period, _ := args["period"].(string)
		if period == "" { period = "today" }
		
		pdfBytes, filename, err := s.generatePDF(reportType, period)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}, nil
		}
		
		reader := bytes.NewReader(pdfBytes)
		go s.telegram.SendDocument(reader, filename, "📄 " + filename)
		
		return map[string]interface{}{
			"status":   "sent",
			"filename": filename,
			"message":  "PDF generado y enviado por Telegram",
		}, nil

	case "generate_chart":
		chartType, _ := args["chart_type"].(string)
		period, _ := args["period"].(string)
		if period == "" { period = "today" }
		
		imgBytes, filename, err := s.generateChart(chartType, period)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}, nil
		}
		
		go s.telegram.SendPhoto(imgBytes, filename)
		
		return map[string]interface{}{
			"status":  "sent",
			"message": "Gráfica enviada por Telegram",
		}, nil

	case "get_sales_report":
		period := "today"
		if p, ok := args["period"].(string); ok {
			period = p
		}
		var from, to time.Time
		if period == "custom" {
			layout := "2006-01-02T15:04:05"
			dateFrom, _ := args["date_from"].(string)
			dateTo, _ := args["date_to"].(string)
			if f, err := time.ParseInLocation(layout, dateFrom, loc); err == nil {
				from = f
			} else if f, err := time.ParseInLocation("2006-01-02", dateFrom, loc); err == nil {
				from = f
			}
			if t, err := time.ParseInLocation(layout, dateTo, loc); err == nil {
				to = t
			} else if t, err := time.ParseInLocation("2006-01-02", dateTo, loc); err == nil {
				to = t.Add(24 * time.Hour)
			}
		} else {
			from, to = parseDateRange(period, loc)
		}
		total, err := s.saleRepo.GetTotalSalesByRange(from, to)
		if err != nil {
			return nil, err
		}
		byMethod, _ := s.saleRepo.GetSalesBreakdownByRange(from, to)
		sales, _ := s.saleRepo.GetByDateRange(from, to)
		return map[string]interface{}{
			"total":             total,
			"transactions":      len(sales),
			"by_payment_method": byMethod,
		}, nil

	case "get_stock_status":
		filter := args["filter"].(string)
		if filter == "product" && args["product_name"] != nil {
			prodName := args["product_name"].(string)
			prod, _ := s.prodRepo.GetByName(prodName)
			if prod != nil {
				return map[string]interface{}{
					"productName": prod.ProductName,
					"stock":       prod.Quantity,
					"salePrice":   prod.SalePrice,
				}, nil
			}
			return map[string]interface{}{"error": "producto no encontrado"}, nil
		}
		
		stats, err := s.prodRepo.GetAllWithLowStock()
		if err != nil {
			return nil, err
		}
		
		var result []map[string]interface{}
		limit := 20
		for i, p := range stats {
			if i >= limit {
				break
			}
			result = append(result, map[string]interface{}{
				"name": p.ProductName,
				"stock": p.Quantity,
			})
		}
		
		return map[string]interface{}{
			"items": result,
			"count": len(stats),
		}, nil

	case "get_expenses_report":
		from, to := parseDateRange(args["period"].(string), loc)
		expenses, err := s.expRepo.GetByDateRange(from, to)
		if err != nil {
			return nil, err
		}
		
		var total float64
		catMap := make(map[string]float64)
		for _, e := range expenses {
			total += e.Amount
			catMap[e.Category] += e.Amount
		}
		
		return map[string]interface{}{
			"total": total,
			"by_category": catMap,
		}, nil

	case "get_restock_suggestions":
		prods, _ := s.prodRepo.GetAllWithLowStock()
		
		var report []map[string]interface{}
		limit := 10
		for i, p := range prods {
			if i >= limit {
				break
			}
			report = append(report, map[string]interface{}{
				"name": p.ProductName,
				"suggested_qty": 20,
				"supplier_id": p.SupplierID,
			})
		}
		
		return map[string]interface{}{
			"suggestions": report,
			"count": len(report),
			"has_more": len(prods) > limit,
		}, nil

	case "approve_restock_order":
		supplierIDf, ok := args["supplier_id"].(float64)
		if !ok {
			return nil, fmt.Errorf("supplier_id must be a number")
		}
		supplierID := uint(supplierIDf)
		
		err := s.restRepo.ClearPurchaseList(supplierID)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{
			"status": "success",
			"message": fmt.Sprintf("Pedido aprobado para proveedor %d", supplierID),
		}, nil

	case "update_product_price":
		newPrice, _ := args["new_price"].(float64)
		name, _ := args["product_name"].(string)
		
		prod, err := s.prodRepo.GetByName(name)
		if err != nil || prod == nil {
			return nil, fmt.Errorf("producto no encontrado")
		}
		
		oldPrice := prod.SalePrice
		prod.SalePrice = newPrice
		err = s.prodRepo.Update(prod.Barcode, prod)
		
		log.Printf("TELEGRAM_AUDIT: Changed price of %s from %v to %v", prod.ProductName, oldPrice, newPrice)
		
		return map[string]interface{}{
			"status": "success",
			"product": prod.ProductName,
			"new_price": newPrice,
		}, err

	case "register_expense":
		amount, _ := args["amount"].(float64)
		concept, _ := args["concept"].(string)
		cat, _ := args["category"].(string)
		
		expense := &models.Expense{
			Amount: amount,
			Description: concept,
			Category: cat,
			Date: now,
			CreatedByDNI: "TELEGRAM_BOT",
			Status: "PAID",
		}
		
		err := s.expRepo.Save(expense)
		return map[string]interface{}{
			"status": "success",
			"expense_id": expense.ID,
		}, err

	case "get_top_products":
		from, to := parseDateRange(args["period"].(string), loc)
		limit := 10
		if l, ok := args["limit"].(float64); ok {
			limit = int(l)
		}
		top, err := s.saleRepo.GetTopSellingProducts(from, to, limit)
		if err != nil {
			return nil, err
		}
		
		return map[string]interface{}{
			"top": top,
		}, nil

	case "get_cash_summary":
		from, to := parseDateRange("today", loc)
		sales, _ := s.saleRepo.GetTotalSalesByRange(from, to)
		expenses, _ := s.expRepo.GetPaidAmountByRange(from, to)
		
		return map[string]interface{}{
			"sales": sales,
			"expenses": expenses,
			"net": sales - expenses,
		}, nil

	case "query_database":
		sql, _ := args["sql"].(string)
		description, _ := args["description"].(string)

		// Seguridad — solo permitir SELECT
		sqlUpper := strings.ToUpper(strings.TrimSpace(sql))
		if !strings.HasPrefix(sqlUpper, "SELECT") {
			return map[string]interface{}{
				"error": "Solo se permiten consultas SELECT",
			}, nil
		}

		// Bloquear palabras peligrosas
		forbidden := []string{"DROP", "DELETE", "UPDATE", "INSERT", "TRUNCATE", "ALTER", "CREATE"}
		for _, word := range forbidden {
			if strings.Contains(sqlUpper, word) {
				return map[string]interface{}{
					"error": "Consulta no permitida por seguridad",
				}, nil
			}
		}

		log.Printf("🤖 Bot DB Query: %s — %s", description, sql)

		// Ejecutar query
		rows, err := s.db.Raw(sql).Rows()
		if err != nil {
			return map[string]interface{}{
				"error": "Error en consulta: " + err.Error(),
			}, nil
		}
		defer rows.Close()

		// Obtener columnas
		columns, _ := rows.Columns()

		// Leer resultados
		var results []map[string]interface{}
		for rows.Next() {
			values := make([]interface{}, len(columns))
			valuePtrs := make([]interface{}, len(columns))
			for i := range values {
				valuePtrs[i] = &values[i]
			}
			rows.Scan(valuePtrs...)

			row := make(map[string]interface{})
			for i, col := range columns {
				val := values[i]
				// Convertir []byte a string para legibilidad
				if b, ok := val.([]byte); ok {
					row[col] = string(b)
				} else {
					row[col] = val
				}
			}
			results = append(results, row)
		}

		// Limitar a 50 filas para no saturar el contexto
		if len(results) > 50 {
			results = results[:50]
			return map[string]interface{}{
				"data":    results,
				"warning": "Resultado limitado a 50 filas",
				"total":   len(results),
			}, nil
		}

		return map[string]interface{}{
			"data":  results,
			"total": len(results),
		}, nil
	}

	if name == "get_today_suppliers" {
		// Resolver el día objetivo: argumento explícito o el actual de Bogotá
		targetDay := ""
		if d, ok := args["day_of_week"].(string); ok && d != "" {
			targetDay = d
		} else {
			targetDay = spanishWeekdays[now.Weekday()]
		}

		// Normalizar para comparación case-insensitive
		targetDayLower := strings.ToLower(targetDay)

		// Listar proveedores cuyo visit_day o visit_days incluye el día objetivo.
		// Soporta tanto el campo legacy `visitDay` (string) como el nuevo
		// `visit_days` (jsonb array). En PostgreSQL `?` es operador JSONB
		// "contiene clave"; lo evitamos usando texto y LIKE para compatibilidad.
		type supRow struct {
			ID         uint
			Name       string
			Phone      string
			VendorName string
			VisitDay   string
			VisitDays  string // jsonb serializado como texto
		}
		var sups []supRow
		err := s.db.Raw(`
			SELECT id, name, COALESCE(phone, '') AS phone,
			       COALESCE("vendorName", '') AS vendor_name,
			       COALESCE("visitDay", '') AS visit_day,
			       COALESCE(visit_days::text, '[]') AS visit_days
			FROM suppliers
			WHERE deleted_at IS NULL
			  AND COALESCE(is_active, true) = true
			  AND (
			        LOWER(COALESCE("visitDay", '')) LIKE ?
			     OR LOWER(COALESCE(visit_days::text, '')) LIKE ?
			      )
			ORDER BY name ASC
		`, "%"+targetDayLower+"%", "%"+targetDayLower+"%").Scan(&sups).Error
		if err != nil {
			return nil, fmt.Errorf("query suppliers: %w", err)
		}

		// Para cada proveedor, traer productos críticos (cantidad <= minStock).
		type critProduct struct {
			Barcode     string  `json:"barcode"`
			ProductName string  `json:"productName"`
			Quantity    float64 `json:"quantity"`
			MinStock    float64 `json:"minStock"`
			SalePrice   float64 `json:"salePrice"`
		}
		type supplierResult struct {
			ID            uint          `json:"id"`
			Name          string        `json:"name"`
			Phone         string        `json:"phone"`
			VendorName    string        `json:"vendorName,omitempty"`
			VisitDay      string        `json:"visitDay,omitempty"`
			Critical      []critProduct `json:"critical"`
			CriticalCount int           `json:"criticalCount"`
		}

		results := make([]supplierResult, 0, len(sups))
		for _, sp := range sups {
			var crit []critProduct
			_ = s.db.Raw(`
				SELECT barcode,
				       "productName" AS product_name,
				       COALESCE(quantity, 0) AS quantity,
				       COALESCE("minStock", 0) AS min_stock,
				       COALESCE("salePrice", 0) AS sale_price
				FROM products
				WHERE deleted_at IS NULL
				  AND COALESCE("isActive", true) = true
				  AND "supplierId" = ?
				  AND COALESCE(quantity, 0) <= COALESCE("minStock", 0)
				ORDER BY (COALESCE("minStock", 0) - COALESCE(quantity, 0)) DESC
				LIMIT 50
			`, sp.ID).Scan(&crit).Error

			results = append(results, supplierResult{
				ID:            sp.ID,
				Name:          sp.Name,
				Phone:         sp.Phone,
				VendorName:    sp.VendorName,
				VisitDay:      sp.VisitDay,
				Critical:      crit,
				CriticalCount: len(crit),
			})
		}

		return map[string]interface{}{
			"day":             targetDay,
			"date":            now.Format("2006-01-02"),
			"supplierCount":   len(results),
			"suppliers":       results,
			"totalCriticalItems": func() int {
				total := 0
				for _, r := range results {
					total += r.CriticalCount
				}
				return total
			}(),
		}, nil
	}

	return nil, fmt.Errorf("función desconocida: %s", name)
}

// ============================================================
// parseDateRange — Date Helper (unchanged)
// ============================================================

func parseDateRange(period string, loc *time.Location) (time.Time, time.Time) {
	now := time.Now().In(loc)
	var from, to time.Time
	
	switch period {
	case "today":
		from = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
		to = from.Add(24 * time.Hour)
	case "yesterday":
		to = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
		from = to.Add(-24 * time.Hour)
	case "week":
		from = now.AddDate(0, 0, -7)
		to = now
	case "month":
		from = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, loc)
		to = now
	}
	
	return from, to
}

func formatCOP(amount float64) string {
	s := fmt.Sprintf("%.0f", amount)
	var parts []string
	for i := len(s); i > 0; i -= 3 {
		start := i - 3
		if start < 0 {
			start = 0
		}
		parts = append([]string{s[start:i]}, parts...)
	}
	return strings.Join(parts, ".")
}

func (s *AIBotService) generatePDF(reportType, period string) ([]byte, string, error) {
	pdf := gofpdf.New("P", "mm", "A4", "")
	pdf.AddPage()
	pdf.SetFont("Arial", "B", 16)
	
	today := time.Now().Format("02/01/2006")
	
	switch reportType {
	case "ventas":
		pdf.Cell(0, 10, "REPORTE DE VENTAS - Surtifamiliar")
		pdf.Ln(8)
		pdf.SetFont("Arial", "", 10)
		pdf.Cell(0, 6, fmt.Sprintf("Fecha: %s | Período: %s", today, period))
		pdf.Ln(10)
		
		var sales []struct {
			Hour   string  `json:"hour"`
			Count  int     `json:"count"`
			Total  float64 `json:"total"`
			Method string  `json:"method"`
		}
		s.db.Raw(`
			SELECT 
				TO_CHAR(created_at, 'HH12:MI AM') as hour,
				COUNT(*) as count,
				SUM(total_amount) as total,
				payment_method as method
			FROM sales
			WHERE DATE(created_at) = CURRENT_DATE
			GROUP BY TO_CHAR(created_at, 'HH12:MI AM'), payment_method
			ORDER BY hour
		`).Scan(&sales)
		
		pdf.SetFont("Arial", "B", 10)
		pdf.SetFillColor(240, 240, 240)
		pdf.CellFormat(40, 8, "Hora", "1", 0, "C", true, 0, "")
		pdf.CellFormat(50, 8, "Metodo", "1", 0, "C", true, 0, "")
		pdf.CellFormat(40, 8, "Transacciones", "1", 0, "C", true, 0, "")
		pdf.CellFormat(50, 8, "Total", "1", 0, "C", true, 0, "")
		pdf.Ln(-1)
		
		pdf.SetFont("Arial", "", 9)
		var grandTotal float64
		for _, saleRow := range sales {
			pdf.CellFormat(40, 7, saleRow.Hour, "1", 0, "C", false, 0, "")
			pdf.CellFormat(50, 7, saleRow.Method, "1", 0, "C", false, 0, "")
			pdf.CellFormat(40, 7, fmt.Sprintf("%d", saleRow.Count), "1", 0, "C", false, 0, "")
			pdf.CellFormat(50, 7, fmt.Sprintf("$%s", formatCOP(saleRow.Total)), "1", 0, "R", false, 0, "")
			pdf.Ln(-1)
			grandTotal += saleRow.Total
		}
		
		pdf.SetFont("Arial", "B", 10)
		pdf.CellFormat(130, 8, "TOTAL", "1", 0, "R", true, 0, "")
		pdf.CellFormat(50, 8, fmt.Sprintf("$%s", formatCOP(grandTotal)), "1", 0, "R", true, 0, "")
		
	case "cuentas_cobrar":
		pdf.Cell(0, 10, "CUENTAS POR COBRAR - Surtifamiliar")
		pdf.Ln(8)
		pdf.SetFont("Arial", "", 10)
		pdf.Cell(0, 6, fmt.Sprintf("Generado: %s", today))
		pdf.Ln(10)
		
		var clients []struct {
			Name    string  `json:"name"`
			Phone   string  `json:"phone"`
			Balance float64 `json:"balance"`
			Days    int     `json:"days"`
		}
		s.db.Raw(`
			SELECT 
				c.name,
				c.phone,
				SUM(CASE WHEN s.payment_method = 'FIADO' THEN s.total_amount ELSE 0 END) -
				COALESCE((SELECT SUM(amount) FROM client_payments WHERE client_id = c.id), 0) as balance,
				EXTRACT(DAY FROM NOW() - MAX(s.created_at))::int as days
			FROM clients c
			JOIN sales s ON s.client_id = c.id
			WHERE s.payment_method = 'FIADO'
			GROUP BY c.id, c.name, c.phone
			HAVING SUM(CASE WHEN s.payment_method = 'FIADO' THEN s.total_amount ELSE 0 END) -
				   COALESCE((SELECT SUM(amount) FROM client_payments WHERE client_id = c.id), 0) > 0
			ORDER BY balance DESC
		`).Scan(&clients)
		
		pdf.SetFont("Arial", "B", 10)
		pdf.SetFillColor(240, 240, 240)
		pdf.CellFormat(70, 8, "Cliente", "1", 0, "L", true, 0, "")
		pdf.CellFormat(50, 8, "Telefono", "1", 0, "C", true, 0, "")
		pdf.CellFormat(40, 8, "Dias", "1", 0, "C", true, 0, "")
		pdf.CellFormat(30, 8, "Saldo", "1", 0, "R", true, 0, "")
		pdf.Ln(-1)
		
		pdf.SetFont("Arial", "", 9)
		var totalDeuda float64
		for _, c := range clients {
			pdf.CellFormat(70, 7, c.Name, "1", 0, "L", false, 0, "")
			pdf.CellFormat(50, 7, c.Phone, "1", 0, "C", false, 0, "")
			pdf.CellFormat(40, 7, fmt.Sprintf("%d dias", c.Days), "1", 0, "C", false, 0, "")
			pdf.CellFormat(30, 7, fmt.Sprintf("$%s", formatCOP(c.Balance)), "1", 0, "R", false, 0, "")
			pdf.Ln(-1)
			totalDeuda += c.Balance
		}
		
		pdf.SetFont("Arial", "B", 10)
		pdf.CellFormat(160, 8, "TOTAL POR COBRAR", "1", 0, "R", true, 0, "")
		pdf.CellFormat(30, 8, fmt.Sprintf("$%s", formatCOP(totalDeuda)), "1", 0, "R", true, 0, "")
		
	case "cierre_dia":
		pdf.Cell(0, 10, fmt.Sprintf("CIERRE DEL DIA - %s", today))
	}
	
	filename := fmt.Sprintf("reporte_%s_%s.pdf", reportType, time.Now().Format("20060102"))
	
	var buf bytes.Buffer
	err := pdf.Output(&buf)
	return buf.Bytes(), filename, err
}

func (s *AIBotService) generateChart(chartType, period string) ([]byte, string, error) {
	var dateFilter string
	switch period {
	case "today":
		dateFilter = "DATE(created_at) = CURRENT_DATE"
	case "week":
		dateFilter = "created_at >= DATE_TRUNC('week', CURRENT_DATE)"
	case "month":
		dateFilter = "created_at >= DATE_TRUNC('month', CURRENT_DATE)"
	}
	
	switch chartType {
	case "ventas_por_hora":
		var data []struct {
			Hour  string  `json:"hour"`
			Total float64 `json:"total"`
		}
		s.db.Raw(fmt.Sprintf(`
			SELECT TO_CHAR(created_at, 'HH AM') as hour, SUM(total_amount) as total
			FROM sales WHERE %s
			GROUP BY TO_CHAR(created_at, 'HH AM')
			ORDER BY hour
		`, dateFilter)).Scan(&data)
		
		graph := chart.BarChart{
			Title:  "Ventas por hora - " + period,
			Width:  800,
			Height: 400,
			Bars:   make([]chart.Value, len(data)),
		}
		for i, d := range data {
			graph.Bars[i] = chart.Value{
				Label: d.Hour,
				Value: d.Total,
			}
		}
		
		var buf bytes.Buffer
		err := graph.Render(chart.PNG, &buf)
		return buf.Bytes(), fmt.Sprintf("ventas_hora_%s.png", period), err
		
	case "ventas_por_metodo":
		var data []struct {
			Method string  `json:"method"`
			Total  float64 `json:"total"`
		}
		s.db.Raw(fmt.Sprintf(`
			SELECT payment_method as method, SUM(total_amount) as total
			FROM sales WHERE %s
			GROUP BY payment_method ORDER BY total DESC
		`, dateFilter)).Scan(&data)
		
		values := make([]chart.Value, len(data))
		for i, d := range data {
			values[i] = chart.Value{Label: d.Method, Value: d.Total}
		}
		
		pie := chart.PieChart{
			Title:  "Ventas por metodo de pago",
			Width:  600,
			Height: 400,
			Values: values,
		}
		
		var buf bytes.Buffer
		err := pie.Render(chart.PNG, &buf)
		return buf.Bytes(), "ventas_metodo.png", err
	}
	
	return nil, "", fmt.Errorf("tipo de grafica no soportado")
}

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

	req := s.buildRequest(state, true)

	resp, err := s.doClaudeRequest(req)
	if err != nil {
		return "", err
	}

	if resp.StopReason == "tool_use" {
		var toolBlocks []ClaudeBlock
		for _, block := range resp.Content {
			if block.Type == "tool_use" {
				toolBlocks = append(toolBlocks, block)
			}
		}

		state.ConversationHistory = append(state.ConversationHistory, ClaudeMessage{
			Role:    "assistant",
			Content: resp.Content,
		})

		var toolResults []map[string]interface{}
		for _, block := range toolBlocks {
			args, _ := block.Input.(map[string]interface{})
			result, err := s.executeFunction(chatID, block.Name, args)
			
			var resultJSON []byte
			if err != nil {
				resultJSON = []byte(`{"error":"` + err.Error() + `"}`)
			} else {
				resultJSON, _ = json.Marshal(result)
			}

			toolResults = append(toolResults, map[string]interface{}{
				"type":        "tool_result",
				"tool_use_id": block.ID,
				"content":     string(resultJSON),
			})
		}

		state.ConversationHistory = append(state.ConversationHistory, ClaudeMessage{
			Role:    "user",
			Content: toolResults,
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
	base := `Analiza esta imagen. 

Si es una FACTURA DE PROVEEDOR:
1. Lee todos los productos, cantidades y precios
2. Muéstrame la lista completa en formato claro
3. Pregúntame qué quiero hacer: ¿ingresar a Carga Maestra, actualizar precios, o las dos cosas?
4. Espera mi respuesta antes de ejecutar cualquier acción

Si es una IMAGEN DE PRODUCTO (código de barras, producto):
- Identifica el producto si puedes
- Dime su stock actual y precio si está en el inventario

Si es otro tipo de imagen:
- Descríbela y pregunta cómo puedo ayudarte con ella`

	if caption != "" {
		base += fmt.Sprintf("\n\nContexto adicional del usuario: %s", caption)
	}

	return base
}

func (s *AIBotService) buildRequest(state *ConversationState, isImage bool) ClaudeRequest {
	maxTokens := 1024
	// Inyección dinámica de fecha/hora actual de Bogotá en cada request
	sysPrompt := buildSystemPrompt(false)
	model := "claude-haiku-4-5"

	if isImage {
		maxTokens = 4096 // Las facturas pueden tener muchos productos
		sysPrompt = buildSystemPrompt(true)
		model = "claude-sonnet-4-5"
	}
	// Si el último mensaje menciona reporte, detalle o desglose
	lastMsg := ""
	if len(state.ConversationHistory) > 0 {
		if content, ok := state.ConversationHistory[len(state.ConversationHistory)-1].Content.(string); ok {
			lastMsg = strings.ToLower(content)
		}
	}
	if strings.Contains(lastMsg, "reporte") ||
		strings.Contains(lastMsg, "detalle") ||
		strings.Contains(lastMsg, "desglose") ||
		strings.Contains(lastMsg, "todos") {
		maxTokens = 4096
	}

	return ClaudeRequest{
		Model:     model,
		MaxTokens: maxTokens,
		System:    sysPrompt,
		Messages:  state.ConversationHistory,
		Tools:     s.getClaudeTools(),
	}
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
