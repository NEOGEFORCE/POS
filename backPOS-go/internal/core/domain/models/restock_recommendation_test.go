package models

import (
	"strings"
	"testing"
)

func days(value int) *int { return &value }

// TestRecommendationFlagsSoldOutProductsAsUrgent: sin minimo, stock 0, con
// ventas. La banda es ROJA (agotado sin minimo). Nivel = urgent.
func TestRecommendationFlagsSoldOutProductsAsUrgent(t *testing.T) {
	message, level := BuildRestockRecommendation(RestockDecisionInput{
		CurrentStock: 0, AvgDailySales: 1.36, ABCCategory: "A", SuggestedOrderQty: 10,
	})
	if level != RestockLevelUrgent {
		t.Fatalf("nivel = %s, want %s (%s)", level, RestockLevelUrgent, message)
	}
}

// TestRecommendationSkipsProductsWithoutRotation: sin minimo, con existencias
// y sin rotacion. La banda no aplica (UNSET). Nivel = skip.
func TestRecommendationSkipsProductsWithoutRotation(t *testing.T) {
	// Rotacion baja, clase C. SuggestedOrderQty=0 (nada que pedir).
	message, level := BuildRestockRecommendation(RestockDecisionInput{
		CurrentStock: 4, AvgDailySales: 0.14, ABCCategory: "C",
		SuggestedOrderQty: 0, DaysSinceReception: days(20),
	})
	if level != RestockLevelSkip {
		t.Fatalf("nivel = %s, want %s (%s)", level, RestockLevelSkip, message)
	}
	// Fase 1: nunca se culpa a la clase C.
	if strings.Contains(message, "baja rotación") || strings.Contains(message, "clase C") {
		t.Fatalf("mensaje no debe culpar a clase C: %q", message)
	}

	// Sin ventas y con existencias. Sin minimo.
	message, level = BuildRestockRecommendation(RestockDecisionInput{
		CurrentStock: 3, AvgDailySales: 0, ABCCategory: "C", DaysSinceReception: days(45),
	})
	if level != RestockLevelSkip {
		t.Fatalf("sin ventas: nivel = %s, want %s (%s)", level, RestockLevelSkip, message)
	}
}

// TestRecommendationOrdersUsingReceptionAndSales: banda amarilla/verde con
// demanda por cubrir. El mensaje habla de recepcion y ventas.
func TestRecommendationOrdersUsingReceptionAndSales(t *testing.T) {
	message, level := BuildRestockRecommendation(RestockDecisionInput{
		CurrentStock: 2, AvgDailySales: 1.5, ABCCategory: "A",
		SuggestedOrderQty: 9, DaysSinceReception: days(6), SoldSinceReception: 11,
	})
	if level != RestockLevelOrder {
		t.Fatalf("nivel = %s, want %s", level, RestockLevelOrder)
	}
	expected := "Pedir 9: última recepción hace 6 días y 11 vendidas desde entonces"
	if message != expected {
		t.Fatalf("mensaje = %q, want %q", message, expected)
	}
}

// TestRecommendationHandlesProductsNeverReceived: banda UNSET (sin minimo) con
// demanda. Mensaje sin fecha de recepcion.
func TestRecommendationHandlesProductsNeverReceived(t *testing.T) {
	message, level := BuildRestockRecommendation(RestockDecisionInput{
		CurrentStock: 1, AvgDailySales: 0.8, ABCCategory: "B", SuggestedOrderQty: 5,
	})
	if level != RestockLevelOrder {
		t.Fatalf("nivel = %s, want %s (%s)", level, RestockLevelOrder, message)
	}
	if message != "Pedir 5: sin recepciones registradas" {
		t.Fatalf("mensaje = %q", message)
	}
}

