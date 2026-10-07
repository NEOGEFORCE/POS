package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================
// Lector de facturas — Contrato de descuentos e impuestos.
//
// Este archivo concentra toda la lógica del OCR de facturas:
//
//   - buildInvoicePrompt: construye las instrucciones para Claude. El
//     prompt pide un JSON con línea completa (barcode, lineType,
//     bonus_quantity, discount_percentage, discount_value, iva/icui/ibua
//     por línea) y describe explícitamente la invariante de precios
//     "pre-descuento, pre-impuestos" para que la contabilidad no sufra
//     doble descuento.
//
//   - normalizeExtractedItem: punto único donde el OCR entra al sistema.
//     Normaliza signo de cantidad (negativa → RETURN), reconcilia %/$
//     en un único DiscountPercentage, hace clamp a [0, 100], anula el
//     DTO en líneas BONUS y deja DiscountValue en 0 por invariante.
//
//   - splitBonusItems: convierte una línea con bonus_quantity > 0 en
//     DOS ítems independientes (REGULAR qty=X unitPrice=P +
//     BONUS qty=Y unitPrice=0). Patrón A del contrato. Si el proveedor
//     emite dos líneas separadas (patrón B), este helper es no-op.
//
//   - ScanInvoice (en product_service.go) orquesta la llamada a Claude,
//     el match por barcode primero y por alias después, y la propagación
//     de los campos nuevos a ScannedItem/UnmatchedItem.
//
// Regla fiscal protegida (ver reception_discount_persistence_test.go):
// el DTO NUNCA rebaja el costo. GrossFromNet, el WAC y el egreso al
// proveedor siguen trabajando sobre entry.NewPurchasePrice sin tocar
// entry.DiscountPct. El DTO viaja como porcentaje al carrito.
// =============================================================

// Límites de validación en handler para prevenir abuso.
const (
	// MaxInvoiceImageBytes es el tope del tamaño decodificado de la imagen
	// (base64 ya decodificado). Claude Vision tiene un tope de ~5 MB en la
	// práctica; ponemos 8 MB para dar margen.
	MaxInvoiceImageBytes = 8 * 1024 * 1024

	// MaxInvoiceBase64Chars es el tope del string base64 ANTES de decodificar.
	// base64 crece ~4/3 vs los bytes crudos: 8 MB → ~10.9 MB. Dejamos 12 MB
	// de margen y le sumamos los ~30 chars del prefijo "data:image/...;base64,".
	MaxInvoiceBase64Chars = 12*1024*1024 + 128

	// MaxInvoiceBodyBytes es el tope del body JSON entrante. El cuerpo lleva
	// imageBase64 (12 MB) + metadata (<4 KB). Dejamos 14 MB.
	MaxInvoiceBodyBytes = 14 * 1024 * 1024

	// claudeVisionTimeout es el tope de duración de la llamada a Claude.
	// 90s cubre facturas largas con margen; menos deja a Claude cortando el
	// JSON a mitad de línea, más mantiene a la UI colgada demasiado tiempo.
	claudeVisionTimeout = 90 * time.Second
)

// MIME types aceptados por Claude Vision.
var acceptedInvoiceMIMETypes = map[string]bool{
	"image/jpeg": true,
	"image/jpg":  true,
	"image/png":  true,
	"image/webp": true,
	"image/gif":  true,
}

// NormalizeMimeType mapea alias comunes al MIME type canónico y valida que
// esté dentro del conjunto que Claude Vision acepta. Devuelve "" si el MIME
// no es válido para que el handler responda 400 sin consultar a Claude.
func NormalizeMimeType(raw string) string {
	m := strings.ToLower(strings.TrimSpace(raw))
	if m == "" {
		// Default conservador: la mayoría de cámaras del POS emiten JPEG.
		return "image/jpeg"
	}
	// "jpg" es un alias común que Claude rechaza, hay que mapearlo.
	switch m {
	case "image/jpg":
		m = "image/jpeg"
	case "jpg", "jpeg":
		m = "image/jpeg"
	case "png":
		m = "image/png"
	case "webp":
		m = "image/webp"
	case "gif":
		m = "image/gif"
	}
	if !acceptedInvoiceMIMETypes[m] {
		return ""
	}
	return m
}

