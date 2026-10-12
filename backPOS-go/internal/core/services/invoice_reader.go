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
// applyExpectedTaxesAllowlist / zeroCatalogRatesForDeselected
// ============================================================================
//
// Modelo de allowlist estricta: la UI envía `expectedTaxes` como pistas de
// qué impuestos BUSCAR y CONSERVAR. Un impuesto no marcado (nil o false)
// debe neutralizarse a 0 en TODO el flujo:
//
//   1. En la respuesta del OCR aunque Claude lo haya devuelto por error.
//   2. En el fallback de catálogo del producto (no debe reaparecer por el
//      IVA guardado en products.iva).
//   3. En los cálculos de costo real / impuestos efectivos que forma
//      calculateItemDetails.
//
// Importante: ESTAS FUNCIONES NO PERSISTEN NADA. No tocan la columna del
// producto ni los parámetros del proveedor. El catálogo se corrige por el
// flujo normal de edición / recepción, no por el lector.

// applyExpectedTaxesAllowlist anula en sitio los porcentajes de impuesto
// de un item extraído cuyo impuesto no esté marcado como esperado. Si
// `expected` es nil, se trata como "ninguno seleccionado" y los tres
// quedan en 0 — regla deliberada: la UI es la única fuente de verdad
// sobre qué impuestos buscar.
func applyExpectedTaxesAllowlist(e *models.ExtractedItem, expected *models.ExpectedTaxes) {
	if e == nil {
		return
	}
	if expected == nil || !expected.IVA {
		e.IvaPercentage = 0
	}
	if expected == nil || !expected.IBUA {
		e.IbuaPercentage = 0
	}
	if expected == nil || !expected.ICUI {
		e.IcuiPercentage = 0
	}
}

