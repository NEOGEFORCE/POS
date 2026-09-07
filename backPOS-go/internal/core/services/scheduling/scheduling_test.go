package scheduling

import (
	"testing"
	"time"
)

// bogotaTime construye una fecha en la zona America/Bogota (UTC-5, sin DST).
// Todos los tests se apoyan en fechas concretas con weekday conocido para que
// el resultado sea determinista.
func bogotaTime(t *testing.T, year int, month time.Month, day, hour int) time.Time {
	t.Helper()
	loc, err := time.LoadLocation("America/Bogota")
	if err != nil {
		// Fallback: en Windows LoadLocation puede fallar sin tzdata. Usamos
		// el mismo offset fijo que el resto del proyecto.
		loc = time.FixedZone("America/Bogota", -5*60*60)
	}
	return time.Date(year, month, day, hour, 0, 0, 0, loc)
}

func TestPlanSupplierOrderScheduleVisitaLunesEntregaMiercoles(t *testing.T) {
	// Domingo 2026-08-30. Proveedor visita lunes y entrega miercoles.
	today := bogotaTime(t, 2026, time.August, 30, 8)

	got := PlanSupplierOrderSchedule(
		[]string{"Lunes"},
		[]string{"Miércoles"},
		today,
	)

	if !got.HasSchedule {
		t.Fatal("HasSchedule = false, want true con dias validos")
	}
	if got.NextVisitDate.Weekday() != time.Monday {
		t.Fatalf("NextVisitDate weekday = %v, want Monday", got.NextVisitDate.Weekday())
	}
	if got.NextDeliveryDate.Weekday() != time.Wednesday {
		t.Fatalf("NextDeliveryDate weekday = %v, want Wednesday", got.NextDeliveryDate.Weekday())
	}
	if got.LeadTimeDays != 2 {
		t.Fatalf("LeadTimeDays = %d, want 2 (lun->mie)", got.LeadTimeDays)
	}
	if got.DaysUntilNextVisit != 1 {
		t.Fatalf("DaysUntilNextVisit = %d, want 1 (dom->lun)", got.DaysUntilNextVisit)
	}
}

func TestPlanSupplierOrderScheduleVisitaYEntregaMismoDia(t *testing.T) {
	// Sabado 2026-08-29. Proveedor visita y entrega en martes (mismo dia).
	today := bogotaTime(t, 2026, time.August, 29, 8)

	got := PlanSupplierOrderSchedule(
		[]string{"Martes"},
		[]string{"Martes"},
		today,
	)

	if !got.HasSchedule {
		t.Fatal("HasSchedule = false, want true")
	}
	if got.LeadTimeDays != 0 {
		t.Fatalf("LeadTimeDays = %d, want 0 cuando visita y entrega caen el mismo dia", got.LeadTimeDays)
	}
	if got.DaysUntilNextVisit != 3 {
		t.Fatalf("DaysUntilNextVisit = %d, want 3 (sab->mar)", got.DaysUntilNextVisit)
	}
	if !got.NextDeliveryDate.Equal(got.NextVisitDate) {
		t.Fatalf("mismo dia: NextDeliveryDate=%v != NextVisitDate=%v",
			got.NextDeliveryDate, got.NextVisitDate)
	}
}

func TestPlanSupplierOrderScheduleVariosDiasElige_ElMasCercano(t *testing.T) {
	// Miercoles 2026-08-26. Visitas lun/vie, entregas mar/jue.
	// Proxima visita: viernes (2 dias). Proxima entrega >= viernes: martes
	// de la SEMANA SIGUIENTE (4 dias despues del viernes).
	today := bogotaTime(t, 2026, time.August, 26, 8)

	got := PlanSupplierOrderSchedule(
		[]string{"Lunes", "Viernes"},
		[]string{"Martes", "Jueves"},
		today,
	)

	if !got.HasSchedule {
		t.Fatal("HasSchedule = false, want true")
	}
	if got.NextVisitDate.Weekday() != time.Friday {
		t.Fatalf("NextVisitDate weekday = %v, want Friday", got.NextVisitDate.Weekday())
	}
	if got.DaysUntilNextVisit != 2 {
		t.Fatalf("DaysUntilNextVisit = %d, want 2 (mie->vie)", got.DaysUntilNextVisit)
	}
	if got.NextDeliveryDate.Weekday() != time.Tuesday {
		t.Fatalf("NextDeliveryDate weekday = %v, want Tuesday (vie->mar)", got.NextDeliveryDate.Weekday())
	}
	if got.LeadTimeDays != 4 {
		t.Fatalf("LeadTimeDays = %d, want 4 (vie->mar de la semana siguiente)", got.LeadTimeDays)
	}
}

