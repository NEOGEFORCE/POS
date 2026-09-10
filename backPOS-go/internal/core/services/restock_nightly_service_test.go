package services

import (
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

func TestCalculateRestockMetricAdjustsDemandAndTransit(t *testing.T) {
	metric := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:        "7701",
		ProductName:      "Producto A",
		CurrentStock:     4,
		TotalSold30d:     60,
		DaysZeroStock:    10,
		InTransitQty:     5,
		SupplierLeadDays: 7,
		UnitCost:         1000,
	}, time.Unix(1, 0))

	if metric.AvgDailySales != 3 {
		t.Fatalf("demand = %v; want 3", metric.AvgDailySales)
	}
	if metric.ABCCategory != "A" {
		t.Fatalf("category = %q; want A", metric.ABCCategory)
	}
	// Ideal = demanda 3 x 7 días de entrega x 1,30 de margen para clase A = 28.
	// Ya hay 4 en bodega y 5 en camino, así que faltan 19.
	if metric.IdealStock != 28 {
		t.Fatalf("ideal stock = %v; want 28", metric.IdealStock)
	}
	if metric.SuggestedOrderQty != 19 {
		t.Fatalf("suggestion = %v; want 19", metric.SuggestedOrderQty)
	}
}

// TestCalculateRestockMetric_ClaseCYaPidePorDemanda: Fase 1 elimino el veto
// contra clase C. Un producto con rotacion baja pero constante ahora si
// puede sugerir un pedido.
//
// CIFRAS ACTUALIZADAS EL 2026-09-10. Este proveedor no tiene dias de visita
// configurados y llega con SupplierLeadDays 30. Antes el ideal se calculaba con
// esos 30 dias (0.1 x 30 = 3), o sea un MES de inventario de golpe. El dueno lo
// rechazo explicitamente: "no a 30 dias". Ahora la cobertura desconocida se
// acota a scheduling.MaxUnknownCycleDays (14 dias), asi que el ideal baja a
// ceil(0.1 x 14) = 2.
//
// Lo que este test protege NO cambia: un producto de clase C con rotacion baja
// sigue generando pedido. Solo cambia el tamano, y a proposito.
func TestCalculateRestockMetric_ClaseCYaPidePorDemanda(t *testing.T) {
	metric := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:        "7702",
		CurrentStock:     0,
		TotalSold30d:     3,
		DaysZeroStock:    0,
		SupplierLeadDays: 30,
	}, time.Unix(1, 0))

	if metric.ABCCategory != "C" {
		t.Fatalf("category = %q; want C", metric.ABCCategory)
	}
	// Demanda = 3/30 = 0.1. Cobertura acotada a 14 dias (sin agenda conocida):
	// ideal = ceil(0.1 * 14 * 1.0) = 2. Con stock 0 la demanda pide los 2
	// completos; el piso de MinMeaningfulOrderQty no aplica porque esta agotado.
	if metric.IdealStock != 2 {
		t.Fatalf("ideal stock = %v; want 2", metric.IdealStock)
	}
	if metric.SuggestedOrderQty != 2 {
		t.Fatalf("suggestion = %v; want 2 (Fase 1: clase C ya pide por demanda)", metric.SuggestedOrderQty)
	}
}

func TestCalculateRestockMetricUsesDefensiveFallbacks(t *testing.T) {
	metric := calculateRestockMetric(models.RestockCalculationInput{
		TotalSold30d:     15,
		DaysZeroStock:    30,
		SupplierLeadDays: 0,
	}, time.Unix(1, 0))

	if metric.DaysWithStock != 1 {
		t.Fatalf("days with stock = %d; want 1", metric.DaysWithStock)
	}
	if metric.SupplierLeadDays != 7 {
		t.Fatalf("lead days = %d; want 7", metric.SupplierLeadDays)
	}
	if metric.ABCCategory != "A" {
		t.Fatalf("category = %q; want A because adjusted demand is 15/day", metric.ABCCategory)
	}
	// Demanda 15/día x 7 días de entrega x 1,30 de margen para clase A = 137.
	if metric.SuggestedOrderQty != 137 {
		t.Fatalf("suggestion = %v; want 137", metric.SuggestedOrderQty)
	}
}

