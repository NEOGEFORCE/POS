package services

import (
	"encoding/json"
	"errors"
	"testing"
)

func makeClaudeInvoiceResponse(t *testing.T, stopReason string, blocks ...map[string]string) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"stop_reason": stopReason,
		"content":     blocks,
	})
	if err != nil {
		t.Fatalf("no se pudo construir respuesta de prueba: %v", err)
	}
	return body
}

func textBlock(text string) map[string]string {
	return map[string]string{"type": "text", "text": text}
}

func TestParseClaudeInvoiceResponse_IgnoraPrimerBloqueSinTexto(t *testing.T) {
	body := makeClaudeInvoiceResponse(t, "end_turn",
		map[string]string{"type": "thinking", "text": ""},
		textBlock(`[{"name":"LECHE","quantity":2,"unitPrice":3500,"totalPrice":7000}]`),
	)

	items, err := parseClaudeInvoiceResponse(body)
	if err != nil {
		t.Fatalf("debía encontrar el bloque text posterior: %v", err)
	}
	if len(items) != 1 || items[0].Name != "LECHE" || items[0].Quantity != 2 {
		t.Fatalf("items inesperados: %+v", items)
	}
}

func TestParseClaudeInvoiceResponse_RecomponeBloquesDeTextoSegmentados(t *testing.T) {
	body := makeClaudeInvoiceResponse(t, "end_turn",
		textBlock(`[{"name":"CAFE",`),
		textBlock(`"quantity":1,"unitPrice":12000,"totalPrice":12000}]`),
	)

	items, err := parseClaudeInvoiceResponse(body)
	if err != nil {
		t.Fatalf("debía probar la concatenación de bloques: %v", err)
	}
	if len(items) != 1 || items[0].Name != "CAFE" {
		t.Fatalf("items inesperados: %+v", items)
	}
}

func TestParseClaudeInvoiceResponse_AceptaCercosYTextoAccidental(t *testing.T) {
	cases := []struct {
		name string
		text string
	}{
		{
			name: "markdown json",
			text: "```json\n[{\"name\":\"PAN\",\"quantity\":3,\"unitPrice\":1000,\"totalPrice\":3000}]\n```",
		},
		{
			name: "frase alrededor",
			text: "Resultado extraído:\n[{\"name\":\"PAN\",\"quantity\":3,\"unitPrice\":1000,\"totalPrice\":3000}]\nFin.",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			items, err := parseClaudeInvoiceResponse(makeClaudeInvoiceResponse(t, "end_turn", textBlock(tc.text)))
			if err != nil {
				t.Fatalf("respuesta recuperable rechazada: %v", err)
			}
			if len(items) != 1 || items[0].Name != "PAN" {
				t.Fatalf("items inesperados: %+v", items)
			}
		})
	}
}

func TestParseClaudeInvoiceResponse_MaxTokensNuncaAceptaFacturaParcial(t *testing.T) {
	// Incluso si el prefijo alcanzó a formar JSON válido, stop_reason=max_tokens
	// no garantiza que Claude hubiera terminado de enumerar todas las líneas.
	body := makeClaudeInvoiceResponse(t, "max_tokens",
		textBlock(`[{"name":"PRIMER ITEM","quantity":1,"unitPrice":1000,"totalPrice":1000}]`),
	)

	_, err := parseClaudeInvoiceResponse(body)
	if !errors.Is(err, errClaudeOutputRetryable) {
		t.Fatalf("max_tokens debe pedir reintento, got %v", err)
	}
}

func TestParseClaudeInvoiceResponse_VacioOTruncadoPideReintento(t *testing.T) {
	cases := []struct {
		name   string
		blocks []map[string]string
	}{
		{name: "sin content"},
		{name: "text vacío", blocks: []map[string]string{textBlock("   ")}},
		{name: "json truncado", blocks: []map[string]string{textBlock(`[{"name":"LECHE","quantity":2`)}},
		{name: "null", blocks: []map[string]string{textBlock("null")}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseClaudeInvoiceResponse(makeClaudeInvoiceResponse(t, "end_turn", tc.blocks...))
			if !errors.Is(err, errClaudeOutputRetryable) {
				t.Fatalf("salida %s debe pedir reintento, got %v", tc.name, err)
			}
		})
	}
}

func TestParseClaudeInvoiceResponse_AceptaArregloVacioCompleto(t *testing.T) {
	items, err := parseClaudeInvoiceResponse(makeClaudeInvoiceResponse(t, "end_turn", textBlock("[]")))
	if err != nil {
		t.Fatalf("[] es una respuesta estructurada válida: %v", err)
	}
	if items == nil || len(items) != 0 {
		t.Fatalf("se esperaba slice vacío no nil, got %#v", items)
	}
}

// TestParseClaudeInvoiceResponse_DosArreglosCompletosEnBloquesDistintosPideReintento
// cubre el caso en que Claude emite dos arreglos JSON completos en bloques
// `text` separados. El flujo combinado NO es un único JSON seguro: aceptar
// solo el primer bloque devolvería una factura parcial (el bug previo), y
// fusionar/concatenar los dos arreglos inventaría una línea de factura que
// Claude nunca garantizó como un único resultado coherente. El contrato es:
// error retryable para que el servicio active su único reintento con mayor
// presupuesto de tokens, sin tocar los datos.
func TestParseClaudeInvoiceResponse_DosArreglosCompletosEnBloquesDistintosPideReintento(t *testing.T) {
	body := makeClaudeInvoiceResponse(t, "end_turn",
		textBlock(`[{"name":"LECHE","quantity":2,"unitPrice":3500,"totalPrice":7000}]`),
		textBlock(`[{"name":"PAN","quantity":1,"unitPrice":1000,"totalPrice":1000}]`),
	)

	items, err := parseClaudeInvoiceResponse(body)
	if err == nil {
		t.Fatalf("dos arreglos completos separados no deben aceptarse como factura; items=%+v", items)
	}
	if !errors.Is(err, errClaudeOutputRetryable) {
		t.Fatalf("debe pedir reintento (errClaudeOutputRetryable), got %v", err)
	}

	// Garantía explícita: no se acepta una factura parcial del primer bloque.
	if items != nil {
		t.Fatalf("no debe devolver items parciales ante dos arreglos separados: %+v", items)
	}
}

// TestParseClaudeInvoiceResponse_ArregloConArregloExtraEnMismoBloquePideReintento
// cubre la variante donde Claude emite ambos arreglos dentro de un único
// bloque `text` ("[arr1][arr2]"). El contrato es el mismo: no se puede
// decidir cuál arreglo es la factura real y no se mezclan; se reintenta.
func TestParseClaudeInvoiceResponse_ArregloConArregloExtraEnMismoBloquePideReintento(t *testing.T) {
	body := makeClaudeInvoiceResponse(t, "end_turn",
		textBlock(`[{"name":"LECHE","quantity":2,"unitPrice":3500,"totalPrice":7000}][{"name":"PAN","quantity":1,"unitPrice":1000,"totalPrice":1000}]`),
	)

	items, err := parseClaudeInvoiceResponse(body)
	if err == nil {
		t.Fatalf("dos arreglos consecutivos en un mismo bloque no son un JSON seguro; items=%+v", items)
	}
	if !errors.Is(err, errClaudeOutputRetryable) {
		t.Fatalf("debe pedir reintento, got %v", err)
	}
}