// StripBase64Prefix quita la cabecera "data:image/*;base64," de un string
// base64 si existe, dejando sólo los bytes codificados.
func StripBase64Prefix(b64 string) string {
	if idx := strings.Index(b64, ","); idx != -1 && strings.Contains(b64[:idx], "base64") {
		return b64[idx+1:]
	}
	return b64
}

// ============================================================================
// normalizeExtractedItem
// ============================================================================

// normalizeExtractedItem aplica las invariantes del contrato OCR sobre un
// item recién extraído por Claude. Trabaja en sitio para no obligar al
// caller a recolectar valores de retorno.
//
// Pasos:
//  1. Normaliza signo de Quantity. Si viene negativa, Quantity = |q| y
//     LineType se fija a "RETURN" (a menos que ya venga explícito, en cuyo
//     caso se respeta — p.ej. una devolución con qty positiva marcada).
//  2. Si UnitPrice es 0 pero hay TotalPrice y Quantity, deriva unitPrice.
//     Antes de hacerlo valida que |unitPrice × quantity − totalPrice| sea
//     < 1 % del total; si no, prefiere unitPrice × quantity como base
//     "pre-descuento" porque TotalPrice puede venir post-descuento en
//     facturas mal estructuradas.
//  3. Resuelve DiscountPercentage con precedencia: porcentaje > monto.
//     Si sólo viene monto, convierte a porcentaje con base = unitPrice ×
//     quantity. Clamp a [0, 100]. Guarda WARN si |pct_derivado −
//     pct_explícito| > 1 pp (ambos vinieron inconsistentes).
//  4. DiscountValue queda en 0 por invariante post-normalización.
//  5. LineType se normaliza a mayúsculas y defaultea a "REGULAR".
//  6. Si LineType == "BONUS", fuerza DiscountPercentage = 0.
func normalizeExtractedItem(e *models.ExtractedItem) {
	if e == nil {
		return
	}

	// --- 1. Signo de Quantity → LineType ---
	rawLineType := strings.ToUpper(strings.TrimSpace(e.LineType))
	if e.Quantity < 0 {
		e.Quantity = -e.Quantity
		// Sólo pisamos a RETURN si no venía ya explícito. Un REGULAR con
		// qty negativa es ambiguo; el flujo seguro es tratarlo como
		// devolución.
		if rawLineType == "" || rawLineType == "REGULAR" {
			rawLineType = models.LineTypeReturn
		}
	}
	// --- 1b. Default y validación de LineType ---
	switch rawLineType {
	case models.LineTypeRegular, models.LineTypeBonus, models.LineTypeReturn:
		e.LineType = rawLineType
	case "":
		e.LineType = models.LineTypeRegular
	default:
		// LineType desconocido: cae a REGULAR y queda constancia en log.
		log.Printf("[invoice_reader] LineType desconocido %q en item %q, se asume REGULAR",
			rawLineType, e.Name)
		e.LineType = models.LineTypeRegular
	}

	// --- 2. Reconstruir UnitPrice si falta ---
	if e.UnitPrice <= 0 && e.Quantity > 0 && e.TotalPrice > 0 {
		e.UnitPrice = e.TotalPrice / e.Quantity
	}

	// --- 3. Resolver DiscountPercentage ---
	base := e.UnitPrice * e.Quantity
	explicitPct := e.DiscountPercentage
	explicitVal := e.DiscountValue

	// Guardia: cualquier valor no finito es ruido del OCR.
	if math.IsNaN(explicitPct) || math.IsInf(explicitPct, 0) {
		explicitPct = 0
	}
	if math.IsNaN(explicitVal) || math.IsInf(explicitVal, 0) {
		explicitVal = 0
	}

	var effectiveDto float64
	switch {
	case explicitPct > 0:
		effectiveDto = explicitPct
		// Chequeo cruzado para auditoría: si vinieron ambos y disienten
		// más de 1 pp, dejamos constancia en el log. El % sigue ganando.
		if explicitVal > 0 && base > 0 {
			derived := explicitVal / base * 100
			if math.Abs(derived-explicitPct) > 1.0 {
				log.Printf("[invoice_reader] descuento inconsistente en %q: pct=%.2f%% val=%.2f base=%.2f (derivado=%.2f%%), se usa el porcentaje",
					e.Name, explicitPct, explicitVal, base, derived)
			}
		}
	case explicitVal > 0 && base > 0:
		effectiveDto = explicitVal / base * 100
	default:
		// Guardia división por cero: base <= 0 y sólo hay monto → DTO = 0.
		effectiveDto = 0
	}

	// Clamp [0, 100]: valores negativos son ruido, >100 serían un recargo
	// disfrazado que no corresponde a este flujo.
	if effectiveDto < 0 {
		effectiveDto = 0
	}
	if effectiveDto > 100 {
		effectiveDto = 100
	}

	// --- 4. Invariante post-normalización ---
	// BONUS fuerza DTO = 0: un regalo con "descuento" no tiene semántica
	// y además BulkReceive sanitiza este caso aparte.
	if e.LineType == models.LineTypeBonus {
		effectiveDto = 0
	}
	e.DiscountPercentage = effectiveDto
	e.DiscountValue = 0

	// --- 5. Impuestos: clamp defensivo. ---
	// Los porcentajes de impuesto son positivos por definición; valores
	// no finitos o negativos se neutralizan silenciosamente para no
	// contaminar la contabilidad.
	e.IvaPercentage = clampTaxPct(e.IvaPercentage)
	e.IbuaPercentage = clampTaxPct(e.IbuaPercentage)
	e.IcuiPercentage = clampTaxPct(e.IcuiPercentage)
}

