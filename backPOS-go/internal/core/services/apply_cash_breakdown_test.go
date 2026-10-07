package services

import (
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// Contrato: applyCashBreakdown TOLERA strings vacíos del frontend.
//
// El frontend inicializa `bills = { '100000': '', '50000': '', ... }` en cada
// turno y, si el cajero no toca una denominación, ese valor viaja como `""`
// al servidor. Antes `strconv.ParseFloat("")` abortaba el cierre con "cantidad
// inválida" y la pantalla devolvía 500. Fix 2026-10-04 (P0).
//
// Las pruebas de este archivo cristalizan el nuevo contrato:
//
//   - `""` / `null`           → cero legítimo, no error.
//   - Valores numéricos reales → suman en CashBills.
//   - Mezcla de ambos         → suma solo los no vacíos sin romper.
//   - Cadena con texto basura ("abc") → sí sigue siendo error.
// ============================================================================

func TestApplyCashBreakdown_ToleraStringsVacios(t *testing.T) {
	t.Parallel()

	closure := &models.CashierClosure{
		CashBreakdown: `{"bills":{"100000":"","50000":"","20000":"","10000":"","5000":"","2000":""},
		                 "coins":{"500/1000":"","200":"","100":""}}`,
	}
	if err := applyCashBreakdown(closure); err != nil {
		t.Fatalf("applyCashBreakdown con strings vacíos: want nil, got %v", err)
	}
	if closure.CashBills != 0 {
		t.Errorf("CashBills = %.2f; want 0 (todas las denominaciones vacías)", closure.CashBills)
	}
	if closure.PhysicalCash != 0 {
		t.Errorf("PhysicalCash = %.2f; want 0", closure.PhysicalCash)
	}
}

func TestApplyCashBreakdown_MezclaDigitadosYVacios(t *testing.T) {
	t.Parallel()

	closure := &models.CashierClosure{
		CashBreakdown: `{"bills":{"100000":"2","50000":"","20000":"3","10000":"","5000":"1","2000":""},
		                 "coins":{"500/1000":"","200":"","100":""}}`,
	}
	if err := applyCashBreakdown(closure); err != nil {
		t.Fatalf("applyCashBreakdown mezcla: want nil, got %v", err)
	}
	// 2*100000 + 3*20000 + 1*5000 = 265000
	want := 265000.0
	if closure.CashBills != want {
		t.Errorf("CashBills = %.2f; want %.2f", closure.CashBills, want)
	}
	if closure.PhysicalCash != want {
		t.Errorf("PhysicalCash = %.2f; want %.2f", closure.PhysicalCash, want)
	}
}

func TestApplyCashBreakdown_RechazaCantidadNoNumerica(t *testing.T) {
	t.Parallel()

	closure := &models.CashierClosure{
		CashBreakdown: `{"bills":{"50000":"abc"},"coins":{}}`,
	}
	if err := applyCashBreakdown(closure); err == nil {
		t.Fatal("applyCashBreakdown con 'abc': want error, got nil")
	}
}

func TestApplyCashBreakdown_ToleraValoresNumericos(t *testing.T) {
	t.Parallel()

	// El frontend podría enviar números JSON en vez de strings. También
	// debe funcionar: 2 billetes de 50k + 3 de 10k = 130k.
	closure := &models.CashierClosure{
		CashBreakdown: `{"bills":{"50000":2,"10000":3},"coins":{}}`,
	}
	if err := applyCashBreakdown(closure); err != nil {
		t.Fatalf("applyCashBreakdown con números: want nil, got %v", err)
	}
	if closure.CashBills != 130000 {
		t.Errorf("CashBills = %.2f; want 130000", closure.CashBills)
	}
}

func TestApplyCashBreakdown_ToleraNull(t *testing.T) {
	t.Parallel()

	closure := &models.CashierClosure{
		CashBreakdown: `{"bills":{"50000":null,"20000":"1"},"coins":{}}`,
	}
	if err := applyCashBreakdown(closure); err != nil {
		t.Fatalf("applyCashBreakdown con null: want nil, got %v", err)
	}
	if closure.CashBills != 20000 {
		t.Errorf("CashBills = %.2f; want 20000", closure.CashBills)
	}
}

func TestParseBreakdownQuantity_Comportamiento(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		value   interface{}
		want    float64
		wantErr bool
	}{
		{"nil → 0", nil, 0, false},
		{"vacío → 0", "", 0, false},
		{"con espacios → 0", "   ", 0, false},
		{"float real", float64(3), 3, false},
		{"int real", 7, 7, false},
		{"string entero", "5", 5, false},
		{"string miles con punto", "1.000", 1000, false},
		{"string decimal con coma", "1,5", 1.5, false},
		{"string basura → error", "abc", 0, true},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := parseBreakdownQuantity(tc.value)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parseBreakdownQuantity(%v): want error, got nil (val=%v)", tc.value, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseBreakdownQuantity(%v) error = %v; want nil", tc.value, err)
			}
			if got != tc.want {
				t.Errorf("parseBreakdownQuantity(%v) = %v; want %v", tc.value, got, tc.want)
			}
		})
	}
}
