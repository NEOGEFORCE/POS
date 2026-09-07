package orchestrator

import (
	"context"
	"testing"
	"time"

	"github.com/robfig/cron/v3"
)

var bogota = time.FixedZone("America/Bogota", -5*60*60)

func mustParse(t *testing.T, spec string) cron.Schedule {
	t.Helper()
	schedule, err := cron.ParseStandard(spec)
	if err != nil {
		t.Fatalf("ParseStandard(%q) devolvió error: %v", spec, err)
	}
	return schedule
}

func TestRetryDelayCreceYSeTopa(t *testing.T) {
	cases := []struct {
		attempt int
		want    time.Duration
	}{
		{attempt: 0, want: time.Second},
		{attempt: 1, want: time.Second},
		{attempt: 2, want: 2 * time.Second},
		{attempt: 3, want: 4 * time.Second},
		{attempt: 9, want: 256 * time.Second},
		{attempt: 10, want: maxRetryDelay},
		{attempt: 64, want: maxRetryDelay},
	}

	for _, tc := range cases {
		if got := retryDelay(tc.attempt); got != tc.want {
			t.Errorf("retryDelay(%d) = %v, se esperaba %v", tc.attempt, got, tc.want)
		}
	}
}

func TestIntervalOfDistingueTipoDeSchedule(t *testing.T) {
	interval := mustParse(t, "@every 5m")
	delay, ok := intervalOf(interval)
	if !ok || delay != 5*time.Minute {
		t.Fatalf("intervalOf(@every 5m) = (%v, %v), se esperaba (5m, true)", delay, ok)
	}
	if !isInterval(interval) {
		t.Error("isInterval(@every 5m) = false, se esperaba true")
	}

	spec := mustParse(t, "20 21 * * *")
	if _, ok := intervalOf(spec); ok {
		t.Error("intervalOf de una expresión cron devolvió true")
	}
	if isInterval(spec) {
		t.Error("isInterval de una expresión cron devolvió true")
	}
}

// La ventana de un job de intervalo debe ser idéntica para dos procesos que
// disparan en instantes ligeramente distintos, porque es la clave de
// idempotencia del índice único.
func TestWindowForIntervaloAlineaProcesosDesfasados(t *testing.T) {
	schedule := mustParse(t, "@every 5m")

	primero := time.Date(2026, 8, 30, 10, 5, 0, 0, bogota)
	segundo := time.Date(2026, 8, 30, 10, 7, 43, 500, bogota)

	ventanaA := windowFor(schedule, primero)
	ventanaB := windowFor(schedule, segundo)

	if !ventanaA.Equal(ventanaB) {
		t.Fatalf("ventanas distintas dentro del mismo intervalo: %v vs %v", ventanaA, ventanaB)
	}

	// Al cruzar el borde de los 5 minutos sí debe cambiar de ventana.
	tercero := time.Date(2026, 8, 30, 10, 10, 1, 0, bogota)
	if windowFor(schedule, tercero).Equal(ventanaA) {
		t.Error("el cruce de intervalo no generó una ventana nueva")
	}
}

func TestWindowForCronUsaLaHoraDeDisparo(t *testing.T) {
	schedule := mustParse(t, "20 21 * * *")

	// El scheduler despierta con unos milisegundos de retraso sobre el borde.
	disparo := time.Date(2026, 8, 30, 21, 20, 0, 12_000_000, bogota)
	ventana := windowFor(schedule, disparo)

	esperada := time.Date(2026, 8, 30, 21, 20, 0, 0, bogota)
	if !ventana.Equal(esperada) {
		t.Fatalf("windowFor = %v, se esperaba %v", ventana, esperada)
	}
}

func TestPreviousOccurrenceEncuentraElRespaldoPerdido(t *testing.T) {
	// Respaldo nocturno de las 21:20. El PC se enciende a las 08:00 del día
	// siguiente: el catch-up debe apuntar al disparo de anoche.
	schedule := mustParse(t, "20 21 * * *")
	arranque := time.Date(2026, 8, 30, 8, 0, 0, 0, bogota)

	perdida, ok := previousOccurrence(schedule, arranque, catchUpLookback)
	if !ok {
		t.Fatal("previousOccurrence no encontró ocurrencia perdida")
	}

	esperada := time.Date(2026, 8, 29, 21, 20, 0, 0, bogota)
	if !perdida.Equal(esperada) {
		t.Fatalf("ocurrencia perdida = %v, se esperaba %v", perdida, esperada)
	}
}

