package models

import "testing"

// ============================================================================
// SuggestedOrderQty — Fase 1 (agosto 2026)
// ============================================================================
//
// Regla:
//   qty = max(byTarget, byDemand)
//     byTarget = ceil(max(0, minStock*0.75 - (stock + transito))). Aplica en
//                ROJO y AMARILLO; en VERDE naturalmente da 0.
//     byDemand = max(0, idealStock - (stock + transito)). Aplica a TODAS
//                las clases, incluida C.
//
// La clase ABC ya no bloquea pedidos: se pasa como parametro por
// retrocompatibilidad pero no afecta el resultado. El colchon por clase
// entra rio arriba, en el idealStock.
// ============================================================================

func TestSuggestedOrderQty_DescuentaLoQueYaVaEnCamino(t *testing.T) {
	// Sin minimo: la rama por objetivo degrada a 0; manda la demanda.
	if got := SuggestedOrderQty(28, 4, 5, 0, "A"); got != 19 {
		t.Fatalf("sugerencia = %v; want 19", got)
	}
	if got := SuggestedOrderQty(28, 4, 24, 0, "A"); got != 0 {
		t.Fatalf("con suficiente en camino la sugerencia debe ser 0, dio %v", got)
	}
	if got := SuggestedOrderQty(28, 30, 0, 0, "A"); got != 0 {
		t.Fatalf("con stock por encima del ideal la sugerencia debe ser 0, dio %v", got)
	}
}

func TestSuggestedOrderQty_ClaseCPidePorDemanda(t *testing.T) {
	// Fase 1: la clase C YA participa en la rama por demanda. Antes se
	// vetaba; ahora si hay ideal y no hay stock, pide.
	if got := SuggestedOrderQty(100, 0, 0, 0, "C"); got != 100 {
		t.Fatalf("clase C con ideal 100 = %v; want 100", got)
	}
	// Sin ideal ni minimo: nada que pedir en ninguna rama.
	if got := SuggestedOrderQty(0, 0, 0, 0, "C"); got != 0 {
		t.Fatalf("clase C sin ideal ni minimo = %v; want 0", got)
	}
}

func TestSuggestedOrderQty_PideTodoElIdealSinExistencias(t *testing.T) {
	if got := SuggestedOrderQty(28, 0, 0, 0, "A"); got != 28 {
		t.Fatalf("sugerencia = %v; want 28", got)
	}
	if got := SuggestedOrderQty(15, 0, 0, 0, "B"); got != 15 {
		t.Fatalf("sugerencia = %v; want 15", got)
	}
	// Clase C ya no se veta.
	if got := SuggestedOrderQty(4, 0, 0, 0, "C"); got != 4 {
		t.Fatalf("clase C con ideal 4 = %v; want 4", got)
	}
}

