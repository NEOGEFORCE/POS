package models

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// TestHistoricalMarkerReservedErrorMessage verifica que Error() nombre el
// barcode y el nombre del marcador sin filtrar comandos internos ni rutas
// administrativas. Esos datos viajan como metadata en la capa HTTP, no dentro
// del texto del error.
func TestHistoricalMarkerReservedErrorMessage(t *testing.T) {
	err := &HistoricalMarkerReservedError{
		RealBarcode:   "7701234567890",
		MarkerBarcode: "7701234567890",
		MarkerName:    "[HISTORICO] COCA COLA 350ML",
	}
	msg := err.Error()
	if !strings.Contains(msg, "7701234567890") {
		t.Fatalf("mensaje sin barcode: %q", msg)
	}
	if !strings.Contains(msg, "[HISTORICO]") {
		t.Fatalf("mensaje sin marca del marcador: %q", msg)
	}
	forbidden := []string{
		"/admin/products/merge-historical",
		"POST ",
		"corregir_referencias.ps1",
	}
	for _, needle := range forbidden {
		if strings.Contains(msg, needle) {
			t.Fatalf("Error() no debe filtrar %q; got %q", needle, msg)
		}
	}
}

// TestHistoricalMarkerReservedErrorNilReceiver protege contra un panic si el
// wrapper llega a operar sobre un puntero nulo. Es defensivo pero barato.
func TestHistoricalMarkerReservedErrorNilReceiver(t *testing.T) {
	var err *HistoricalMarkerReservedError
	// llamar Error() sobre un *nil* del tipo debe devolver un mensaje
	// razonable, no un panic.
	msg := err.Error()
	if msg == "" {
		t.Fatalf("Error() sobre nil no debe devolver cadena vacía")
	}
}

// TestHistoricalMarkerReservedErrorErrorsAsThroughWrap verifica que la capa
// service puede envolver el error con fmt.Errorf("...: %w", err) sin romper
// la detección por errors.As en la capa HTTP. Sin esto, la mejora en el
// handler no funcionaría porque el service actualmente envuelve todos los
// errores de UpdateProduct con "error al persistir producto: %w".
func TestHistoricalMarkerReservedErrorErrorsAsThroughWrap(t *testing.T) {
	original := &HistoricalMarkerReservedError{
		RealBarcode:   "ABC",
		MarkerBarcode: "ABC",
		MarkerName:    "[HISTORICO] ABC",
	}
	wrapped := fmt.Errorf("error al persistir producto: %w", original)

	var got *HistoricalMarkerReservedError
	if !errors.As(wrapped, &got) {
		t.Fatalf("errors.As no encontró el tipo en la cadena %v", wrapped)
	}
	if got == nil {
		t.Fatal("errors.As devolvió true pero el destino quedó nil")
	}
	if got.RealBarcode != "ABC" || got.MarkerName != "[HISTORICO] ABC" {
		t.Fatalf("errors.As no preservó campos: %+v", got)
	}

	// También debe funcionar con doble envoltura, que es lo que ocurre en la
	// práctica: repo → service → handler.
	doubleWrapped := fmt.Errorf("capa externa: %w", wrapped)
	var got2 *HistoricalMarkerReservedError
	if !errors.As(doubleWrapped, &got2) {
		t.Fatalf("errors.As falló con doble envoltura: %v", doubleWrapped)
	}
}

// TestHistoricalMarkerReservedErrorErrorsAsRejectsOthers confirma que un
// error cualquiera no coincide con el tipo. Evita falsos positivos que
// mandarían un 500 disfrazado de 409.
func TestHistoricalMarkerReservedErrorErrorsAsRejectsOthers(t *testing.T) {
	other := errors.New("cualquier otro error")
	var got *HistoricalMarkerReservedError
	if errors.As(other, &got) {
		t.Fatalf("errors.As nunca debería coincidir con un error genérico: %v", other)
	}
}
