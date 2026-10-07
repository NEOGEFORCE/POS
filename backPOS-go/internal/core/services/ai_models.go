package services

import (
	"os"
	"strings"
	"unicode"
)

// ============================================================================
// MODELOS DE IA — enrutamiento adaptativo por clase de petición
// ============================================================================
//
// La API de Anthropic cobra por token de entrada + salida y el delta de
// precio entre tiers es de ~20x, así que el enrutamiento correcto es la
// palanca de ahorro más grande que tenemos. En vez de usar un solo modelo
// caro para TODO, clasificamos cada petición y la mandamos al modelo más
// barato que la resuelve bien:
//
//   ClassSimpleChat     → Haiku    (chat trivial, confirmaciones, FAQ)
//   ClassComplexReport  → Sonnet   (reportes, análisis, desgloses)
//   ClassVision         → Haiku    (OCR de facturas; vision multimodal)
//
// Opus (powerful tier) NO se enruta automáticamente desde este archivo.
// Queda disponible como override explícito por env (POS_AI_MODEL_POWERFUL)
// para análisis excepcionales que un operador decida escalar a mano.
//
// Todas las decisiones son funciones puras (sin estado, sin globals mutables)
// para que los tests las ejerciten directamente. buildRequest del bot y
// callClaudeVision del lector de facturas sólo consumen ClassifyRequest +
// SelectModel + MaxTokensFor; la elección de modelo no se duplica en los
// callers.
//
// Overrides por variable de entorno (sin recompilar):
//
//   POS_AI_MODEL_FAST / POS_AI_MODEL_BALANCED / POS_AI_MODEL_POWERFUL   (tiers)
//   POS_AI_MODEL_VISION / POS_AI_MODEL_CHAT / POS_AI_MODEL_REASONING    (usos)
//
// Las variables de uso tienen precedencia sobre las de tier dentro de su
// función (p.ej. POS_AI_MODEL_VISION gana al default de VisionModel()). Si
// una var no está seteada, aplica el default compilado.
//
// Para la lista actualizada de IDs oficiales ver:
//   https://docs.anthropic.com/en/docs/about-claude/models
// Documentación operativa de este routing: backPOS-go/AI_MODELS.md
// ============================================================================

const (
	// Tiers base. Usamos los alias oficiales vigentes publicados por Anthropic.
	// Estos alias apuntan a la generación 5.5 y permiten recibir correcciones
	// compatibles del proveedor sin fijarnos a un snapshot antiguo. Cualquier
	// cuenta que requiera un snapshot concreto puede fijarlo por variable de
	// entorno sin recompilar.
	fastTierModel     = "claude-haiku-5-5"
	balancedTierModel = "claude-sonnet-5-5"
	powerfulTierModel = "claude-opus-5-5"
)

// ============================================================================
// Request classification
// ============================================================================

// RequestClass identifica el tipo de petición para enrutarla al tier correcto.
// Es un int simple y no una string para que el switch de SelectModel sea
// exhaustivo bajo revisión de go vet.
type RequestClass int

const (
	// ClassSimpleChat es la clase por defecto: preguntas cortas, confirmaciones,
	// comandos triviales. Haiku resuelve el 90 % del tráfico del bot.
	ClassSimpleChat RequestClass = iota

	// ClassComplexReport es para peticiones que exigen razonamiento o síntesis:
	// reportes, desgloses, análisis de ventas, PDFs. Sonnet gana en calidad y
	// el gasto extra queda acotado porque son poco frecuentes.
	ClassComplexReport

	// ClassVision es para cualquier petición que incluya una imagen (OCR de
	// facturas, foto de producto). Siempre va al modelo de visión, aun si el
	// caption del usuario dice "reporte": la imagen es la señal fuerte.
	ClassVision
)

// String ayuda al logging y a los mensajes de test. Mantener los nombres
// alineados con las constantes para que una regresión sea trivial de leer.
func (c RequestClass) String() string {
	switch c {
	case ClassSimpleChat:
		return "simple_chat"
	case ClassComplexReport:
		return "complex_report"
	case ClassVision:
		return "vision"
	default:
		return "unknown"
	}
}

