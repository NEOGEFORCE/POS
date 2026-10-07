package services

import (
	"testing"
)

// =============================================================================
// Contrato de enrutamiento de modelos Anthropic
//
// Estos tests blindan la selección de modelo y la clasificación de peticiones.
// Si alguno falla, el POS podría estar escalando chat trivial a Sonnet (10x
// más caro) o — peor — bajando OCR a un modelo sin visión y rompiendo el
// lector de facturas en producción.
//
// Casos cubiertos:
//
//   - ClassifyRequest sobre un abanico de frases reales del dominio:
//     "todos" NO escala, imagen con caption "reporte" conserva Vision,
//     "detalla", "desglose", "pdf" sí escalan.
//
//   - SelectModel por clase + overrides por env (POS_AI_MODEL_* en sus
//     seis variantes). Verifica también la precedencia uso > tier.
//
//   - MaxTokensFor por clase: valores exactos para que un cambio
//     accidental no trunque facturas.
//
//   - Helpers legacy (VisionModel/ChatModel/ReasoningModel/FastTier/
//     BalancedTier/PowerfulTier/FastModel) siguen respetando env.
//
// Convenciones: t.Setenv restaura automáticamente la variable al final
// del test, por lo que es seguro paralelizar NO al setear env; los sub-tests
// de env NO llaman t.Parallel() a propósito.
// =============================================================================

// -------------------- ClassifyRequest --------------------

func TestClassifyRequest(t *testing.T) {
	cases := []struct {
		name     string
		text     string
		hasImage bool
		want     RequestClass
	}{
		// --- Imagen manda siempre (contrato principal) ---
		{"imagen sin caption", "", true, ClassVision},
		{"imagen con caption de factura", "esta es la factura de hoy", true, ClassVision},
		{
			"imagen con caption diciendo 'reporte' debe conservar Vision",
			"hazme un reporte de esta factura",
			true,
			ClassVision,
		},
		{
			"imagen con caption 'desglose' debe conservar Vision",
			"desglose completo de la factura adjunta",
			true,
			ClassVision,
		},

		// --- Chat trivial NO escala (regresión del bug "todos") ---
		{"vacío", "", false, ClassSimpleChat},
		{"saludo", "hola, buenos días", false, ClassSimpleChat},
		{"consulta corta", "¿cuánto cuesta la coca cola de 400?", false, ClassSimpleChat},
		{
			"'todos los pedidos' NO debe escalar (chat trivial)",
			"¿tienes todos los pedidos de hoy?",
			false,
			ClassSimpleChat,
		},
		{
			"'todos los proveedores' NO debe escalar",
			"muéstrame todos los proveedores que vienen hoy",
			false,
			ClassSimpleChat,
		},
		{
			"'todos los productos' NO debe escalar",
			"listame todos los productos del aseo",
			false,
			ClassSimpleChat,
		},
		{"consulta con 'toda' trivial", "¿pasó toda la plata al banco?", false, ClassSimpleChat},
		{"consulta con 'reportero' no debe escalar (sin 'reporte' como palabra)", "el reportero vino hoy", false, ClassSimpleChat},

		// --- Reportes y análisis sí escalan ---
		{"petición de reporte directa", "dame el reporte de ventas de hoy", false, ClassComplexReport},
		{"informe", "necesito un informe mensual", false, ClassComplexReport},
		{"desglose", "desglosa los egresos del mes", false, ClassComplexReport},
		{"análisis con tilde", "hazme un análisis de rentabilidad", false, ClassComplexReport},
		{"analisis sin tilde", "hazme un analisis de rentabilidad", false, ClassComplexReport},
		{"resumen", "resumen de la semana por favor", false, ClassComplexReport},
		{"balance", "balance del mes de agosto", false, ClassComplexReport},
		{"utilidad", "cuál fue la utilidad neta del mes", false, ClassComplexReport},
		{"rentabilidad", "muéstrame la rentabilidad por categoría", false, ClassComplexReport},
		{"pdf export", "exporta todo a pdf", false, ClassComplexReport},
		{"gráfica con tilde", "hazme una gráfica de ventas diarias", false, ClassComplexReport},
		{"grafica sin tilde", "necesito una grafica mensual", false, ClassComplexReport},

		// --- "detalla" / variantes como verbo imperativo (caso límite A4) ---
		{"detalla verbo", "detalla el egreso 42", false, ClassComplexReport},
		{"detállame con tilde", "detállame los movimientos de hoy", false, ClassComplexReport},
		{"detallame sin tilde", "detallame los movimientos de hoy", false, ClassComplexReport},
		{"detallado adjetivo", "quiero un informe detallado", false, ClassComplexReport},

		// --- Frases multi-token ---
		{"frase 'listado completo'", "necesito el listado completo de inventario", false, ClassComplexReport},
		{"frase 'detalle completo'", "dame el detalle completo del cierre", false, ClassComplexReport},
		{"frase 'todo el detalle'", "muéstrame todo el detalle del día", false, ClassComplexReport},

		// --- Casos sensibles: la palabra debe estar completa, no como prefijo accidental ---
		{"'reporte' con puntuación", "¿me pasas el reporte?", false, ClassComplexReport},
		{"'reporte' con mayúsculas", "DAME EL REPORTE DE HOY", false, ClassComplexReport},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := ClassifyRequest(tc.text, tc.hasImage)
			if got != tc.want {
				t.Fatalf("ClassifyRequest(%q, hasImage=%v) = %s, want %s",
					tc.text, tc.hasImage, got, tc.want)
			}
		})
	}
}

