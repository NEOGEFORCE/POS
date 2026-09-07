package scheduling

import (
	"testing"
	"time"
)

// bogotaFixed devuelve la zona horaria del proyecto tolerante a Windows
// (donde LoadLocation puede fallar sin tzdata). Copia del helper que ya vive
// en scheduling_test.go para no cruzar dependencias entre archivos de test.
func bogotaFixed(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("America/Bogota")
	if err != nil {
		loc = time.FixedZone("America/Bogota", -5*60*60)
	}
	return loc
}

// visit construye una observacion de visita (confirmed_at).
func visit(t *testing.T, y int, m time.Month, d int) SupplierVisitObservation {
	t.Helper()
	return SupplierVisitObservation{
		ConfirmedAt: time.Date(y, m, d, 8, 0, 0, 0, bogotaFixed(t)),
	}
}

// delivery construye una observacion de entrega (expense.date).
func delivery(t *testing.T, y int, m time.Month, d int) SupplierDeliveryObservation {
	t.Helper()
	return SupplierDeliveryObservation{
		PaidAt: time.Date(y, m, d, 8, 0, 0, 0, bogotaFixed(t)),
	}
}

// referenceDate es una fecha ancla dentro de la ventana de aprendizaje.
// Lunes 2026-08-31 para que las observaciones dentro/fuera de rango sean
// obvias y las expectativas de weekday sean deterministas.
func referenceDate(t *testing.T) time.Time {
	t.Helper()
	return time.Date(2026, 8, 31, 8, 0, 0, 0, bogotaFixed(t))
}

// ---------------------------------------------------------------------------
// LearnSupplierSchedule con la nueva fuente EGRESO (agosto 2026)
// ---------------------------------------------------------------------------

// TestLearnSupplierSchedule_EntregaConcentradaEnUnDiaAprende cubre el caso
// pedido por el dueno: cuando los egresos a un proveedor caen consistentemente
// el mismo dia de la semana, ese es el dia de entrega aprendido. La fuente
// ahora es expenses.date, no confirmed_orders.received_at.
func TestLearnSupplierSchedule_EntregaConcentradaEnUnDiaAprende(t *testing.T) {
	ref := referenceDate(t)
	// 5 egresos en jueves consecutivos, dentro de la ventana de 90 dias.
	deliveries := []SupplierDeliveryObservation{
		delivery(t, 2026, time.July, 2),   // jueves
		delivery(t, 2026, time.July, 9),   // jueves
		delivery(t, 2026, time.July, 16),  // jueves
		delivery(t, 2026, time.July, 23),  // jueves
		delivery(t, 2026, time.August, 6), // jueves
	}

	got := LearnSupplierSchedule(nil, deliveries, ref)

	if !got.HasLearned {
		t.Fatalf("HasLearned = false; con 5 egresos concentrados en jueves debe aprender")
	}
	if len(got.DeliveryDays) != 1 || got.DeliveryDays[0] != "Jueves" {
		t.Fatalf("DeliveryDays = %v, want [Jueves]", got.DeliveryDays)
	}
	if len(got.VisitDays) != 0 {
		t.Fatalf("VisitDays = %v, want vacio (no se pasaron visitas)", got.VisitDays)
	}
	if got.LeadTimeDays != 0 {
		t.Fatalf("LeadTimeDays = %d, want 0 sin dias de visita (no derivable)",
			got.LeadTimeDays)
	}
	if got.SampleCount != 5 {
		t.Fatalf("SampleCount = %d, want 5 (todos los egresos son validos)",
			got.SampleCount)
	}
}