// zeroCatalogRatesForDeselected anula los porcentajes de catálogo que
// correspondan a impuestos NO seleccionados. Se llama sobre una copia local
// (no sobre el modelo persistido). Si `expected` es nil, los tres quedan
// en 0.
func zeroCatalogRatesForDeselected(rates *models.TaxRates, expected *models.ExpectedTaxes) {
	if rates == nil {
		return
	}
	if expected == nil || !expected.IVA {
		rates.IvaPct = 0
	}
	if expected == nil || !expected.IBUA {
		rates.IbuaPct = 0
	}
	if expected == nil || !expected.ICUI {
		rates.IcuiPct = 0
	}
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

	// Pistas fiscales condicionales (allowlist estricta).
	//
	// Reglas del contrato:
	//   - Si al menos un impuesto está seleccionado, se emite la sección
	//     "PISTAS FISCALES DEL USUARIO" mencionando ÚNICAMENTE los
	//     impuestos seleccionados, junto con una instrucción explícita de
	//     poner en 0 u omitir los NO seleccionados.
	//   - Si no hay ninguno seleccionado, se emite una sección "IMPUESTOS"
	//     que PROHÍBE buscar columnas fiscales. Nunca se instruye al
	//     modelo a buscar IVA/IBUA/ICUI "si aparecen".
	anySelected := expectedTaxes != nil && (expectedTaxes.IVA || expectedTaxes.IBUA || expectedTaxes.ICUI)
	if anySelected {
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
		// Enumerar explícitamente los NO seleccionados para que Claude los
		// omita aunque los vea en la factura. Es la mitad del contrato de
		// allowlist que no puede delegarse al post-procesado.
		var skipped []string
		if !expectedTaxes.IVA {
			skipped = append(skipped, "iva_percentage")
		}
		if !expectedTaxes.IBUA {
			skipped = append(skipped, "ibua_percentage")
		}
		if !expectedTaxes.ICUI {
			skipped = append(skipped, "icui_percentage")
		}
		if len(skipped) > 0 {
			sb.WriteString(fmt.Sprintf("- NO busques ni emitas %s. Déjalos en 0 u omítelos del JSON de la línea, aunque la factura muestre esas columnas.\n", strings.Join(skipped, ", ")))
		}
		sb.WriteString("- Si un impuesto está marcado como esperado y NO aparece en una línea concreta, deja ese campo en 0 (no inventes).\n\n")
	} else {
		sb.WriteString("IMPUESTOS\n")
		sb.WriteString("- NO busques columnas fiscales (IVA, IBUA, ICUI) en esta factura. Deja iva_percentage, ibua_percentage e icui_percentage en 0 u omítelos del JSON, aunque aparezcan impresos.\n\n")
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

const claudeVisionMaxAttempts = 2

var (
	// ErrInvoiceReaderUnavailable se usa cuando Claude no respondió a tiempo o
	// devolvió error 5xx. El handler lo mapea a 503.
	ErrInvoiceReaderUnavailable = errors.New("lector de facturas no disponible, intente de nuevo en unos minutos")

	// ErrInvoiceReaderIncomplete indica que Claude respondió HTTP 200, pero la
	// salida quedó vacía, truncada o no fue JSON completo incluso tras un
	// reintento. Es distinto de indisponibilidad: el handler lo traduce a 502
	// con una instrucción accionable y nunca expone el contenido de la factura.
	ErrInvoiceReaderIncomplete = errors.New("respuesta incompleta del lector de facturas")

	// errClaudeOutputRetryable es interno: autoriza exactamente un reintento.
	// No se usa para errores HTTP, credenciales, cancelaciones ni red.
	errClaudeOutputRetryable = errors.New("salida OCR de Claude incompleta o inválida")
)

type claudeVisionResponse struct {
	StopReason string `json:"stop_reason"`
	Content    []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

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

	// Un único presupuesto de tiempo cubre ambos intentos. Así el reintento no
	// puede duplicar los 90 segundos ni sobrevivir a una pestaña cerrada.
	callCtx, cancel := context.WithTimeout(ctx, claudeVisionTimeout)
	defer cancel()

	baseTokenBudget := MaxTokensFor(ClassVision)
	for attempt := 1; attempt <= claudeVisionMaxAttempts; attempt++ {
		tokenBudget := baseTokenBudget
		attemptPrompt := prompt
		if attempt > 1 {
			// El segundo intento sólo ocurre si el primero fue vacío/truncado o
			// no estructurado. Duplicar el techo no duplica el costo: Anthropic
			// cobra tokens realmente emitidos, y evita cortar facturas largas.
			tokenBudget *= 2
			attemptPrompt += "\nREINTENTO DE FORMATO: devuelve el arreglo JSON completo en un único bloque de texto. No escribas explicación antes ni después.\n"
		}

		items, err := doClaudeVisionAttempt(callCtx, apiKey, cleanBase64, cleanMime, attemptPrompt, tokenBudget)
		if err == nil {
			return items, nil
		}
		if !errors.Is(err, errClaudeOutputRetryable) {
			return nil, err
		}
		log.Printf("[invoice_reader] salida OCR inválida/incompleta en intento %d/%d: %v",
			attempt, claudeVisionMaxAttempts, err)
	}

	return nil, ErrInvoiceReaderIncomplete
}

// buildClaudeVisionRequestBody arma el map que se serializa como body de la
// llamada POST /v1/messages de Anthropic para OCR de facturas.
//
// Se mantiene como función PURA (sin I/O, sin estado, sin globals) para que
// las pruebas verifiquen el shape exacto del payload sin tener que montar un
// servidor HTTP. Es el único lugar del backend donde se construye el request
// a Claude Vision; cualquier campo nuevo debe pasar por aquí y por sus tests.
//
// Decisiones intencionales del shape:
//
//   - NO se envía el campo `temperature`. Anthropic rechazó requests con
//     HTTP 400 invalid_request_error apuntando a este campo (y a `model`)
//     en los modelos vigentes del tier de visión; dejar que el modelo use
//     su temperatura por defecto es seguro para OCR estructurado, porque el
//     prompt ya exige un arreglo JSON determinista y el pipeline reintenta
//     si la salida vuelve truncada o inválida. Reintroducir `temperature`
//     volvería a romper el lector de facturas en producción.
//
//   - `model`, `max_tokens` y `messages` son los únicos campos obligatorios
//     del protocolo Messages API para esta ruta. El resto (system,
//     stop_sequences, top_k, top_p, tools, metadata) queda ausente a
//     propósito para minimizar la superficie que Anthropic puede rechazar.
func buildClaudeVisionRequestBody(model, imageBase64, mimeType, prompt string, maxTokens int) map[string]interface{} {
	return map[string]interface{}{
		"model":      model,
		"max_tokens": maxTokens,
		"messages": []map[string]interface{}{
			{
				"role": "user",
				"content": []map[string]interface{}{
					{
						"type": "image",
						"source": map[string]interface{}{
							"type":       "base64",
							"media_type": mimeType,
							"data":       imageBase64,
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
}

// doClaudeVisionAttempt realiza una sola llamada. Mantenerla separada permite
// que callClaudeVision decida el reintento sin repetir manejo HTTP ni parseo.
func doClaudeVisionAttempt(
	ctx context.Context,
	apiKey, imageBase64, mimeType, prompt string,
	maxTokens int,
) ([]models.ExtractedItem, error) {
	reqBody := buildClaudeVisionRequestBody(SelectModel(ClassVision), imageBase64, mimeType, prompt, maxTokens)

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("[invoice_reader] no se pudo serializar el request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
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
			// Se preserva el sentinel con %w para que las capas superiores
			// puedan reconocer la cancelación del cliente con errors.Is sin
			// depender del texto del mensaje.
			return nil, fmt.Errorf("[invoice_reader] solicitud cancelada por el cliente: %w", err)
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
		// Observabilidad segura: NUNCA se loguea `string(body)` crudo ni el
		// mensaje de error upstream. Un payload de error de Anthropic puede
		// citar el request que lo originó (`messages`, `metadata`), y en
		// esta ruta ese request transporta la imagen y los datos de la
		// factura. Sólo se loguea el status + el `error.type` reportado por
		// Anthropic + las categorías de campo mencionadas, filtradas por
		// una allowlist estricta de campos del protocolo.
		errorType, fieldCats := summarizeClaudeUpstreamError(body)
		log.Printf("[invoice_reader] Claude respondió %d error_type=%q fields=%v",
			resp.StatusCode, errorType, fieldCats)
		if resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests {
			return nil, ErrInvoiceReaderUnavailable
		}
		return nil, &claudeAPIError{status: resp.StatusCode, message: "no se pudo procesar la factura"}
	}

	return parseClaudeInvoiceResponse(body)
}

// ============================================================================
// summarizeClaudeUpstreamError — observabilidad segura de errores Anthropic
// ============================================================================

// claudeUpstreamErrorEnvelope es la forma mínima de un error 4xx/5xx que
// Anthropic emite. Sólo capturamos `type` y `error.{type,message}`; cualquier
// otro campo que agreguen en el futuro queda intencionalmente fuera del
// unmarshal para no arrastrarlo al log.
type claudeUpstreamErrorEnvelope struct {
	Type  string `json:"type"`
	Error struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

// claudeErrorFieldAllowlist enumera, en orden estable, los nombres de campos
// del protocolo Messages API cuya mención en un error de Anthropic sí es
// seguro registrar. El contenido de factura jamás vive en estos nombres —
// son identificadores del protocolo, no datos del negocio— y el orden
// estable deja los logs deterministas para los operadores.
//
// Cualquier substring del mensaje de error que no coincida con esta lista
// se descarta: no se intenta "inferir" el campo, para no acabar logueando
// fragmentos de la factura que Anthropic pudo citar al explicar el error.
var claudeErrorFieldAllowlist = []string{
	"model",
	"max_tokens",
	"messages",
	"temperature",
	"system",
	"stop_sequences",
	"top_k",
	"top_p",
	"metadata",
	"tools",
	"tool_choice",
	"anthropic-version",
	"anthropic-beta",
}

// summarizeClaudeUpstreamError extrae del body de error de Anthropic sólo
// la información que es segura de loguear: el `error.type` y las CATEGORÍAS
// de campo mencionadas en el mensaje (contrastadas contra una allowlist
// estricta de nombres del protocolo). Devuelve las categorías en MAYÚSCULAS
// para que un operador distinga de un vistazo un rechazo por MODEL vs. uno
// por TEMPERATURE sin tener que leer el cuerpo original.
//
// La función es pura y robusta ante cualquier basura: body vacío, body no-JSON
// o body con un shape distinto al esperado devuelven ("", nil) silenciosamente,
// que es la señal "no sé, no se puede resumir" para el llamador. Nunca
// devuelve el mensaje original ni fragmentos del body — ésa es la garantía
// que mantiene el log libre de contenido de factura.
func summarizeClaudeUpstreamError(body []byte) (errorType string, fieldCategories []string) {
	if len(body) == 0 {
		return "", nil
	}
	var env claudeUpstreamErrorEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return "", nil
	}
	errorType = env.Error.Type
	msg := strings.ToLower(env.Error.Message)
	if msg == "" {
		return errorType, nil
	}
	seen := make(map[string]struct{}, len(claudeErrorFieldAllowlist))
	for _, field := range claudeErrorFieldAllowlist {
		if _, dup := seen[field]; dup {
			continue
		}
		if strings.Contains(msg, field) {
			seen[field] = struct{}{}
			fieldCategories = append(fieldCategories, strings.ToUpper(field))
		}
	}
	return errorType, fieldCategories
}

// parseClaudeInvoiceResponse interpreta el envelope de Messages API y
// reconstruye el flujo combinado y ordenado de TODOS los bloques `text`.
// Nunca devuelve el contenido de un bloque individual ignorando el resto:
// si Claude emite dos arreglos completos en bloques distintos, el flujo
// combinado NO es un único JSON seguro y se pide reintento sin fusionar
// datos. La única manipulación admisible es el saneo de prosa accidental
// y cercos markdown; jamás se completan llaves ni se concatenan arreglos
// a mano.
func parseClaudeInvoiceResponse(body []byte) ([]models.ExtractedItem, error) {
	var response claudeVisionResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, fmt.Errorf("%w: envelope JSON inválido: %v", errClaudeOutputRetryable, err)
	}

	// Aunque el texto alcance a cerrar un arreglo, max_tokens no garantiza que
	// Claude haya terminado de enumerar TODAS las líneas. No aceptamos una
	// factura posiblemente parcial: se reintenta con mayor presupuesto.
	if response.StopReason == "max_tokens" {
		return nil, fmt.Errorf("%w: stop_reason=max_tokens", errClaudeOutputRetryable)
	}

	textBlocks := make([]string, 0, len(response.Content))
	for _, block := range response.Content {
		if block.Type != "text" {
			continue
		}
		if text := strings.TrimSpace(block.Text); text != "" {
			textBlocks = append(textBlocks, text)
		}
	}
	if len(textBlocks) == 0 {
		return nil, fmt.Errorf("%w: sin bloques de texto (stop_reason=%q)",
			errClaudeOutputRetryable, response.StopReason)
	}

	// Concatenación directa sin separador: la segmentación de Messages API
	// ocurre a nivel de token (puede partir un string JSON entre dos bloques)
	// y cualquier separador que inyectemos corre el riesgo de corromperlo.
	// La única excepción es la cancelación por max_tokens, atrapada arriba.
	combined := strings.Join(textBlocks, "")
	items, err := decodeInvoiceItemsCandidate(combined)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errClaudeOutputRetryable, err)
	}
	return items, nil
}

// decodeInvoiceItemsCandidate aplica saneo mínimo (cercos markdown y prosa
// accidental alrededor del arreglo) y exige que el string resultante contenga
// EXACTAMENTE un arreglo JSON de ítems. Si quedan datos residuales (otro
// arreglo, prosa, basura) devuelve error, para que el llamador active el
// reintento sin inventar la fusión de dos facturas distintas.
func decodeInvoiceItemsCandidate(raw string) ([]models.ExtractedItem, error) {
	candidate := strings.TrimSpace(raw)
	if strings.HasPrefix(candidate, "```") {
		if newline := strings.IndexByte(candidate, '\n'); newline >= 0 {
			candidate = candidate[newline+1:]
		}
		if fence := strings.LastIndex(candidate, "```"); fence >= 0 {
			candidate = candidate[:fence]
		}
		candidate = strings.TrimSpace(candidate)
	}

	if items, err := strictDecodeInvoiceArray(candidate); err == nil {
		return items, nil
	}

	// Compat defensiva: una frase accidental antes y/o después del arreglo
	// se recorta por la primera '[' y la última ']'. Si entre esas marcas
	// hay más de un arreglo (ej. "[arr1] prose [arr2]"), el decodificador
	// estricto detectará contenido residual y volverá a fallar sin aceptar
	// solo la primera porción.
	start := strings.IndexByte(candidate, '[')
	end := strings.LastIndexByte(candidate, ']')
	if start >= 0 && end > start {
		return strictDecodeInvoiceArray(candidate[start : end+1])
	}

	return nil, errors.New("JSON de ítems inválido o incompleto")
}

// strictDecodeInvoiceArray decodifica un string que debe contener UN único
// arreglo JSON de ítems. Si queda contenido no-blanco tras ese arreglo
// (otro arreglo completo, prosa residual, otra factura), devuelve error
// en vez de aceptar silenciosamente la primera porción como válida: ese
// comportamiento era el que permitía que la respuesta se tomara como una
// factura parcial cuando Claude emitía dos arreglos en bloques distintos.
func strictDecodeInvoiceArray(s string) ([]models.ExtractedItem, error) {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" || trimmed == "null" {
		return nil, errors.New("la salida fue vacía o null")
	}

	dec := json.NewDecoder(strings.NewReader(trimmed))
	var items []models.ExtractedItem
	if err := dec.Decode(&items); err != nil {
		return nil, err
	}
	if items == nil {
		return nil, errors.New("la salida no contiene un arreglo")
	}

	remaining := strings.TrimSpace(trimmed[dec.InputOffset():])
	if remaining != "" {
		return nil, errors.New("contenido JSON extra tras el primer arreglo (se requiere un único arreglo)")
	}
	return items, nil
}
