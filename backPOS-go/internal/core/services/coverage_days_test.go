package services

import (
	"testing"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/core/services/scheduling"
)

// ============================================================================
// COVERAGE DAYS DEL SERVICIO LEGACY (/inventory/suggested-orders).
//
// Antes de este cambio inventory_service.go usaba:
//   - diasCobertura = p.VisitFrequencyDays (sin agenda = fallback de 30 dias)
//   - suggestedMinStock = ceil(avgDaily * 14)
//
// Ambos valores eran arbitrarios. El sugerido-v2 ya se calcula con la agenda
// real (visita + entrega + lead time); el servicio legacy se migra aqui para
// que ambos endpoints concuerden y el reclamo del dueno ("no a 30 dias") deje
// de aparecer en ninguna ruta viva. coverageDaysForSupplier es la funcion
// compartida; estos tests cubren los casos del enunciado.
// ============================================================================

func stringPtr(s string) *string { return &s }
func intPtr(v int) *int          { return &v }

func TestCoverageDaysForSupplier_ProveedorSemanal(t *testing.T) {
	t.Parallel()
	// Visita martes y entrega miercoles: 7 (ciclo semanal) + 1 (lead) = 8.
	info := ports.ProductRestockInfo{
		BestSupplierVisitDays:    models.StringArray{"Martes"},
		BestSupplierDeliveryDays: models.StringArray{"Miércoles"},
		BestSupplierLeadTimeDays: intPtr(1),
	}
	if got := coverageDaysForSupplier(info); got != 8 {
		t.Fatalf("proveedor semanal: coverage = %d; want 8", got)
	}
}

func TestCoverageDaysForSupplier_DosVisitasUsaPeorHueco(t *testing.T) {
	t.Parallel()
	// Martes y viernes: viernes->martes son 4 dias (peor hueco), lead 0 por
	// entrega inmediata el mismo dia -> 4 dias.
	info := ports.ProductRestockInfo{
		BestSupplierVisitDays:    models.StringArray{"martes", "viernes"},
		BestSupplierDeliveryDays: models.StringArray{"martes", "viernes"},
	}
	if got := coverageDaysForSupplier(info); got != 4 {
		t.Fatalf("dos visitas: coverage = %d; want 4 (peor hueco)", got)
	}
}

func TestCoverageDaysForSupplier_SinAgendaUsaFallbackAcotado(t *testing.T) {
	t.Parallel()
	// Sin agenda y con visit_frequency_days inflado a 30 (clasico aprendizaje
	// sospechoso): el fallback cae al tope MaxUnknownCycleDays = 14. No puede
	// volver al viejo "30".
	info := ports.ProductRestockInfo{
		VisitFrequencyDays: 30,
	}
	if got := coverageDaysForSupplier(info); got != scheduling.MaxUnknownCycleDays {
		t.Fatalf("sin agenda con freq=30: coverage = %d; want %d", got, scheduling.MaxUnknownCycleDays)
	}
	if scheduling.MaxUnknownCycleDays > 14 {
		t.Fatalf("tope %d > 14: contradice la regla del dueno de no inflar la factura",
			scheduling.MaxUnknownCycleDays)
	}
}

func TestCoverageDaysForSupplier_SinAgendaUsaExplicitLead(t *testing.T) {
	t.Parallel()
	// Sin agenda pero con lead_time_days explicito: ese valor manda sobre
	// visit_frequency_days.
	info := ports.ProductRestockInfo{
		VisitFrequencyDays:       30, // seria 30 (acotado a 14), pero el explicit lo pisa
		BestSupplierLeadTimeDays: intPtr(5),
	}
	if got := coverageDaysForSupplier(info); got != 5 {
		t.Fatalf("sin agenda con lead=5: coverage = %d; want 5", got)
	}
}

func TestCoverageDaysForSupplier_SinNadaCaeASieteDias(t *testing.T) {
	t.Parallel()
	// Sin agenda, sin lead, sin frecuencia: 7 dias por defecto, nunca 0.
	info := ports.ProductRestockInfo{}
	if got := coverageDaysForSupplier(info); got != 7 {
		t.Fatalf("sin ningun dato: coverage = %d; want 7 (default)", got)
	}
}

func TestCoverageDaysForSupplier_LegacyCSVTambienCuenta(t *testing.T) {
	t.Parallel()
	// Un proveedor con la agenda guardada en los campos legacy (CSV) tiene
	// que calcular igual que uno con JSONB.
	info := ports.ProductRestockInfo{
		BestSupplierLegacyVisit:    stringPtr("Martes"),
		BestSupplierLegacyDelivery: stringPtr("Miércoles"),
	}
	if got := coverageDaysForSupplier(info); got != 8 {
		t.Fatalf("legacy CSV martes/miercoles: coverage = %d; want 8", got)
	}
}

func TestCoverageDaysForSupplier_NuncaMenorAUno(t *testing.T) {
	t.Parallel()
	// Fallback invalido / cero / negativo: scheduling.ReplenishmentCoverageDays
	// ya garantiza >= 1. Guardianes defensivos.
	for _, lead := range []int{-5, 0} {
		info := ports.ProductRestockInfo{BestSupplierLeadTimeDays: intPtr(lead)}
		if got := coverageDaysForSupplier(info); got < 1 {
			t.Fatalf("lead=%d: coverage=%d; nunca menor a 1", lead, got)
		}
	}
}
