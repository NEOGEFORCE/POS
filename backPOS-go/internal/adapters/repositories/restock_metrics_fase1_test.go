package repositories

import (
	"database/sql"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"backPOS-go/internal/core/domain/models"
)

// TestBuildRestockSuggestion_Fase1_ObjetivoDelBrief verifica los cuatro
// casos con nombre propio del brief de Fase 1 usando buildRestockSuggestion
// (que corre en cada request).
func TestBuildRestockSuggestion_Fase1_ObjetivoDelBrief(t *testing.T) {
	tests := []struct {
		name            string
		liveStock       float64
		liveInTransit   float64
		minStock        float64
		idealStock      float64
		abcCategory     string
		wantSuggested   float64
		wantBand        string
		wantOrderReason string
	}{
		{
			// COLATE: stock 6, min 12, demanda baja/clase C -> pide 3 por objetivo.
			name:      "COLATE min 12 stock 6 pide 3",
			liveStock: 6, minStock: 12, idealStock: 1, abcCategory: "C",
			wantSuggested: 3, wantBand: models.StockBandYellow, wantOrderReason: models.OrderReasonTarget,
		},
		{
			// SUAVITEL: stock 1, min 6 -> pide 4 por objetivo.
			name:      "SUAVITEL min 6 stock 1 pide 4",
			liveStock: 1, minStock: 6, idealStock: 0, abcCategory: "C",
			wantSuggested: 4, wantBand: models.StockBandRed, wantOrderReason: models.OrderReasonTarget,
		},
		{
			// Sano: stock 6, min 6 -> pide 0.
			name:      "sano min 6 stock 6 no pide",
			liveStock: 6, minStock: 6, idealStock: 2, abcCategory: "B",
			wantSuggested: 0, wantBand: models.StockBandGreen, wantOrderReason: models.OrderReasonNone,
		},
		{
			// Demanda alta que supera el objetivo.
			// byTarget = ceil(0.75*30 - 5) = 18. byDemand = 40-5 = 35.
			name:      "demanda alta gana al objetivo",
			liveStock: 5, minStock: 30, idealStock: 40, abcCategory: "A",
			wantSuggested: 35, wantBand: models.StockBandRed, wantOrderReason: models.OrderReasonDemand,
		},
	}

	now := time.Date(2026, 8, 30, 8, 0, 0, 0, bogotaLoc)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			row := restockSuggestionRow{}
			row.ProductRestockMetric = models.ProductRestockMetric{
				ProductID: "TEST", ProductName: tt.name,
				IdealStock: tt.idealStock, ABCCategory: tt.abcCategory,
			}
			row.MinStock = tt.minStock
			row.LiveStock = tt.liveStock
			row.LiveInTransitQty = tt.liveInTransit
			row.EffectiveSupplierID = uintPtr(10)
			row.EffectiveSupplierName = strPtr("PROVEEDOR")
			row.EffectiveUnitCost = floatPtr(100)

			got := buildRestockSuggestion(row, now)
			if got.SuggestedOrderQty != tt.wantSuggested {
				t.Errorf("SuggestedOrderQty = %v; want %v", got.SuggestedOrderQty, tt.wantSuggested)
			}
			if got.StockBand != tt.wantBand {
				t.Errorf("StockBand = %q; want %q", got.StockBand, tt.wantBand)
			}
			if got.OrderReason != tt.wantOrderReason {
				t.Errorf("OrderReason = %q; want %q", got.OrderReason, tt.wantOrderReason)
			}
		})
	}
}

