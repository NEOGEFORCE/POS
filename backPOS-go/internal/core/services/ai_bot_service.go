package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"bytes"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type AIBotService struct {
	saleRepo ports.SaleRepository
	prodRepo ports.ProductRepository
	expRepo  ports.ExpenseRepository
	restRepo ports.RestockRepository
	telegram *TelegramService
	http     *http.Client

	stateMap map[int64]*ConversationState
	mu       sync.Mutex
}

type ConversationState struct {
	PendingAction       string
	PendingPayload      map[string]interface{}
	LastMessageAt       time.Time
	ConversationHistory []GeminiContent
}

// Gemini Types
type GeminiRequest struct {
	SystemInstruction *GeminiContent  `json:"system_instruction,omitempty"`
	Contents          []GeminiContent `json:"contents"`
	Tools             []GeminiTool    `json:"tools,omitempty"`
}

type GeminiContent struct {
	Parts []GeminiPart `json:"parts"`
	Role  string       `json:"role,omitempty"`
}

type GeminiPart struct {
	Text             string            `json:"text,omitempty"`
	FunctionCall     *FunctionCall     `json:"functionCall,omitempty"`
	FunctionResponse *FunctionResponse `json:"functionResponse,omitempty"`
}

type GeminiTool struct {
	FunctionDeclarations []FunctionDeclaration `json:"function_declarations"`
}

type FunctionDeclaration struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Parameters  interface{} `json:"parameters"`
}

type FunctionCall struct {
	Name string                 `json:"name"`
	Args map[string]interface{} `json:"args"`
}

type FunctionResponse struct {
	Name     string      `json:"name"`
	Response interface{} `json:"response"`
}

func NewAIBotService(sale ports.SaleRepository, prod ports.ProductRepository, exp ports.ExpenseRepository, rest ports.RestockRepository, telegram *TelegramService) *AIBotService {
	return &AIBotService{
		saleRepo: sale,
		prodRepo: prod,
		expRepo:  exp,
		restRepo: rest,
		telegram: telegram,
		http:     &http.Client{Timeout: 30 * time.Second},
		stateMap: make(map[int64]*ConversationState),
	}
}

func (s *AIBotService) getOrCreateState(chatID int64) *ConversationState {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, exists := s.stateMap[chatID]
	if !exists || time.Since(state.LastMessageAt) > 30*time.Minute {
		state = &ConversationState{
			ConversationHistory: make([]GeminiContent, 0),
		}
		s.stateMap[chatID] = state
	}
	state.LastMessageAt = time.Now()
	return state
}