func TestSafetyFactorProtegeLosDeAltaRotacion(t *testing.T) {
	// El colchón existe para no llegar a cero el día de la visita del proveedor.
	if safetyFactor("A") <= safetyFactor("B") {
		t.Fatal("la clase A debe llevar más colchón que la B")
	}
	if safetyFactor("B") <= safetyFactor("C") {
		t.Fatal("la clase B debe llevar más colchón que la C")
	}
	if safetyFactor("C") != 1.0 {
		t.Fatalf("clase C = %v; want 1.0 sin margen", safetyFactor("C"))
	}
	if safetyFactor("") != 1.0 {
		t.Fatalf("categoría desconocida = %v; want 1.0", safetyFactor(""))
	}
}

func TestCalculateRestockMetricNoDejaEnCeroElDiaDeLaVisita(t *testing.T) {
	// Caso concreto: vende 2 al día y el proveedor viene cada 7 días. Sin margen
	// el ideal era 14 y el producto llegaba a cero exactamente el día de la
	// visita. Con margen queda con qué aguantar un retraso.
	metric := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:        "7703",
		TotalSold30d:     60,
		DaysZeroStock:    0,
		CurrentStock:     0,
		SupplierLeadDays: 7,
	}, time.Unix(1, 0))

	if metric.ABCCategory != "A" {
		t.Fatalf("category = %q; want A", metric.ABCCategory)
	}
	if metric.IdealStock <= metric.AvgDailySales*7 {
		t.Fatalf("ideal %v no supera la demanda del tiempo de entrega %v", metric.IdealStock, metric.AvgDailySales*7)
	}
	if metric.SuggestedOrderQty != metric.IdealStock {
		t.Fatalf("sin existencias la sugerencia debe igualar el ideal: %v vs %v", metric.SuggestedOrderQty, metric.IdealStock)
	}
}

// ============================================================================
// Fase 1 (agosto 2026): el objetivo de reposicion es 75% del minimo. El
// ideal ya no tiene piso por minimo; SuggestedOrderQty combina objetivo y
// demanda.
// ============================================================================
func TestCalculateRestockMetric_MinimoComoObjetivo(t *testing.T) {
	tests := []struct {
		name          string
		input         models.RestockCalculationInput
		wantIdeal     float64
		wantSuggested float64
	}{
		{
			// Sin ventas y con minimo 10: ideal por demanda = 0.
			// byTarget = ceil(0.75*10 - 0) = 8.
			name: "sin ventas con minimo 10 pide 8 (objetivo)",
			input: models.RestockCalculationInput{
				ProductID: "8001", TotalSold30d: 0, CurrentStock: 0,
				MinStock: 10, SupplierLeadDays: 7,
			},
			wantIdeal: 0, wantSuggested: 8,
		},
		{
			// Clase C con minimo 12, stock 2 (rojo).
			// Ideal por demanda 3/30 -> ceil(0.1*7*1.0) = 1.
			// byTarget = ceil(9 - 2) = 7. byDemand = max(0, 1-2) = 0.
			// Fase 1: clase C ya participa en la rama por demanda.
			name: "clase C en rojo pide 7 por objetivo",
			input: models.RestockCalculationInput{
				ProductID: "8002", TotalSold30d: 3, CurrentStock: 2,
				MinStock: 12, SupplierLeadDays: 7,
			},
			wantIdeal: 1, wantSuggested: 7,
		},
		{
			// COLATE del brief: min 12, stock 6, demanda baja -> pide 3.
			// byTarget = ceil(9 - 6) = 3.
			name: "COLATE stock 6 min 12 amarillo pide 3",
			input: models.RestockCalculationInput{
				ProductID: "COLATE", TotalSold30d: 1, CurrentStock: 6,
				MinStock: 12, SupplierLeadDays: 7,
			},
			wantIdeal: 1, wantSuggested: 3,
		},
		{
			// SUAVITEL del brief: min 6, stock 1 -> pide 4.
			// byTarget = ceil(4.5 - 1) = 4.
			name: "SUAVITEL stock 1 min 6 rojo pide 4",
			input: models.RestockCalculationInput{
				ProductID: "SUAVITEL", TotalSold30d: 0, CurrentStock: 1,
				MinStock: 6, SupplierLeadDays: 7,
			},
			wantIdeal: 0, wantSuggested: 4,
		},
		{
			// Sano del brief: stock 6, min 6, demanda que no supera stock.
			// ratio = 1.0, VERDE. byTarget = 0. Sin demanda no cubierta.
			name: "sano stock 6 min 6 verde no pide",
			input: models.RestockCalculationInput{
				ProductID: "SANO", TotalSold30d: 5, CurrentStock: 6,
				MinStock: 6, SupplierLeadDays: 7,
			},
			wantIdeal: 2, wantSuggested: 0,
		},
		{
			// Demanda alta que supera el minimo: la demanda manda.
			name: "demanda alta por encima del minimo",
			input: models.RestockCalculationInput{
				ProductID: "8004", TotalSold30d: 60, CurrentStock: 0,
				MinStock: 5, SupplierLeadDays: 7,
			},
			// demanda 2/dia, clase A -> 2*7*1.30 = 18.2 -> 19. byTarget=4.
			wantIdeal: 19, wantSuggested: 19,
		},
		{
			// El transito ya cubre el objetivo. Stock 4, transito 10, min 12.
			// Target=9, stock+transit=14 -> byTarget=0. Sin demanda -> 0.
			name: "transito cubre el objetivo",
			input: models.RestockCalculationInput{
				ProductID: "8005", TotalSold30d: 0, CurrentStock: 4,
				InTransitQty: 10, MinStock: 12, SupplierLeadDays: 7,
			},
			wantIdeal: 0, wantSuggested: 0,
		},
		{
			// Sin minimo configurado se conserva el comportamiento anterior.
			name: "sin minimo configurado y sin ventas no sugiere nada",
			input: models.RestockCalculationInput{
				ProductID: "8006", TotalSold30d: 0, CurrentStock: 0,
				MinStock: 0, SupplierLeadDays: 7,
			},
			wantIdeal: 0, wantSuggested: 0,
		},
		{
			// Un minimo invalido (negativo por dato sucio) se ignora.
			name: "minimo negativo se ignora",
			input: models.RestockCalculationInput{
				ProductID: "8007", TotalSold30d: 0, CurrentStock: 0,
				MinStock: -5, SupplierLeadDays: 7,
			},
			wantIdeal: 0, wantSuggested: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			metric := calculateRestockMetric(tt.input, time.Unix(1, 0))
			if metric.IdealStock != tt.wantIdeal {
				t.Fatalf("IdealStock = %v; want %v", metric.IdealStock, tt.wantIdeal)
			}
			if metric.SuggestedOrderQty != tt.wantSuggested {
				t.Fatalf("SuggestedOrderQty = %v; want %v", metric.SuggestedOrderQty, tt.wantSuggested)
			}
		})
	}
}