// TestBuildRestockSuggestion_Fase1_SuggestedMinStockConReason verifica que
// la respuesta trae SuggestedMinStock + SuggestedMinStockReason cuando el
// minimo esta mal calibrado (arriba o abajo del rango).
//
// CAMBIO 2026-09-05: la sugerencia ya NO sale del ideal reciente (14 dias) sino
// de un ideal recalculado con la VENTANA DE 90 DIAS. Regla del dueno: cambiar un
// minimo es estructural y solo aplica a productos que "lleven mucho mucho tiempo
// sin vender lo que dice el stock minimo". Con el ideal reciente, dos semanas
// flojas alcanzaban para proponer bajar un minimo bien puesto.
//
// Por eso los casos ahora fijan ventas de 90 dias (LiveTotalSold90d) en vez de
// IdealStock: la evidencia larga es la que manda.
func TestBuildRestockSuggestion_Fase1_SuggestedMinStockConReason(t *testing.T) {
	tests := []struct {
		name string
		// OJO: leadDays del fixture NO se aplica. buildRestockSuggestion RESUELVE
		// el lead con ResolveSupplierLeadTime y sobrescribe metric.SupplierLeadDays;
		// sin agenda ni lead configurado, el resuelto es 7. Los valores esperados
		// estan calculados con 7:  longTermIdeal = ceil((sold90 / 90) * 7)
		sold90     float64
		leadDays   int
		minStock   float64
		wantValue  float64
		wantReason string
	}{
		{
			// 270 en 90 dias = 3/dia -> ideal largo ceil(3*7) = 21. Min 10 -> subir.
			name:   "subir cuando la venta larga supera el minimo",
			sold90: 270, leadDays: 10, minStock: 10,
			wantValue: 21, wantReason: models.MinStockSuggestionIncrease,
		},
		{
			// 27 en 90 dias = 0,3/dia; lead 10 -> ideal largo 3. Min 100 -> bajar.
			name:   "bajar cuando lleva mucho tiempo vendiendo poco",
			sold90: 27, leadDays: 10, minStock: 100,
			wantValue: 3, wantReason: models.MinStockSuggestionDecrease,
		},
		{
			// 72 en 90 dias = 0,8/dia; lead 10 -> ideal largo 8. Min 10: coherente.
			name:   "bien calibrado no sugiere",
			sold90: 72, leadDays: 10, minStock: 10,
			wantValue: 0, wantReason: models.MinStockSuggestionNone,
		},
		{
			// Sin minimo pero con rotacion larga: sugerir ponerle uno.
			// 45 en 90 dias = 0,5/dia -> ideal largo ceil(0,5*7) = 4.
			name:   "sin minimo con venta larga sugiere subir",
			sold90: 45, leadDays: 10, minStock: 0,
			wantValue: 4, wantReason: models.MinStockSuggestionIncrease,
		},
		{
			// EL CASO QUE MOTIVO EL CAMBIO: sin evidencia larga NO se toca el
			// minimo, aunque la venta reciente sea baja. No se cambia un minimo
			// por falta de datos.
			name:   "sin ventas en 90 dias no sugiere nada",
			sold90: 0, leadDays: 10, minStock: 100,
			wantValue: 0, wantReason: models.MinStockSuggestionNone,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			row := restockSuggestionRow{}
			row.ProductRestockMetric = models.ProductRestockMetric{
				ProductID: "T", ABCCategory: "B", SupplierLeadDays: tt.leadDays,
			}
			row.MinStock = tt.minStock
			row.LiveStock = 100 // arbitrario; no afecta la sugerencia de minimo
			row.LiveTotalSold90d = tt.sold90
			row.EffectiveSupplierID = uintPtr(1)
			row.EffectiveSupplierName = strPtr("X")
			row.EffectiveUnitCost = floatPtr(100)

			got := buildRestockSuggestion(row, time.Now())
			if got.SuggestedMinStock != tt.wantValue {
				t.Errorf("SuggestedMinStock = %v; want %v", got.SuggestedMinStock, tt.wantValue)
			}
			if got.SuggestedMinStockReason != tt.wantReason {
				t.Errorf("SuggestedMinStockReason = %q; want %q", got.SuggestedMinStockReason, tt.wantReason)
			}
		})
	}
}

// TestBuildRestockSuggestion_Fase1_ExponeVentanas30y90 verifica que la
// respuesta trae totalSold90d y las dos demandas diarias por ventana.
func TestBuildRestockSuggestion_Fase1_ExponeVentanas30y90(t *testing.T) {
	row := restockSuggestionRow{}
	row.ProductRestockMetric = models.ProductRestockMetric{
		ProductID: "T", ABCCategory: "C",
	}
	row.LiveTotalSold30d = 0
	row.LiveTotalSold90d = 90
	row.LiveDaysZero30d = 0
	row.LiveDaysZero90d = 0
	row.EffectiveSupplierID = uintPtr(1)
	row.EffectiveSupplierName = strPtr("X")
	row.EffectiveUnitCost = floatPtr(100)

	got := buildRestockSuggestion(row, time.Now())
	if got.TotalSold90d != 90 {
		t.Errorf("TotalSold90d = %v; want 90", got.TotalSold90d)
	}
	if got.AvgDailySales30d != 0 {
		t.Errorf("AvgDailySales30d = %v; want 0 (sin ventas 30d)", got.AvgDailySales30d)
	}
	if got.AvgDailySales90d != 1 {
		t.Errorf("AvgDailySales90d = %v; want 1 (90/90)", got.AvgDailySales90d)
	}
}

// TestBuildRestockSuggestion_Fase1_ClaseCPideAhora verifica el cambio de
// contrato: clase C ya no se veta, ahora puede pedir por demanda.
func TestBuildRestockSuggestion_Fase1_ClaseCPideAhora(t *testing.T) {
	row := restockSuggestionRow{}
	row.ProductRestockMetric = models.ProductRestockMetric{
		ProductID: "LENTO", ABCCategory: "C",
		IdealStock: 5, // demanda 90d, colchon 1.0
	}
	row.LiveStock = 0
	row.MinStock = 0 // sin minimo, para probar la rama pura de demanda
	row.EffectiveSupplierID = uintPtr(1)
	row.EffectiveSupplierName = strPtr("X")
	row.EffectiveUnitCost = floatPtr(100)

	got := buildRestockSuggestion(row, time.Now())
	if got.SuggestedOrderQty != 5 {
		t.Fatalf("SuggestedOrderQty = %v; want 5 (clase C ya pide por demanda)", got.SuggestedOrderQty)
	}
	if got.OrderReason != models.OrderReasonDemand {
		t.Fatalf("OrderReason = %q; want demand", got.OrderReason)
	}
	// El mensaje no debe culpar a la clase.
	if got.Recommendation == "" {
		t.Fatal("recommendation vacio")
	}
}

