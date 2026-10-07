package services

import (
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// VALIDACION DE MAGNITUDES (ValidateCorrectPaymentChannelRequest)
// ============================================================================

func TestValidateCorrectPayment_RechazaMagnitudesNegativas(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		req  CorrectPaymentChannelRequest
	}{
		{"cash negativo", CorrectPaymentChannelRequest{CashAmount: -1, TransferAmount: 1000}},
		{"transferAmount negativo", CorrectPaymentChannelRequest{TransferAmount: -1}},
		{"nequi negativo", CorrectPaymentChannelRequest{TransferNequi: -1, TransferAmount: 0}},
		{"daviplata negativo", CorrectPaymentChannelRequest{TransferDaviplata: -1}},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if err := ValidateCorrectPaymentChannelRequest(tt.req); err == nil {
				t.Fatal("se esperaba rechazo por magnitud negativa")
			}
		})
	}
}

func TestValidateCorrectPayment_DesgloseNoPuedeSuperarElTotal(t *testing.T) {
	t.Parallel()
	req := CorrectPaymentChannelRequest{
		TransferAmount:    5000,
		TransferNequi:     3000,
		TransferDaviplata: 3000, // suma 6000 > 5000+5
	}
	err := ValidateCorrectPaymentChannelRequest(req)
	if err == nil {
		t.Fatal("se esperaba rechazo cuando el desglose supera el total")
	}
	if !strings.Contains(err.Error(), "desglose") {
		t.Errorf("mensaje = %q; want menciona desglose", err.Error())
	}
}

func TestValidateCorrectPayment_AceptaMagnitudesCoherentes(t *testing.T) {
	t.Parallel()
	// Caso real: cliente pago mitad en Nequi, mitad en efectivo.
	req := CorrectPaymentChannelRequest{
		CashAmount:        10000,
		TransferAmount:    10000,
		TransferNequi:     10000,
		TransferDaviplata: 0,
	}
	if err := ValidateCorrectPaymentChannelRequest(req); err != nil {
		t.Fatalf("se esperaba aceptacion: %v", err)
	}
}

// ============================================================================
// ELEGIBILIDAD DE LA VENTA (isSaleEligibleForEmployeeCorrection)
// ============================================================================

func baseEligibleSale(t *testing.T) (models.Sale, time.Time) {
	t.Helper()
	// Venta sencilla pagada 50% efectivo / 50% Nequi, del turno activo
	// que empezo hace 1 hora, hecha por el cajero "CAJERA1".
	start := time.Now().Add(-1 * time.Hour)
	return models.Sale{
		SaleID:         1,
		EmployeeDNI:    "CAJERA1",
		SaleDate:       start.Add(10 * time.Minute),
		Status:         "PAID",
		TotalAmount:    20000,
		AmountPaid:     20000,
		CashAmount:     10000,
		TransferAmount: 10000,
		TransferNequi:  10000,
	}, start
}

func TestEligibilityOK(t *testing.T) {
	t.Parallel()
	sale, shiftStart := baseEligibleSale(t)
	if err := isSaleEligibleForEmployeeCorrection(&sale, "CAJERA1", shiftStart); err != nil {
		t.Fatalf("venta base deberia ser elegible: %v", err)
	}
}

func TestEligibilityOtroCajero(t *testing.T) {
	t.Parallel()
	sale, shiftStart := baseEligibleSale(t)
	err := isSaleEligibleForEmployeeCorrection(&sale, "OTRA", shiftStart)
	if err == nil {
		t.Fatal("otro cajero deberia ser rechazado (403)")
	}
	if !strings.Contains(err.Error(), "cajero") {
		t.Errorf("mensaje = %q; se esperaba referencia a cajero", err.Error())
	}
}