// TestCalculateRestockMetric_Demanda90PorLosLentos verifica el escenario del
// brief: sold30=0, sold90=3. La demanda 30d es 0 pero la 90d ~= 0.033/dia.
// El motor toma la mayor (90d) y calcula ideal por ella.
func TestCalculateRestockMetric_Demanda90PorLosLentos(t *testing.T) {
	metric := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:        "LENTO",
		TotalSold30d:     0,
		TotalSold90d:     3,
		DaysZeroStock:    0,
		DaysZeroStock90d: 0,
		CurrentStock:     2,
		MinStock:         4,
		SupplierLeadDays: 7,
	}, time.Unix(1, 0))

	// Demanda 90d = 3/90 = 0.0333. avg_daily_sales redondea a 4 decimales.
	if metric.AvgDailySales == 0 {
		t.Fatalf("avgDailySales = 0; se esperaba demanda proveniente de la ventana 90d")
	}
	// Ideal por demanda ~= ceil(0.033 * 7 * 1.0) = 1.
	if metric.IdealStock < 1 {
		t.Fatalf("IdealStock = %v; want >= 1 (demanda 90d activa)", metric.IdealStock)
	}
	// REGLA DEL DUEÑO (2026-09-04): byTarget = ceil(0.75*4 - 2) = 1, pero como
	// TODAVIA HAY EXISTENCIA (stock 2) y 1 no llega al piso de
	// MinMeaningfulOrderQty, la sugerencia queda en 0 a proposito: pedir de a 1
	// en muchos productos infla la factura sin resolver el abastecimiento.
	//
	// Lo que este test sigue protegiendo es que la VENTANA DE 90 DIAS detecte
	// la demanda de los productos lentos (AvgDailySales e IdealStock arriba).
	// La decision de pedir o esperar es una capa aparte.
	if metric.SuggestedOrderQty != 0 {
		t.Fatalf("SuggestedOrderQty = %v; want 0 (necesidad marginal con existencia disponible)", metric.SuggestedOrderQty)
	}
}