// TestLearnSupplierSchedule_VisitaYEntregaConDosSetsCompletos ejercita el
// happy path completo: dos series independientes, ambas concentradas, se
// aprende ambos dias y se deriva el lead time con
// PlanSupplierOrderSchedule.
func TestLearnSupplierSchedule_VisitaYEntregaConDosSetsCompletos(t *testing.T) {
	ref := referenceDate(t) // lunes 2026-08-31
	// El preventista cierra el pedido los martes; la mercancia llega los
	// jueves. Lead time derivado = 2 dias (mar->jue).
	visits := []SupplierVisitObservation{
		visit(t, 2026, time.July, 7),
		visit(t, 2026, time.July, 14),
		visit(t, 2026, time.July, 21),
		visit(t, 2026, time.July, 28),
	}
	deliveries := []SupplierDeliveryObservation{
		delivery(t, 2026, time.July, 9),
		delivery(t, 2026, time.July, 16),
		delivery(t, 2026, time.July, 23),
		delivery(t, 2026, time.July, 30),
	}

	got := LearnSupplierSchedule(visits, deliveries, ref)

	if !got.HasLearned {
		t.Fatal("HasLearned = false; con 4+4 muestras consistentes debe aprender")
	}
	if len(got.VisitDays) != 1 || got.VisitDays[0] != "Martes" {
		t.Fatalf("VisitDays = %v, want [Martes]", got.VisitDays)
	}
	if len(got.DeliveryDays) != 1 || got.DeliveryDays[0] != "Jueves" {
		t.Fatalf("DeliveryDays = %v, want [Jueves]", got.DeliveryDays)
	}
	if got.LeadTimeDays != 2 {
		t.Fatalf("LeadTimeDays = %d, want 2 (derivado martes->jueves)",
			got.LeadTimeDays)
	}
	// Ambos sets con 4 muestras: min = 4.
	if got.SampleCount != 4 {
		t.Fatalf("SampleCount = %d, want 4 (min de ambos sets)", got.SampleCount)
	}
}

// TestLearnSupplierSchedule_ProveedorSinPedidosSoloAprendeEntregas cubre el
// caso "pago al contado directo al preventista, sin capturar la visita en el
// sistema". Debe aprender DeliveryDays y no VisitDays; LeadTimeDays queda en
// 0 porque no se puede derivar sin dias de visita. La decision esta
// documentada al inicio de learn.go.
func TestLearnSupplierSchedule_ProveedorSinPedidosSoloAprendeEntregas(t *testing.T) {
	ref := referenceDate(t)
	deliveries := []SupplierDeliveryObservation{
		delivery(t, 2026, time.July, 6),   // lunes
		delivery(t, 2026, time.July, 13),  // lunes
		delivery(t, 2026, time.July, 20),  // lunes
		delivery(t, 2026, time.July, 27),  // lunes
		delivery(t, 2026, time.August, 3), // lunes
	}

	got := LearnSupplierSchedule(nil, deliveries, ref)

	if !got.HasLearned {
		t.Fatal("HasLearned = false; con 5 egresos debe aprender aunque no haya visitas")
	}
	if len(got.VisitDays) != 0 {
		t.Fatalf("VisitDays = %v, want vacio (no hay observaciones de visita)",
			got.VisitDays)
	}
	if len(got.DeliveryDays) != 1 || got.DeliveryDays[0] != "Lunes" {
		t.Fatalf("DeliveryDays = %v, want [Lunes]", got.DeliveryDays)
	}
	if got.LeadTimeDays != 0 {
		t.Fatalf("LeadTimeDays = %d, want 0 (no derivable sin dias de visita)",
			got.LeadTimeDays)
	}
	if got.SampleCount != 5 {
		t.Fatalf("SampleCount = %d, want 5", got.SampleCount)
	}
}

// TestLearnSupplierSchedule_ProveedorSinEgresosSoloAprendeVisitas es el
// simetrico del anterior: hay confirmed_orders pero ningun egreso capturado.
// Aprende VisitDays; DeliveryDays queda vacio; LeadTimeDays = 0.
func TestLearnSupplierSchedule_ProveedorSinEgresosSoloAprendeVisitas(t *testing.T) {
	ref := referenceDate(t)
	visits := []SupplierVisitObservation{
		visit(t, 2026, time.July, 7),  // martes
		visit(t, 2026, time.July, 14), // martes
		visit(t, 2026, time.July, 21), // martes
		visit(t, 2026, time.July, 28), // martes
	}

	got := LearnSupplierSchedule(visits, nil, ref)

	if !got.HasLearned {
		t.Fatal("HasLearned = false; con 4 confirmed_orders debe aprender")
	}
	if len(got.VisitDays) != 1 || got.VisitDays[0] != "Martes" {
		t.Fatalf("VisitDays = %v, want [Martes]", got.VisitDays)
	}
	if len(got.DeliveryDays) != 0 {
		t.Fatalf("DeliveryDays = %v, want vacio", got.DeliveryDays)
	}
	if got.LeadTimeDays != 0 {
		t.Fatalf("LeadTimeDays = %d, want 0", got.LeadTimeDays)
	}
}