func TestPlanSupplierOrderScheduleEntregaSemanaSiguienteAVisita(t *testing.T) {
	// Jueves 2026-08-27. Visita viernes, entrega lunes (siguiente semana).
	today := bogotaTime(t, 2026, time.August, 27, 8)

	got := PlanSupplierOrderSchedule(
		[]string{"Viernes"},
		[]string{"Lunes"},
		today,
	)

	if !got.HasSchedule {
		t.Fatal("HasSchedule = false, want true")
	}
	if got.NextVisitDate.Weekday() != time.Friday {
		t.Fatalf("NextVisitDate weekday = %v, want Friday", got.NextVisitDate.Weekday())
	}
	if got.NextDeliveryDate.Weekday() != time.Monday {
		t.Fatalf("NextDeliveryDate weekday = %v, want Monday", got.NextDeliveryDate.Weekday())
	}
	if got.LeadTimeDays != 3 {
		t.Fatalf("LeadTimeDays = %d, want 3 (vie->lun de la semana siguiente)", got.LeadTimeDays)
	}
	if got.DaysUntilNextVisit != 1 {
		t.Fatalf("DaysUntilNextVisit = %d, want 1 (jue->vie)", got.DaysUntilNextVisit)
	}
}

func TestPlanSupplierOrderScheduleSinDiasConfigurados(t *testing.T) {
	today := bogotaTime(t, 2026, time.August, 27, 8)

	if got := PlanSupplierOrderSchedule(nil, []string{"Lunes"}, today); got.HasSchedule {
		t.Fatal("sin visita no debe reportar HasSchedule=true")
	}
	if got := PlanSupplierOrderSchedule([]string{"Lunes"}, nil, today); got.HasSchedule {
		t.Fatal("sin entrega no debe reportar HasSchedule=true")
	}
	if got := PlanSupplierOrderSchedule(nil, nil, today); got.HasSchedule {
		t.Fatal("sin datos no debe reportar HasSchedule=true")
	}
	if got := PlanSupplierOrderSchedule([]string{"cualquier cosa"}, []string{"otro dia"}, today); got.HasSchedule {
		t.Fatal("valores invalidos no deben interpretarse como dias")
	}
}

func TestPlanSupplierOrderScheduleNombresConTildesYMinusculas(t *testing.T) {
	// Domingo 2026-08-30. Miercoles y sabado sin tildes, en minuscula, con
	// espacios: el usuario tipeo el dato a mano.
	today := bogotaTime(t, 2026, time.August, 30, 8)

	got := PlanSupplierOrderSchedule(
		[]string{"  miercoles ", "SÁBADO"},
		[]string{"jueves", "DoMinGo"},
		today,
	)

	if !got.HasSchedule {
		t.Fatal("HasSchedule = false, want true con normalizacion tolerante")
	}
	// Hoy es domingo. La proxima visita desde domingo es miercoles (3 dias),
	// porque sabado tambien esta pero cae despues.
	if got.NextVisitDate.Weekday() != time.Wednesday {
		t.Fatalf("NextVisitDate weekday = %v, want Wednesday", got.NextVisitDate.Weekday())
	}
	if got.DaysUntilNextVisit != 3 {
		t.Fatalf("DaysUntilNextVisit = %d, want 3", got.DaysUntilNextVisit)
	}
	// Entrega: jueves posterior a miercoles = 1 dia despues (domingo tambien
	// esta pero cae 4 dias despues del miercoles).
	if got.NextDeliveryDate.Weekday() != time.Thursday {
		t.Fatalf("NextDeliveryDate weekday = %v, want Thursday", got.NextDeliveryDate.Weekday())
	}
	if got.LeadTimeDays != 1 {
		t.Fatalf("LeadTimeDays = %d, want 1", got.LeadTimeDays)
	}
}