func TestEligibilityVentaFueraDelTurno(t *testing.T) {
	t.Parallel()
	sale, shiftStart := baseEligibleSale(t)
	// Venta hecha ANTES de abrir el turno actual (ej. cierre anterior).
	sale.SaleDate = shiftStart.Add(-30 * time.Minute)
	err := isSaleEligibleForEmployeeCorrection(&sale, "CAJERA1", shiftStart)
	if err == nil {
		t.Fatal("venta fuera del turno deberia rechazarse")
	}
}

func TestEligibilityConDevoluciones(t *testing.T) {
	t.Parallel()
	sale, shiftStart := baseEligibleSale(t)
	sale.HasReturn = true
	if err := isSaleEligibleForEmployeeCorrection(&sale, "CAJERA1", shiftStart); err == nil {
		t.Fatal("venta con devolucion deberia rechazarse")
	}
	// Variante: ParentReturnRef != nil es la venta que SE GENERA al hacer
	// una devolucion. Tampoco se puede corregir.
	sale2, shiftStart2 := baseEligibleSale(t)
	ref := uint(99)
	sale2.ParentReturnRef = &ref
	if err := isSaleEligibleForEmployeeCorrection(&sale2, "CAJERA1", shiftStart2); err == nil {
		t.Fatal("venta hija de devolucion deberia rechazarse")
	}
}

func TestEligibilityConFiado(t *testing.T) {
	t.Parallel()
	// Status CREDIT es el caso tipico.
	sale, shiftStart := baseEligibleSale(t)
	sale.Status = "CREDIT"
	sale.CreditAmount = 5000
	sale.DebtPending = 5000
	if err := isSaleEligibleForEmployeeCorrection(&sale, "CAJERA1", shiftStart); err == nil {
		t.Fatal("venta con fiado deberia rechazarse")
	}
	// Variante: PAID pero con DebtPending > 0 (abono pendiente).
	sale2, shiftStart2 := baseEligibleSale(t)
	sale2.DebtPending = 10
	if err := isSaleEligibleForEmployeeCorrection(&sale2, "CAJERA1", shiftStart2); err == nil {
		t.Fatal("venta con DebtPending deberia rechazarse")
	}
	// Variante: CreditAmount > 0 (combinada).
	sale3, shiftStart3 := baseEligibleSale(t)
	sale3.CreditAmount = 5
	if err := isSaleEligibleForEmployeeCorrection(&sale3, "CAJERA1", shiftStart3); err == nil {
		t.Fatal("venta con CreditAmount deberia rechazarse")
	}
}

func TestEligibilityConDesbalanceHistorico(t *testing.T) {
	t.Parallel()
	sale, shiftStart := baseEligibleSale(t)
	// AmountPaid muy distinto al Total: venta corrompida historicamente.
	sale.AmountPaid = 15000 // total es 20000
	if err := isSaleEligibleForEmployeeCorrection(&sale, "CAJERA1", shiftStart); err == nil {
		t.Fatal("venta con desbalance historico deberia pasar a admin")
	}
}

// ============================================================================
// DESCRIPCION DE SNAPSHOT PARA LOGS/TELEGRAM
// ============================================================================

func TestDescribePaymentSnapshotCubreCanales(t *testing.T) {
	t.Parallel()
	s := SaleChannelSnapshot{
		CashAmount:        5000,
		TransferAmount:    10000,
		TransferNequi:     7000,
		TransferDaviplata: 3000,
	}
	out := describePaymentSnapshot(s)
	for _, want := range []string{"EFECTIVO $5000", "NEQUI $7000", "DAVIPLATA $3000"} {
		if !strings.Contains(out, want) {
			t.Errorf("descripcion = %q; falta %q", out, want)
		}
	}
}

func TestDescribePaymentSnapshotSinCanales(t *testing.T) {
	t.Parallel()
	if got := describePaymentSnapshot(SaleChannelSnapshot{}); got != "(sin pagos)" {
		t.Fatalf("descripcion = %q; want \"(sin pagos)\"", got)
	}
}
