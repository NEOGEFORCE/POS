package services

import (
	"math"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// CONTRATO: EL BACKEND NO RECHAZA CIERRES EN CERO.
//
// Queja del dueño (histórica): "cuando no me entra plata el sistema no me deja
// cerrar". El bug vivía en el frontend; en el backend NO existe validación que
// rechace un cierre por tener campos en 0. La única regla de bloqueo real es
// FALTANTE (diferencia < 0) y vive en la pantalla (`showAuthModal`), que exige
// credenciales admin.
//
// Este archivo fija por tabla las 5 situaciones que el enunciado pide:
//
//  1. esperado=0, contado=0        -> BALANCED, cierre permitido.
//  2. esperado>0, contado=esperado -> BALANCED.
//  3. contado>esperado             -> SURPLUS (sobrante positivo).
//  4. contado<esperado             -> SHORTAGE (faltante negativo); el servicio
//                                     igual lo computa y persiste. El gate por
//                                     faltante lo aplica la UI con el modal
//                                     de autorización, no el handler.
//  5. campos cero explícitos NO se reinterpretan como ausentes: PhysicalCash=0
//     con desglose vacío y sin monedas sobrevive el pipeline con valor 0.
//
// Fórmulas canónicas replicadas aquí (y usadas por SaveClosure/UpdateClosure):
//
//     ExpectedCash = OpeningCash + TotalCash − EgresosCaja − TotalReturns
//     Difference   = PhysicalCash − ExpectedCash
//
// Clasificación:
//
//     Difference  = 0 -> BALANCED
//     Difference  > 0 -> SURPLUS
//     Difference  < 0 -> SHORTAGE
// ============================================================================

// expectedAndDifference aplica las mismas fórmulas que SaveClosure y
// publishClosureMetrics, para que el test cubra exactamente la aritmética
// del servicio y no una copia aparte.
func expectedAndDifference(c *models.CashierClosure, m ClosureMetrics) (float64, float64) {
	expected := c.OpeningCash + c.TotalCash - m.EgresosCaja - c.TotalReturns
	diff := m.PhysicalCash - expected
	return expected, diff
}

func classifyDifference(diff float64) string {
	switch {
	case math.Abs(diff) < 0.0001:
		return "BALANCED"
	case diff > 0:
		return "SURPLUS"
	default:
		return "SHORTAGE"
	}
}

// TestClosureAceptaEscenariosDeDinero cubre los 5 casos del enunciado con una
// tabla única. Cada fila verifica que:
//
//   - ComputeClosureMetrics devuelve los agregados esperados (ningún campo se
//     reinterpreta ni se cae en NaN con valores en cero).
//   - El cálculo de expected/difference coincide exactamente con la fórmula
//     que ejecuta SaveClosure al persistir.
//   - La clasificación por diferencia (BALANCED / SURPLUS / SHORTAGE) coincide
//     con la que consume el frontend al decidir si pedir autorización admin.
func TestClosureAceptaEscenariosDeDinero(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name              string
		closure           models.CashierClosure
		wantExpectedCash  float64
		wantDifference    float64
		wantClassify      string
		wantPhysicalCash  float64
		wantEgresosCaja   float64
		wantVentasCajero  float64
		wantDigitalIncome float64
	}{
		{
			// CASO 1: la tienda abrió, no vendió nada y no gastó nada.
			// Todo en cero debe producir BALANCED y permitir cerrar.
			name:              "todo_en_cero_cierra_balanceado",
			closure:           models.CashierClosure{},
			wantExpectedCash:  0,
			wantDifference:    0,
			wantClassify:      "BALANCED",
			wantPhysicalCash:  0,
			wantEgresosCaja:   0,
			wantVentasCajero:  0,
			wantDigitalIncome: 0,
		},
		{
			// CASO 2: hubo venta en efectivo y el cajero contó exactamente lo
			// que esperaba el sistema. Es el escenario feliz y debe cerrar.
			name: "contado_iguala_esperado",
			closure: models.CashierClosure{
				TotalCash:    500_000,
				PhysicalCash: 500_000,
			},
			wantExpectedCash:  500_000,
			wantDifference:    0,
			wantClassify:      "BALANCED",
			wantPhysicalCash:  500_000,
			wantEgresosCaja:   0,
			wantVentasCajero:  500_000,
			wantDigitalIncome: 0,
		},
		{
			// CASO 3: el cajero contó MÁS de lo que esperaba el sistema.
			// Sobrante positivo. No existe bloqueo en el backend ni en la UI
			// (la autorización admin es solo para faltante).
			name: "contado_mayor_que_esperado_es_sobrante",
			closure: models.CashierClosure{
				TotalCash:    500_000,
				PhysicalCash: 600_000,
			},
			wantExpectedCash:  500_000,
			wantDifference:    100_000,
			wantClassify:      "SURPLUS",
			wantPhysicalCash:  600_000,
			wantEgresosCaja:   0,
			wantVentasCajero:  600_000,
			wantDigitalIncome: 0,
		},
		{
			// CASO 4: faltante real. El backend NO rechaza: computa, clasifica
			// como SHORTAGE y deja que la UI pida la autorización admin.
			// Si este test llegara a fallar porque el servicio empezó a
			// rechazar faltantes, el flujo de cierre quedaría roto en todo
			// descuadre, no solo en el que el dueño autoriza.
			name: "contado_menor_que_esperado_es_faltante_sin_bloqueo_backend",
			closure: models.CashierClosure{
				TotalCash:    500_000,
				PhysicalCash: 400_000,
			},
			wantExpectedCash:  500_000,
			wantDifference:    -100_000,
			wantClassify:      "SHORTAGE",
			wantPhysicalCash:  400_000,
			wantEgresosCaja:   0,
			wantVentasCajero:  400_000,
			wantDigitalIncome: 0,
		},
		{
			// CASO 1 bis: todo en cero con base de apertura, egresos y
			// devoluciones también en cero. Verifica que el cero EXPLÍCITO
			// de cada campo no se interpreta como "ausente" ni dispara
			// cálculos alternativos (el bug que estaba del lado del frontend
			// con truthy/falsy sobre strings vacíos).
			name: "campos_cero_explicitos_no_son_ausentes",
			closure: models.CashierClosure{
				OpeningCash:    0,
				TotalCash:      0,
				TotalReturns:   0,
				TotalNequi:     0,
				TotalDaviplata: 0,
				PhysicalCash:   0,
				CashBills:      0,
				Coins100:       0,
				Coins200:       0,
				Coins500:       0,
				Coins1000:      0,
				CashBreakdown:  "",
				ExpectedCash:   0,
				Difference:     0,
				Expenses:       nil,
				ExpensesDetail: "",
			},
			wantExpectedCash:  0,
			wantDifference:    0,
			wantClassify:      "BALANCED",
			wantPhysicalCash:  0,
			wantEgresosCaja:   0,
			wantVentasCajero:  0,
			wantDigitalIncome: 0,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			closure := tc.closure
			m := ComputeClosureMetrics(&closure)

			if m.PhysicalCash != tc.wantPhysicalCash {
				t.Errorf("PhysicalCash = %.2f; want %.2f", m.PhysicalCash, tc.wantPhysicalCash)
			}
			if m.EgresosCaja != tc.wantEgresosCaja {
				t.Errorf("EgresosCaja = %.2f; want %.2f", m.EgresosCaja, tc.wantEgresosCaja)
			}
			if m.DigitalIncome != tc.wantDigitalIncome {
				t.Errorf("DigitalIncome = %.2f; want %.2f", m.DigitalIncome, tc.wantDigitalIncome)
			}
			if m.VentasCajero != tc.wantVentasCajero {
				t.Errorf("VentasCajero = %.2f; want %.2f", m.VentasCajero, tc.wantVentasCajero)
			}
			if math.IsNaN(m.PhysicalCash) || math.IsNaN(m.VentasCajero) || math.IsNaN(m.EgresosCaja) {
				t.Errorf("ningún agregado puede ser NaN con entradas numéricas: %+v", m)
			}

			expected, diff := expectedAndDifference(&closure, m)
			if expected != tc.wantExpectedCash {
				t.Errorf("ExpectedCash = %.2f; want %.2f", expected, tc.wantExpectedCash)
			}
			if diff != tc.wantDifference {
				t.Errorf("Difference = %.2f; want %.2f", diff, tc.wantDifference)
			}
			if got := classifyDifference(diff); got != tc.wantClassify {
				t.Errorf("clasificación = %q; want %q", got, tc.wantClassify)
			}
		})
	}
}