// clampTaxPct neutraliza NaN/Inf/negativos y satura a un tope defensivo de
// 100 % (en Colombia ningún impuesto supera eso).
func clampTaxPct(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

// ============================================================================
// splitBonusItems
// ============================================================================

// splitBonusItems implementa el patrón A del contrato de bonificaciones:
// una línea con bonus_quantity > 0 se parte en DOS ítems independientes
// (REGULAR qty=quantity-bonus_quantity + BONUS qty=bonus_quantity, unitPrice=0).
//
// Es no-op para líneas que vienen con dos registros separados (patrón B) o
// sin bonus_quantity.
//
// Mantiene el orden original para que la UI pueda renderizar REGULAR y BONUS
// contiguos; cada hijo arrastra los impuestos y el DTO (si aplica) de la
// línea padre, con la salvedad de que el BONUS siempre lleva DTO = 0.
func splitBonusItems(items []models.ExtractedItem) []models.ExtractedItem {
	out := make([]models.ExtractedItem, 0, len(items))
	for _, it := range items {
		// La línea padre debe ser REGULAR y tener bonus_quantity válido y
		// menor que la cantidad total. Caso borde: bonus_quantity >= quantity
		// se trata como "todo bonus" (quantity queda en el BONUS, no se
		// genera REGULAR).
		if it.BonusQuantity > 0 && strings.EqualFold(it.LineType, models.LineTypeRegular) {
			bonusQty := it.BonusQuantity
			if bonusQty > it.Quantity {
				bonusQty = it.Quantity
			}
			regularQty := it.Quantity - bonusQty

			// REGULAR: hereda unitPrice, impuestos y DTO (si lo había).
			if regularQty > 0 {
				regular := it
				regular.Quantity = regularQty
				regular.BonusQuantity = 0
				regular.LineType = models.LineTypeRegular
				// TotalPrice del padre se reparte proporcionalmente. Si
				// venía 0 o inconsistente, lo recalculamos.
				regular.TotalPrice = regular.UnitPrice * regularQty
				out = append(out, regular)
			}

			// BONUS: cost = 0, DTO = 0 por invariante.
			bonus := it
			bonus.Quantity = bonusQty
			bonus.BonusQuantity = 0
			bonus.LineType = models.LineTypeBonus
			bonus.UnitPrice = 0
			bonus.TotalPrice = 0
			bonus.DiscountPercentage = 0
			bonus.DiscountValue = 0
			out = append(out, bonus)
			continue
		}

		// No es patrón A: pasar tal cual.
		out = append(out, it)
	}
	return out
}

// ============================================================================
// buildInvoicePrompt
// ============================================================================

// buildInvoicePrompt arma las instrucciones multimodales para Claude Vision.
// El prompt pide un JSON con el shape completo (barcode, lineType,
// bonus_quantity, discount_percentage, discount_value, iva/icui/ibua) y
// documenta las invariantes de precios "pre-descuento, pre-impuestos" que
// mantiene a la contabilidad lejos del doble descuento.
//
// Si expectedTaxes no es nil y marca algún impuesto, se agrega una sección
// "PISTAS FISCALES DEL USUARIO" con instrucciones concretas de los
// porcentajes esperados en facturas colombianas.
func buildInvoicePrompt(supplierName string, params *models.SupplierInvoiceParams, expectedTaxes *models.ExpectedTaxes) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Analiza esta factura del proveedor \"%s\" y extrae TODAS las líneas de productos.\n\n", supplierName))

	sb.WriteString("Responde ÚNICAMENTE con un arreglo JSON válido, sin texto adicional, sin cercos de código, con el siguiente shape por línea:\n")
	sb.WriteString("[\n")
	sb.WriteString("  {\n")
	sb.WriteString("    \"name\": \"nombre exacto del producto como aparece en la factura\",\n")
	sb.WriteString("    \"barcode\": \"código de barras si aparece legible en la línea, si no omite el campo\",\n")
	sb.WriteString("    \"quantity\": número,\n")
	sb.WriteString("    \"lineType\": \"REGULAR | BONUS | RETURN\" (opcional, default REGULAR),\n")
	sb.WriteString("    \"bonus_quantity\": número (opcional, unidades regaladas dentro de la misma línea),\n")
	sb.WriteString("    \"unitPrice\": número (precio UNITARIO PRE-DESCUENTO y PRE-IMPUESTOS),\n")
	sb.WriteString("    \"totalPrice\": número (unitPrice × quantity, PRE-DESCUENTO y PRE-IMPUESTOS),\n")
	sb.WriteString("    \"discount_percentage\": número 0..100 (opcional, DTO% de la LÍNEA),\n")
	sb.WriteString("    \"discount_value\": número (opcional, monto TOTAL del descuento de la LÍNEA entera, NO por unidad),\n")
	sb.WriteString("    \"iva_percentage\": número 0..100 (opcional),\n")
	sb.WriteString("    \"ibua_percentage\": número 0..100 (opcional),\n")
	sb.WriteString("    \"icui_percentage\": número 0..100 (opcional)\n")
	sb.WriteString("  }\n")
	sb.WriteString("]\n\n")

	sb.WriteString("REGLAS ESTRICTAS DE PRECIOS Y DESCUENTOS\n")
	sb.WriteString("- unitPrice y totalPrice se emiten SIEMPRE pre-descuento. Si la factura imprime el total post-descuento en la última columna, usa la columna del precio unitario original para calcular totalPrice = unitPrice × quantity.\n")
	sb.WriteString("- discount_value es TOTAL por LÍNEA: la suma pesos del descuento aplicado a toda la cantidad de esa línea, equivalente a unitPrice × quantity × discount_percentage/100.\n")
	sb.WriteString("- Si la línea trae tanto porcentaje como monto de descuento, emite ambos; el backend prefiere el porcentaje.\n")
	sb.WriteString("- Descuentos GLOBALES al pie de la factura (p.ej. \"Descuento comercial 5%\" sobre el subtotal general): IGNÓRALOS, no los repartas entre líneas.\n")
	sb.WriteString("- Descuentos de LÍNEA (columna \"DESC\", \"DTO\", \"DTO %\" o similar al lado de cada producto): INCLÚYELOS en la línea correspondiente.\n")
	sb.WriteString("- Si una cantidad dice \"1 PAC x 6 UND\", pon quantity: 6 (unidades reales).\n")
	sb.WriteString("- Precios como números puros (sin $, puntos de miles ni comas de decimales mal colocadas).\n")
	sb.WriteString("- Si un valor no es legible, pon 0.\n\n")

	sb.WriteString("BONIFICACIONES (\"Pague X, lleve Y\")\n")
	sb.WriteString("- Patrón A (preferido): una sola línea con quantity = X+Y, bonus_quantity = Y, unitPrice = precio normal. El backend la parte automáticamente en REGULAR + BONUS.\n")
	sb.WriteString("- Patrón B: si la factura imprime la bonificación como línea separada con precio 0, emítela como lineType: \"BONUS\", unitPrice: 0, discount_percentage: 0.\n")
	sb.WriteString("- Nunca emitas discount_percentage > 0 en una línea BONUS: un regalo no tiene descuento.\n\n")

	sb.WriteString("DEVOLUCIONES / NOTAS CRÉDITO\n")
	sb.WriteString("- Si una línea representa una devolución (nota crédito, cantidad negativa, columna de \"DEV\"), emítela con lineType: \"RETURN\" y quantity POSITIVA (el backend ya sabe que descuenta stock).\n")
	sb.WriteString("- Preserva el discount_percentage original si la devolución refleja los términos de la línea comprada.\n\n")

	sb.WriteString("CAMPOS GENERALES A IGNORAR\n")
	sb.WriteString("- Encabezados, pie de página, subtotales acumulados, totales generales, impuestos agregados, fletes y abonos.\n")
	sb.WriteString("- NO incluyas productos con cantidad 0.\n\n")

	// Pistas fiscales condicionales.
	if expectedTaxes != nil && (expectedTaxes.IVA || expectedTaxes.IBUA || expectedTaxes.ICUI) {
		sb.WriteString("PISTAS FISCALES DEL USUARIO (OBLIGATORIAS)\n")
		if expectedTaxes.IVA {
			sb.WriteString("- IVA: esta factura DEBE traer IVA por línea. Busca la columna \"IVA %\" o \"% IVA\". Los valores típicos en Colombia son 5 o 19. Emítelos en iva_percentage de cada línea.\n")
		}
		if expectedTaxes.IBUA {
			sb.WriteString("- IBUA: busca columna \"IBUA\" o \"IMP SALUDABLE\". Valores típicos: 8, 16, 18 o 20 (gramos de azúcar). Emítelos en ibua_percentage.\n")
		}
		if expectedTaxes.ICUI {
			sb.WriteString("- ICUI: busca columna \"ICUI\" o \"IMP ULTRAPROCESADO\". Si aparece por línea, emítelo en icui_percentage.\n")
		}
		sb.WriteString("- Si un impuesto está marcado como esperado y NO aparece en una línea concreta, deja ese campo en 0 (no inventes).\n\n")
	} else {
		sb.WriteString("IMPUESTOS\n")
		sb.WriteString("- Sólo emite iva_percentage/ibua_percentage/icui_percentage si aparecen explícitamente por línea en la factura. Si no, deja los campos en 0 o omítelos.\n\n")
	}

	// Hint específico del proveedor (lo que ya existía).
	if params != nil && strings.TrimSpace(params.Notes) != "" {
		sb.WriteString("INSTRUCCIÓN ESPECIAL DEL PROVEEDOR\n")
		sb.WriteString(params.Notes)
		sb.WriteString("\n")
	}

	return sb.String()
}

