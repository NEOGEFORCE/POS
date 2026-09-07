package handlers

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// TestHistoricalMarkerReservedResponseMatchesTypedError verifica el contrato
// del helper: al recibir el tipo del dominio devuelve 409 con code
// HISTORICAL_MARKER_RESERVED, mensaje breve (no instructivo) y la metadata
// exacta con realBarcode, markerBarcode y markerName. El frontend depende de
// esa forma para armar el modal de fusión.
func TestHistoricalMarkerReservedResponseMatchesTypedError(t *testing.T) {
	// Semántica del conflicto: el producto real vive en '7700000000001'; el
	// operador intenta renombrarlo a '7701234567890', que está retenido por
	// un marcador '[HISTORICO]'. Ambos códigos SIEMPRE son distintos en un
	// conflicto real; si fueran iguales el UPDATE se saltaría el chequeo de
	// colisión (targetBarcode == barcode) y no habría 409 que devolver.
	// Este test protege la distinción para que el frontend arme el body
	// correcto de /admin/products/merge-historical.
	src := &models.HistoricalMarkerReservedError{
		RealBarcode:   "7700000000001",
		MarkerBarcode: "7701234567890",
		MarkerName:    "[HISTORICO] COCA COLA 350ML",
	}

	status, apiErr, ok := historicalMarkerReservedResponse(src)
	if !ok {
		t.Fatal("historicalMarkerReservedResponse debía reconocer el tipo")
	}
	if status != 409 {
		t.Fatalf("status = %d; want 409", status)
	}
	if apiErr.Code != ErrHistoricalMarkerReserved {
		t.Fatalf("code = %q; want %q", apiErr.Code, ErrHistoricalMarkerReserved)
	}
	if apiErr.Code != "HISTORICAL_MARKER_RESERVED" {
		t.Fatalf("code literal = %q; want HISTORICAL_MARKER_RESERVED (contrato con el frontend)", apiErr.Code)
	}
	if apiErr.Message == "" {
		t.Fatal("message vacío: el frontend espera un texto breve para el toast")
	}
	// El mensaje no debe filtrar instrucciones internas.
	forbidden := []string{"/admin/products/merge-historical", "POST ", "corregir_referencias"}
	for _, needle := range forbidden {
		if strings.Contains(apiErr.Message, needle) {
			t.Fatalf("message no debe filtrar %q: %q", needle, apiErr.Message)
		}
	}

	meta, ok := apiErr.Metadata.(map[string]string)
	if !ok {
		t.Fatalf("metadata debía ser map[string]string; got %T", apiErr.Metadata)
	}
	wantMeta := map[string]string{
		"realBarcode":   "7700000000001",
		"markerBarcode": "7701234567890",
		"markerName":    "[HISTORICO] COCA COLA 350ML",
	}
	for k, want := range wantMeta {
		if got := meta[k]; got != want {
			t.Fatalf("metadata[%q] = %q; want %q", k, got, want)
		}
	}
	if len(meta) != len(wantMeta) {
		t.Fatalf("metadata tiene claves extra: %+v", meta)
	}
}

// TestHistoricalMarkerReservedResponseUnwrapsThroughFmt verifica que el
// helper detecta el tipo aún cuando venga envuelto en la cadena de errores,
// que es lo que ocurre en el flujo real: repositorio devuelve el tipo,
// ProductService lo envuelve con fmt.Errorf("...: %w"), y el handler recibe
// el error compuesto.
func TestHistoricalMarkerReservedResponseUnwrapsThroughFmt(t *testing.T) {
	src := &models.HistoricalMarkerReservedError{
		RealBarcode:   "ABC",
		MarkerBarcode: "ABC",
		MarkerName:    "[HISTORICO] ABC",
	}
	wrapped := fmt.Errorf("error al persistir producto: %w", src)

	status, apiErr, ok := historicalMarkerReservedResponse(wrapped)
	if !ok {
		t.Fatalf("historicalMarkerReservedResponse debía atravesar %%w: %v", wrapped)
	}
	if status != 409 {
		t.Fatalf("status = %d; want 409", status)
	}
	meta, ok := apiErr.Metadata.(map[string]string)
	if !ok {
		t.Fatalf("metadata debía ser map[string]string; got %T", apiErr.Metadata)
	}
	if meta["markerName"] != "[HISTORICO] ABC" {
		t.Fatalf("metadata perdida al desenrollar: %+v", meta)
	}
}

// TestHistoricalMarkerReservedResponseRejectsOthers evita falsos positivos.
// Si el error es cualquier otro, el helper debe devolver ok=false para que
// el handler siga con su ruta normal (404, 500, etc.). Sin este chequeo, un
// error genérico podría acabar disfrazado de 409.
func TestHistoricalMarkerReservedResponseRejectsOthers(t *testing.T) {
	cases := []struct {
		name string
		err  error
	}{
		{name: "nil", err: nil},
		{name: "generico", err: errors.New("cualquier otro error")},
		{name: "duplicado_generico", err: errors.New("el código de barras X ya pertenece a otro producto")},
		{name: "typed_nil", err: (*models.HistoricalMarkerReservedError)(nil)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, ok := historicalMarkerReservedResponse(tc.err)
			if ok {
				t.Fatalf("historicalMarkerReservedResponse debía rechazar %v", tc.err)
			}
		})
	}
}

// (helper local eliminado: se usa strings.Contains directamente en las
// aserciones porque strings ya está importado.)
