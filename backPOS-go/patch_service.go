package main

import (
	"fmt"
	"io/ioutil"
	"strings"
)

func main() {
	filePath := "internal/core/services/product_service.go"
	contentBytes, err := ioutil.ReadFile(filePath)
	if err != nil {
		fmt.Println("Error reading:", err)
		return
	}

	content := string(contentBytes)

	if !strings.Contains(content, "\"bytes\"") {
		content = strings.Replace(content, "\"fmt\"", "\"bytes\"\n\t\"encoding/json\"\n\t\"fmt\"\n\t\"net/http\"\n\t\"os\"", 1)
	}

	appendCode := `

// --- AI Invoice Reader Logic ---

func (s *ProductService) ScanInvoice(imageBase64, mimeType, supplierName string, supplierID uint) (*models.ScanInvoiceResult, error) {
	aliases, err := s.repo.GetSupplierAliases(supplierID)
	if err != nil {
		aliases = make(map[string]models.SupplierProductAlias)
	}

	params, _ := s.repo.GetSupplierInvoiceParams(supplierID)

	extractedItems, err := s.callGeminiVision(imageBase64, mimeType, supplierName, params)
	if err != nil {
		return nil, err
	}

	result := &models.ScanInvoiceResult{}

	for _, extracted := range extractedItems {
		if extracted.Quantity <= 0 {
			continue
		}

		if alias, ok := aliases[strings.ToUpper(extracted.Name)]; ok {
			product, _ := s.repo.GetByBarcode(alias.ProductBarcode)
			if product != nil {
				item := s.calculateItemDetails(product, extracted, params, "alias", 1.0)
				result.ScannedItems = append(result.ScannedItems, item)
				continue
			}
		}

		result.Unmatched = append(result.Unmatched, models.UnmatchedItem{
			InvoiceName: extracted.Name,
			Quantity:    extracted.Quantity,
			UnitPrice:   extracted.UnitPrice,
		})
	}

	return result, nil
}

func (s *ProductService) calculateItemDetails(product *models.Product, extracted models.ExtractedItem, params *models.SupplierInvoiceParams, matchType string, confidence float64) models.ScannedItem {
	unitPrice := extracted.UnitPrice
	if unitPrice == 0 && extracted.Quantity > 0 && extracted.TotalPrice > 0 {
		unitPrice = extracted.TotalPrice / extracted.Quantity
	}

	if params != nil && params.PriceIncludesIVA && product.Iva > 0 {
		unitPrice = unitPrice / (1 + product.Iva/100)
	}
	if params != nil && params.PriceIncludesICUI && product.Icui > 0 {
		unitPrice = unitPrice / (1 + product.Icui/100)
	}
	if params != nil && params.PriceIncludesIBUA && product.Ibua > 0 {
		unitPrice = unitPrice / (1 + product.Ibua/100)
	}

	costoReal := unitPrice
	costoReal *= (1 + product.Iva/100)
	costoReal *= (1 + product.Icui/100)
	costoReal *= (1 + product.Ibua/100)

	var margin float64
	var marginSource string

	if product.MarginPercentage > 0 {
		margin = product.MarginPercentage
		marginSource = "producto"
	} else if product.CategoryID > 0 && product.Category.MarginPercentage > 0 {
		margin = product.Category.MarginPercentage
		marginSource = "categoria"
	} else {
		margin = 20.0
		marginSource = "global"
	}

	pvpSugerido := costoReal * (1 + margin/100)
	pvpSugerido = applyRounding(pvpSugerido)

	return models.ScannedItem{
		Barcode:      product.Barcode,
		ProductName:  product.ProductName,
		InvoiceName:  extracted.Name,
		Quantity:     extracted.Quantity,
		CostUnit:     math.Round(unitPrice*100) / 100,
		CostoReal:    math.Round(costoReal*100) / 100,
		PVPActual:    product.SalePrice,
		PVPSugerido:  pvpSugerido,
		MarginUsed:   margin,
		MarginSource: marginSource,
		IVA:          product.Iva,
		ICUI:         product.Icui,
		IBUA:         product.Ibua,
		CurrentStock: product.Quantity,
		CurrentWAC:   product.PurchasePrice,
		Confidence:   confidence,
		MatchType:    matchType,
	}
}

func buildInvoicePrompt(supplierName string, params *models.SupplierInvoiceParams) string {
	prompt := fmt.Sprintf("\x60Analiza esta factura del proveedor \"%s\".\n" +
		"Extrae TODOS los productos con sus cantidades y precios.\n" +
		"Responde ÚNICAMENTE con JSON válido, sin texto adicional en el siguiente formato:\n" +
		"[\n" +
		"  {\n" +
		"    \"name\": \"nombre exacto del producto como aparece en la factura\",\n" +
		"    \"quantity\": número,\n" +
		"    \"unitPrice\": número,\n" +
		"    \"totalPrice\": número\n" +
		"  }\n" +
		"]\n" +
		"Reglas estrictas:\n" +
		"- Si solo aparece precio total de línea, divide entre cantidad para obtener unitario\n" +
		"- Ignora filas de subtotal, total, descuentos globales, encabezados y pie de página\n" +
		"- Si una cantidad dice \"1 PAC x 6 UND\", pon quantity: 6\n" +
		"- Precios como números puros sin símbolos ni puntos de miles\n" +
		"- Si un valor no es legible, pon 0\n" +
		"- NO incluyas productos con cantidad 0\x60", supplierName)

	if params != nil && params.Notes != "" {
		prompt += "\nInstrucción especial para este proveedor: " + params.Notes
	}
	return prompt
}

func (s *ProductService) callGeminiVision(imageBase64, mimeType, supplierName string, params *models.SupplierInvoiceParams) ([]models.ExtractedItem, error) {
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("GEMINI_API_KEY no configurado")
	}

	url := "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + apiKey

	prompt := buildInvoicePrompt(supplierName, params)

	if idx := strings.Index(imageBase64, ","); idx != -1 {
		imageBase64 = imageBase64[idx+1:]
	}

	reqBody := map[string]interface{}{
		"contents": []map[string]interface{}{
			{
				"parts": []map[string]interface{}{
					{
						"text": prompt,
					},
					{
						"inline_data": map[string]interface{}{
							"mime_type": mimeType,
							"data":      imageBase64,
						},
					},
				},
			},
		},
		"generationConfig": map[string]interface{}{
			"temperature": 0.0,
			"response_mime_type": "application/json",
		},
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	resp, err := http.Post(url, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&errResp)
		return nil, fmt.Errorf("gemini API error (%%d): %%v", resp.StatusCode, errResp)
	}

	var geminiResp struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string \x60json:"text"\x60
				} \x60json:"parts"\x60
			} \x60json:"content"\x60
		} \x60json:"candidates"\x60
	}

	if err := json.NewDecoder(resp.Body).Decode(&geminiResp); err != nil {
		return nil, err
	}

	if len(geminiResp.Candidates) == 0 || len(geminiResp.Candidates[0].Content.Parts) == 0 {
		return nil, fmt.Errorf("gemini devolvió respuesta vacía")
	}

	text := geminiResp.Candidates[0].Content.Parts[0].Text

	text = strings.TrimPrefix(text, "\x60\x60\x60json")
	text = strings.TrimPrefix(text, "\x60\x60\x60")
	text = strings.TrimSuffix(text, "\x60\x60\x60")
	text = strings.TrimSpace(text)

	var items []models.ExtractedItem
	if err := json.Unmarshal([]byte(text), &items); err != nil {
		return nil, fmt.Errorf("error parseando JSON de Gemini: %%v. Raw Text: %%s", err, text)
	}

	return items, nil
}
`

	if !strings.Contains(content, "ScanInvoice(imageBase64") {
		content += appendCode
	}

	err = ioutil.WriteFile(filePath, []byte(content), 0644)
	if err != nil {
		fmt.Println("Error writing:", err)
		return
	}
	fmt.Println("Patch applied successfully")
}