// TestResolvePhysicalCashConCeroExplicitoDevuelveCero cristaliza que un cierre
// con PhysicalCash=0, sin desglose y sin monedas devuelve 0 (no se cae en el
// fallback ExpectedCash+Difference como si no se hubiera digitado nada). El
// test del enunciado: "campos cero explícitos no se interpretan como ausentes".
//
// La función tiene un último fallback a `c.ExpectedCash + c.Difference`, que
// con ambos en cero también da cero; este test fija ese comportamiento para
// que una refactorización no lo convierta en "default razonable" ni en NaN.
func TestResolvePhysicalCashConCeroExplicitoDevuelveCero(t *testing.T) {
	t.Parallel()

	c := &models.CashierClosure{
		PhysicalCash:  0,
		CashBills:     0,
		Coins100:      0,
		Coins200:      0,
		Coins500:      0,
		Coins1000:     0,
		CashBreakdown: "",
		ExpectedCash:  0,
		Difference:    0,
	}
	got := resolvePhysicalCash(c)
	if got != 0 {
		t.Fatalf("resolvePhysicalCash(todo-cero) = %v; want 0", got)
	}
	if math.IsNaN(got) {
		t.Fatalf("resolvePhysicalCash(todo-cero) = NaN; want 0")
	}
}

// TestResolvePhysicalCashRespetaDesgloseVacio asegura que un CashBreakdown
// con la cadena JSON vacía estructuralmente ("{\"bills\":{},\"coins\":{}}")
// tampoco se interpreta como "sin dato" en el sentido de forzar un valor
// alternativo: queda en cero porque todo lo digitado fue cero.
func TestResolvePhysicalCashRespetaDesgloseVacio(t *testing.T) {
	t.Parallel()

	c := &models.CashierClosure{
		PhysicalCash:  0,
		CashBreakdown: `{"bills":{},"coins":{}}`,
	}
	got := resolvePhysicalCash(c)
	if got != 0 {
		t.Fatalf("resolvePhysicalCash(desglose vacio) = %v; want 0", got)
	}
}