// -------------------- SelectModel con defaults --------------------

func TestSelectModel_DefaultsCompilados(t *testing.T) {
	// Aislar overrides heredados del entorno de desarrollo para que el test
	// mida el default compilado real. t.Setenv a cadena vacía deja la
	// variable "seteada en vacío", pero firstNonEmpty la trata como no
	// configurada (TrimSpace). Esto cubre ambos casos.
	for _, k := range []string{
		"POS_AI_MODEL_FAST", "POS_AI_MODEL_BALANCED", "POS_AI_MODEL_POWERFUL",
		"POS_AI_MODEL_CHAT", "POS_AI_MODEL_REASONING", "POS_AI_MODEL_VISION",
	} {
		t.Setenv(k, "")
	}

	cases := []struct {
		class RequestClass
		want  string
	}{
		{ClassSimpleChat, fastTierModel},
		{ClassComplexReport, balancedTierModel},
		{ClassVision, fastTierModel},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.class.String(), func(t *testing.T) {
			got := SelectModel(tc.class)
			if got != tc.want {
				t.Fatalf("SelectModel(%s) = %q, want %q", tc.class, got, tc.want)
			}
		})
	}
}

func TestSelectModel_ClaseDesconocidaCaeAFast(t *testing.T) {
	// Defensa: una RequestClass fuera del enum (p.ej. un sprint futuro
	// que agregue clases pero no actualice SelectModel) no debe panic
	// ni romper; cae silenciosamente al modelo más barato.
	for _, k := range []string{
		"POS_AI_MODEL_FAST", "POS_AI_MODEL_CHAT",
	} {
		t.Setenv(k, "")
	}
	got := SelectModel(RequestClass(99))
	if got != fastTierModel {
		t.Fatalf("SelectModel(unknown) = %q, want %q (fallback a fastTierModel)", got, fastTierModel)
	}
}

// -------------------- SelectModel con overrides por env --------------------

func TestSelectModel_OverrideSimpleChatPorEnvChat(t *testing.T) {
	for _, k := range []string{
		"POS_AI_MODEL_FAST", "POS_AI_MODEL_BALANCED", "POS_AI_MODEL_POWERFUL",
		"POS_AI_MODEL_CHAT", "POS_AI_MODEL_REASONING", "POS_AI_MODEL_VISION",
	} {
		t.Setenv(k, "")
	}
	t.Setenv("POS_AI_MODEL_CHAT", "mi-chat-model")

	if got := SelectModel(ClassSimpleChat); got != "mi-chat-model" {
		t.Fatalf("SelectModel(SimpleChat) = %q, want %q", got, "mi-chat-model")
	}
	// Vision no debe cambiar con POS_AI_MODEL_CHAT.
	if got := SelectModel(ClassVision); got != fastTierModel {
		t.Fatalf("SelectModel(Vision) = %q, debería seguir en default %q (CHAT no afecta Vision)",
			got, fastTierModel)
	}
}

