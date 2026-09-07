package repositories

import (
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services/scheduling"
)

// bogotaLoc es la zona horaria del proyecto. Los tests operan con horas
// concretas para que el weekday resultante sea determinista.
var bogotaLoc = time.FixedZone("America/Bogota", -5*60*60)

func uintPtr(v uint) *uint        { return &v }
func floatPtr(v float64) *float64 { return &v }
func strPtr(v string) *string     { return &v }
func intPtr(v int) *int           { return &v }

// baseRow arma un row plausible para el fixture de tests. Cada test lo
// muta con los campos que necesita destacar.
func baseRow() restockSuggestionRow {
	row := restockSuggestionRow{}
	row.ProductID = "7702"
	row.ProductName = "Producto de prueba"
	row.ABCCategory = "A"
	row.IdealStock = 20
	row.CurrentStock = 5
	row.InTransitQty = 0
	row.AvgDailySales = 2
	// Datos del proveedor PRIMARIO tal como los persiste el batch nocturno.
	row.PrimarySupplierID = uintPtr(10)
	row.SupplierName = "HERMARLY"
	row.UnitCost = 1000
	row.SupplierLeadDays = 30 // aprendido, sospechoso
	row.LiveStock = 5
	row.LiveInTransitQty = 0
	return row
}

func TestBuildRestockSuggestion_SinFiltro_MantieneAtribucionAlPrimario(t *testing.T) {
	row := baseRow()
	// Sin filtro, el SQL resuelve `effective` = primario. Simulamos eso.
	row.EffectiveSupplierID = uintPtr(10)
	row.EffectiveSupplierName = strPtr("HERMARLY")
	row.EffectiveUnitCost = floatPtr(1000)
	// Sin dias configurados -> cae a explicit lead time.
	row.EffectiveLeadTimeDays = intPtr(3)

	now := time.Date(2026, 8, 30, 8, 0, 0, 0, bogotaLoc) // domingo
	got := buildRestockSuggestion(row, now)

	if got.PrimarySupplierID == nil || *got.PrimarySupplierID != 10 {
		t.Fatalf("PrimarySupplierID = %v, want 10", got.PrimarySupplierID)
	}
	if got.SupplierName != "HERMARLY" {
		t.Fatalf("SupplierName = %q, want HERMARLY", got.SupplierName)
	}
	if got.UnitCost != 1000 {
		t.Fatalf("UnitCost = %v, want 1000", got.UnitCost)
	}
	if got.SupplierLeadDays != 3 || got.LeadTimeSource != scheduling.LeadTimeSourceExplicit {
		t.Fatalf("lead = %d/%s, want 3/explicit_lead_time",
			got.SupplierLeadDays, got.LeadTimeSource)
	}
	if got.AgendaSource != "none" {
		t.Fatalf("AgendaSource = %q, want none (sin manual ni aprendida)", got.AgendaSource)
	}
	if got.LearnedSampleCount != 0 {
		t.Fatalf("LearnedSampleCount = %d, want 0", got.LearnedSampleCount)
	}
}