func TestPlanSupplierOrderScheduleHoyEsDiaDeVisita(t *testing.T) {
	// Miercoles 2026-08-26. Visita miercoles, entrega viernes.
	today := bogotaTime(t, 2026, time.August, 26, 15)

	got := PlanSupplierOrderSchedule(
		[]string{"Miércoles"},
		[]string{"Viernes"},
		today,
	)

	if !got.HasSchedule {
		t.Fatal("HasSchedule = false, want true")
	}
	// Hoy es dia de visita: no se salta a la semana siguiente. Se asume que
	// el operador todavia puede pasarle el pedido hoy. Es una decision
	// deliberada para mantener las fechas cortas y accionables — el bug
	// original era que las fechas quedaban demasiado lejos.
	if got.DaysUntilNextVisit != 0 {
		t.Fatalf("DaysUntilNextVisit = %d, want 0 (hoy es dia de visita)", got.DaysUntilNextVisit)
	}
	if got.NextVisitDate.Day() != today.Day() {
		t.Fatalf("NextVisitDate = %v, want hoy (%v)", got.NextVisitDate, today)
	}
	if got.LeadTimeDays != 2 {
		t.Fatalf("LeadTimeDays = %d, want 2 (mie->vie)", got.LeadTimeDays)
	}
}

func TestPlanSupplierOrderScheduleAceptaCSVDelCampoLegacy(t *testing.T) {
	// El campo legacy "visitDay" a veces trae "Lunes, Miercoles". La funcion
	// pura no debe reventar si el consumidor le pasa el string sin dividir.
	today := bogotaTime(t, 2026, time.August, 30, 8) // domingo

	got := PlanSupplierOrderSchedule(
		[]string{"Lunes, Miercoles"},
		[]string{"Martes, Jueves"},
		today,
	)

	if !got.HasSchedule {
		t.Fatal("HasSchedule = false; el CSV embebido debe aceptarse")
	}
	// Lunes es el mas cercano desde domingo.
	if got.NextVisitDate.Weekday() != time.Monday {
		t.Fatalf("NextVisitDate weekday = %v, want Monday", got.NextVisitDate.Weekday())
	}
	if got.NextDeliveryDate.Weekday() != time.Tuesday {
		t.Fatalf("NextDeliveryDate weekday = %v, want Tuesday", got.NextDeliveryDate.Weekday())
	}
	if got.LeadTimeDays != 1 {
		t.Fatalf("LeadTimeDays = %d, want 1", got.LeadTimeDays)
	}
}

func TestPlanSupplierOrderScheduleIgnoraValoresInvalidosMixtos(t *testing.T) {
	// Domingo. Se pasa un dia real y otro invalido; debe usar el real.
	today := bogotaTime(t, 2026, time.August, 30, 8)

	got := PlanSupplierOrderSchedule(
		[]string{"lunes", "xyz"},
		[]string{"blah", "Martes"},
		today,
	)
	if !got.HasSchedule {
		t.Fatal("HasSchedule = false; con al menos un valor valido debe funcionar")
	}
	if got.NextVisitDate.Weekday() != time.Monday {
		t.Fatalf("visita = %v, want Monday", got.NextVisitDate.Weekday())
	}
	if got.NextDeliveryDate.Weekday() != time.Tuesday {
		t.Fatalf("entrega = %v, want Tuesday", got.NextDeliveryDate.Weekday())
	}
}

