package services

import (
	"encoding/json"
	"strings"
	"testing"
)

// =============================================================================
// Contrato del body que se envía a Anthropic en el OCR de facturas.
//
// Estos tests blindan dos invariantes clave:
//
//  1. `temperature` NUNCA se envía. Anthropic rechazó requests con
//     HTTP 400 invalid_request_error apuntando a este campo en los modelos
//     vigentes del tier de visión; dejar que el modelo use su temperatura
//     por defecto es seguro para OCR estructurado. Reintroducir el campo
//     volvería a romper el lector de facturas en producción silenciosamente
//     (el usuario solo verá "no se pudo procesar la factura").
//
//  2. `model`, `max_tokens` y `messages` siguen presentes, con la forma que
//     el pipeline del lector espera: una sola imagen base64 con media_type,
//     un bloque de texto con el prompt, y un max_tokens configurable para
//     que el reintento con techo doble (8192) no se pierda al pasar por el
//     helper.
//
// También se blinda el helper de observabilidad segura
// (`summarizeClaudeUpstreamError`): nunca devuelve texto del mensaje, sólo
// `error.type` y categorías de campo de la allowlist.
// =============================================================================

// -------------------- buildClaudeVisionRequestBody --------------------

func TestBuildClaudeVisionRequestBody_NoEnviaTemperature(t *testing.T) {
	t.Parallel()
	body := buildClaudeVisionRequestBody("claude-haiku-5-5", "FAKEBASE64", "image/jpeg", "prompt", 4096)
	if _, has := body["temperature"]; has {
		t.Fatalf("`temperature` no debe estar en el body: %#v", body)
	}

	// También verificamos via el JSON serializado real: una entrada
	// `temperature` oculta vendría de map[string]interface{} con key en otra
	// forma; serializar y buscar la clave es la prueba final.
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("no se pudo serializar body: %v", err)
	}
	if strings.Contains(string(raw), `"temperature"`) {
		t.Fatalf("el JSON serializado NO debe contener la clave temperature: %s", string(raw))
	}
}

func TestBuildClaudeVisionRequestBody_CamposObligatoriosPresentes(t *testing.T) {
	t.Parallel()
	body := buildClaudeVisionRequestBody("claude-haiku-5-5", "FAKEBASE64", "image/jpeg", "mi-prompt", 4096)

	if got, want := body["model"], "claude-haiku-5-5"; got != want {
		t.Errorf("model: got %v, want %v", got, want)
	}
	if got, want := body["max_tokens"], 4096; got != want {
		t.Errorf("max_tokens: got %v, want %v", got, want)
	}
	msgs, ok := body["messages"].([]map[string]interface{})
	if !ok || len(msgs) != 1 {
		t.Fatalf("messages debe ser slice de un único mensaje: %#v", body["messages"])
	}
	if role, _ := msgs[0]["role"].(string); role != "user" {
		t.Errorf("messages[0].role: got %q, want \"user\"", role)
	}
	content, _ := msgs[0]["content"].([]map[string]interface{})
	if len(content) != 2 {
		t.Fatalf("content debe tener 2 bloques (image + text), got %d", len(content))
	}
	// Bloque imagen con media_type + data en base64.
	if content[0]["type"] != "image" {
		t.Errorf("content[0].type = %v, want image", content[0]["type"])
	}
	src, _ := content[0]["source"].(map[string]interface{})
	if src["type"] != "base64" || src["media_type"] != "image/jpeg" || src["data"] != "FAKEBASE64" {
		t.Errorf("source mal armado: %#v", src)
	}
	// Bloque de texto con el prompt tal cual.
	if content[1]["type"] != "text" || content[1]["text"] != "mi-prompt" {
		t.Errorf("content[1] no transporta el prompt: %#v", content[1])
	}
}