// TestLearnSupplierSchedule_MuestrasInsuficientesPorSet valida que cada set
// necesita alcanzar LearnMinSamples POR SEPARADO. Un proveedor con 3 egresos
// y 3 visitas no aprende ninguno de los dos.
func TestLearnSupplierSchedule_MuestrasInsuficientesPorSet(t *testing.T) {
	ref := referenceDate(t)
	visits := []SupplierVisitObservation{
		visit(t, 2026, time.July, 7),
		visit(t, 2026, time.July, 14),
		visit(t, 2026, time.July, 21),
	}
	deliveries := []SupplierDeliveryObservation{
		delivery(t, 2026, time.July, 9),
		delivery(t, 2026, time.July, 16),
		delivery(t, 2026, time.July, 23),
	}

	got := LearnSupplierSchedule(visits, deliveries, ref)
	if got.HasLearned {
		t.Fatalf("HasLearned = true; ambos sets tienen 3 (< %d), no debe aprender",
			LearnMinSamples)
	}
	if got.SampleCount != 0 {
		t.Fatalf("SampleCount = %d, want 0", got.SampleCount)
	}
}

// TestLearnSupplierSchedule_DiaAtipicoNoContamina: proveedor viene 8 veces en
// martes y una vez en jueves. El jueves solo representa el 11% (< 25%) y
// tampoco alcanza el conteo minimo de 2. No debe entrar como habitual.
func TestLearnSupplierSchedule_DiaAtipicoNoContamina(t *testing.T) {
	ref := referenceDate(t)
	deliveries := []SupplierDeliveryObservation{
		delivery(t, 2026, time.June, 30),   // martes
		delivery(t, 2026, time.July, 7),    // martes
		delivery(t, 2026, time.July, 14),   // martes
		delivery(t, 2026, time.July, 21),   // martes
		delivery(t, 2026, time.July, 28),   // martes
		delivery(t, 2026, time.August, 4),  // martes
		delivery(t, 2026, time.August, 11), // martes
		delivery(t, 2026, time.August, 18), // martes
		// Atipico: jueves 2026-08-13.
		delivery(t, 2026, time.August, 13),
	}

	got := LearnSupplierSchedule(nil, deliveries, ref)

	if !got.HasLearned {
		t.Fatal("HasLearned = false; hay 9 muestras validas, debe aprender")
	}
	if len(got.DeliveryDays) != 1 || got.DeliveryDays[0] != "Martes" {
		t.Fatalf("DeliveryDays = %v, want solo [Martes]; el jueves atipico no debe entrar",
			got.DeliveryDays)
	}
}

// TestLearnSupplierSchedule_TodoDispersoNoAprende: 10 entregas repartidas
// entre 5 dias distintos (2 cada uno). Ninguno alcanza el 25% (20% cada uno)
// aunque todos alcancen el conteo minimo. No debe aprender ningun dia.
func TestLearnSupplierSchedule_TodoDispersoNoAprende(t *testing.T) {
	ref := referenceDate(t)
	deliveries := []SupplierDeliveryObservation{
		// lunes x2
		delivery(t, 2026, time.July, 6),
		delivery(t, 2026, time.July, 13),
		// miercoles x2
		delivery(t, 2026, time.July, 15),
		delivery(t, 2026, time.July, 22),
		// jueves x2
		delivery(t, 2026, time.July, 30),
		delivery(t, 2026, time.August, 6),
		// viernes x2
		delivery(t, 2026, time.August, 14),
		delivery(t, 2026, time.August, 21),
		// sabado x2
		delivery(t, 2026, time.August, 22),
		delivery(t, 2026, time.August, 29),
	}

	got := LearnSupplierSchedule(nil, deliveries, ref)
	if got.HasLearned {
		t.Fatalf("HasLearned = true; ningun dia supera el 25%%, no debe aprender: %+v",
			got)
	}
}