// ============================================================================
// callClaudeVision (contexto + body + sanitización de errores)
// ============================================================================

// claudeAPIError es el error estructurado que viaja al handler. Separa el
// detalle técnico (para el log) del motivo "humano" (para el cliente) y
// expone un sentinel reconocible para traducir a HTTP 502/503.
type claudeAPIError struct {
	status  int
	message string
}

func (e *claudeAPIError) Error() string {
	if e.status > 0 {
		return fmt.Sprintf("Claude API error %d: %s", e.status, e.message)
	}
	return e.message
}

// ErrInvoiceReaderUnavailable se usa cuando Claude no respondió a tiempo o
// devolvió error 5xx. El handler lo mapea a 503.
var ErrInvoiceReaderUnavailable = errors.New("lector de facturas no disponible, intente de nuevo en unos minutos")

func (s *ProductService) callClaudeVision(
	ctx context.Context,
	imageBase64, mimeType, supplierName string,
	params *models.SupplierInvoiceParams,
	expectedTaxes *models.ExpectedTaxes,
) ([]models.ExtractedItem, error) {
	apiKey := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	if apiKey == "" {
		// Sin credencial: el servicio no está configurado. El handler
		// traduce esto a 503. El mensaje no revela nada técnico.
		return nil, ErrInvoiceReaderUnavailable
	}

	prompt := buildInvoicePrompt(supplierName, params, expectedTaxes)
	cleanBase64 := StripBase64Prefix(imageBase64)
	cleanMime := NormalizeMimeType(mimeType)
	if cleanMime == "" {
		// El handler valida esto antes, pero defendemos en profundidad.
		return nil, &claudeAPIError{status: http.StatusBadRequest, message: "tipo de imagen no soportado"}
	}

	reqBody := map[string]interface{}{
		"model":      SelectModel(ClassVision),
		"max_tokens": MaxTokensFor(ClassVision),
		"messages": []map[string]interface{}{
			{
				"role": "user",
				"content": []map[string]interface{}{
					{
						"type": "image",
						"source": map[string]interface{}{
							"type":       "base64",
							"media_type": cleanMime,
							"data":       cleanBase64,
						},
					},
					{
						"type": "text",
						"text": prompt,
					},
				},
			},
		},
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("[invoice_reader] no se pudo serializar el request: %w", err)
	}

	// Contexto con timeout de servicio. Encadenamos el ctx del handler
	// para que si el cliente HTTP se desconecta, abortamos la llamada
	// a Claude en vez de retener el goroutine por hasta 90 segundos.
	callCtx, cancel := context.WithTimeout(ctx, claudeVisionTimeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(callCtx, http.MethodPost,
		"https://api.anthropic.com/v1/messages", bytes.NewReader(jsonData))
	if err != nil {
		return nil, fmt.Errorf("[invoice_reader] no se pudo construir request: %w", err)
	}
	httpReq.Header.Set("x-api-key", apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")
	httpReq.Header.Set("content-type", "application/json")

	client := &http.Client{Timeout: claudeVisionTimeout}
	resp, err := client.Do(httpReq)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return nil, fmt.Errorf("[invoice_reader] solicitud cancelada por el cliente")
		}
		if errors.Is(err, context.DeadlineExceeded) {
			log.Printf("[invoice_reader] timeout llamando a Claude: %v", err)
			return nil, ErrInvoiceReaderUnavailable
		}
		log.Printf("[invoice_reader] error de red hacia Claude: %v", err)
		return nil, ErrInvoiceReaderUnavailable
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if err != nil {
		log.Printf("[invoice_reader] error leyendo respuesta de Claude: %v", err)
		return nil, ErrInvoiceReaderUnavailable
	}

	if resp.StatusCode != http.StatusOK {
		// Loguear el status y el payload de error para debug; al cliente
		// sólo le llega un mensaje genérico.
		log.Printf("[invoice_reader] Claude respondió %d: %s", resp.StatusCode, string(body))
		if resp.StatusCode >= 500 || resp.StatusCode == 429 {
			return nil, ErrInvoiceReaderUnavailable
		}
		return nil, &claudeAPIError{status: resp.StatusCode, message: "no se pudo procesar la factura"}
	}

	var claudeResp struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(body, &claudeResp); err != nil {
		log.Printf("[invoice_reader] respuesta de Claude no es JSON válido: %v", err)
		return nil, fmt.Errorf("respuesta inválida del lector de facturas")
	}
	if len(claudeResp.Content) == 0 {
		log.Printf("[invoice_reader] Claude devolvió content vacío")
		return nil, fmt.Errorf("respuesta vacía del lector de facturas")
	}

	text := claudeResp.Content[0].Text
	text = strings.TrimSpace(text)
	text = strings.TrimPrefix(text, "```json")
	text = strings.TrimPrefix(text, "```")
	text = strings.TrimSuffix(text, "```")
	text = strings.TrimSpace(text)

	var items []models.ExtractedItem
	if err := json.Unmarshal([]byte(text), &items); err != nil {
		log.Printf("[invoice_reader] JSON de Claude inválido: %v. Raw[:200]=%q", err, truncateForLog(text, 200))
		return nil, fmt.Errorf("respuesta no estructurada del lector de facturas")
	}
	return items, nil
}

func truncateForLog(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "...<truncado>"
}