func TestBuildRestockSuggestion_ConFiltro_ReescribeAlProveedorSeleccionado(t *testing.T) {
	// Reproduce el bug: el batch dice que el primario es HERMARLY (id=10),
	// pero el operador filtro por RINVAL (id=42) que tambien vende el
	// producto. La respuesta debe atribuirse a RINVAL, con su precio y su
	// lead time — NO al primario.
	row := baseRow()
	row.EffectiveSupplierID = uintPtr(42) // RINVAL
	row.EffectiveSupplierName = strPtr("RINVAL")
	row.EffectiveUnitCost = floatPtr(950) // RINVAL es mas barato
	row.EffectiveVisitDays = models.StringArray{"Lunes"}
	row.EffectiveDeliveryDays = models.StringArray{"Miércoles"}

	now := time.Date(2026, 8, 30, 8, 0, 0, 0, bogotaLoc) // domingo
	got := buildRestockSuggestion(row, now)

	if got.PrimarySupplierID == nil || *got.PrimarySupplierID != 42 {
		t.Fatalf("PrimarySupplierID = %v, want 42 (RINVAL); el frontend agrupa por este campo",
			got.PrimarySupplierID)
	}
	if got.SupplierName != "RINVAL" {
		t.Fatalf("SupplierName = %q, want RINVAL", got.SupplierName)
	}
	if got.UnitCost != 950 {
		t.Fatalf("UnitCost = %v, want 950 (el precio de RINVAL)", got.UnitCost)
	}
	// lunes -> miercoles = 2 dias de lead time desde los dias configurados.
	if got.SupplierLeadDays != 2 || got.LeadTimeSource != scheduling.LeadTimeSourceConfiguredDays {
		t.Fatalf("lead = %d/%s, want 2/configured_days",
			got.SupplierLeadDays, got.LeadTimeSource)
	}
	if got.NextVisitDate == nil || got.NextDeliveryDate == nil {
		t.Fatal("las fechas deben salir cuando hay schedule")
	}
	if *got.NextVisitDate != "2026-08-31" {
		t.Fatalf("NextVisitDate = %s, want 2026-08-31 (lunes)", *got.NextVisitDate)
	}
	if *got.NextDeliveryDate != "2026-09-02" {
		t.Fatalf("NextDeliveryDate = %s, want 2026-09-02 (miercoles)", *got.NextDeliveryDate)
	}
	if got.AgendaSource != "manual" {
		t.Fatalf("AgendaSource = %q, want manual", got.AgendaSource)
	}
	if !got.ScheduleHasConfigured {
		t.Fatal("ScheduleHasConfigured = false, want true cuando hay agenda manual")
	}
}

func TestBuildRestockSuggestion_CheaperSupplier_UsaAhorroContraElEfectivo(t *testing.T) {
	// El proveedor mas barato es un dato INFORMATIVO por producto. Con
	// filtro activo el ahorro se compara contra el precio del proveedor
	// SELECCIONADO (ya reescrito en unitCost), no contra el primario.
	row := baseRow()
	row.EffectiveSupplierID = uintPtr(42)
	row.EffectiveSupplierName = strPtr("RINVAL")
	row.EffectiveUnitCost = floatPtr(950)
	row.CheaperSupplierID = uintPtr(77)
	row.CheaperSupplierName = strPtr("OTRO PROVEEDOR")
	row.CheaperUnitPrice = 800
	row.Savings = 950 - 800 // = 150 por unidad
	row.IdealStock = 20
	row.LiveStock = 5
	row.LiveInTransitQty = 0

	got := buildRestockSuggestion(row, time.Now())
	if got.CheaperSupplier == nil {
		t.Fatal("cheaperSupplier debe estar presente")
	}
	if got.CheaperSupplier.SupplierID != 77 {
		t.Fatalf("cheaperSupplier.supplierId = %d, want 77", got.CheaperSupplier.SupplierID)
	}
	if got.CheaperSupplier.Savings != 150 {
		t.Fatalf("savings = %v, want 150", got.CheaperSupplier.Savings)
	}
	// TotalSavings se recomputa con la SUGERENCIA VIVA (15 unidades, porque
	// ideal=20 y ya hay 5 en stock). Debe ser 150 * 15 = 2250.
	if got.CheaperSupplier.TotalSavings != 2250 {
		t.Fatalf("totalSavings = %v, want 2250 (150 * 15)", got.CheaperSupplier.TotalSavings)
	}
}

func TestBuildRestockSuggestion_SinDiasConfiguradosExponeSourceFallback(t *testing.T) {
	row := baseRow()
	row.EffectiveSupplierID = uintPtr(10)
	row.EffectiveSupplierName = strPtr("HERMARLY")
	row.EffectiveUnitCost = floatPtr(1000)
	// Sin visit_days, sin delivery_days, sin lead_time_days -> cae a
	// visit_frequency_days.
	row.EffectiveVisitFrequency = 21

	got := buildRestockSuggestion(row, time.Now())

	if got.SupplierLeadDays != 21 {
		t.Fatalf("lead = %d, want 21 (visit_frequency)", got.SupplierLeadDays)
	}
	if got.LeadTimeSource != scheduling.LeadTimeSourceVisitFrequency {
		t.Fatalf("source = %s, want %s",
			got.LeadTimeSource, scheduling.LeadTimeSourceVisitFrequency)
	}
	if got.NextVisitDate != nil || got.NextDeliveryDate != nil {
		t.Fatal("sin schedule las fechas deben ser null")
	}
	if got.DaysUntilNextVisit != nil {
		t.Fatal("sin schedule daysUntilNextVisit debe ser null")
	}
}