// TestLearnSupplierSchedule_FueraDeVentanaSeIgnora: las muestras anteriores
// a reference-90 dias se descartan. En este test hay 5 fuera de ventana y 3
// dentro; no debe alcanzar el minimo y no aprende.
func TestLearnSupplierSchedule_FueraDeVentanaSeIgnora(t *testing.T) {
	ref := referenceDate(t) // 2026-08-31, ventana >= 2026-06-02
	deliveries := []SupplierDeliveryObservation{
		// Fuera de ventana (antes del 2026-06-02):
		delivery(t, 2026, time.January, 6),
		delivery(t, 2026, time.January, 13),
		delivery(t, 2026, time.January, 20),
		delivery(t, 2026, time.January, 27),
		delivery(t, 2026, time.February, 3),
		// Dentro de ventana pero solo 3:
		delivery(t, 2026, time.August, 4),
		delivery(t, 2026, time.August, 11),
		delivery(t, 2026, time.August, 18),
	}

	got := LearnSupplierSchedule(nil, deliveries, ref)
	if got.HasLearned {
		t.Fatalf("HasLearned = true; solo 3 en ventana, debajo del minimo")
	}
}

// TestLearnSupplierSchedule_DosDiasHabitualesEnDeliveries: 8 entregas repartidas
// mitad lunes / mitad jueves. Ambos superan el 25% y el conteo minimo. Ambos
// entran como dias de entrega habituales.
func TestLearnSupplierSchedule_DosDiasHabitualesEnDeliveries(t *testing.T) {
	ref := referenceDate(t)
	deliveries := []SupplierDeliveryObservation{
		delivery(t, 2026, time.July, 6),  // lunes
		delivery(t, 2026, time.July, 9),  // jueves
		delivery(t, 2026, time.July, 13), // lunes
		delivery(t, 2026, time.July, 16), // jueves
		delivery(t, 2026, time.July, 20), // lunes
		delivery(t, 2026, time.July, 23), // jueves
		delivery(t, 2026, time.July, 27), // lunes
		delivery(t, 2026, time.July, 30), // jueves
	}

	got := LearnSupplierSchedule(nil, deliveries, ref)
	if !got.HasLearned {
		t.Fatal("HasLearned = false")
	}
	if len(got.DeliveryDays) != 2 || got.DeliveryDays[0] != "Lunes" || got.DeliveryDays[1] != "Jueves" {
		t.Fatalf("DeliveryDays = %v, want [Lunes Jueves] en orden natural",
			got.DeliveryDays)
	}
}

// TestLearnSupplierSchedule_SinObservacionesNoAprende cubre el edge case de
// entradas vacias.
func TestLearnSupplierSchedule_SinObservacionesNoAprende(t *testing.T) {
	ref := referenceDate(t)
	if got := LearnSupplierSchedule(nil, nil, ref); got.HasLearned {
		t.Fatal("HasLearned = true; con 0 observaciones no debe aprender")
	}
	if got := LearnSupplierSchedule(
		[]SupplierVisitObservation{}, []SupplierDeliveryObservation{}, ref,
	); got.HasLearned {
		t.Fatal("HasLearned = true; con slices vacios no debe aprender")
	}
}

