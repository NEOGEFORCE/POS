package models

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// Contrato con FrontPOS-main: SuggestionCard y useSmartRestock consumen el
// desglose de transito por proveedor bajo la clave canonica
// `inTransitSuppliers`. El nombre Go interno sigue siendo InTransitBreakdown
// por retrocompatibilidad del repositorio y los tests existentes, pero el
// JSON que viaja al navegador DEBE usar `inTransitSuppliers`. Cualquier
// cambio de ese tag rompe silenciosamente el aviso "ya pedido" del front.

func TestRestockSuggestionResponse_InTransitSuppliersJSONTag(t *testing.T) {
	// 1) Reflection sobre el struct: fija la clave esperada ante refactors.
	fieldType, ok := reflect.TypeOf(RestockSuggestionResponse{}).FieldByName("InTransitBreakdown")
	if !ok {
		t.Fatal("RestockSuggestionResponse debe conservar el campo Go InTransitBreakdown")
	}
	gotTag := fieldType.Tag.Get("json")
	wantTag := "inTransitSuppliers,omitempty"
	if gotTag != wantTag {
		t.Fatalf("tag json = %q; want %q (contrato con FrontPOS SuggestionCard)", gotTag, wantTag)
	}

	// 2) Marshal real: con datos verifica que el payload lleva la clave
	// canonica, no la vieja `inTransitBreakdown`.
	resp := RestockSuggestionResponse{
		InTransitBreakdown: []InTransitProduct{
			{
				ProductID:    "770123",
				ProductName:  "COCA 1L",
				Quantity:     6,
				SupplierID:   7,
				SupplierName: "HERMARLY",
				OrderID:      "co-1",
				ExpectedDate: "2026-10-04",
			},
		},
	}
	raw, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("json.Marshal fallo: %v", err)
	}
	payload := string(raw)

	if !strings.Contains(payload, `"inTransitSuppliers":`) {
		t.Errorf("payload JSON debe exponer `inTransitSuppliers`; got %s", payload)
	}
	if strings.Contains(payload, `"inTransitBreakdown"`) {
		t.Errorf("payload JSON NO debe exponer `inTransitBreakdown` (contrato roto con FrontPOS); got %s", payload)
	}

	// 3) Round-trip: deserializar el payload en un map confirma que la
	// clave canonica es exactamente la que entiende el front.
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("json.Unmarshal fallo: %v", err)
	}
	if _, ok := decoded["inTransitSuppliers"]; !ok {
		t.Error("decoded JSON no incluye la clave `inTransitSuppliers`")
	}
	if _, ok := decoded["inTransitBreakdown"]; ok {
		t.Error("decoded JSON incluye la clave legada `inTransitBreakdown`")
	}
}

// Cuando no hay transito, `omitempty` debe eliminar la clave por completo.
// Asi el payload no mete arrays vacios en los 2.000+ productos sin pedido.
func TestRestockSuggestionResponse_InTransitSuppliersOmitEmptyCuandoVacio(t *testing.T) {
	resp := RestockSuggestionResponse{} // InTransitBreakdown nil
	raw, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("json.Marshal fallo: %v", err)
	}
	payload := string(raw)
	if strings.Contains(payload, `"inTransitSuppliers"`) {
		t.Errorf("sin transito la clave `inTransitSuppliers` debe omitirse; got %s", payload)
	}
	if strings.Contains(payload, `"inTransitBreakdown"`) {
		t.Errorf("payload NO debe exponer `inTransitBreakdown`; got %s", payload)
	}
}