const systemPrompt = `Eres el asistente personal de Sebastian, dueño de Surtifamiliar, un supermercado de barrio en Colombia. Tienes acceso a todas las herramientas del POS para consultarle información de su negocio en tiempo real.

Reglas de comportamiento:
- Responde siempre en español, de forma directa y concisa
- Usa el formato de Telegram (negritas con *texto*, no con HTML)
- Los montos siempre en pesos colombianos con puntos de miles: $1.250.000
- Cuando el usuario pida cambiar un precio o registrar un egreso, SIEMPRE confirma primero antes de ejecutar: "¿Confirmas que quieres cambiar el precio de X a $Y?"
- Si el usuario responde "sí", "dale", "confirma", "ok" a una confirmación pendiente, ejecuta la acción
- Para reportes, sé directo: da el número importante primero, luego el detalle
- Si no entiendes la solicitud, pide clarificación de forma amable
- Nunca inventes datos — si la herramienta no devuelve resultados, dilo claramente
- El negocio está en Colombia, usa horario de Bogotá`

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
			result, err := s.executeDangerousAction(state.PendingAction, state.PendingPayload)
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

		resp, err := s.callGemini(chatID, text)
		if err != nil {
			s.telegram.SendMarkdownAlert("❌ Error conectando con Gemini: " + err.Error())
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
					// Llama a approve_restock_order directamente
					args := map[string]interface{}{"supplier_id": float64(supplierID), "supplier_name": "Proveedor"}
					res, err := s.executeFunction("approve_restock_order", args)
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

func (s *AIBotService) callGemini(chatID int64, userMessage string) (string, error) {
	state := s.getOrCreateState(chatID)

	state.ConversationHistory = append(state.ConversationHistory, GeminiContent{
		Role:  "user",
		Parts: []GeminiPart{{Text: userMessage}},
	})

	req := GeminiRequest{
		SystemInstruction: &GeminiContent{
			Parts: []GeminiPart{{Text: systemPrompt}},
		},
		Contents: state.ConversationHistory,
		Tools: []GeminiTool{{
			FunctionDeclarations: s.getFunctionDeclarations(),
		}},
	}

	resp, err := s.doGeminiRequest(req)
	if err != nil {
		return "", err
	}

	if resp.hasFunctionCall() {
		fnCall := resp.getFunctionCall()

		if fnCall.Name == "update_product_price" || fnCall.Name == "register_expense" {
			state.PendingAction = fnCall.Name
			state.PendingPayload = fnCall.Args
			
			// Preguntar confirmacion
			respText := "¿Confirmas que deseas ejecutar esta acción de modificación?"
			if fnCall.Name == "update_product_price" {
				respText = fmt.Sprintf("¿Confirmas que quieres cambiar el precio de %v a $%v?", fnCall.Args["product_name"], fnCall.Args["new_price"])
			} else if fnCall.Name == "register_expense" {
				respText = fmt.Sprintf("¿Confirmas que quieres registrar un egreso de $%v por concepto de '%v'?", fnCall.Args["amount"], fnCall.Args["concept"])
			}
			return respText, nil
		}

		result, err := s.executeFunction(fnCall.Name, fnCall.Args)
		if err != nil {
			result = map[string]interface{}{"error": err.Error()}
		}

		state.ConversationHistory = append(state.ConversationHistory,
			GeminiContent{
				Role:  "model",
				Parts: []GeminiPart{{FunctionCall: fnCall}},
			},
			GeminiContent{
				Role: "user",
				Parts: []GeminiPart{{FunctionResponse: &FunctionResponse{
					Name:     fnCall.Name,
					Response: result,
				}}},
			},
		)

		req.Contents = state.ConversationHistory
		resp, err = s.doGeminiRequest(req)
		if err != nil {
			return "", err
		}
	}

	finalText := resp.getText()
	
	state.ConversationHistory = append(state.ConversationHistory, GeminiContent{
		Role:  "model",
		Parts: []GeminiPart{{Text: finalText}},
	})

	if len(state.ConversationHistory) > 20 {
		state.ConversationHistory = state.ConversationHistory[len(state.ConversationHistory)-20:]
	}

	return finalText, nil
}

type GeminiAPIResponse struct {
	Candidates []struct {
		Content GeminiContent `json:"content"`
	} `json:"candidates"`
}

func (r *GeminiAPIResponse) hasFunctionCall() bool {
	if len(r.Candidates) > 0 && len(r.Candidates[0].Content.Parts) > 0 {
		return r.Candidates[0].Content.Parts[0].FunctionCall != nil
	}
	return false
}

func (r *GeminiAPIResponse) getFunctionCall() *FunctionCall {
	if len(r.Candidates) > 0 && len(r.Candidates[0].Content.Parts) > 0 {
		return r.Candidates[0].Content.Parts[0].FunctionCall
	}
	return nil
}

func (r *GeminiAPIResponse) getText() string {
	if len(r.Candidates) > 0 && len(r.Candidates[0].Content.Parts) > 0 {
		return r.Candidates[0].Content.Parts[0].Text
	}
	return ""
}

func (s *AIBotService) doGeminiRequest(req GeminiRequest) (*GeminiAPIResponse, error) {
	key := os.Getenv("GEMINI_API_KEY")
	if key == "" {
		return nil, fmt.Errorf("GEMINI_API_KEY no configurado")
	}

	url := "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + key
	jsonData, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := s.http.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := ioutil.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("gemini api error %d: %s", resp.StatusCode, string(body))
	}

	var apiResp GeminiAPIResponse
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return nil, err
	}

	return &apiResp, nil
}