// TestSuggestedOrderQty_ObjetivoDelBrief cubre los escenarios que el brief
// de Fase 1 nombro textualmente (COLATE, SUAVITEL, etc.).
func TestSuggestedOrderQty_ObjetivoDelBrief(t *testing.T) {
	tests := []struct {
		name         string
		idealStock   float64
		currentStock float64
		inTransitQty float64
		minStock     float64
		abcCategory  string
		want         float64
	}{
		{
			// COLATE: stock 6, min 12, demanda baja/clase C -> pide 3 por objetivo.
			// byTarget = ceil(9 - 6) = 3. byDemand = max(0, ideal - 6) = 0 (ideal chico).
			name:       "COLATE stock 6 min 12 pide 3 por objetivo",
			idealStock: 1, currentStock: 6, inTransitQty: 0,
			minStock: 12, abcCategory: "C", want: 3,
		},
		{
			// SUAVITEL: stock 1, min 6 -> pide 4 por objetivo.
			// byTarget = ceil(4.5 - 1) = 4. byDemand = max(0, 0 - 1) = 0.
			name:       "SUAVITEL stock 1 min 6 pide 4 por objetivo",
			idealStock: 0, currentStock: 1, inTransitQty: 0,
			minStock: 6, abcCategory: "C", want: 4,
		},
		{
			// REGLA DEL DUEÑO (2026-09-04): este es EXACTAMENTE el caso que
			// reclamó. Antes pedía 1 por objetivo (byTarget = ceil(3-2) = 1) y
			// con veinte productos así la factura se inflaba sin resolver nada.
			// Ahora, como todavía hay existencia (stock 2 > 0) y la necesidad
			// no llega al piso de 3, NO se pide: se deja acumular.
			name:       "producto lento stock 2 min 4 ya NO pide 1 (necesidad marginal)",
			idealStock: 1, currentStock: 2, inTransitQty: 0,
			minStock: 4, abcCategory: "C", want: 0,
		},
		{
			// Sano: stock 6, min 6, demanda que no supera stock.
			// ratio = 1.0, VERDE. byTarget = 0. byDemand = max(0, 3 - 6) = 0.
			name:       "sano stock 6 min 6 verde no pide",
			idealStock: 3, currentStock: 6, inTransitQty: 0,
			minStock: 6, abcCategory: "B", want: 0,
		},
		{
			// Demanda alta que supera el objetivo 75%: manda la demanda.
			// byTarget = ceil(22.5 - 5) = 18. byDemand = max(0, 40 - 5) = 35.
			name:       "demanda alta gana al objetivo",
			idealStock: 40, currentStock: 5, inTransitQty: 0,
			minStock: 30, abcCategory: "A", want: 35,
		},
		{
			// En camino que ya cubre el objetivo: byTarget queda en 0.
			// byTarget = ceil(4.5 - (2 + 4)) = ceil(-1.5) -> 0. byDemand = 0.
			name:       "transito cubre el objetivo",
			idealStock: 3, currentStock: 2, inTransitQty: 4,
			minStock: 6, abcCategory: "B", want: 0,
		},
		{
			// Sin minimo: la rama de objetivo se apaga; queda la demanda.
			name:       "sin minimo con demanda alta pide por demanda",
			idealStock: 10, currentStock: 3, inTransitQty: 0,
			minStock: 0, abcCategory: "B", want: 7,
		},
		{
			// Objetivo aplica a AMARILLO tambien (no solo a ROJO).
			// stock 15, min 30, ratio 0.5 AMARILLO.
			// byTarget = ceil(22.5 - 15) = 8. byDemand = 0.
			name:       "amarillo con objetivo activo pide 8",
			idealStock: 0, currentStock: 15, inTransitQty: 0,
			minStock: 30, abcCategory: "B", want: 8,
		},
		// --------------------------------------------------------------------
		// FILTRO DE NECESIDAD MARGINAL (regla del dueño 2026-09-04)
		// --------------------------------------------------------------------
		{
			// AGOTADO es la excepcion: se pide aunque sea 1 unidad, porque no
			// hay con que vender. Aca el criterio de "factura grande" no aplica.
			name:       "agotado pide aunque sea 1 unidad",
			idealStock: 1, currentStock: 0, inTransitQty: 0,
			minStock: 1, abcCategory: "C", want: 1,
		},
		{
			// Agotado con minimo chico: byTarget = ceil(0.75*2 - 0) = 2.
			// Menor que el piso de 3, pero esta agotado -> se pide.
			name:       "agotado con minimo chico pide los 2 que faltan",
			idealStock: 0, currentStock: 0, inTransitQty: 0,
			minStock: 2, abcCategory: "C", want: 2,
		},
		{
			// Con existencia y necesidad de 2 (bajo el piso): se espera.
			// byTarget = ceil(0.75*8 - 4) = 2.
			name:       "con existencia y necesidad de 2 no se pide todavia",
			idealStock: 0, currentStock: 4, inTransitQty: 0,
			minStock: 8, abcCategory: "B", want: 0,
		},
		{
			// Justo en el piso: 3 SI se pide (el corte es < 3, no <= 3).
			// byTarget = ceil(0.75*12 - 6) = 3.
			name:       "necesidad de 3 exactos si se pide",
			idealStock: 0, currentStock: 6, inTransitQty: 0,
			minStock: 12, abcCategory: "B", want: 3,
		},
		{
			// El transito cuenta como disponible para la excepcion de agotado:
			// stock 0 pero 5 en camino -> NO esta agotado, y la necesidad
			// marginal se suprime.
			name:       "stock 0 con transito no cuenta como agotado",
			idealStock: 1, currentStock: 0, inTransitQty: 5,
			minStock: 8, abcCategory: "B", want: 0,
		},
		{
			// Lo que mas se vende NO se ve afectado por el filtro: la demanda
			// alta genera cantidades muy por encima del piso.
			name:       "alta rotacion no se ve afectada por el piso",
			idealStock: 60, currentStock: 4, inTransitQty: 0,
			minStock: 10, abcCategory: "A", want: 56,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SuggestedOrderQty(tt.idealStock, tt.currentStock, tt.inTransitQty, tt.minStock, tt.abcCategory)
			if got != tt.want {
				t.Fatalf("SuggestedOrderQty(ideal=%v, stock=%v, transito=%v, min=%v, %q) = %v; want %v",
					tt.idealStock, tt.currentStock, tt.inTransitQty, tt.minStock,
					tt.abcCategory, got, tt.want)
			}
		})
	}
}

func TestMinStockShortfall(t *testing.T) {
	tests := []struct {
		name                                 string
		minStock, currentStock, inTransitQty float64
		want                                 float64
	}{
		{name: "sin minimo configurado", minStock: 0, currentStock: 0, want: 0},
		{name: "minimo negativo se ignora", minStock: -5, currentStock: 0, want: 0},
		{name: "faltan 6 para el minimo", minStock: 30, currentStock: 24, want: 6},
		{name: "el transito cuenta como disponible", minStock: 30, currentStock: 24, inTransitQty: 6, want: 0},
		{name: "el transito no alcanza", minStock: 30, currentStock: 5, inTransitQty: 5, want: 20},
		{name: "stock igual al minimo", minStock: 30, currentStock: 30, want: 0},
		{name: "stock sobre el minimo", minStock: 30, currentStock: 45, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := MinStockShortfall(tt.minStock, tt.currentStock, tt.inTransitQty); got != tt.want {
				t.Fatalf("MinStockShortfall(%v, %v, %v) = %v; want %v",
					tt.minStock, tt.currentStock, tt.inTransitQty, got, tt.want)
			}
		})
	}
}
