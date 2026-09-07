package handlers

import (
	"encoding/json"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// TestHistoricalMarkerReservedJSONContract verifica que la serialización JSON
// del ErrorResponse que emite el handler coincida EXACTAMENTE con el shape
// que consume el frontend (src/lib/historical-marker.mjs).
//
// Este test es el pin del contrato entre Go y Next. Si algún día alguien
// cambia los json tags de APIError/ErrorResponse (por ejemplo, renombrando
// `metadata` a `meta`), o si se decide dejar de anidar el error bajo
// `error`, este test falla antes de que el frontend se rompa en producción.
//
// El frontend detecta el 409 vía `data.error.code === HISTORICAL_MARKER_RESERVED`
// y extrae la metadata desde `data.error.metadata.{realBarcode,markerBarcode,markerName}`.
// Ver tests/historical-marker.test.mjs (test "detecta el 409 aunque el code
// venga anidado en data.error").
func TestHistoricalMarkerReservedJSONContract(t *testing.T) {
	src := &models.HistoricalMarkerReservedError{
		RealBarcode:   "7700000000001",
		MarkerBarcode: "7701234567890",
		MarkerName:    "[HISTORICO] COCA COLA 350ML",
	}

	_, apiErr, ok := historicalMarkerReservedResponse(src)
	if !ok {
		t.Fatal("historicalMarkerReservedResponse debía reconocer el tipo")
	}

	// El handler emite este envelope exacto (ver product_handler.go, ruta
	// PUT /products/update-products/:barcode, rama "matched").
	envelope := ErrorResponse{
		Success: false,
		Message: apiErr.Message,
		Error:   apiErr,
	}

	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("json.Marshal falló: %v", err)
	}

	// Re-unmarshal a map para inspeccionar sin depender del orden de claves
	// (Go no garantiza orden estable en maps).
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("json.Unmarshal falló sobre %s: %v", raw, err)
	}

	// Raíz: success, message y error. NO deben aparecer claves fantasma.
	if success, _ := out["success"].(bool); success {
		t.Fatalf("success debe ser false; got %v (raw=%s)", out["success"], raw)
	}
	if msg, _ := out["message"].(string); msg == "" {
		t.Fatalf("message vacío; raw=%s", raw)
	}
	// La raíz sólo debe tener exactamente estas tres claves (contrato
	// mínimo). Cualquier clave extra rompería el parser del frontend o
	// introduciría ambigüedad.
	for k := range out {
		switch k {
		case "success", "message", "error":
		default:
			t.Fatalf("raíz tiene clave inesperada %q; raw=%s", k, raw)
		}
	}

	errorObj, ok := out["error"].(map[string]any)
	if !ok {
		t.Fatalf("`error` debe ser objeto; got %T (raw=%s)", out["error"], raw)
	}

	// Contrato con el frontend: code === HISTORICAL_MARKER_RESERVED.
	if code, _ := errorObj["code"].(string); code != "HISTORICAL_MARKER_RESERVED" {
		t.Fatalf("error.code = %q; want HISTORICAL_MARKER_RESERVED (raw=%s)", code, raw)
	}
	// El message se copia en el envelope y dentro de error.message; ambos
	// son cadena no vacía.
	if msg, _ := errorObj["message"].(string); msg == "" {
		t.Fatalf("error.message vacío; raw=%s", raw)
	}

	// details lleva `omitempty`; en este caso NO debe aparecer porque el
	// helper no lo setea. Si aparece, es una regresión: la traducción
	// automática filtraría texto interno hacia el usuario final.
	if _, present := errorObj["details"]; present {
		t.Fatalf("error.details no debe aparecer para HISTORICAL_MARKER_RESERVED; raw=%s", raw)
	}

	metadata, ok := errorObj["metadata"].(map[string]any)
	if !ok {
		t.Fatalf("error.metadata debe ser objeto; got %T (raw=%s)", errorObj["metadata"], raw)
	}
	// Las tres claves exactas — y sólo estas — que consume el frontend. Y
	// realBarcode ≠ markerBarcode: si fueran iguales, el endpoint admin
	// rechazaría la fusión con "no pueden ser iguales" y el helper
	// buildMergeRequest devolvería null. La invariante nace del contexto:
	// solo hay conflicto cuando el operador quiere reasignar un código
	// distinto al actual.
	wantMeta := map[string]string{
		"realBarcode":   "7700000000001",
		"markerBarcode": "7701234567890",
		"markerName":    "[HISTORICO] COCA COLA 350ML",
	}
	for k, want := range wantMeta {
		got, ok := metadata[k].(string)
		if !ok {
			t.Fatalf("error.metadata[%q] debe ser string; got %T (raw=%s)", k, metadata[k], raw)
		}
		if got != want {
			t.Fatalf("error.metadata[%q] = %q; want %q (raw=%s)", k, got, want, raw)
		}
	}
	if len(metadata) != len(wantMeta) {
		t.Fatalf("error.metadata tiene claves extra: %+v (raw=%s)", metadata, raw)
	}
	if metadata["realBarcode"] == metadata["markerBarcode"] {
		t.Fatalf("realBarcode y markerBarcode NO pueden coincidir: la fusión los quiere distintos (raw=%s)", raw)
	}
}
