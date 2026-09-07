package models

import "testing"

// TestClassifyStockBand cubre la regla nueva del semaforo (agosto 2026):
// ROJO < 25%, AMARILLO 25% – 75%, VERDE >= 75%. Es el contrato con las
// consultas SQL de stats/paginacion y con el dashboard.
func TestClassifyStockBand(t *testing.T) {
	cases := []struct {
		name     string
		stock    float64
		minStock float64
		want     string
	}{
		// Sin minimo: la banda no juzga contra el minimo.
		{name: "sin minimo y sin stock", stock: 0, minStock: 0, want: StockBandRed},
		{name: "sin minimo y stock negativo", stock: -1, minStock: 0, want: StockBandRed},
		{name: "sin minimo y stock positivo", stock: 5, minStock: 0, want: StockBandUnset},
		{name: "sin minimo y stock 0.5", stock: 0.5, minStock: 0, want: StockBandUnset},
		{name: "minimo negativo cuenta como sin minimo", stock: 3, minStock: -2, want: StockBandUnset},
		{name: "minimo negativo con stock cero es rojo", stock: 0, minStock: -2, want: StockBandRed},

		// Con minimo: ratio = stock/minStock. Fronteras exactas 0.25 y 0.75.
		{name: "stock 0 con minimo 10 -> 0%% rojo", stock: 0, minStock: 10, want: StockBandRed},
		{name: "stock 2 con minimo 10 -> 20%% rojo", stock: 2, minStock: 10, want: StockBandRed},
		{name: "stock 2.49 con minimo 10 -> 24.9%% rojo", stock: 2.49, minStock: 10, want: StockBandRed},
		{name: "stock exactamente 25%% del minimo -> amarillo", stock: 2.5, minStock: 10, want: StockBandYellow},
		{name: "stock 5 con minimo 10 -> 50%% amarillo", stock: 5, minStock: 10, want: StockBandYellow},
		{name: "stock 7.49 con minimo 10 -> 74.9%% amarillo", stock: 7.49, minStock: 10, want: StockBandYellow},
		{name: "stock exactamente 75%% del minimo -> verde", stock: 7.5, minStock: 10, want: StockBandGreen},
		{name: "stock igual al minimo -> verde", stock: 10, minStock: 10, want: StockBandGreen},
		{name: "stock por encima del minimo -> verde", stock: 20, minStock: 10, want: StockBandGreen},

		// Casos limite.
		{name: "1 unidad de 4 -> 25%% amarillo", stock: 1, minStock: 4, want: StockBandYellow},
		{name: "3 unidades de 4 -> 75%% verde", stock: 3, minStock: 4, want: StockBandGreen},
		{name: "stock negativo con minimo positivo es rojo", stock: -3, minStock: 10, want: StockBandRed},
		// Frontera exacta del caso famoso: minimo 30, stock 24 -> ratio 0.8, verde.
		{name: "minimo 30 stock 24 -> 80%% verde", stock: 24, minStock: 30, want: StockBandGreen},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClassifyStockBand(tc.stock, tc.minStock); got != tc.want {
				t.Fatalf("ClassifyStockBand(%v, %v) = %q; want %q", tc.stock, tc.minStock, got, tc.want)
			}
		})
	}
}

// TestTargetShortfall verifica el objetivo de reposicion nuevo (Fase 1,
// agosto 2026): apuntar al 75% del minimo, redondear hacia arriba y no
// pedir cuando ya se cubrio.
func TestTargetShortfall(t *testing.T) {
	tests := []struct {
		name                                 string
		minStock, currentStock, inTransitQty float64
		want                                 float64
	}{
		{name: "sin minimo devuelve 0", minStock: 0, currentStock: 0, want: 0},
		{name: "minimo negativo devuelve 0", minStock: -5, currentStock: 0, want: 0},
		// COLATE del brief: stock 6, min 12 -> falta 3 para 75%.
		{name: "COLATE min 12 stock 6 pide 3", minStock: 12, currentStock: 6, want: 3},
		// SUAVITEL del brief: stock 1, min 6 -> falta 4 para 75% (ceil de 3.5).
		{name: "SUAVITEL min 6 stock 1 pide 4", minStock: 6, currentStock: 1, want: 4},
		// Verde exacto: 75% del minimo ya esta cubierto, no falta nada.
		{name: "stock exacto en 75%% no falta nada", minStock: 40, currentStock: 30, want: 0},
		{name: "stock por encima del 75%% no falta nada", minStock: 40, currentStock: 35, want: 0},
		// Amarillo con transito que ya cubre el 75%.
		{name: "amarillo con transito que cubre el 75%%", minStock: 40, currentStock: 12, inTransitQty: 20, want: 0},
		// Rojo con transito que no alcanza.
		{name: "rojo con transito que no alcanza", minStock: 100, currentStock: 10, inTransitQty: 20, want: 45},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := TargetShortfall(tt.minStock, tt.currentStock, tt.inTransitQty); got != tt.want {
				t.Fatalf("TargetShortfall(%v, %v, %v) = %v; want %v",
					tt.minStock, tt.currentStock, tt.inTransitQty, got, tt.want)
			}
		})
	}
}