func TestSelectModel_OverrideSimpleChatPorEnvFast(t *testing.T) {
	// Si CHAT no está pero FAST sí, FAST aplica a SimpleChat (y a Vision).
	for _, k := range []string{
		"POS_AI_MODEL_FAST", "POS_AI_MODEL_BALANCED", "POS_AI_MODEL_POWERFUL",
		"POS_AI_MODEL_CHAT", "POS_AI_MODEL_REASONING", "POS_AI_MODEL_VISION",
	} {
		t.Setenv(k, "")
	}
	t.Setenv("POS_AI_MODEL_FAST", "mi-fast-tier")

	if got := SelectModel(ClassSimpleChat); got != "mi-fast-tier" {
		t.Fatalf("SelectModel(SimpleChat) = %q, want %q", got, "mi-fast-tier")
	}
	if got := SelectModel(ClassVision); got != "mi-fast-tier" {
		t.Fatalf("SelectModel(Vision) = %q, want %q (Vision cae a FAST cuando no hay VISION)",
			got, "mi-fast-tier")
	}
}

func TestSelectModel_PrecedenciaUsoSobreTier(t *testing.T) {
	// POS_AI_MODEL_CHAT debe ganar sobre POS_AI_MODEL_FAST para SimpleChat.
	for _, k := range []string{
		"POS_AI_MODEL_FAST", "POS_AI_MODEL_BALANCED", "POS_AI_MODEL_POWERFUL",
		"POS_AI_MODEL_CHAT", "POS_AI_MODEL_REASONING", "POS_AI_MODEL_VISION",
	} {
		t.Setenv(k, "")
	}
	t.Setenv("POS_AI_MODEL_FAST", "tier-fast")
	t.Setenv("POS_AI_MODEL_CHAT", "uso-chat")

	if got := SelectModel(ClassSimpleChat); got != "uso-chat" {
		t.Fatalf("SelectModel(SimpleChat) = %q, want %q (uso debe pisar al tier)", got, "uso-chat")
	}
}

func TestSelectModel_OverrideComplexReport(t *testing.T) {
	for _, k := range []string{
		"POS_AI_MODEL_FAST", "POS_AI_MODEL_BALANCED", "POS_AI_MODEL_POWERFUL",
		"POS_AI_MODEL_CHAT", "POS_AI_MODEL_REASONING", "POS_AI_MODEL_VISION",
	} {
		t.Setenv(k, "")
	}
	t.Setenv("POS_AI_MODEL_REASONING", "mi-reasoning")

	if got := SelectModel(ClassComplexReport); got != "mi-reasoning" {
		t.Fatalf("SelectModel(ComplexReport) = %q, want %q", got, "mi-reasoning")
	}
}

func TestSelectModel_OverrideBalancedParaComplex(t *testing.T) {
	for _, k := range []string{
		"POS_AI_MODEL_FAST", "POS_AI_MODEL_BALANCED", "POS_AI_MODEL_POWERFUL",
		"POS_AI_MODEL_CHAT", "POS_AI_MODEL_REASONING", "POS_AI_MODEL_VISION",
	} {
		t.Setenv(k, "")
	}
	t.Setenv("POS_AI_MODEL_BALANCED", "mi-balanced")

	if got := SelectModel(ClassComplexReport); got != "mi-balanced" {
		t.Fatalf("SelectModel(ComplexReport) = %q, want %q", got, "mi-balanced")
	}
}