// ============================================================================
// REGLA DE PEDIDOS (Fase 1, agosto 2026): banda + objetivo 75% + demanda
// ============================================================================
//
// Tabla que cubre los escenarios que el brief pidio explicitamente. Cada
// caso tiene su motivo especifico y se testea que el mensaje y el nivel
// sean consistentes con la banda que ve el operador en la tarjeta.
func TestRecommendationBandaYObjetivo(t *testing.T) {
	tests := []struct {
		name            string
		input           RestockDecisionInput
		wantLevel       string
		wantOrder       bool     // ¿se pide o no se pide?
		wantMessagePart string   // substring que tiene que aparecer en el mensaje
		forbiddenParts  []string // substrings prohibidos en el mensaje
	}{
		{
			// COLATE del brief: stock 6, min 12, demanda baja/clase C.
			// byTarget = ceil(9-6) = 3, byDemand = 0. SuggestedOrderQty = 3.
			// ratio = 0.5 -> AMARILLO.
			name: "COLATE amarillo pide 3 por objetivo",
			input: RestockDecisionInput{
				MinStock: 12, CurrentStock: 6, InTransitQty: 0,
				SuggestedOrderQty: 3, AvgDailySales: 0.03, ABCCategory: "C",
			},
			wantLevel: RestockLevelOrder, wantOrder: true,
			wantMessagePart: "75% del mínimo",
			forbiddenParts:  []string{"baja rotación", "clase C"},
		},
		{
			// SUAVITEL: stock 1, min 6, ratio 0.17 -> ROJO. Pide 4 por objetivo.
			name: "SUAVITEL rojo pide 4 por objetivo",
			input: RestockDecisionInput{
				MinStock: 6, CurrentStock: 1, InTransitQty: 0,
				SuggestedOrderQty: 4, AvgDailySales: 0, ABCCategory: "C",
			},
			wantLevel: RestockLevelUrgent, wantOrder: true,
			wantMessagePart: "75% del mínimo",
			forbiddenParts:  []string{"cobertura suficiente", "baja rotación"},
		},
		{
			// Sano: stock 6, min 6, ratio 1.0 VERDE. Sin pedido.
			name: "sano verde no pide y no culpa a la clase",
			input: RestockDecisionInput{
				MinStock: 6, CurrentStock: 6, InTransitQty: 0,
				SuggestedOrderQty: 0, AvgDailySales: 0.5, ABCCategory: "C",
				DaysSinceReception: days(10),
			},
			wantLevel: RestockLevelSkip, wantOrder: false,
			wantMessagePart: "verde",
			forbiddenParts:  []string{"clase C", "baja rotación"},
		},
		{
			// Verde con demanda alta: se pide POR DEMANDA aunque la banda
			// sea verde.
			name: "minimo 30 stock 24 verde con demanda alta pide 16 por demanda",
			input: RestockDecisionInput{
				MinStock: 30, CurrentStock: 24, InTransitQty: 0,
				SuggestedOrderQty: 16, AvgDailySales: 6, ABCCategory: "A",
				DaysSinceReception: days(5),
			},
			wantLevel: RestockLevelOrder, wantOrder: true,
			wantMessagePart: "Pedir 16",
			forbiddenParts:  []string{"objetivo", "mínimo"},
		},
		{
			// En camino que cubre el objetivo: no se pide.
			// Stock 5, transito 10, min 30. byTarget = ceil(22.5 - 15) = 8.
			// (transito no basta para el 75% -> objetivo pide 8.)
			// Pero si SuggestedOrderQty pasa como 0 (asi lo simulariamos si el
			// transito fuera suficiente), el mensaje habla del transito.
			name: "transito que cubre el objetivo -> wait",
			input: RestockDecisionInput{
				MinStock: 30, CurrentStock: 5, InTransitQty: 25,
				SuggestedOrderQty: 0, AvgDailySales: 1, ABCCategory: "B",
			},
			wantLevel: RestockLevelWait, wantOrder: false,
			wantMessagePart: "en camino",
			forbiddenParts:  []string{"cobertura suficiente"},
		},
		{
			// Sin minimo configurado: se conserva el criterio de rotacion.
			name: "sin minimo y sin ventas no se pide",
			input: RestockDecisionInput{
				MinStock: 0, CurrentStock: 3, InTransitQty: 0,
				SuggestedOrderQty: 0, AvgDailySales: 0, ABCCategory: "C",
				DaysSinceReception: days(45),
			},
			wantLevel: RestockLevelSkip, wantOrder: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			message, level := BuildRestockRecommendation(tt.input)
			if level != tt.wantLevel {
				t.Fatalf("nivel = %q, want %q (mensaje: %s)", level, tt.wantLevel, message)
			}
			ordered := level == RestockLevelOrder || level == RestockLevelUrgent
			if ordered != tt.wantOrder {
				t.Fatalf("¿se pide? = %v, want %v (mensaje: %s)", ordered, tt.wantOrder, message)
			}
			if tt.wantMessagePart != "" && !strings.Contains(message, tt.wantMessagePart) {
				t.Fatalf("mensaje = %q; debe contener %q", message, tt.wantMessagePart)
			}
			for _, forbidden := range tt.forbiddenParts {
				if strings.Contains(message, forbidden) {
					t.Fatalf("mensaje = %q; NO debe contener %q", message, forbidden)
				}
			}
		})
	}
}

