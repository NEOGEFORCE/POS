const fs = require('fs');

const file = 'c:/Users/jaide/OneDrive/Desktop/POS/backPOS-go/internal/core/services/ai_bot_service.go';
let content = fs.readFileSync(file, 'utf8');

// 1. Imports
if (!content.includes('github.com/jung-kurt/gofpdf')) {
    content = content.replace('"gorm.io/gorm"', '"net/url"\n\t"github.com/jung-kurt/gofpdf"\n\t"github.com/wcharczuk/go-chart/v2"\n\t"gorm.io/gorm"');
}

// 2. Add tools to getClaudeTools
const newTools = `		{
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
	}
}`;
if (!content.includes('"get_credit_clients"')) {
    content = content.replace(/\t\t\t\},\n\t\t\},\n\t\}\n\}/, '\t\t\t},\n\t\t},\n' + newTools);
}

// 3. Update signatures and calls to include chatID
content = content.replace(/executeDangerousAction\(state\.PendingAction, state\.PendingPayload\)/, 'executeDangerousAction(chatID, state.PendingAction, state.PendingPayload)');
content = content.replace(/executeFunction\("approve_restock_order", args\)/, 'executeFunction(chatID, "approve_restock_order", args)');
content = content.replace(/executeFunction\(toolBlock\.Name, args\)/, 'executeFunction(chatID, toolBlock.Name, args)');
content = content.replace(/func \(s \*AIBotService\) executeDangerousAction\(name string, args map\[string\]interface\{\}\) \(map\[string\]interface\{\}, error\) \{/, 'func (s *AIBotService) executeDangerousAction(chatID int64, name string, args map[string]interface{}) (map[string]interface{}, error) {');
content = content.replace(/return s\.executeFunction\(name, args\)/, 'return s.executeFunction(chatID, name, args)');
content = content.replace(/func \(s \*AIBotService\) executeFunction\(name string, args map\[string\]interface\{\}\) \(map\[string\]interface\{\}, error\) \{/, 'func (s *AIBotService) executeFunction(chatID int64, name string, args map[string]interface{}) (map[string]interface{}, error) {');

// 4. Add cases to executeFunction
const newCases = `	case "get_credit_clients":
		clientName, _ := args["client_name"].(string)
		
		nameFilter := ""
		if clientName != "" {
			nameFilter = fmt.Sprintf("AND UPPER(c.name) LIKE UPPER('%%%s%%')", clientName)
		}
		
		var clients []struct {
			ID          int     \`json:"id"\`
			Name        string  \`json:"name"\`
			Phone       string  \`json:"phone"\`
			TotalDebt   float64 \`json:"totalDebt"\`
			TotalPaid   float64 \`json:"totalPaid"\`
			Balance     float64 \`json:"balance"\`
			LastPurchase string  \`json:"lastPurchase"\`
			DaysSince   int     \`json:"daysSince"\`
		}
		
		s.db.Raw(fmt.Sprintf(\`
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
		\`, nameFilter)).Scan(&clients)
		
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
			ID    int    \`json:"id"\`
			Name  string \`json:"name"\`
			Phone string \`json:"phone"\`
		}
		s.db.Raw(fmt.Sprintf(\`SELECT id, name, phone FROM clients %s LIMIT 1\`, filter)).Scan(&client)
		
		var purchases []struct {
			Date   string  \`json:"date"\`
			Total  float64 \`json:"total"\`
			Items  string  \`json:"items"\`
		}
		s.db.Raw(\`
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
		\`, client.ID).Scan(&purchases)
		
		var payments []struct {
			Date   string  \`json:"date"\`
			Amount float64 \`json:"amount"\`
			Method string  \`json:"method"\`
		}
		s.db.Raw(\`
			SELECT 
				created_at::date::text as date,
				amount,
				payment_method as method
			FROM client_payments
			WHERE client_id = ?
			ORDER BY created_at DESC
		\`, client.ID).Scan(&payments)
		
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

`;

if (!content.includes('"get_credit_clients":')) {
    content = content.replace(/switch name \{\n\tcase "get_sales_report":/, 'switch name {\n' + newCases + '\tcase "get_sales_report":');
}

// 5. Add generatePDF, generateChart and formatCOP functions
const newFuncs = `
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
			Hour   string  \`json:"hour"\`
			Count  int     \`json:"count"\`
			Total  float64 \`json:"total"\`
			Method string  \`json:"method"\`
		}
		s.db.Raw(\`
			SELECT 
				TO_CHAR(created_at, 'HH12:MI AM') as hour,
				COUNT(*) as count,
				SUM(total_amount) as total,
				payment_method as method
			FROM sales
			WHERE DATE(created_at) = CURRENT_DATE
			GROUP BY TO_CHAR(created_at, 'HH12:MI AM'), payment_method
			ORDER BY hour
		\`).Scan(&sales)
		
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
			Name    string  \`json:"name"\`
			Phone   string  \`json:"phone"\`
			Balance float64 \`json:"balance"\`
			Days    int     \`json:"days"\`
		}
		s.db.Raw(\`
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
		\`).Scan(&clients)
		
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
			Hour  string  \`json:"hour"\`
			Total float64 \`json:"total"\`
		}
		s.db.Raw(fmt.Sprintf(\`
			SELECT TO_CHAR(created_at, 'HH AM') as hour, SUM(total_amount) as total
			FROM sales WHERE %s
			GROUP BY TO_CHAR(created_at, 'HH AM')
			ORDER BY hour
		\`, dateFilter)).Scan(&data)
		
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
			Method string  \`json:"method"\`
			Total  float64 \`json:"total"\`
		}
		s.db.Raw(fmt.Sprintf(\`
			SELECT payment_method as method, SUM(total_amount) as total
			FROM sales WHERE %s
			GROUP BY payment_method ORDER BY total DESC
		\`, dateFilter)).Scan(&data)
		
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
`;

if (!content.includes('func formatCOP(')) {
    content += newFuncs;
}

fs.writeFileSync(file, content);

// Add SendPhoto to telegram_service.go
const tgFile = 'c:/Users/jaide/OneDrive/Desktop/POS/backPOS-go/internal/core/services/telegram_service.go';
let tgContent = fs.readFileSync(tgFile, 'utf8');

const sendPhotoFunc = `
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
`;

if (!tgContent.includes('func (s *TelegramService) SendPhoto(')) {
    tgContent = tgContent.replace('// StartListener', sendPhotoFunc + '\n// StartListener');
    fs.writeFileSync(tgFile, tgContent);
}

console.log('Update complete.');