func TestRestockSuggestionsSQLCandidateFirst(t *testing.T) {
	sqlText := restockSuggestionsSQL
	candidate := strings.Index(sqlText, "WITH candidatos AS")
	transit := strings.Index(sqlText, "), transito_vivo AS")
	sales := strings.Index(sqlText, "), ventas_vivas AS")
	zero := strings.Index(sqlText, "), dias_cero AS")
	if candidate < 0 || transit <= candidate || sales <= transit || zero <= sales {
		t.Fatalf("orden de CTEs no es candidate-first: candidatos=%d tránsito=%d ventas=%d cero=%d", candidate, transit, sales, zero)
	}

	for _, required := range []string{
		`JOIN candidatos c ON c.product_id = coi.product_id`,
		`JOIN candidatos c ON c.product_id = poi."productBarcode"`,
		`JOIN candidatos c ON c.product_id = sd.barcode`,
		`JOIN candidatos c ON c.product_id = dss.product_id`,
		`FROM candidatos c`,
	} {
		if !strings.Contains(sqlText, required) {
			t.Errorf("falta restricción candidate-first %q", required)
		}
	}
}

func TestRestockSuggestionsSQLFiltroHuerfanoVivoYParametrizado(t *testing.T) {
	for _, required := range []string{
		`@unassigned_only = TRUE`,
		`p."supplierId" IS NULL`,
		`NOT EXISTS (`,
		`FROM product_suppliers orphan_links`,
		`p.deleted_at IS NULL`,
		`COALESCE(p."isActive", TRUE) = TRUE`,
		`@supplier_id`,
		`@search`,
	} {
		if !strings.Contains(restockSuggestionsSQL, required) {
			t.Errorf("SQL de huérfanos no contiene %q", required)
		}
	}
	if strings.Contains(restockSuggestionsSQL, `NOT IN (SELECT product_barcode`) {
		t.Error("el filtro huérfano debe usar NOT EXISTS para semántica viva y tolerancia a NULL")
	}
}

func TestRestockSuggestionsSQLConservaVentanasFase1(t *testing.T) {
	for _, required := range []string{
		`INTERVAL '30 days'`,
		`INTERVAL '90 days'`,
		`CURRENT_DATE - 30`,
		`CURRENT_DATE - 90`,
		`effective.learned_visit_days`,
		`ps."purchasePrice" < effective.unit_cost`,
	} {
		if !strings.Contains(restockSuggestionsSQL, required) {
			t.Errorf("consulta perdió señal de Fase 1 %q", required)
		}
	}
}

func TestGetSuggestionsRechazaUnassignedConSupplierAntesDeConsultar(t *testing.T) {
	supplierID := uint(12)
	repo := &RestockMetricsRepository{}
	_, err := repo.GetSuggestions(t.Context(), SuggestionQueryParams{
		SupplierID: &supplierID, UnassignedOnly: true,
	})
	if err == nil {
		t.Fatal("se esperaba conflicto de filtros antes de consultar la base")
	}
}

func TestRestockSuggestionQueryArgsLimitaSearchPorRunasUnicode(t *testing.T) {
	tests := []struct {
		name     string
		boundary string
	}{
		{name: "enye", boundary: "ñ"},
		{name: "vocal con tilde", boundary: "á"},
		{name: "emoji", boundary: "🛒"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := strings.Repeat("a", MaxSuggestionSearchLength-1) + tt.boundary + "final"
			if utf8.ValidString(input[:MaxSuggestionSearchLength]) {
				t.Fatalf("fixture inválido: el corte histórico por bytes no parte %q", tt.boundary)
			}

			args := restockSuggestionQueryArgs(0, false, input)
			searchArg, ok := args[2].(sql.NamedArg)
			if !ok || searchArg.Name != "search" {
				t.Fatalf("argumento SQL search = %#v; se esperaba sql.NamedArg", args[2])
			}
			search, ok := searchArg.Value.(string)
			if !ok {
				t.Fatalf("valor SQL search tiene tipo %T; se esperaba string", searchArg.Value)
			}
			if !utf8.ValidString(search) {
				t.Fatalf("SQL recibió UTF-8 inválido: %q", search)
			}
			if got := utf8.RuneCountInString(search); got != MaxSuggestionSearchLength {
				t.Fatalf("search contiene %d runas; se esperaban %d", got, MaxSuggestionSearchLength)
			}
			if !strings.HasSuffix(search, tt.boundary) {
				t.Fatalf("search = %q; perdió la runa límite %q", search, tt.boundary)
			}
		})
	}
}