// TestRedFloorShortfall verifica que el helper legado (piso 25%, banda ROJA)
// sigue funcionando para las heuristicas que lo usan (alta rotacion en
// InventoryService y fallback de Telegram en cron_jobs). Bajo la regla nueva
// las decisiones de pedido usan TargetShortfall, no esto.
func TestRedFloorShortfall(t *testing.T) {
	tests := []struct {
		name                                 string
		minStock, currentStock, inTransitQty float64
		want                                 float64
	}{
		{name: "sin minimo devuelve 0", minStock: 0, currentStock: 0, want: 0},
		{name: "minimo negativo devuelve 0", minStock: -5, currentStock: 0, want: 0},
		{name: "minimo 100 stock 10 pide 15", minStock: 100, currentStock: 10, want: 15},
		{name: "minimo 10 stock 0 pide 3 (ceil de 2.5)", minStock: 10, currentStock: 0, want: 3},
		{name: "el transito cuenta como disponible", minStock: 100, currentStock: 10, inTransitQty: 15, want: 0},
		{name: "el transito no alcanza", minStock: 100, currentStock: 5, inTransitQty: 5, want: 15},
		{name: "stock exacto en 25%% ya es amarillo, sin piso", minStock: 40, currentStock: 10, want: 0},
		{name: "banda amarilla sin piso", minStock: 30, currentStock: 15, want: 0},
		{name: "banda verde sin piso", minStock: 30, currentStock: 25, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := RedFloorShortfall(tt.minStock, tt.currentStock, tt.inTransitQty); got != tt.want {
				t.Fatalf("RedFloorShortfall(%v, %v, %v) = %v; want %v",
					tt.minStock, tt.currentStock, tt.inTransitQty, got, tt.want)
			}
		})
	}
}

// TestSuggestMinStockChange cubre las tres bandas (subir/bajar/no-change)
// y el caso especial de minimo ausente con demanda.
func TestSuggestMinStockChange(t *testing.T) {
	tests := []struct {
		name       string
		idealStock float64
		minStock   float64
		wantValue  float64
		wantReason string
	}{
		// Sin minimo pero con demanda: sugerir subir.
		{name: "sin minimo con ideal 5 sugiere subir a 5", idealStock: 5, minStock: 0, wantValue: 5, wantReason: MinStockSuggestionIncrease},
		{name: "sin minimo con ideal 2.3 sugiere subir a 3", idealStock: 2.3, minStock: 0, wantValue: 3, wantReason: MinStockSuggestionIncrease},
		// Sin minimo y sin demanda: no sugerir.
		{name: "sin minimo y sin ideal no sugiere", idealStock: 0, minStock: 0, wantValue: 0, wantReason: MinStockSuggestionNone},
		// Minimo negativo se trata como sin minimo.
		{name: "minimo negativo con ideal 5 sugiere subir a 5", idealStock: 5, minStock: -1, wantValue: 5, wantReason: MinStockSuggestionIncrease},

		// Subir cuando el ideal es > 125% del minimo actual.
		{name: "ideal 13 con minimo 10 sugiere subir a 13", idealStock: 13, minStock: 10, wantValue: 13, wantReason: MinStockSuggestionIncrease},
		{name: "ideal 12.6 con minimo 10 sugiere subir a 13 (ceil)", idealStock: 12.6, minStock: 10, wantValue: 13, wantReason: MinStockSuggestionIncrease},
		{name: "ideal 12.5 (exacto 125%%) NO sugiere subir", idealStock: 12.5, minStock: 10, wantValue: 0, wantReason: MinStockSuggestionNone},

		// Bajar cuando el ideal es < 50% del minimo actual.
		{name: "minimo 100 con ideal 3 sugiere bajar a 3", idealStock: 3, minStock: 100, wantValue: 3, wantReason: MinStockSuggestionDecrease},
		{name: "minimo 30 con ideal 1 sugiere bajar a 1", idealStock: 1, minStock: 30, wantValue: 1, wantReason: MinStockSuggestionDecrease},
		{name: "minimo 20 con ideal 0 sugiere bajar a 1 (piso)", idealStock: 0, minStock: 20, wantValue: 1, wantReason: MinStockSuggestionDecrease},
		{name: "minimo 100 con ideal 2.3 sugiere bajar a 3 (ceil)", idealStock: 2.3, minStock: 100, wantValue: 3, wantReason: MinStockSuggestionDecrease},

		// Entre bandas: no sugerir.
		{name: "ideal 9 con minimo 10 no sugiere (dentro de la banda)", idealStock: 9, minStock: 10, wantValue: 0, wantReason: MinStockSuggestionNone},
		{name: "ideal exactamente 50%% del minimo no sugiere (no es <)", idealStock: 5, minStock: 10, wantValue: 0, wantReason: MinStockSuggestionNone},
		{name: "ideal exactamente el minimo no sugiere", idealStock: 10, minStock: 10, wantValue: 0, wantReason: MinStockSuggestionNone},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotValue, gotReason := SuggestMinStockChange(tt.idealStock, tt.minStock)
			if gotValue != tt.wantValue || gotReason != tt.wantReason {
				t.Fatalf("SuggestMinStockChange(%v, %v) = (%v, %q); want (%v, %q)",
					tt.idealStock, tt.minStock, gotValue, gotReason, tt.wantValue, tt.wantReason)
			}
		})
	}
}

// TestSuggestedMinStockLegacy verifica que el wrapper legado sigue
// devolviendo solo el numero, sin la razon.
func TestSuggestedMinStockLegacy(t *testing.T) {
	if got := SuggestedMinStock(3, 100); got != 3 {
		t.Fatalf("SuggestedMinStock(3,100) = %v; want 3", got)
	}
	if got := SuggestedMinStock(9, 10); got != 0 {
		t.Fatalf("SuggestedMinStock(9,10) = %v; want 0", got)
	}
	if got := SuggestedMinStock(15, 10); got != 15 {
		t.Fatalf("SuggestedMinStock(15,10) = %v; want 15 (subir)", got)
	}
	if got := SuggestedMinStock(0, 20); got != 1 {
		t.Fatalf("SuggestedMinStock(0,20) = %v; want 1 (piso al bajar)", got)
	}
}
