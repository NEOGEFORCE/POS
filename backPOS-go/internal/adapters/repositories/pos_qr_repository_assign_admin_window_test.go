// Pruebas del repo para la ventana extendida de asignación admin (C).
//
// Hasta este sprint `AssignEventToIntent` sólo aceptaba eventos
// recibidos en los últimos 60 min (`QRAssignmentWindow`). El sprint
// agrega `QRAssignmentWindowAdmin = 24 h`: el servicio pasa `MaxAge`
// diferenciado según el rol del actor; el repo lo recibe por el
// mismo campo `AssignEventOptions.MaxAge`.
//
// Qué cubrimos aquí:
//
//   - Un evento recibido hace 2 h se asigna correctamente cuando el
//     caller pasa MaxAge = 24 h (ventana admin).
//
//   - El MISMO evento (2 h de antigüedad) se rechaza con
//     ErrQREventAlreadyAssigned cuando se usa la ventana por default
//     (`QRAssignmentWindow`, 60 min) — lo que sucede cuando el actor
//     es cajero regular.

package repositories

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// evento de 2 h de antigüedad, intent viva PENDIENTE que empata.
func fakeAdmin2hFixture(now time.Time) *fakeSQL {
	received := now.Add(-2 * time.Hour)
	futureExpires := now.Add(10 * time.Minute)
	return &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, "POS_QR_PAYMENT_INTENTS") &&
			strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "STATUS IN"):
			return fakeResult{}
		case strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "POS_QR_WEBHOOK_EVENTS"):
			return fakeEventRow(99, 16000, "UNMATCHED", "BRIDGE_NOTIFICATION", received, "Recibiste $16.000", nil)
		case strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "POS_QR_PAYMENT_INTENTS"):
			return fakeIntentRow(42, 16000, "PENDIENTE", futureExpires)
		}
		return fakeResult{}
	}}
}

// Admin: evento de 2 h se asigna con MaxAge=24h.
func TestQrRepo_AssignEventToIntent_AdminWindow24h_AceptaEventoDe2Horas(t *testing.T) {
	now := time.Date(2026, 10, 24, 15, 22, 0, 0, time.UTC)
	f := fakeAdmin2hFixture(now)
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	outcome, err := repo.AssignEventToIntent(context.Background(), AssignEventOptions{
		VentaTempID: "temp-admin-ventana",
		EventID:     99,
		ActorDNI:    "ADMIN-1",
		MaxAge:      models.QRAssignmentWindowAdmin, // 24 h
		Now:         func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("admin con MaxAge=24h debe asignar evento de 2 h, got %v", err)
	}
	if outcome == nil || outcome.Intent == nil || outcome.Event == nil {
		t.Fatal("outcome incompleto")
	}
	if outcome.Intent.Status != models.QRIntentStatusApproved {
		t.Errorf("intent status = %s, want APROBADA", outcome.Intent.Status)
	}
	if outcome.Event.ProcessedStatus != models.QRWebhookStatusApproved {
		t.Errorf("event processed_status = %s, want APPROVED", outcome.Event.ProcessedStatus)
	}
}

// Cajero: el mismo evento de 2 h se rechaza con MaxAge=60min (default).
func TestQrRepo_AssignEventToIntent_CajeroWindow60m_RechazaEventoDe2Horas(t *testing.T) {
	now := time.Date(2026, 10, 24, 15, 22, 0, 0, time.UTC)
	f := fakeAdmin2hFixture(now)
	repo := NewQrPaymentRepository(newFakeGormDB(t, f))

	_, err := repo.AssignEventToIntent(context.Background(), AssignEventOptions{
		VentaTempID: "temp-cajero-ventana",
		EventID:     99,
		ActorDNI:    "EMP-1",
		MaxAge:      models.QRAssignmentWindow, // 60 min
		Now:         func() time.Time { return now },
	})
	if !errors.Is(err, ErrQREventAlreadyAssigned) {
		t.Errorf("cajero con MaxAge=60min debe rechazar evento de 2 h, got %v", err)
	}
}

// Guardián de las constantes expuestas: la ventana admin es
// estrictamente mayor que la ventana del cajero y empata con 24 h.
func TestQrRepo_QRAssignmentWindows_ConstantesCoherentes(t *testing.T) {
	if models.QRAssignmentWindow <= 0 {
		t.Errorf("QRAssignmentWindow debe ser positiva, got %v", models.QRAssignmentWindow)
	}
	if models.QRAssignmentWindowAdmin != 24*time.Hour {
		t.Errorf("QRAssignmentWindowAdmin debe ser 24h, got %v", models.QRAssignmentWindowAdmin)
	}
	if models.QRAssignmentWindowAdmin <= models.QRAssignmentWindow {
		t.Error("QRAssignmentWindowAdmin debe exceder QRAssignmentWindow")
	}
}

// Silencio al linter: driver.Value sólo se referencia desde el fixture.
var _ driver.Value = int64(0)
