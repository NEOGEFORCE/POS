package services

import (
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// Miércoles 2026-08-26 como referencia estable.
var reference = time.Date(2026, 8, 26, 10, 0, 0, 0, time.UTC)

func TestNextSupplierVisitUsesClosestUpcomingDay(t *testing.T) {
	supplier := models.Supplier{VisitDays: models.StringArray{"Lunes", "Viernes"}}
	label, days, ok := NextSupplierVisit(supplier, reference)
	if !ok {
		t.Fatal("se esperaba un día de visita")
	}
	if label != "Viernes" || days != 2 {
		t.Fatalf("NextSupplierVisit = %s en %d días, want Viernes en 2", label, days)
	}
}

func TestNextSupplierVisitTodayRollsToNextWeek(t *testing.T) {
	supplier := models.Supplier{VisitDays: models.StringArray{"Miércoles"}}
	label, days, ok := NextSupplierVisit(supplier, reference)
	if !ok || label != "Miércoles" || days != 7 {
		t.Fatalf("visita de hoy debe pasar a la semana siguiente: %s en %d días (ok=%v)", label, days, ok)
	}
}

func TestNextSupplierVisitAcceptsUnaccentedAndLegacyFields(t *testing.T) {
	supplier := models.Supplier{VisitDays: models.StringArray{"miercoles", "sabado"}}
	label, days, ok := NextSupplierVisit(supplier, reference)
	if !ok || label != "Sábado" || days != 3 {
		t.Fatalf("sin acentos = %s en %d días (ok=%v), want Sábado en 3", label, days, ok)
	}

	legacy := models.Supplier{VisitDay: "Jueves, Domingo"}
	label, days, ok = NextSupplierVisit(legacy, reference)
	if !ok || label != "Jueves" || days != 1 {
		t.Fatalf("campo legacy = %s en %d días (ok=%v), want Jueves en 1", label, days, ok)
	}
}

func TestNextSupplierVisitFallsBackToDeliveryDays(t *testing.T) {
	supplier := models.Supplier{DeliveryDays: models.StringArray{"Martes"}}
	label, days, ok := NextSupplierVisit(supplier, reference)
	if !ok || label != "Martes" || days != 6 {
		t.Fatalf("respaldo por entrega = %s en %d días (ok=%v), want Martes en 6", label, days, ok)
	}
}

func TestNextSupplierVisitReportsMissingSchedule(t *testing.T) {
	if _, _, ok := NextSupplierVisit(models.Supplier{}, reference); ok {
		t.Fatal("sin días registrados no debe inventar una fecha")
	}
	if _, _, ok := NextSupplierVisit(models.Supplier{VisitDays: models.StringArray{"cualquier cosa"}}, reference); ok {
		t.Fatal("un valor inválido no debe interpretarse como día")
	}
}