func TestPreviousOccurrenceDevuelveLaMasRecienteNoLaMasVieja(t *testing.T) {
	schedule := mustParse(t, "0 7 * * *")
	// Tres días encendido: sólo interesa el 07:00 de hoy, no los anteriores.
	ahora := time.Date(2026, 8, 30, 9, 30, 0, 0, bogota)

	ultima, ok := previousOccurrence(schedule, ahora, catchUpLookback)
	if !ok {
		t.Fatal("previousOccurrence no encontró ocurrencia")
	}

	esperada := time.Date(2026, 8, 30, 7, 0, 0, 0, bogota)
	if !ultima.Equal(esperada) {
		t.Fatalf("ocurrencia = %v, se esperaba %v", ultima, esperada)
	}
}

func TestPreviousOccurrenceSinOcurrenciaEnLaVentana(t *testing.T) {
	schedule := mustParse(t, "0 7 * * *")
	// A las 06:30, mirando sólo una hora atrás, no hubo disparo.
	ahora := time.Date(2026, 8, 30, 6, 30, 0, 0, bogota)

	if _, ok := previousOccurrence(schedule, ahora, time.Hour); ok {
		t.Error("previousOccurrence reportó una ocurrencia inexistente")
	}
}

func TestPreviousOccurrenceRechazaLookbackInvalido(t *testing.T) {
	schedule := mustParse(t, "0 7 * * *")
	if _, ok := previousOccurrence(schedule, time.Now(), 0); ok {
		t.Error("lookback cero debería devolver false")
	}
	if _, ok := previousOccurrence(nil, time.Now(), time.Hour); ok {
		t.Error("schedule nil debería devolver false")
	}
}

func TestRegisterValidaLasDefiniciones(t *testing.T) {
	noop := func(context.Context) error { return nil }
	o := New(nil, bogota)

	if err := o.Register(Definition{Key: "  ", Schedule: "@every 1m"}, noop); err == nil {
		t.Error("se aceptó un job sin clave")
	}
	if err := o.Register(Definition{Key: "sin_funcion", Schedule: "@every 1m"}, nil); err == nil {
		t.Error("se aceptó un job sin función")
	}
	if err := o.Register(Definition{Key: "mal_schedule", Schedule: "no-es-cron"}, noop); err == nil {
		t.Error("se aceptó un schedule inválido")
	}

	valido := Definition{Key: "respaldo", Schedule: "20 21 * * *"}
	if err := o.Register(valido, noop); err != nil {
		t.Fatalf("Register válido devolvió error: %v", err)
	}
	if err := o.Register(valido, noop); err == nil {
		t.Error("se aceptó una clave duplicada")
	}

	registrado := o.jobs["respaldo"]
	if registrado.def.Timeout != defaultTimeout {
		t.Errorf("timeout por defecto = %v, se esperaba %v", registrado.def.Timeout, defaultTimeout)
	}
	if registrado.def.MaxAttempts != defaultMaxAttempts {
		t.Errorf("maxAttempts por defecto = %d, se esperaba %d", registrado.def.MaxAttempts, defaultMaxAttempts)
	}
}

func TestRunNowRechazaJobDesconocido(t *testing.T) {
	o := New(nil, bogota)
	if err := o.RunNow("no_existe"); err == nil {
		t.Error("RunNow aceptó un job no registrado")
	}
}

func TestTruncateErrorAcotaMensajesEnormes(t *testing.T) {
	corto := "fallo simple"
	if got := truncateError(corto); got != corto {
		t.Errorf("truncateError alteró un mensaje corto: %q", got)
	}

	largo := make([]byte, 5000)
	for i := range largo {
		largo[i] = 'x'
	}
	got := truncateError(string(largo))
	if len(got) >= 5000 {
		t.Errorf("truncateError no acotó el mensaje: largo %d", len(got))
	}
}