// TestRecommendationNuncaDiceCoberturaSuficienteEnRojo: guardian del sintoma
// exacto que reporto el dueno.
func TestRecommendationNuncaDiceCoberturaSuficienteEnRojo(t *testing.T) {
	for _, minStock := range []float64{1, 5, 10, 30, 100} {
		// Recorre stocks debajo del 25% (banda roja garantizada) y arriba
		// de 0 tambien (para no colisionar con "agotado sin minimo").
		for stock := 0.0; stock < minStock*0.25; stock += minStock * 0.05 {
			for _, abc := range []string{"A", "B", "C"} {
				for _, avgDaily := range []float64{0, 0.1, 3} {
					// Bajo la Fase 1, byTarget se computa hasta el 75%.
					target := minStock * 0.75
					suggested := 0.0
					if missing := target - stock; missing > 0 {
						// ceil como TargetShortfall.
						suggested = float64(int(missing))
						if suggested < missing {
							suggested++
						}
					}
					input := RestockDecisionInput{
						MinStock: minStock, CurrentStock: stock,
						AvgDailySales:     avgDaily,
						ABCCategory:       abc,
						SuggestedOrderQty: suggested,
					}
					message, level := BuildRestockRecommendation(input)
					if strings.Contains(message, "cobertura suficiente") {
						t.Fatalf("min=%v stock=%v: mensaje contradictorio %q",
							minStock, stock, message)
					}
					if strings.Contains(message, "baja rotación") {
						t.Fatalf("min=%v stock=%v abc=%s: mensaje culpa a clase %q", minStock, stock, abc, message)
					}
					if suggested > 0 {
						if level != RestockLevelUrgent {
							t.Fatalf("min=%v stock=%v: nivel = %q, want urgent (%s)",
								minStock, stock, level, message)
						}
					}
				}
			}
		}
	}
}

// TestRecommendationTransitoQueSacaDelRojoDaWait: cuando el transito por si
// solo cubre el objetivo, la sugerencia es 0 y el mensaje explica que el
// transito ya cubre.
func TestRecommendationTransitoCubreObjetivoDaWait(t *testing.T) {
	message, level := BuildRestockRecommendation(RestockDecisionInput{
		MinStock: 30, CurrentStock: 5, InTransitQty: 25,
		SuggestedOrderQty: 0, AvgDailySales: 1, ABCCategory: "B",
	})
	if level != RestockLevelWait {
		t.Fatalf("nivel = %s, want wait (%s)", level, message)
	}
	if !strings.Contains(message, "objetivo") {
		t.Fatalf("mensaje = %q; debe explicar que el transito cubre el objetivo", message)
	}
}