// complexReportTokens son palabras que, en el dominio del POS, señalan una
// petición de reporte/análisis con alta confianza. La selección es
// deliberadamente conservadora: cada token aquí "escala" el chat a Sonnet y
// un falso positivo cuesta ~20x más que un falso negativo.
//
// Las versiones con y sin tilde conviven como entradas separadas para evitar
// depender de normalización Unicode (NFD) en el hot path del clasificador.
//
// NO INCLUIR aquí "todos" / "toda" / "todo": disparan en frases triviales
// ("¿tienes todos los pedidos de hoy?", "muéstrame todos los proveedores")
// y arrastran chat barato a Sonnet sin razón.
var complexReportTokens = map[string]struct{}{
	// Reportes y síntesis explícitos.
	"reporte": {}, "reportes": {},
	"informe": {}, "informes": {},
	"desglose": {}, "desgloses": {}, "desglosar": {}, "desglosa": {}, "desglosame": {},
	"resumen": {}, "resumenes": {}, "resúmenes": {}, "resumir": {}, "resume": {}, "resumeme": {},
	"analisis": {}, "análisis": {}, "analizar": {}, "analiza": {}, "analízame": {}, "analizame": {},
	"balance": {}, "balances": {},
	// Finanzas / contables.
	"utilidad": {}, "rentabilidad": {}, "ganancias": {}, "perdidas": {}, "pérdidas": {},
	// Entregables.
	"pdf": {}, "exportar": {}, "exporta": {}, "exportame": {},
	"grafica": {}, "gráfica": {}, "graficas": {}, "gráficas": {},
	// Verbos que piden detalle expandido (uso explícito, no sustantivo
	// ambiguo). "detalla" en el POS siempre tiene esta intención.
	"detalla": {}, "detallame": {}, "detállame": {}, "detallar": {},
	"detallado": {}, "detallada": {}, "detallados": {}, "detalladas": {},
}

// complexReportPhrases son multi-tokens cuya intención es clara aun cuando
// las palabras individuales son triviales. Se evalúan por substring sobre
// el texto en minúsculas.
var complexReportPhrases = []string{
	"listado completo",
	"detalle completo",
	"detalle total",
	"todo el detalle",
	"todos los detalles",
	"informe completo",
	"reporte completo",
}

// ClassifyRequest decide la RequestClass de una petición a partir del texto
// del usuario y de si la petición incluye una imagen.
//
// Contrato:
//
//  1. hasImage == true → ClassVision SIEMPRE. Esto se mantiene aun cuando el
//     caption diga "reporte": el modelo de visión es el único que puede leer
//     la imagen; si está presente, manda. Un caption con intención de
//     reporte no justifica cambiar de modelo y perder la imagen.
//  2. Texto que contiene algún complexReportToken (comparado por palabra
//     tokenizada, no por substring) o alguna complexReportPhrase →
//     ClassComplexReport.
//  3. Cualquier otra cosa → ClassSimpleChat.
//
// La función es pura: sin estado, sin globals mutables, sin side effects.
// Se testea directamente con table tests. Si el texto está vacío y no hay
// imagen, se asume ClassSimpleChat (el bot responderá con una guía corta).
func ClassifyRequest(text string, hasImage bool) RequestClass {
	if hasImage {
		return ClassVision
	}
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return ClassSimpleChat
	}
	for _, phrase := range complexReportPhrases {
		if strings.Contains(lower, phrase) {
			return ClassComplexReport
		}
	}
	for _, token := range tokenize(lower) {
		if _, hit := complexReportTokens[token]; hit {
			return ClassComplexReport
		}
	}
	return ClassSimpleChat
}

// tokenize parte el texto por cualquier runa que no sea letra Unicode o
// dígito. Esto maneja limpiamente los acentos del español (á, é, í, ó, ú,
// ñ son letras Unicode) sin depender de \b, que en RE2 sólo cubre ASCII.
// La función se mantiene no-exportada: es un detalle de la clasificación.
func tokenize(text string) []string {
	var out []string
	var current strings.Builder
	flush := func() {
		if current.Len() == 0 {
			return
		}
		out = append(out, current.String())
		current.Reset()
	}
	for _, r := range text {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			current.WriteRune(r)
		} else {
			flush()
		}
	}
	flush()
	return out
}

// ============================================================================
// Model selection and token budget
// ============================================================================