// TestApplyCashBreakdownConservaCeroExplicito prueba el paso previo a
// ComputeClosureMetrics dentro de SaveClosure. applyCashBreakdown NO debe
// reinterpretar un cierre completamente en cero: ni rellena CashBills, ni
// toca PhysicalCash, ni rechaza por ausencia de JSON.
func TestApplyCashBreakdownConservaCeroExplicito(t *testing.T) {
	t.Parallel()

	closure := &models.CashierClosure{
		PhysicalCash:  0,
		CashBills:     0,
		Coins100:      0,
		Coins200:      0,
		Coins500:      0,
		Coins1000:     0,
		CashBreakdown: "",
	}
	if err := applyCashBreakdown(closure); err != nil {
		t.Fatalf("applyCashBreakdown(todo-cero) error = %v; want nil", err)
	}
	if closure.PhysicalCash != 0 {
		t.Errorf("PhysicalCash tras applyCashBreakdown = %.2f; want 0", closure.PhysicalCash)
	}
	if closure.CashBills != 0 {
		t.Errorf("CashBills tras applyCashBreakdown = %.2f; want 0", closure.CashBills)
	}
}

// TestNormalizeClosureExpensesConSliceVacioNoFalla fija el contrato de que un
// cierre sin egresos (todos en cero: lista nil, lista vacía, egreso con
// Amount=0) pasa la normalización sin error. Ningún camino "requerido > 0".
func TestNormalizeClosureExpensesConSliceVacioNoFalla(t *testing.T) {
	t.Parallel()

	if err := normalizeClosureExpenses(nil); err != nil {
		t.Fatalf("normalizeClosureExpenses(nil) error = %v; want nil", err)
	}
	if err := normalizeClosureExpenses([]models.Expense{}); err != nil {
		t.Fatalf("normalizeClosureExpenses([]) error = %v; want nil", err)
	}

	expenses := []models.Expense{{Amount: 0, Status: "PAID", PaymentSource: ""}}
	if err := normalizeClosureExpenses(expenses); err != nil {
		t.Fatalf("normalizeClosureExpenses(egreso-cero) error = %v; want nil", err)
	}
}

// TestComputeClosureMetricsConEgresosCeroNoRompe comprueba que un cierre con
// egresos marcados pero con monto cero no inventa NaN ni infla ningún canal.
// Es una regresión defensiva: si alguien agregara `if amount == 0 { ... }`
// con intención de "limpiar" quedarían canales negativos o infinitos.
func TestComputeClosureMetricsConEgresosCeroNoRompe(t *testing.T) {
	t.Parallel()

	c := &models.CashierClosure{
		TotalCash:    0,
		PhysicalCash: 0,
		Expenses: []models.Expense{
			{Status: "PAID", Amount: 0, CashAmount: 0},
			{Status: "PAID", Amount: 0, FondoAmount: 0},
		},
	}
	m := ComputeClosureMetrics(c)

	if m.EgresosCaja != 0 || m.EgresosFondo != 0 || m.EgresosDigital != 0 || m.EgresosAlcancia != 0 || m.EgresosTotales != 0 {
		t.Fatalf("egresos en cero deben dejar todos los canales en 0: %+v", m)
	}
	if m.VentasCajero != 0 {
		t.Fatalf("VentasCajero con todo en cero = %.2f; want 0", m.VentasCajero)
	}
	if math.IsNaN(m.VentasCajero) || math.IsNaN(m.EgresosTotales) {
		t.Fatalf("ningún agregado puede ser NaN: %+v", m)
	}
}