func (s *AIBotService) executeDangerousAction(name string, args map[string]interface{}) (map[string]interface{}, error) {
	// Execute the action directly since it's confirmed
	return s.executeFunction(name, args)
}

func (s *AIBotService) getFunctionDeclarations() []FunctionDeclaration {
	return []FunctionDeclaration{
		{
			Name:        "get_sales_report",
			Description: "Obtiene reporte de ventas. Puede ser de hoy, ayer, esta semana, este mes o un rango de fechas específico.",
			Parameters: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"period":    map[string]interface{}{"type": "string", "enum": []string{"today", "yesterday", "week", "month", "custom"}},
					"date_from": map[string]interface{}{"type": "string"},
					"date_to":   map[string]interface{}{"type": "string"},
				},
				"required": []string{"period"},
			},
		},
		{
			Name:        "get_stock_status",
			Description: "Consulta el estado del inventario. Puede filtrar por producto específico, mostrar solo críticos o todos.",
			Parameters: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"filter":       map[string]interface{}{"type": "string", "enum": []string{"all", "critical", "warning", "product"}},
					"product_name": map[string]interface{}{"type": "string"},
				},
				"required": []string{"filter"},
			},
		},
		{
			Name:        "get_expenses_report",
			Description: "Obtiene reporte de egresos con detalle por categoría.",
			Parameters: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"period":   map[string]interface{}{"type": "string", "enum": []string{"today", "yesterday", "week", "month"}},
					"category": map[string]interface{}{"type": "string"},
				},
				"required": []string{"period"},
			},
		},
		{
			Name:        "get_restock_suggestions",
			Description: "Obtiene los productos que necesitan pedirse según el Smart Restock.",
			Parameters: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"supplier_name": map[string]interface{}{"type": "string"},
					"only_critical": map[string]interface{}{"type": "boolean"},
				},
			},
		},
		{
			Name:        "approve_restock_order",
			Description: "Aprueba y confirma un pedido de restock para un proveedor específico.",
			Parameters: map[string]interface{}{
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
			Description: "Actualiza el precio de venta (PVP) de un producto.",
			Parameters: map[string]interface{}{
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
			Description: "Registra un egreso rápido en el sistema. Requiere concepto, monto y categoría.",
			Parameters: map[string]interface{}{
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
			Parameters: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"period": map[string]interface{}{"type": "string", "enum": []string{"today", "week", "month"}},
					"limit":  map[string]interface{}{"type": "integer"},
				},
				"required": []string{"period"},
			},
		},
		{
			Name:        "get_cash_summary",
			Description: "Obtiene el resumen de caja del día: ventas, egresos, devoluciones y saldo neto.",
			Parameters: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"date": map[string]interface{}{"type": "string"},
				},
			},
		},
	}
}

func (s *AIBotService) executeFunction(name string, args map[string]interface{}) (map[string]interface{}, error) {
	loc, _ := time.LoadLocation("America/Bogota")
	now := time.Now().In(loc)

	switch name {
	case "get_sales_report":
		from, to := parseDateRange(args["period"].(string), loc)
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
		// We'll mock the smart restock here by grabbing low stock items for simplicity
		prods, _ := s.prodRepo.GetAllWithLowStock()
		
		var report []map[string]interface{}
		limit := 10
		for i, p := range prods {
			if i >= limit {
				break
			}
			report = append(report, map[string]interface{}{
				"name": p.ProductName,
				"suggested_qty": 20, // dummy suggestion
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
		
		// Auditoría
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
	}

	return nil, fmt.Errorf("función desconocida: %s", name)
}

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