func TestBuildRestockSuggestion_SinNadaConfiguradoCaeADefault7(t *testing.T) {
	row := baseRow()
	row.EffectiveSupplierID = uintPtr(10)
	row.EffectiveSupplierName = strPtr("HERMARLY")
	row.EffectiveUnitCost = floatPtr(1000)

	got := buildRestockSuggestion(row, time.Now())

	if got.SupplierLeadDays != 7 {
		t.Fatalf("lead = %d, want 7 (default)", got.SupplierLeadDays)
	}
	if got.LeadTimeSource != scheduling.LeadTimeSourceDefault {
		t.Fatalf("source = %s, want %s",
			got.LeadTimeSource, scheduling.LeadTimeSourceDefault)
	}
}

func TestBuildRestockSuggestion_TransitoVivoDescuentaSugerencia(t *testing.T) {
	// La sugerencia SIEMPRE se recalcula con la existencia y el tránsito
	// del momento. Si hay un pedido recien confirmado, no se debe volver
	// a pedir.
	row := baseRow()
	row.EffectiveSupplierID = uintPtr(10)
	row.EffectiveSupplierName = strPtr("HERMARLY")
	row.EffectiveUnitCost = floatPtr(1000)
	row.IdealStock = 20
	row.LiveStock = 5
	row.LiveInTransitQty = 20 // ya viene lo que falta

	got := buildRestockSuggestion(row, time.Now())

	if got.SuggestedOrderQty != 0 {
		t.Fatalf("SuggestedOrderQty = %v, want 0 con transito suficiente", got.SuggestedOrderQty)
	}
	if !got.InTransit {
		t.Fatal("InTransit debe ser true cuando LiveInTransitQty > 0")
	}
	if got.InTransitQty != 20 {
		t.Fatalf("InTransitQty = %v, want 20 (valor vivo)", got.InTransitQty)
	}
}

// ---------------------------------------------------------------------------
// AGENDA APRENDIDA vs AGENDA MANUAL (Sprint 9 / migracion 014)
// ---------------------------------------------------------------------------

// TestBuildRestockSuggestion_AprendidoNoPisaManual: si el dueno configuro
// visit_days y delivery_days, el sistema puede haber aprendido otra cosa,
// pero LA MANUAL manda para las fechas efectivas y el lead time. La
// aprendida se expone en paralelo para que la UI pueda mostrar la
// comparacion.
func TestBuildRestockSuggestion_AprendidoNoPisaManual(t *testing.T) {
	row := baseRow()
	row.EffectiveSupplierID = uintPtr(10)
	row.EffectiveSupplierName = strPtr("HERMARLY")
	row.EffectiveUnitCost = floatPtr(1000)
	// El dueno dice: viene lunes, entrega miercoles.
	row.EffectiveVisitDays = models.StringArray{"Lunes"}
	row.EffectiveDeliveryDays = models.StringArray{"Miércoles"}
	// El sistema observo: parece que viene jueves y entrega viernes.
	row.EffectiveLearnedVisitDays = models.StringArray{"Jueves"}
	row.EffectiveLearnedDeliveryDays = models.StringArray{"Viernes"}
	row.EffectiveLearnedLeadTimeDays = intPtr(1)
	row.EffectiveLearnedSampleCount = 8

	now := time.Date(2026, 8, 30, 8, 0, 0, 0, bogotaLoc) // domingo
	got := buildRestockSuggestion(row, now)

	// El manual gana en fechas efectivas y en lead time.
	if got.LeadTimeSource != scheduling.LeadTimeSourceConfiguredDays {
		t.Fatalf("LeadTimeSource = %s, want configured_days", got.LeadTimeSource)
	}
	if got.SupplierLeadDays != 2 {
		t.Fatalf("SupplierLeadDays = %d, want 2 (lun->mie)", got.SupplierLeadDays)
	}
	if got.AgendaSource != "manual" {
		t.Fatalf("AgendaSource = %q, want manual", got.AgendaSource)
	}
	if got.NextVisitDate == nil || *got.NextVisitDate != "2026-08-31" {
		t.Fatalf("NextVisitDate = %v, want 2026-08-31 (lunes)", got.NextVisitDate)
	}
	// La aprendida se expone SIEMPRE que haya sample_count > 0, incluso si no
	// se uso para las fechas efectivas.
	if len(got.LearnedVisitDays) != 1 || got.LearnedVisitDays[0] != "Jueves" {
		t.Fatalf("LearnedVisitDays = %v, want [Jueves]", got.LearnedVisitDays)
	}
	if got.LearnedSampleCount != 8 {
		t.Fatalf("LearnedSampleCount = %d, want 8", got.LearnedSampleCount)
	}
	if got.LearnedLeadTimeDays == nil || *got.LearnedLeadTimeDays != 1 {
		t.Fatalf("LearnedLeadTimeDays = %v, want 1", got.LearnedLeadTimeDays)
	}
}

