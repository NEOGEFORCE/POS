package services

import "testing"

// TestClassifyStockHealth verifica que el mapeo historico
// (CRITICAL/WARNING/OPTIMAL) siga los cortes nuevos del semaforo del dueno
// (agosto 2026): ROJO < 25%, AMARILLO 25%–75%, VERDE >= 75%.
//
// Los umbrales viven en models.ClassifyStockBand y aca se prueban solo por
// el adaptador. Si aca cambian, la consulta SQL de GetProductStatsAggregate
// tambien tiene que actualizarse: es el mismo contrato que la agrega.
func TestClassifyStockHealth(t *testing.T) {
	cases := []struct {
		name     string
		quantity float64
		minStock float64
		want     string
	}{
		// minStock <= 0: solo CRITICAL cuando quantity <= 0.
		{name: "sin minimo y sin stock", quantity: 0, minStock: 0, want: StockHealthCritical},
		{name: "sin minimo y stock negativo", quantity: -1, minStock: 0, want: StockHealthCritical},
		{name: "sin minimo y stock positivo", quantity: 5, minStock: 0, want: StockHealthOptimal},
		{name: "sin minimo y stock 0.5", quantity: 0.5, minStock: 0, want: StockHealthOptimal},
		{name: "minimo negativo cuenta como sin minimo", quantity: 3, minStock: -2, want: StockHealthOptimal},
		{name: "minimo negativo con stock cero es critico", quantity: 0, minStock: -2, want: StockHealthCritical},

		// minStock > 0: ratio = quantity/minStock. Fronteras EXACTAS 0.25 y 0.75.
		{name: "stock 0 con minimo 10 -> 0%% critico", quantity: 0, minStock: 10, want: StockHealthCritical},
		{name: "stock 2 con minimo 10 -> 20%% critico", quantity: 2, minStock: 10, want: StockHealthCritical},
		{name: "stock 2.49 con minimo 10 -> 24.9%% critico", quantity: 2.49, minStock: 10, want: StockHealthCritical},
		{name: "stock 2.5 con minimo 10 -> 25%% advertencia (frontera >=0.25)", quantity: 2.5, minStock: 10, want: StockHealthWarning},
		{name: "stock 5 con minimo 10 -> 50%% advertencia", quantity: 5, minStock: 10, want: StockHealthWarning},
		{name: "stock 7.49 con minimo 10 -> 74.9%% advertencia", quantity: 7.49, minStock: 10, want: StockHealthWarning},
		{name: "stock 7.5 con minimo 10 -> 75%% optimo (frontera >=0.75)", quantity: 7.5, minStock: 10, want: StockHealthOptimal},
		{name: "stock igual al minimo -> optimo", quantity: 10, minStock: 10, want: StockHealthOptimal},
		{name: "stock por encima del minimo -> optimo", quantity: 20, minStock: 10, want: StockHealthOptimal},

		// El caso emblematico: minimo 30, stock 24 -> 80%% VERDE (invierte la
		// regla anterior a proposito, confirmado por el dueno).
		{name: "minimo 30 stock 24 -> 80%% optimo (era WARNING antes)", quantity: 24, minStock: 30, want: StockHealthOptimal},

		// Fracciones puras para validar frontera.
		{name: "1 unidad de 4 -> 25%% advertencia", quantity: 1, minStock: 4, want: StockHealthWarning},
		{name: "3 unidades de 4 -> 75%% optimo", quantity: 3, minStock: 4, want: StockHealthOptimal},
		{name: "stock negativo con minimo positivo es critico", quantity: -3, minStock: 10, want: StockHealthCritical},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClassifyStockHealth(tc.quantity, tc.minStock); got != tc.want {
				t.Fatalf("ClassifyStockHealth(%v, %v) = %q; want %q", tc.quantity, tc.minStock, got, tc.want)
			}
		})
	}
}