func TestPlanSupplierOrderScheduleConservaLocation(t *testing.T) {
	// El calculo debe respetar la zona horaria de la referencia. Usar una
	// hora tarde del dia (23:00) no debe correr el resultado un dia.
	bogota := bogotaTime(t, 2026, time.August, 30, 23) // domingo, 23:00 local
	if bogota.Weekday() != time.Sunday {
		t.Fatalf("setup: bogota debe ser domingo, es %v", bogota.Weekday())
	}
	got := PlanSupplierOrderSchedule([]string{"Lunes"}, []string{"Lunes"}, bogota)
	if got.DaysUntilNextVisit != 1 {
		t.Fatalf("DaysUntilNextVisit = %d, want 1 aunque la hora sea tarde",
			got.DaysUntilNextVisit)
	}
}

func TestResolveSupplierLeadTimePrecedenciaConfiguredDays(t *testing.T) {
	schedule := SupplierSchedule{HasSchedule: true, LeadTimeDays: 2}
	explicit := 5

	days, source := ResolveSupplierLeadTime(schedule, nil, &explicit, 10)
	if days != 2 || source != LeadTimeSourceConfiguredDays {
		t.Fatalf("configured_days debe ganar; days=%d source=%s", days, source)
	}
}

func TestResolveSupplierLeadTimeCaeAExplicitCuandoNoHaySchedule(t *testing.T) {
	explicit := 5
	days, source := ResolveSupplierLeadTime(SupplierSchedule{}, nil, &explicit, 10)
	if days != 5 || source != LeadTimeSourceExplicit {
		t.Fatalf("explicit_lead_time esperado; days=%d source=%s", days, source)
	}
}

func TestResolveSupplierLeadTimeCaeAVisitFrequencyCuandoElExplicitEsNilOCero(t *testing.T) {
	days, source := ResolveSupplierLeadTime(SupplierSchedule{}, nil, nil, 10)
	if days != 10 || source != LeadTimeSourceVisitFrequency {
		t.Fatalf("visit_frequency_learned esperado; days=%d source=%s", days, source)
	}
	zero := 0
	days, source = ResolveSupplierLeadTime(SupplierSchedule{}, nil, &zero, 10)
	if days != 10 || source != LeadTimeSourceVisitFrequency {
		t.Fatalf("explicit=0 debe caer a visit_frequency; days=%d source=%s", days, source)
	}
}

func TestResolveSupplierLeadTimeUltimoRecursoSiete(t *testing.T) {
	days, source := ResolveSupplierLeadTime(SupplierSchedule{}, nil, nil, 0)
	if days != 7 || source != LeadTimeSourceDefault {
		t.Fatalf("default esperado; days=%d source=%s", days, source)
	}
}

func TestParseWeekdayNameTolerante(t *testing.T) {
	cases := []struct {
		input   string
		want    time.Weekday
		wantOK  bool
		wantLbl string
	}{
		{"Lunes", time.Monday, true, "Lunes"},
		{"lunes", time.Monday, true, "Lunes"},
		{"  LUNES ", time.Monday, true, "Lunes"},
		{"Miércoles", time.Wednesday, true, "Miércoles"},
		{"miercoles", time.Wednesday, true, "Miércoles"},
		{"MIÉRCOLES", time.Wednesday, true, "Miércoles"},
		{"Sábado", time.Saturday, true, "Sábado"},
		{"sabado", time.Saturday, true, "Sábado"},
		{"cualquiera", 0, false, ""},
		{"", 0, false, ""},
	}
	for _, c := range cases {
		got, ok := ParseWeekdayName(c.input)
		if ok != c.wantOK {
			t.Fatalf("ParseWeekdayName(%q) ok = %v, want %v", c.input, ok, c.wantOK)
		}
		if !ok {
			continue
		}
		if got != c.want {
			t.Fatalf("ParseWeekdayName(%q) = %v, want %v", c.input, got, c.want)
		}
		if lbl := WeekdayLabels[got]; lbl != c.wantLbl {
			t.Fatalf("WeekdayLabels[%v] = %q, want %q", got, lbl, c.wantLbl)
		}
	}
}