// TestBuildRestockSuggestion_SinManualUsaAprendidoParaFechas: cuando no hay
// agenda manual pero SI aprendida con evidencia, la funcion usa la aprendida
// para calcular next_visit / next_delivery y marca agendaSource="learned"
// y leadTimeSource="learned_days".
func TestBuildRestockSuggestion_SinManualUsaAprendidoParaFechas(t *testing.T) {
	row := baseRow()
	row.EffectiveSupplierID = uintPtr(10)
	row.EffectiveSupplierName = strPtr("HERMARLY")
	row.EffectiveUnitCost = floatPtr(1000)
	// Sin agenda manual.
	row.EffectiveVisitDays = nil
	row.EffectiveDeliveryDays = nil
	// Con aprendida confiable.
	row.EffectiveLearnedVisitDays = models.StringArray{"Martes"}
	row.EffectiveLearnedDeliveryDays = models.StringArray{"Jueves"}
	row.EffectiveLearnedLeadTimeDays = intPtr(2)
	row.EffectiveLearnedSampleCount = 6

	now := time.Date(2026, 8, 30, 8, 0, 0, 0, bogotaLoc) // domingo
	got := buildRestockSuggestion(row, now)

	if got.AgendaSource != "learned" {
		t.Fatalf("AgendaSource = %q, want learned", got.AgendaSource)
	}
	if got.LeadTimeSource != scheduling.LeadTimeSourceLearned {
		t.Fatalf("LeadTimeSource = %s, want learned_days", got.LeadTimeSource)
	}
	if got.SupplierLeadDays != 2 {
		t.Fatalf("SupplierLeadDays = %d, want 2 (mediana aprendida)", got.SupplierLeadDays)
	}
	if got.NextVisitDate == nil {
		t.Fatal("NextVisitDate = nil; con aprendida confiable debe salir")
	}
	// Martes mas cercano a domingo 2026-08-30 es 2026-09-01.
	if *got.NextVisitDate != "2026-09-01" {
		t.Fatalf("NextVisitDate = %s, want 2026-09-01 (martes)", *got.NextVisitDate)
	}
	if got.NextDeliveryDate == nil || *got.NextDeliveryDate != "2026-09-03" {
		t.Fatalf("NextDeliveryDate = %v, want 2026-09-03 (jueves)", got.NextDeliveryDate)
	}
	if got.ScheduleHasConfigured {
		t.Fatal("ScheduleHasConfigured = true; no hay agenda manual")
	}
}