// TestLearnSupplierSchedule_SampleCountEsMinDeAmbosSets: con ambos sets
// aprendidos, el SampleCount refleja el eslabon debil.
func TestLearnSupplierSchedule_SampleCountEsMinDeAmbosSets(t *testing.T) {
	ref := referenceDate(t)
	// 6 visitas en martes.
	visits := []SupplierVisitObservation{
		visit(t, 2026, time.June, 30),
		visit(t, 2026, time.July, 7),
		visit(t, 2026, time.July, 14),
		visit(t, 2026, time.July, 21),
		visit(t, 2026, time.July, 28),
		visit(t, 2026, time.August, 4),
	}
	// 4 egresos en jueves.
	deliveries := []SupplierDeliveryObservation{
		delivery(t, 2026, time.July, 2),
		delivery(t, 2026, time.July, 9),
		delivery(t, 2026, time.July, 16),
		delivery(t, 2026, time.July, 23),
	}

	got := LearnSupplierSchedule(visits, deliveries, ref)
	if !got.HasLearned {
		t.Fatal("HasLearned = false")
	}
	if got.SampleCount != 4 {
		t.Fatalf("SampleCount = %d, want 4 (min de 6 visitas y 4 entregas)",
			got.SampleCount)
	}
	// El dia derivado sigue siendo martes -> jueves = 2 dias.
	if got.LeadTimeDays != 2 {
		t.Fatalf("LeadTimeDays = %d, want 2", got.LeadTimeDays)
	}
}

// TestLearnSupplierSchedule_ObservacionesConCeroTimeSeIgnoran: proteccion
// contra filas con fechas cero (por si el DB alguna vez trae basura). No
// deben contaminar el histograma ni el conteo de validas.
func TestLearnSupplierSchedule_ObservacionesConCeroTimeSeIgnoran(t *testing.T) {
	ref := referenceDate(t)
	deliveries := []SupplierDeliveryObservation{
		delivery(t, 2026, time.July, 6),  // lunes
		delivery(t, 2026, time.July, 13), // lunes
		delivery(t, 2026, time.July, 20), // lunes
		delivery(t, 2026, time.July, 27), // lunes
		{PaidAt: time.Time{}},            // basura, se ignora
	}
	got := LearnSupplierSchedule(nil, deliveries, ref)
	if !got.HasLearned {
		t.Fatal("HasLearned = false; hay 4 muestras validas")
	}
	if got.SampleCount != 4 {
		t.Fatalf("SampleCount = %d, want 4 (la fecha cero no cuenta)",
			got.SampleCount)
	}
}

// ---------------------------------------------------------------------------
// ResolveSupplierLeadTime — no cambia con la nueva fuente, se re-verifica que
// la precedencia entre learned / explicit / visit_frequency / default sigue
// funcionando igual.
// ---------------------------------------------------------------------------

func TestResolveSupplierLeadTime_LearnedGanaCuandoNoHayConfigured(t *testing.T) {
	learned := 3
	explicit := 5
	days, source := ResolveSupplierLeadTime(SupplierSchedule{}, &learned, &explicit, 10)
	if days != 3 || source != LeadTimeSourceLearned {
		t.Fatalf("learned_days debe ganar sobre explicit y visit_frequency; got %d/%s",
			days, source)
	}
}

func TestResolveSupplierLeadTime_ConfiguredGanaAunConLearned(t *testing.T) {
	schedule := SupplierSchedule{HasSchedule: true, LeadTimeDays: 2}
	learned := 3
	explicit := 5
	days, source := ResolveSupplierLeadTime(schedule, &learned, &explicit, 10)
	if days != 2 || source != LeadTimeSourceConfiguredDays {
		t.Fatalf("configured_days debe ganar SIEMPRE; got %d/%s", days, source)
	}
}

func TestResolveSupplierLeadTime_LearnedNilCaeAExplicit(t *testing.T) {
	explicit := 5
	days, source := ResolveSupplierLeadTime(SupplierSchedule{}, nil, &explicit, 10)
	if days != 5 || source != LeadTimeSourceExplicit {
		t.Fatalf("nil learned + explicit > 0 debe ser explicit_lead_time; got %d/%s",
			days, source)
	}
}

func TestResolveSupplierLeadTime_LearnedCeroCaeAExplicit(t *testing.T) {
	zero := 0
	explicit := 5
	days, source := ResolveSupplierLeadTime(SupplierSchedule{}, &zero, &explicit, 10)
	if days != 5 || source != LeadTimeSourceExplicit {
		t.Fatalf("learned = 0 no debe usarse; got %d/%s", days, source)
	}
}