// SelectModel resuelve el ID del modelo Anthropic a usar para la clase dada,
// respetando los overrides por variable de entorno.
//
// Precedencia por clase:
//
//	ClassSimpleChat     → POS_AI_MODEL_CHAT      | POS_AI_MODEL_FAST     | fastTierModel
//	ClassComplexReport  → POS_AI_MODEL_REASONING | POS_AI_MODEL_BALANCED | balancedTierModel
//	ClassVision         → POS_AI_MODEL_VISION    | POS_AI_MODEL_FAST     | fastTierModel
//
// La variable "de uso" (CHAT/REASONING/VISION) gana a la de "tier" para
// permitir mover un uso aislado a otro tier sin arrastrar los demás. Si
// ninguna está seteada, se aplica el default compilado.
//
// Opus (POS_AI_MODEL_POWERFUL / powerfulTierModel) NO se enruta aquí.
// Está disponible vía PowerfulTier() para casos manuales explícitos.
func SelectModel(c RequestClass) string {
	switch c {
	case ClassSimpleChat:
		if v := firstNonEmpty(os.Getenv("POS_AI_MODEL_CHAT"), os.Getenv("POS_AI_MODEL_FAST")); v != "" {
			return v
		}
		return fastTierModel
	case ClassComplexReport:
		if v := firstNonEmpty(os.Getenv("POS_AI_MODEL_REASONING"), os.Getenv("POS_AI_MODEL_BALANCED")); v != "" {
			return v
		}
		return balancedTierModel
	case ClassVision:
		if v := firstNonEmpty(os.Getenv("POS_AI_MODEL_VISION"), os.Getenv("POS_AI_MODEL_FAST")); v != "" {
			return v
		}
		return fastTierModel
	default:
		// Default defensivo: cualquier clase desconocida va al modelo más
		// barato. No panic en caliente por una clase futura mal propagada.
		return fastTierModel
	}
}

// MaxTokensFor devuelve el presupuesto de tokens de salida razonable por
// clase. Los valores están calibrados para no truncar los entregables
// realistas del POS y a la vez no pedir headroom innecesario:
//
//   - SimpleChat (1024): confirmaciones y respuestas cortas; un cajero no
//     lee más de media pantalla.
//   - ComplexReport (2048): reportes y desgloses del bot. Sonnet sintetiza
//     bien a esta altura; subirlo no mejora calidad y aumenta costo lineal.
//   - Vision (4096): facturas pueden traer 60+ líneas con impuestos y
//     descuentos. Bajar de 4096 corta JSON a mitad de línea y rompe el OCR.
//     NO reducir sin medir con una factura larga real.
func MaxTokensFor(c RequestClass) int {
	switch c {
	case ClassSimpleChat:
		return 1024
	case ClassComplexReport:
		return 2048
	case ClassVision:
		return 4096
	default:
		return 1024
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}

// ============================================================================
// Legacy helpers (compatibilidad). Preferir ClassifyRequest + SelectModel en
// código nuevo.
// ============================================================================

func modelFromEnv(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// FastTier — tareas de alto volumen y baja latencia: clasificación,
// extracción estructurada, routing, respuestas cortas de chat.
func FastTier() string { return modelFromEnv("POS_AI_MODEL_FAST", fastTierModel) }

// BalancedTier — tareas que necesitan razonamiento moderado: reportes,
// análisis de ventas, desgloses, resúmenes con contexto.
func BalancedTier() string { return modelFromEnv("POS_AI_MODEL_BALANCED", balancedTierModel) }

// PowerfulTier — tareas complejas o críticas donde la calidad justifica el
// costo. NO se enruta automáticamente desde ClassifyRequest/SelectModel;
// queda disponible como override manual.
func PowerfulTier() string { return modelFromEnv("POS_AI_MODEL_POWERFUL", powerfulTierModel) }

// VisionModel — modelo para OCR de facturas e imágenes. Equivalente a
// SelectModel(ClassVision); se mantiene como alias semántico para los
// callers que leen el nombre como documentación.
func VisionModel() string { return SelectModel(ClassVision) }

// ChatModel — modelo para conversación corta del bot. Equivalente a
// SelectModel(ClassSimpleChat).
func ChatModel() string { return SelectModel(ClassSimpleChat) }

// ReasoningModel — modelo para reportes y análisis. Equivalente a
// SelectModel(ClassComplexReport).
func ReasoningModel() string { return SelectModel(ClassComplexReport) }

// FastModel es un alias histórico de FastTier conservado para no romper
// callers externos.
//
// Deprecated: usar FastTier() o SelectModel(ClassSimpleChat).
func FastModel() string { return FastTier() }