// TestBuildRestockSuggestion_AprendidoSinEvidenciaNoSeUsa: si
// learned_sample_count < LearnMinSamples, la aprendida no se usa ni para las
// fechas ni para el lead time. La precedencia cae a explicit / visit_frequency.
func TestBuildRestockSuggestion_AprendidoSinEvidenciaNoSeUsa(t *testing.T) {
	row := baseRow()
	row.EffectiveSupplierID = uintPtr(10)
	row.EffectiveSupplierName = strPtr("HERMARLY")
	row.EffectiveUnitCost = floatPtr(1000)
	// Sin manual.
	row.EffectiveVisitDays = nil
	row.EffectiveDeliveryDays = nil
	// Aprendida pero con solo 2 muestras: por debajo del umbral.
	row.EffectiveLearnedVisitDays = models.StringArray{"Martes"}
	row.EffectiveLearnedDeliveryDays = models.StringArray{"Jueves"}
	row.EffectiveLearnedLeadTimeDays = intPtr(2)
	row.EffectiveLearnedSampleCount = 2 // < scheduling.LearnMinSamples
	row.EffectiveLeadTimeDays = intPtr(5)
	row.EffectiveVisitFrequency = 10

	got := buildRestockSuggestion(row, time.Now())

	// La aprendida sin evidencia no se usa.
	if got.AgendaSource != "none" {
		t.Fatalf("AgendaSource = %q, want none (aprendida por debajo del umbral)",
			got.AgendaSource)
	}
	if got.LeadTimeSource != scheduling.LeadTimeSourceExplicit {
		t.Fatalf("LeadTimeSource = %s, want explicit_lead_time", got.LeadTimeSource)
	}
	if got.SupplierLeadDays != 5 {
		t.Fatalf("SupplierLeadDays = %d, want 5", got.SupplierLeadDays)
	}
	// Sin embargo la aprendida SI se expone en el bloque separado, para que
	// la UI pueda decir "sin evidencia suficiente" con N=2.
	if got.LearnedSampleCount != 2 {
		t.Fatalf("LearnedSampleCount = %d, want 2 (se expone crudo)", got.LearnedSampleCount)
	}
	if got.NextVisitDate != nil {
		t.Fatal("NextVisitDate debe ser nil sin agenda efectiva")
	}
}

// TestBuildRestockSuggestion_LearnedSampleCountCero_NoExponeDatos: cuando el
// batch de aprendizaje nunca corrio (o corrio pero no aprendio), la respuesta
// no debe filtrarse learned_visit_days / learned_delivery_days. Este es el
// caso "degrada limpio antes de la migracion 014".
func TestBuildRestockSuggestion_LearnedSampleCountCero_NoExponeDatos(t *testing.T) {
	row := baseRow()
	row.EffectiveSupplierID = uintPtr(10)
	row.EffectiveSupplierName = strPtr("HERMARLY")
	row.EffectiveUnitCost = floatPtr(1000)
	row.EffectiveLearnedSampleCount = 0 // batch nunca corrio o no aprendio
	// Aunque los campos vinieran con dato, sin sample_count no deberian
	// exponerse — pero por seguridad tampoco los pongamos aca.

	got := buildRestockSuggestion(row, time.Now())

	if len(got.LearnedVisitDays) != 0 {
		t.Fatalf("LearnedVisitDays = %v, want vacio cuando SampleCount=0",
			got.LearnedVisitDays)
	}
	if got.LearnedLeadTimeDays != nil {
		t.Fatalf("LearnedLeadTimeDays = %v, want nil cuando SampleCount=0",
			got.LearnedLeadTimeDays)
	}
	if got.LearnedAt != nil {
		t.Fatalf("LearnedAt = %v, want nil cuando SampleCount=0", got.LearnedAt)
	}
}

// TestBuildRestockSuggestion_LearnedLeadTimeGanaSobreExplicit verifica la
// precedencia del nuevo escalon dentro de ResolveSupplierLeadTime.
func TestBuildRestockSuggestion_LearnedLeadTimeGanaSobreExplicit(t *testing.T) {
	row := baseRow()
	row.EffectiveSupplierID = uintPtr(10)
	row.EffectiveSupplierName = strPtr("HERMARLY")
	row.EffectiveUnitCost = floatPtr(1000)
	// Sin manual pero con aprendida confiable y explicit.
	row.EffectiveVisitDays = nil
	row.EffectiveDeliveryDays = nil
	row.EffectiveLearnedLeadTimeDays = intPtr(3)
	row.EffectiveLearnedSampleCount = 5 // >= LearnMinSamples
	row.EffectiveLeadTimeDays = intPtr(7)

	got := buildRestockSuggestion(row, time.Now())

	if got.SupplierLeadDays != 3 {
		t.Fatalf("SupplierLeadDays = %d, want 3 (learned gana sobre explicit)",
			got.SupplierLeadDays)
	}
	if got.LeadTimeSource != scheduling.LeadTimeSourceLearned {
		t.Fatalf("LeadTimeSource = %s, want learned_days", got.LeadTimeSource)
	}
}
