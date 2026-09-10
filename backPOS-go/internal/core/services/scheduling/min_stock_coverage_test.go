package scheduling

import (
	"math"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// EL MINIMO SE MIDE POR EL CICLO DE REPOSICION
//
// Reporte del dueno (2026-09-10, textual): "Eso de sugerir bajar el stock no lo
// tiene que medir por días, tiene que medirlo por los días que viene osea 8
// días".
//
// El lead time responde "cuanto tarda en llegar lo que pido". El stock minimo
// responde otra cosa: "cuanto tengo que aguantar con lo que hay". Y eso es hasta
// la siguiente oportunidad de reposicion, no hasta que llegue el pedido de hoy.
// ============================================================================

func TestMinStockCoverageDays_ProveedorSemanalDaOchoDias(t *testing.T) {
	// El caso exacto de la pantalla del dueno: COLANTA, visita martes y entrega
	// miercoles. Lead time 1 dia, ciclo semanal 7 dias -> 8 dias de cobertura.
	got := MinStockCoverageDays([]string{"martes"}, []string{"miercoles"}, 1)
	if got != 8 {
		t.Fatalf("cobertura = %d dias; want 8 (7 de ciclo semanal + 1 de lead)", got)
	}
}

func TestMinStockCoverageDays_NoUsaSoloElLeadTime(t *testing.T) {
	// Guardian del bug: con lead time 1 la cobertura NO puede ser 1.
	got := MinStockCoverageDays([]string{"martes"}, []string{"miercoles"}, 1)
	if got <= 1 {
		t.Fatalf("cobertura = %d: se volvio a medir por el lead time y el minimo "+
			"quedaria calculado con un solo dia de venta", got)
	}
}

func TestMinStockCoverageDays_VisitaYEntregaElMismoDia(t *testing.T) {
	// Entrega inmediata: solo hay que cubrir el ciclo semanal.
	got := MinStockCoverageDays([]string{"lunes"}, []string{"lunes"}, 3)
	if got != 7 {
		t.Fatalf("cobertura = %d; want 7 (ciclo semanal, lead 0)", got)
	}
}

func TestMinStockCoverageDays_DosVisitasUsaElHuecoMasLargo(t *testing.T) {
	// Martes y viernes: martes->viernes son 3 dias, viernes->martes son 4.
	// El minimo tiene que sobrevivir el hueco LARGO, o el producto se agota
	// justo el fin de semana.
	got := MinStockCoverageDays([]string{"martes", "viernes"}, []string{"martes", "viernes"}, 7)
	if got != 4 {
		t.Fatalf("cobertura = %d; want 4 (peor hueco viernes->martes, lead 0)", got)
	}
}

func TestMinStockCoverageDays_TresVisitas(t *testing.T) {
	// Lunes, miercoles y viernes: el peor hueco es viernes->lunes = 3.
	got := MinStockCoverageDays(
		[]string{"lunes", "miercoles", "viernes"},
		[]string{"lunes", "miercoles", "viernes"},
		7,
	)
	if got != 3 {
		t.Fatalf("cobertura = %d; want 3 (viernes->lunes)", got)
	}
}

func TestMinStockCoverageDays_TodosLosDias(t *testing.T) {
	// Proveedor diario: el ciclo es 1 dia.
	todos := []string{"lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"}
	got := MinStockCoverageDays(todos, todos, 7)
	if got != 1 {
		t.Fatalf("cobertura = %d; want 1 (visita diaria)", got)
	}
}

func TestMinStockCoverageDays_EntregaLaSemanaSiguiente(t *testing.T) {
	// Visita viernes, entrega martes: el lead cruza el fin de semana (4 dias).
	// Ciclo semanal 7 + lead 4 = 11.
	got := MinStockCoverageDays([]string{"viernes"}, []string{"martes"}, 1)
	if got != 11 {
		t.Fatalf("cobertura = %d; want 11 (7 de ciclo + 4 de lead viernes->martes)", got)
	}
}

func TestMinStockCoverageDays_SinAgendaCaeAlFallback(t *testing.T) {
	// Sin dias de visita no se puede conocer el ciclo: se usa lo que resolvio
	// la cadena de precedencia del lead time.
	if got := MinStockCoverageDays(nil, nil, 5); got != 5 {
		t.Errorf("sin agenda: cobertura = %d; want 5 (fallback)", got)
	}
	if got := MinStockCoverageDays([]string{}, []string{"lunes"}, 9); got != 9 {
		t.Errorf("sin dias de visita: cobertura = %d; want 9 (fallback)", got)
	}
	// Fallback invalido -> 7, nunca 0 ni negativo.
	if got := MinStockCoverageDays(nil, nil, 0); got != 7 {
		t.Errorf("fallback 0: cobertura = %d; want 7", got)
	}
	if got := MinStockCoverageDays(nil, nil, -3); got != 7 {
		t.Errorf("fallback negativo: cobertura = %d; want 7", got)
	}
}

func TestMinStockCoverageDays_ToleraNombresConTildesYBasura(t *testing.T) {
	// La misma tolerancia que el resto del sistema: tildes, mayusculas y CSV.
	got := MinStockCoverageDays([]string{"MARTES"}, []string{"Miércoles"}, 1)
	if got != 8 {
		t.Fatalf("con tildes y mayusculas: cobertura = %d; want 8", got)
	}
	// Dias invalidos se ignoran; si no queda ninguno valido, fallback.
	if got := MinStockCoverageDays([]string{"lunez", "xyz"}, []string{"lunes"}, 6); got != 6 {
		t.Fatalf("dias invalidos: cobertura = %d; want 6 (fallback)", got)
	}
}

func TestMinStockCoverageDays_NuncaDevuelveMenosDeUno(t *testing.T) {
	// Un cero haria que el ideal fuera 0 y el sistema propondria bajar todos
	// los minimos a 1.
	todos := []string{"lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"}
	for _, fallback := range []int{-10, 0, 1, 7, 30} {
		if got := MinStockCoverageDays(todos, todos, fallback); got < 1 {
			t.Fatalf("cobertura = %d con fallback %d; nunca puede ser menor que 1", got, fallback)
		}
	}
}

// ============================================================================
// EL CASO REAL DE LA PANTALLA DEL DUENO
//
// COLANTA ENTERA 1100ML, proveedor con visita los martes y entrega los
// miercoles (lead 1 dia):
//
//	existencia 0, stock minimo 3
//	demanda 90 dias: 0.23/dia
//	agotado 7 de los ultimos 30 dias
//
// El sistema mostraba: "Sugerido bajar el minimo de 3 a 1. Vende 0.48/dia: el
// minimo de 3 esta muy por encima de lo que rota." Y en la MISMA tarjeta, el
// aviso de pedido decia "la demanda hasta la proxima visita pide mas que el
// objetivo". Dos formulas de la misma tarjeta contradiciendose.
// ============================================================================

func TestCasoColanta_YaNoProponeBajarElMinimo(t *testing.T) {
	const (
		demand90 = 0.23 // ventas/dia a 90 dias
		minStock = 3.0
		lead     = 1
	)
	visita := []string{"martes"}
	entrega := []string{"miercoles"}

	// ANTES: ideal = demanda x lead time = ceil(0.23 * 1) = 1
	idealViejo := math.Ceil(demand90 * float64(lead))
	_, razonVieja := models.SuggestMinStockChange(idealViejo, minStock)
	if razonVieja != models.MinStockSuggestionDecrease {
		t.Fatalf("el test perdio su sentido: con el calculo viejo (ideal %.0f) "+
			"el sistema deberia proponer BAJAR, y propuso %q", idealViejo, razonVieja)
	}

	// AHORA: ideal = demanda x cobertura del ciclo = ceil(0.23 * 8) = 2
	cobertura := MinStockCoverageDays(visita, entrega, lead)
	idealNuevo := math.Ceil(demand90 * float64(cobertura))
	if idealNuevo != 2 {
		t.Fatalf("ideal con cobertura de %d dias = %.0f; want 2", cobertura, idealNuevo)
	}

	valor, razon := models.SuggestMinStockChange(idealNuevo, minStock)
	if razon != models.MinStockSuggestionNone {
		t.Errorf("con 8 dias de cobertura el minimo de 3 es coherente y NO debe "+
			"sugerirse cambio; se sugirio %q hacia %.0f", razon, valor)
	}
}

func TestCasoColanta_UnMinimoRealmenteInfladoSiSeBaja(t *testing.T) {
	// El arreglo no puede desactivar la sugerencia: un minimo genuinamente
	// desproporcionado tiene que seguir avisando. Con la misma demanda de
	// COLANTA, un minimo de 30 sigue estando muy por encima.
	cobertura := MinStockCoverageDays([]string{"martes"}, []string{"miercoles"}, 1)
	ideal := math.Ceil(0.23 * float64(cobertura)) // 2

	valor, razon := models.SuggestMinStockChange(ideal, 30)
	if razon != models.MinStockSuggestionDecrease {
		t.Fatalf("un minimo de 30 con ideal %.0f debe seguir sugiriendo BAJAR; got %q", ideal, razon)
	}
	if valor != 2 {
		t.Errorf("valor sugerido = %.0f; want 2 (el ideal por ciclo, no 1)", valor)
	}
}

func TestCasoColanta_TambienSigueSugiriendoSubir(t *testing.T) {
	// Producto que rota mucho mas de lo que dice su minimo: 2/dia con 8 dias de
	// cobertura pide 16, y el minimo esta en 4.
	cobertura := MinStockCoverageDays([]string{"martes"}, []string{"miercoles"}, 1)
	ideal := math.Ceil(2.0 * float64(cobertura)) // 16

	valor, razon := models.SuggestMinStockChange(ideal, 4)
	if razon != models.MinStockSuggestionIncrease {
		t.Fatalf("razon = %q; want increase", razon)
	}
	if valor != 16 {
		t.Errorf("valor sugerido = %.0f; want 16", valor)
	}
}
