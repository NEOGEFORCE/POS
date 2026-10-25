// Pruebas del servicio para la ventana admin de /asignar (C).
//
// El sprint eleva la ventana de asignación de 60 min a 24 h cuando el
// actor es admin/administrador/superadmin. El flag `ActorIsAdmin` del
// `AssignEventInput` controla la decisión y el servicio traduce al
// `MaxAge` que el repo consume.
//
// Qué verifica cada test:
//
//   - assignmentWindowFor(true)  == QRAssignmentWindowAdmin (24h)
//   - assignmentWindowFor(false) == QRAssignmentWindow (60min)
//
//   - AssignEventToIntent con ActorIsAdmin=true asigna un evento de
//     2 h de antigüedad (empata la fixture de la bandeja real de la
//     tienda: $16.000 UNMATCHED a las 13:22, el dueño lo asigna a las
//     15:22 — 2 h después).
//
//   - AssignEventToIntent con ActorIsAdmin=false (cajero) sobre el
//     MISMO evento falla con ErrQREventAlreadyAssigned, confirmando
//     que la decisión vive en el servicio y no en el repo.

package services

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/sse"
)

func TestAssignmentWindowFor_AdminYCajero(t *testing.T) {
	t.Parallel()
	if got := assignmentWindowFor(true); got != models.QRAssignmentWindowAdmin {
		t.Errorf("admin → %v, want %v", got, models.QRAssignmentWindowAdmin)
	}
	if got := assignmentWindowFor(false); got != models.QRAssignmentWindow {
		t.Errorf("cajero → %v, want %v", got, models.QRAssignmentWindow)
	}
}

// Fixture que simula el evento #38 de producción: $16.000 UNMATCHED
// recibido hace 2 h, con una intención PENDIENTE viva del mismo monto
// que el dueño quiere enlazar.
func assignAdmin2hFakeSQL(now time.Time) *svcFakeSQL {
	received := now.Add(-2 * time.Hour)
	expires := now.Add(10 * time.Minute)
	return &svcFakeSQL{respond: func(q string, _ []interface{}) svcFakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, "POS_QR_PAYMENT_INTENTS") &&
			strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "STATUS IN"):
			return svcFakeResult{}
		case strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "POS_QR_WEBHOOK_EVENTS"):
			return svcFakeResult{
				Columns: []string{
					"id", "received_at", "source", "event_type", "external_id",
					"fingerprint", "amount_cop", "processed_at", "processed_status",
					"matched_intent_id", "note",
				},
				Rows: [][]driver.Value{{
					int64(38), received, "BRIDGE_NOTIFICATION", "PUSH_NOTIFICATION", nil,
					"fp-16k2h", int64(16000), received, "UNMATCHED",
					nil, "Recibiste $16.000 de JUAN",
				}},
			}
		case strings.HasPrefix(strings.TrimSpace(up), "SELECT") &&
			strings.Contains(up, "POS_QR_PAYMENT_INTENTS"):
			return svcFakeResult{
				Columns: []string{
					"id", "venta_temp_id", "caja_id", "created_by_dni",
					"amount_cop", "status", "created_at", "expires_at",
					"approved_at", "approved_source", "approved_reference",
					"approved_event_id", "cancelled_at", "cancelled_by_dni",
					"cancel_reason", "manual_confirmed_by_dni",
					"manual_confirmed_note", "related_sale_id",
				},
				Rows: [][]driver.Value{{
					int64(42), "temp-admin-2h", "CAJA-1", "ADMIN-1",
					int64(16000), "PENDIENTE", now.Add(-1 * time.Minute), expires,
					nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
				}},
			}
		}
		return svcFakeResult{}
	}}
}

// Admin asigna el evento de 2 h. Debe aprobarse (ventana 24 h).
func TestQrPaymentService_AssignEventToIntent_ActorIsAdmin_AceptaEventoDe2Horas(t *testing.T) {
	now := time.Date(2026, 10, 24, 15, 22, 0, 0, time.UTC)
	f := assignAdmin2hFakeSQL(now)
	repo := repositories.NewQrPaymentRepository(newSvcGormDB(t, f))
	svc := NewQrPaymentService(repo, sse.NewQRHub(), nil).
		WithClock(func() time.Time { return now })

	out, err := svc.AssignEventToIntent(context.Background(), AssignEventInput{
		VentaTempID:  "temp-admin-2h",
		EventID:      38,
		ActorDNI:     "ADMIN-1",
		ActorName:    "Dueño Sarmiento",
		ActorIsAdmin: true,
	})
	if err != nil {
		t.Fatalf("admin con ActorIsAdmin=true debe asignar evento de 2 h, got %v", err)
	}
	if out == nil || out.Status != models.QRIntentStatusApproved {
		t.Fatalf("output esperado APROBADA, got %+v", out)
	}
	if out.ApprovedReference != "ASIG-38" {
		t.Errorf("approved_reference esperado 'ASIG-38', got %q", out.ApprovedReference)
	}
}

// Cajero (ActorIsAdmin=false) sobre el MISMO evento: rechazado.
func TestQrPaymentService_AssignEventToIntent_ActorNoAdmin_RechazaEventoDe2Horas(t *testing.T) {
	now := time.Date(2026, 10, 24, 15, 22, 0, 0, time.UTC)
	f := assignAdmin2hFakeSQL(now)
	repo := repositories.NewQrPaymentRepository(newSvcGormDB(t, f))
	svc := NewQrPaymentService(repo, sse.NewQRHub(), nil).
		WithClock(func() time.Time { return now })

	_, err := svc.AssignEventToIntent(context.Background(), AssignEventInput{
		VentaTempID:  "temp-admin-2h",
		EventID:      38,
		ActorDNI:     "EMP-9",
		ActorName:    "Cajero Regular",
		ActorIsAdmin: false,
	})
	if !errors.Is(err, ErrQREventAlreadyAssigned) {
		t.Errorf("cajero con ActorIsAdmin=false debe ErrQREventAlreadyAssigned para evento de 2 h, got %v", err)
	}
}