func TestSelectModel_OverrideVision(t *testing.T) {
	for _, k := range []string{
		"POS_AI_MODEL_FAST", "POS_AI_MODEL_BALANCED", "POS_AI_MODEL_POWERFUL",
		"POS_AI_MODEL_CHAT", "POS_AI_MODEL_REASONING", "POS_AI_MODEL_VISION",
	} {
		t.Setenv(k, "")
	}
	t.Setenv("POS_AI_MODEL_VISION", "mi-vision")

	if got := SelectModel(ClassVision); got != "mi-vision" {
		t.Fatalf("SelectModel(Vision) = %q, want %q", got, "mi-vision")
	}
	// SimpleChat NO debe cambiar.
	if got := SelectModel(ClassSimpleChat); got != fastTierModel {
		t.Fatalf("SelectModel(SimpleChat) = %q, debería seguir en default", got)
	}
}

func TestSelectModel_EnvVacioOEspaciosEsIgnorado(t *testing.T) {
	// Un override con sólo espacios debe tratarse como "no seteado".
	for _, k := range []string{
		"POS_AI_MODEL_FAST", "POS_AI_MODEL_BALANCED", "POS_AI_MODEL_POWERFUL",
		"POS_AI_MODEL_CHAT", "POS_AI_MODEL_REASONING", "POS_AI_MODEL_VISION",
	} {
		t.Setenv(k, "")
	}
	t.Setenv("POS_AI_MODEL_CHAT", "   ")

	if got := SelectModel(ClassSimpleChat); got != fastTierModel {
		t.Fatalf("SelectModel(SimpleChat) = %q con env en blanco, want default %q",
			got, fastTierModel)
	}
}

// -------------------- MaxTokensFor --------------------

func TestMaxTokensFor(t *testing.T) {
	cases := []struct {
		class RequestClass
		want  int
	}{
		{ClassSimpleChat, 1024},
		{ClassComplexReport, 2048},
		{ClassVision, 4096}, // crítico: no bajar sin probar factura larga real
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.class.String(), func(t *testing.T) {
			t.Parallel()
			got := MaxTokensFor(tc.class)
			if got != tc.want {
				t.Fatalf("MaxTokensFor(%s) = %d, want %d", tc.class, got, tc.want)
			}
		})
	}
}

func TestMaxTokensFor_ClaseDesconocidaCaeASimple(t *testing.T) {
	t.Parallel()
	got := MaxTokensFor(RequestClass(99))
	if got != 1024 {
		t.Fatalf("MaxTokensFor(unknown) = %d, want 1024 (fallback)", got)
	}
}

// -------------------- Legacy helpers con env --------------------

func TestLegacyHelpers_RespetanEnv(t *testing.T) {
	for _, k := range []string{
		"POS_AI_MODEL_FAST", "POS_AI_MODEL_BALANCED", "POS_AI_MODEL_POWERFUL",
		"POS_AI_MODEL_CHAT", "POS_AI_MODEL_REASONING", "POS_AI_MODEL_VISION",
	} {
		t.Setenv(k, "")
	}

	t.Setenv("POS_AI_MODEL_FAST", "fast-x")
	t.Setenv("POS_AI_MODEL_BALANCED", "bal-x")
	t.Setenv("POS_AI_MODEL_POWERFUL", "pow-x")

	if got := FastTier(); got != "fast-x" {
		t.Errorf("FastTier() = %q, want %q", got, "fast-x")
	}
	if got := BalancedTier(); got != "bal-x" {
		t.Errorf("BalancedTier() = %q, want %q", got, "bal-x")
	}
	if got := PowerfulTier(); got != "pow-x" {
		t.Errorf("PowerfulTier() = %q, want %q", got, "pow-x")
	}
	if got := FastModel(); got != "fast-x" {
		t.Errorf("FastModel() = %q, want %q (alias de FastTier)", got, "fast-x")
	}
}

