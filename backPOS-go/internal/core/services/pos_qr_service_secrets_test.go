package services

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// =========================================================================
// Guardianes estáticos del flujo QR.
//
// Replican el patrón de TestNoAutoWriteToVisitDaysOrDeliveryDays:
// escanean la fuente de los archivos del flujo QR y fallan la build si
// aparecen patrones peligrosos de concatenación de secretos a logs,
// errores o persistencia.
//
// NUNCA desactivar estos tests: si una modificación legítima requiere
// cambiar el patrón, hay que explicarlo en el commit y añadir una
// excepción explícita documentada.
// =========================================================================

func TestPosQrServiceDoesNotLeakSecretsIntoLogsOrErrors(t *testing.T) {
	files := []string{
		"pos_qr_service.go",
		"pos_qr_async_dispatcher.go",
	}
	// Patrón: tokens o secretos pasados por valor a log/fmt.Errorf/
	// errors.New/MarkFinalizationFailed. La forma típica es
	// `os.Getenv("BOLD_BRIDGE_TOKEN")` o `BOLD_BRIDGE_TOKEN` como
	// variable/identificador dentro de la lista de argumentos. Si
	// aparecen esos patrones Y están DENTRO de una llamada a log o a
	// construcción de error, estamos leakeando el valor.
	//
	// Deliberadamente permitimos que la cadena LITERAL "BOLD_SECRET_KEY"
	// aparezca dentro de un string (p.ej. "AVISO: BOLD_SECRET_KEY no
	// configurada") porque eso es sólo el nombre, no el valor. Para
	// distinguir, exigimos `os.Getenv(` o `envBold` prefix (identificadores
	// de código) antes del nombre del secreto.
	badPatterns := []*regexp.Regexp{
		regexp.MustCompile(`log\.(?:Printf|Println|Fatalf)\s*\([^)]*os\.Getenv\s*\(\s*"BOLD_(?:BRIDGE_TOKEN|SECRET_KEY)"`),
		regexp.MustCompile(`(?:fmt\.Errorf|errors\.New)\s*\([^)]*os\.Getenv\s*\(\s*"BOLD_(?:BRIDGE_TOKEN|SECRET_KEY)"`),
		regexp.MustCompile(`MarkFinalizationFailed\s*\([^)]*os\.Getenv\s*\(\s*"BOLD_(?:BRIDGE_TOKEN|SECRET_KEY)"`),
		// También detecta uso de los alias de variable del package
		// `envBoldBridgeToken` / `envBoldSecretKey` concatenados a logs.
		regexp.MustCompile(`log\.(?:Printf|Println|Fatalf)\s*\([^)]*envBold(?:BridgeToken|SecretKey)\b`),
		regexp.MustCompile(`(?:fmt\.Errorf|errors\.New)\s*\([^)]*envBold(?:BridgeToken|SecretKey)\b`),
	}
	for _, name := range files {
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("no se pudo leer %s: %v", name, err)
		}
		src := string(raw)
		for _, pat := range badPatterns {
			if loc := pat.FindStringIndex(src); loc != nil {
				start := loc[0]
				end := loc[1]
				context := src[maxZero(start-40):minLen(end+40, len(src))]
				t.Errorf("%s: patrón prohibido %q cerca de:\n%s",
					name, pat.String(), strings.ReplaceAll(context, "\n", "\\n"))
			}
		}
	}
}

// TestSanitizeFinalizationErrorRedactsSecrets verifica el filtro
// defensivo que corre al persistir finalization_last_error. El valor
// del token NUNCA debe quedar en el mensaje después de pasar por el
// sanitizador.
func TestSanitizeFinalizationErrorRedactsSecrets(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		in   string
		want string // substring que DEBE estar presente
		bad  string // substring que NO debe aparecer
	}{
		{
			name: "regex detecta BOLD_BRIDGE_TOKEN=valor",
			in:   "fallo HTTP: BOLD_BRIDGE_TOKEN=supersecret123 remoto no respondió",
			want: "[REDACTED]",
			bad:  "supersecret123",
		},
		{
			name: "regex detecta X-Bridge-Token header",
			in:   "config inválida: X-Bridge-Token=abc.def.ghi en logs",
			want: "[REDACTED]",
			bad:  "abc.def.ghi",
		},
		{
			name: "env runtime bloquea literal",
			env:  map[string]string{"BOLD_BRIDGE_TOKEN": "token-de-prod-largo-x"},
			in:   "no pude parsear total token-de-prod-largo-x detrás del parser",
			want: "[REDACTED]",
			bad:  "token-de-prod-largo-x",
		},
		{
			name: "mensaje genérico no cambia",
			in:   "producto no encontrado: ABC123",
			want: "producto no encontrado",
			bad:  "", // nada que esconder
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Setup env para el caso de defensa en profundidad.
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			got := sanitizeFinalizationError(tc.in)
			if !strings.Contains(got, tc.want) {
				t.Errorf("want substring %q, got %q", tc.want, got)
			}
			if tc.bad != "" && strings.Contains(got, tc.bad) {
				t.Errorf("got %q — contiene secreto filtrado %q", got, tc.bad)
			}
			if len(got) > 200 {
				t.Errorf("sanitize no truncó a 200 chars: len=%d", len(got))
			}
		})
	}
}

// =========================================================================
// Guardián operativo: AMBIGUOUS jamás dispara CreateSale.
//
// Esta prueba estática asegura que la rama AMBIGUOUS de
// publishWebhookOutcome publique eventos SSE pero NUNCA invoque
// triggerAutoSale ni DispatchAutoSale ni s.saleService.CreateSale.
// Es un chequeo de texto para blindaje: si alguien reintroduce la
// llamada en esa rama, el test falla.
// =========================================================================

func TestAmbiguousBranchNeverTriggersAutoSale(t *testing.T) {
	raw, err := os.ReadFile("pos_qr_service.go")
	if err != nil {
		t.Fatalf("read pos_qr_service.go: %v", err)
	}
	src := string(raw)

	// Localizar el bloque que arranca con el comentario que menciona
	// "AMBIGUOUS" en `publishWebhookOutcome` y termina en el `return`.
	idx := strings.Index(src, "ProcessedStatus == models.QRWebhookStatusAmbiguous")
	if idx < 0 {
		t.Fatal("no se encontró la rama AMBIGUOUS en publishWebhookOutcome")
	}
	// Mirar los siguientes ~800 chars de la rama (suficiente para la
	// implementación actual) y buscar llamadas prohibidas.
	window := src[idx:minLen(idx+800, len(src))]
	for _, forbidden := range []string{
		"triggerAutoSale(",
		"DispatchAutoSale(",
		"saleService.CreateSale(",
		"s.saleService",
	} {
		if strings.Contains(window, forbidden) {
			t.Errorf("rama AMBIGUOUS invoca %q — viola invariante: 2+ pendientes mismo monto NUNCA deben facturarse automáticamente", forbidden)
		}
	}
}

func maxZero(x int) int {
	if x < 0 {
		return 0
	}
	return x
}

func minLen(a, b int) int {
	if a < b {
		return a
	}
	return b
}
