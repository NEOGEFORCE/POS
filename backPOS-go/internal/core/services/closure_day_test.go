package services

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// LA FECHA DEL TURNO ES EL DIA DEL NEGOCIO, NO LA HORA EN QUE SE CERRO
// ============================================================================
//
// Pedido del dueño (2026-09-04/05): la fecha del reporte tiene que ser la misma
// que muestra el historial visual de /reports.
//
// EL CAMPO CORRECTO ES c.Date. Así agrupa ClosuresHistory.tsx:
//
//	const dateStr = c.date || c.startDate;
//
// EJEMPLO REAL que lo define (cierre CC-166): cerró el 29/08/2026 a las
// 07:38 a.m., pero la pantalla lo muestra bajo VIERNES 28 DE AGOSTO porque casi
// toda su venta es del 28. El dueño fue explícito: "tiene que salir que es del
// 28".
//
// HISTORIA PARA NO REPETIRLA: el 2026-09-04 se cambió a EndDate asumiendo que la
// pantalla agrupaba por fecha de cierre. Quedó al revés y el dueño lo detectó al
// comparar el PDF contra /reports. EndDate sólo sirve de respaldo cuando Date
// viene vacío en cierres históricos.
//
// Es lógica pura: no necesita Postgres, según la convención test-sin-postgres.

// readServiceSource lee un archivo de este paquete para los guardianes
// estáticos.
func readServiceSource(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(name))
	if err != nil {
		t.Fatalf("no se pudo leer %s: %v", name, err)
	}
	return string(b)
}

func contains(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}

// resolveClosureDay replica la resolución de fecha que usan los reportes.
func resolveClosureDay(c *models.CashierClosure, loc *time.Location) string {
	ref := c.Date
	if ref.IsZero() {
		ref = c.EndDate
	}
	return ref.In(loc).Format("2006-01-02")
}

func bogota() *time.Location { return time.FixedZone("America/Bogota", -5*60*60) }

func TestFechaDelTurno_CierreDeMadrugadaPerteneceAlDiaAnterior(t *testing.T) {
	loc := bogota()

	// CASO REAL CC-166: la jornada es del 28, el cierre se hizo el 29 a las
	// 07:38 a.m. La pantalla lo muestra en el 28 y el PDF debe decir 28.
	c := models.CashierClosure{
		ID:        166,
		Date:      time.Date(2026, 8, 28, 0, 0, 0, 0, loc),
		StartDate: time.Date(2026, 8, 28, 7, 30, 0, 0, loc),
		EndDate:   time.Date(2026, 8, 29, 7, 38, 6, 0, loc),
	}

	got := resolveClosureDay(&c, loc)
	if got != "2026-08-28" {
		t.Fatalf("dia del turno = %q; want \"2026-08-28\" (el dia del negocio, no la hora de cierre)", got)
	}
}

func TestFechaDelTurno_TurnoNormalNoSeMueve(t *testing.T) {
	loc := bogota()
	c := models.CashierClosure{
		ID:        142,
		Date:      time.Date(2026, 8, 30, 0, 0, 0, 0, loc),
		StartDate: time.Date(2026, 8, 30, 8, 0, 0, 0, loc),
		EndDate:   time.Date(2026, 8, 30, 20, 0, 0, 0, loc),
	}
	if got := resolveClosureDay(&c, loc); got != "2026-08-30" {
		t.Fatalf("dia del turno = %q; want \"2026-08-30\"", got)
	}
}

func TestFechaDelTurno_SinFechaDeNegocioCaeALaDeCierre(t *testing.T) {
	loc := bogota()
	// Cierre histórico sin Date: no puede quedar sin fecha.
	c := models.CashierClosure{
		ID:      77,
		EndDate: time.Date(2026, 7, 15, 19, 0, 0, 0, loc),
	}
	if got := resolveClosureDay(&c, loc); got != "2026-07-15" {
		t.Fatalf("dia del turno = %q; want \"2026-07-15\" (respaldo a EndDate)", got)
	}
}

func TestFechaDelTurno_LaFechaSeLeeEnZonaColombiaNoEnUTC(t *testing.T) {
	loc := bogota()
	// Guardado en UTC a las 02:30 del 30 = 21:30 del 29 en Colombia.
	c := models.CashierClosure{
		ID:   143,
		Date: time.Date(2026, 8, 30, 2, 30, 0, 0, time.UTC),
	}
	if got := resolveClosureDay(&c, loc); got != "2026-08-29" {
		t.Fatalf("dia del turno = %q; want \"2026-08-29\" (leido en hora Colombia)", got)
	}
}

func TestFechaDelTurno_ElConceptoNoMuestraRangoEntreDosDias(t *testing.T) {
	// El concepto del evento no puede volver a imprimir un rango de horas:
	// "22:00 a 01:00" hacía parecer que el movimiento es de dos días.
	source := readServiceSource(t, "dashboard_service.go")
	if contains(source, `Turno #%d - %s (%s a %s)`) {
		t.Fatal("el concepto del turno no debe llevar rango de horas: da a entender dos dias")
	}
	if !contains(source, `Turno #%d - %s`) {
		t.Fatal("se esperaba el concepto 'Turno #N - CAJERO'")
	}
}

func TestFechaDelTurno_LosReportesNoPuedenPreferirEndDate(t *testing.T) {
	// GUARDIAN DE LA REGRESION CONCRETA: si algún reporte vuelve a preferir
	// EndDate, el PDF deja de coincidir con la pantalla y reaparece el bug que
	// el dueño detectó con el cierre CC-166.
	for _, file := range []string{"dashboard_service.go", "export_service_consolidated.go"} {
		source := readServiceSource(t, file)
		if contains(source, "ref := c.EndDate") {
			t.Errorf("%s prefiere c.EndDate; debe usar c.Date (el dia del negocio) para coincidir con /reports", file)
		}
		if contains(source, "turnoRef := c.EndDate") {
			t.Errorf("%s arma la fecha del turno con c.EndDate; debe usar c.Date", file)
		}
	}
}