// El mismo producto lento, pero AGOTADO, si debe pedirse: es la excepcion de la
// regla de necesidad marginal. Sin existencia no hay con que vender.
func TestCalculateRestockMetric_LentoAgotadoSiSePide(t *testing.T) {
	metric := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:        "LENTO_AGOTADO",
		TotalSold30d:     0,
		TotalSold90d:     3,
		DaysZeroStock:    0,
		DaysZeroStock90d: 0,
		CurrentStock:     0,
		MinStock:         4,
		SupplierLeadDays: 7,
	}, time.Unix(1, 0))

	if metric.SuggestedOrderQty < 1 {
		t.Fatalf("SuggestedOrderQty = %v; want >= 1 (agotado se pide aunque sea poco)", metric.SuggestedOrderQty)
	}
}

// TestCalculateRestockMetric_MaxEntre30y90: verifica que el motor toma la
// ventana MAYOR cuando las dos difieren.
func TestCalculateRestockMetric_MaxEntre30y90(t *testing.T) {
	// Caso 1: la 30d es mayor (acelerado).
	m := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:        "ACELERADO",
		TotalSold30d:     60, // 2/dia
		TotalSold90d:     90, // 1/dia
		SupplierLeadDays: 7,
	}, time.Unix(1, 0))
	if m.AvgDailySales != 2 {
		t.Fatalf("acelerado avg = %v; want 2 (30d gana sobre 90d)", m.AvgDailySales)
	}

	// Caso 2: la 90d es mayor (lento con historia).
	m = calculateRestockMetric(models.RestockCalculationInput{
		ProductID:        "LENTO",
		TotalSold30d:     3,  // 0.1/dia
		TotalSold90d:     90, // 1/dia
		SupplierLeadDays: 7,
	}, time.Unix(1, 0))
	if m.AvgDailySales != 1 {
		t.Fatalf("lento avg = %v; want 1 (90d gana sobre 30d)", m.AvgDailySales)
	}
}

// TestCalculateRestockMetric_DaysZero90NoInfla verifica que dias sin
// snapshot no cuentan como agotados. Con daysZero90=0 (no vino la info),
// el denominador es 90 completo aunque no haya snapshots todos los dias.
func TestCalculateRestockMetric_DaysZero90NoInfla(t *testing.T) {
	m := calculateRestockMetric(models.RestockCalculationInput{
		TotalSold90d:     90,
		DaysZeroStock90d: 0,
		SupplierLeadDays: 7,
	}, time.Unix(1, 0))
	// 90 / 90 = 1/dia.
	if m.AvgDailySales != 1 {
		t.Fatalf("avg = %v; want 1 (dias sin snapshot no cuentan como agotados)", m.AvgDailySales)
	}
}

func TestClassifyABCUsesEitherThreshold(t *testing.T) {
	tests := []struct {
		name      string
		demand    float64
		totalSold float64
		want      string
	}{
		{name: "A by daily demand", demand: 3, totalSold: 1, want: "A"},
		{name: "A by monthly sales", demand: 0.1, totalSold: 60, want: "A"},
		{name: "B by daily demand", demand: 0.5, totalSold: 1, want: "B"},
		{name: "B by monthly sales", demand: 0.1, totalSold: 15, want: "B"},
		{name: "C", demand: 0.49, totalSold: 14.99, want: "C"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyABC(tt.demand, tt.totalSold); got != tt.want {
				t.Fatalf("classifyABC(%v, %v) = %q; want %q", tt.demand, tt.totalSold, got, tt.want)
			}
		})
	}
}

// TestCalculateRestockMetric_PrefiereSchedule verifica que cuando el proveedor
// tiene dias configurados a mano, el batch calcula el lead time con ellos y
// no con visit_frequency_days (que puede estar inflado por el aprendizaje).
func TestCalculateRestockMetric_PrefiereScheduleSobreVisitFrequency(t *testing.T) {
	freq := 30 // aprendido, sospechosamente largo
	// Fecha calendario en Bogota. La calculamos con el mismo offset fijo
	// que usa el batch en produccion (bogotaLocation).
	loc := time.FixedZone("America/Bogota", -5*60*60)
	calculatedAt := time.Date(2026, 8, 30, 8, 0, 0, 0, loc) // domingo

	metric := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:                 "7710",
		TotalSold30d:              30,
		CurrentStock:              0,
		PrimaryVisitDays:          models.StringArray{"Lunes"},
		PrimaryDeliveryDays:       models.StringArray{"Miércoles"},
		PrimaryVisitFrequencyDays: freq,
		SupplierLeadDays:          freq, // eco de lo que hacia la SQL vieja
	}, calculatedAt)

	// visita lunes, entrega miercoles -> lead=2. Con demand=1 y clase B
	// (30 ventas en 30 dias) el ideal seria 2 * 1 * 1.15 = 2.3 -> ceil 3.
	if metric.SupplierLeadDays != 2 {
		t.Fatalf("SupplierLeadDays = %d, want 2 (configured_days debe ganar)", metric.SupplierLeadDays)
	}
	if metric.IdealStock >= 30 {
		t.Fatalf("IdealStock = %v; el schedule NO debio caer a visit_frequency (30)", metric.IdealStock)
	}
}