func TestBuildClaudeVisionRequestBody_Preserva8192EnReintento(t *testing.T) {
	// El pipeline duplica el max_tokens en el reintento: 4096 → 8192.
	// Si el helper truncase el valor (por capping defensivo mal pensado o
	// por asumir el default compilado), el segundo intento sería inútil
	// para facturas largas. Este test blinda el pass-through exacto.
	t.Parallel()

	body := buildClaudeVisionRequestBody("claude-haiku-5-5", "img", "image/png", "prompt", 8192)

	got, ok := body["max_tokens"].(int)
	if !ok {
		t.Fatalf("max_tokens debe ser int, got %T", body["max_tokens"])
	}
	if got != 8192 {
		t.Fatalf("max_tokens debe preservar 8192 cuando se pasa, got %d", got)
	}

	// Y en la serialización final (sin cuantización ni redondeo numérico).
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"max_tokens":8192`) {
		t.Fatalf("JSON serializado debe mantener 8192: %s", string(raw))
	}
}

func TestBuildClaudeVisionRequestBody_SoloContieneClavesEsperadas(t *testing.T) {
	// Guardia explícita: ningún campo adicional (temperature, top_p, top_k,
	// system, stop_sequences, metadata) debe filtrarse al body. Si un sprint
	// futuro agrega una clave, debe pasar también por este contrato y
	// documentar la razón.
	t.Parallel()
	body := buildClaudeVisionRequestBody("m", "img", "image/jpeg", "p", 4096)
	allowed := map[string]struct{}{
		"model":      {},
		"max_tokens": {},
		"messages":   {},
	}
	for key := range body {
		if _, ok := allowed[key]; !ok {
			t.Errorf("clave inesperada en body: %q (sólo deben viajar model/max_tokens/messages)", key)
		}
	}
}

// -------------------- doClaudeVisionAttempt usa el helper --------------------

// TestDoClaudeVisionAttempt_UsaBuildHelper deja constancia estructural de que
// `doClaudeVisionAttempt` arma su body a través del helper puro. No podemos
// interceptar la llamada HTTP sin reescribir el cliente, pero sí podemos
// garantizar que el helper produce el shape canónico que la Messages API
// aceptó históricamente; si alguien reintroduce `temperature` dentro de
// doClaudeVisionAttempt sin pasar por el helper, el test de "no_temperature"
// seguiría pasando pero fallaría en Anthropic. Este test documenta la
// expectativa en nombre, no bloquea refactors.
func TestDoClaudeVisionAttempt_UsaBuildHelper(t *testing.T) {
	t.Parallel()
	// Verificación de regresión indirecta: si el helper deja de incluir
	// alguna de las claves obligatorias, el caller producirá requests que
	// Anthropic rechaza y los otros tests ya cubren ese desvío. Aquí sólo
	// confirmamos que llamar al helper con los mismos argumentos que el
	// caller construye un body no vacío con las 3 claves obligatorias.
	body := buildClaudeVisionRequestBody(SelectModel(ClassVision), "img", "image/jpeg", "p", MaxTokensFor(ClassVision))
	for _, k := range []string{"model", "max_tokens", "messages"} {
		if _, ok := body[k]; !ok {
			t.Fatalf("body construido por el caller perdió la clave %q: %#v", k, body)
		}
	}
	if _, ok := body["temperature"]; ok {
		t.Fatalf("body construido por el caller volvió a incluir temperature: %#v", body)
	}
}

// -------------------- summarizeClaudeUpstreamError --------------------

func TestSummarizeClaudeUpstreamError_ExtraeTipoYCategorias(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name         string
		body         string
		wantType     string
		wantCategory []string
	}{
		{
			name:         "temperature rechazada",
			body:         `{"type":"error","error":{"type":"invalid_request_error","message":"temperature: Extra inputs are not permitted"}}`,
			wantType:     "invalid_request_error",
			wantCategory: []string{"TEMPERATURE"},
		},
		{
			name:         "model y max_tokens citados",
			body:         `{"type":"error","error":{"type":"invalid_request_error","message":"invalid model id for max_tokens limit"}}`,
			wantType:     "invalid_request_error",
			wantCategory: []string{"MODEL", "MAX_TOKENS"},
		},
		{
			name:         "mensaje vacio devuelve solo tipo",
			body:         `{"type":"error","error":{"type":"authentication_error","message":""}}`,
			wantType:     "authentication_error",
			wantCategory: nil,
		},
		{
			name:         "campo fuera de la allowlist no se escapa al log",
			body:         `{"type":"error","error":{"type":"invalid_request_error","message":"producto COCA-COLA 400ML no reconocido en linea 42"}}`,
			wantType:     "invalid_request_error",
			wantCategory: nil,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			gotType, gotCats := summarizeClaudeUpstreamError([]byte(tc.body))
			if gotType != tc.wantType {
				t.Errorf("errorType = %q, want %q", gotType, tc.wantType)
			}
			if !equalStringSlice(gotCats, tc.wantCategory) {
				t.Errorf("fieldCategories = %v, want %v", gotCats, tc.wantCategory)
			}
		})
	}
}

func TestSummarizeClaudeUpstreamError_NuncaDevuelveMensajeOriginal(t *testing.T) {
	t.Parallel()
	// Un mensaje "evocador" que menciona un campo del protocolo + datos de
	// la factura (nombres de productos, precios): el summarizer sólo debe
	// devolver el tipo y la categoría MODEL, nunca el texto completo.
	body := `{"type":"error","error":{"type":"invalid_request_error","message":"invalid model: pepsi 1.5L sold at 3500 pesos line 3"}}`
	errorType, cats := summarizeClaudeUpstreamError([]byte(body))
	if errorType != "invalid_request_error" {
		t.Errorf("errorType = %q", errorType)
	}
	// Verificar que ninguna categoría contenga datos de factura.
	for _, c := range cats {
		if strings.Contains(strings.ToLower(c), "pepsi") || strings.Contains(c, "3500") {
			t.Fatalf("summary filtró contenido de factura: %v", cats)
		}
	}
}

func TestSummarizeClaudeUpstreamError_BodyInvalidoDevuelveVacio(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		body []byte
	}{
		{"vacio", nil},
		{"no es json", []byte("gateway timeout")},
		{"json pero no tiene shape de error", []byte(`{"foo":"bar"}`)},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			errorType, cats := summarizeClaudeUpstreamError(tc.body)
			if errorType != "" || cats != nil {
				t.Fatalf("input inválido debe devolver vacío, got type=%q cats=%v", errorType, cats)
			}
		})
	}
}

func TestSummarizeClaudeUpstreamError_AllowlistCubreCamposDelProtocolo(t *testing.T) {
	t.Parallel()
	// Blinda el inventario de la allowlist contra ediciones accidentales:
	// cada entrada debe ser un nombre real del protocolo Messages API, no
	// prosa libre.
	expected := []string{
		"model", "max_tokens", "messages", "temperature",
		"system", "stop_sequences", "top_k", "top_p",
		"metadata", "tools", "tool_choice",
		"anthropic-version", "anthropic-beta",
	}
	if len(claudeErrorFieldAllowlist) != len(expected) {
		t.Fatalf("allowlist tiene %d entradas, se esperaban %d", len(claudeErrorFieldAllowlist), len(expected))
	}
	seen := make(map[string]struct{}, len(expected))
	for _, f := range expected {
		seen[f] = struct{}{}
	}
	for _, f := range claudeErrorFieldAllowlist {
		if _, ok := seen[f]; !ok {
			t.Errorf("campo inesperado en allowlist: %q", f)
		}
	}
}

// -------------------- helpers --------------------

func equalStringSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