func TestLegacyHelpers_UsoRespetaOverrideDeUso(t *testing.T) {
	for _, k := range []string{
		"POS_AI_MODEL_FAST", "POS_AI_MODEL_BALANCED", "POS_AI_MODEL_POWERFUL",
		"POS_AI_MODEL_CHAT", "POS_AI_MODEL_REASONING", "POS_AI_MODEL_VISION",
	} {
		t.Setenv(k, "")
	}

	t.Setenv("POS_AI_MODEL_CHAT", "override-chat")
	t.Setenv("POS_AI_MODEL_REASONING", "override-reason")
	t.Setenv("POS_AI_MODEL_VISION", "override-vision")

	if got := ChatModel(); got != "override-chat" {
		t.Errorf("ChatModel() = %q, want %q", got, "override-chat")
	}
	if got := ReasoningModel(); got != "override-reason" {
		t.Errorf("ReasoningModel() = %q, want %q", got, "override-reason")
	}
	if got := VisionModel(); got != "override-vision" {
		t.Errorf("VisionModel() = %q, want %q", got, "override-vision")
	}
}

func TestPowerfulTier_SoloViaEnvNoEnruteoAutomatico(t *testing.T) {
	// Contrato: Opus (powerful) NUNCA entra por SelectModel automático.
	// Ninguna RequestClass del enum debería devolver powerfulTierModel
	// con env limpio.
	for _, k := range []string{
		"POS_AI_MODEL_FAST", "POS_AI_MODEL_BALANCED", "POS_AI_MODEL_POWERFUL",
		"POS_AI_MODEL_CHAT", "POS_AI_MODEL_REASONING", "POS_AI_MODEL_VISION",
	} {
		t.Setenv(k, "")
	}

	for _, c := range []RequestClass{ClassSimpleChat, ClassComplexReport, ClassVision} {
		if got := SelectModel(c); got == powerfulTierModel {
			t.Errorf("SelectModel(%s) devolvió powerful (%q) sin override; Opus no debe enrutarse automáticamente",
				c, got)
		}
	}
	// Pero sí debe ser accesible como override explícito.
	if got := PowerfulTier(); got != powerfulTierModel {
		t.Errorf("PowerfulTier() = %q, want %q", got, powerfulTierModel)
	}
}

func TestDefaultsCompilados_ModelosOficialesVigentes(t *testing.T) {
	// Contrato costo/calidad validado contra la tabla oficial de Anthropic:
	// Haiku para alto volumen, Sonnet para razonamiento y Opus sólo explícito.
	// Si se actualiza de generación, este test obliga a revisar los tres tiers
	// y la documentación operativa en AI_MODELS.md juntos.
	if fastTierModel != "claude-haiku-5-5" {
		t.Fatalf("fastTierModel = %q, want claude-haiku-5-5", fastTierModel)
	}
	if balancedTierModel != "claude-sonnet-5-5" {
		t.Fatalf("balancedTierModel = %q, want claude-sonnet-5-5", balancedTierModel)
	}
	if powerfulTierModel != "claude-opus-5-5" {
		t.Fatalf("powerfulTierModel = %q, want claude-opus-5-5", powerfulTierModel)
	}
}

// -------------------- Defaults compilados (IDs plausibles) --------------------

func TestDefaultsCompilados_IDsPlausibles(t *testing.T) {
	// Guard rail: los defaults deben parecer IDs reales de Anthropic.
	// No podemos validar contra la API (está prohibido tocar red en tests
	// unitarios) pero sí podemos chequear forma: prefijo "claude-", contiene
	// la familia esperada, no es una cadena vacía ni placeholder obvio.
	cases := []struct {
		name   string
		got    string
		family string
	}{
		{"fast tier es haiku", fastTierModel, "haiku"},
		{"balanced tier es sonnet", balancedTierModel, "sonnet"},
		{"powerful tier es opus", powerfulTierModel, "opus"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if tc.got == "" {
				t.Fatal("ID vacío")
			}
			if !hasPrefix(tc.got, "claude-") {
				t.Errorf("ID %q no empieza con 'claude-'", tc.got)
			}
			if !containsSubstr(tc.got, tc.family) {
				t.Errorf("ID %q no contiene la familia %q", tc.got, tc.family)
			}
		})
	}
}

// -------------------- helpers de test (evitamos nueva dependencia) --------------------

func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

func containsSubstr(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