// TestCalculateRestockMetric_CaeAVisitFrequencySinAgenda verifica que el
// fallback a visit_frequency se conserva cuando no hay dias configurados.
func TestCalculateRestockMetric_CaeAVisitFrequencySinAgenda(t *testing.T) {
	metric := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:                 "7711",
		TotalSold30d:              30,
		PrimaryVisitFrequencyDays: 14,
	}, time.Unix(1, 0))

	if metric.SupplierLeadDays != 14 {
		t.Fatalf("SupplierLeadDays = %d, want 14 (visit_frequency)", metric.SupplierLeadDays)
	}
}

// TestCalculateRestockMetric_PrefiereLearnedSobreExplicit: si el proveedor no
// tiene agenda manual pero SI aprendida con evidencia suficiente, el batch
// nocturno debe usar el learned_lead_time_days antes que el explicit.
func TestCalculateRestockMetric_PrefiereLearnedSobreExplicit(t *testing.T) {
	learned := 3
	explicit := 7
	loc := time.FixedZone("America/Bogota", -5*60*60)
	calculatedAt := time.Date(2026, 8, 30, 8, 0, 0, 0, loc) // domingo

	metric := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:                   "7720",
		TotalSold30d:                30,
		CurrentStock:                0,
		PrimaryLearnedLeadTimeDays:  &learned,
		PrimaryLearnedSampleCount:   5, // >= LearnMinSamples
		PrimaryExplicitLeadTimeDays: &explicit,
	}, calculatedAt)

	if metric.SupplierLeadDays != 3 {
		t.Fatalf("SupplierLeadDays = %d, want 3 (learned gana sobre explicit)",
			metric.SupplierLeadDays)
	}
}

// TestCalculateRestockMetric_LearnedSinEvidenciaNoSeUsa: si el batch previo
// no aprendio con muestras suficientes, el learned no se usa aunque haya un
// numero. Se cae al escalon siguiente.
func TestCalculateRestockMetric_LearnedSinEvidenciaNoSeUsa(t *testing.T) {
	learned := 3
	explicit := 7

	metric := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:                   "7721",
		TotalSold30d:                30,
		PrimaryLearnedLeadTimeDays:  &learned,
		PrimaryLearnedSampleCount:   2, // debajo del umbral
		PrimaryExplicitLeadTimeDays: &explicit,
	}, time.Unix(1, 0))

	if metric.SupplierLeadDays != 7 {
		t.Fatalf("SupplierLeadDays = %d, want 7 (explicit; learned sin evidencia)",
			metric.SupplierLeadDays)
	}
}

// TestCalculateRestockMetric_ManualGanaAunConLearned: el escalon manual
// (visit_days / delivery_days) siempre pisa al learned, aunque este ultimo
// tenga muchas muestras.
func TestCalculateRestockMetric_ManualGanaAunConLearned(t *testing.T) {
	learned := 30
	loc := time.FixedZone("America/Bogota", -5*60*60)
	calculatedAt := time.Date(2026, 8, 30, 8, 0, 0, 0, loc) // domingo

	metric := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:                  "7722",
		TotalSold30d:               30,
		PrimaryVisitDays:           models.StringArray{"Lunes"},
		PrimaryDeliveryDays:        models.StringArray{"Miércoles"},
		PrimaryLearnedLeadTimeDays: &learned,
		PrimaryLearnedSampleCount:  50, // muchas muestras, pero manual manda
	}, calculatedAt)

	if metric.SupplierLeadDays != 2 {
		t.Fatalf("SupplierLeadDays = %d, want 2 (manual manda sobre learned)",
			metric.SupplierLeadDays)
	}
}
