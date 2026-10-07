package services

import (
	"strings"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================================
// deriveSalePaymentMethod — representacion estable del canal de pago.
//
// Hasta 2026-10 esta funcion devolvia el literal "MIXTO" cuando habia dos o
// mas canales. Rompia la consistencia con CreateSale (que ya persistia
// "EFECTIVO + NEQUI", "NEQUI + DAVIPLATA", ...). Ahora los tres consumidores
// (UpdateSalePayment, UpdateSale, CorrectPaymentChannel) persisten el mismo
// formato unido por " + " y la palabra generica "MIXTO" deja de aparecer en
// la cadena de display.
//
// Reglas documentadas aqui:
//
//   1. Orden ESTABLE: EFECTIVO -> NEQUI -> DAVIPLATA -> otras transferencias
//      -> FIADO. No depende del orden en que llegue el payload.
//   2. Nombres UNICOS: cada canal aparece una sola vez (dedupe por campo).
//   3. "MIXTO" nunca se escribe por el sistema; es solo fallback de datos
//      historicos. Si TransferSource viene como "MIXTO" en una venta antigua
//      sin desglose, se traduce a "TRANSFERENCIA" neutra.
//   4. Si no hay ningun canal con monto > 0, devuelve "EFECTIVO" por defecto
//      (compatibilidad con CreateSale: evita paymentMethod vacio).
// =============================================================================

func TestDeriveSalePaymentMethod_UnSoloCanal(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		sale models.Sale
		want string
	}{
		{"solo efectivo", models.Sale{CashAmount: 10000}, "EFECTIVO"},
		{"solo nequi", models.Sale{TransferAmount: 10000, TransferNequi: 10000, TransferSource: "NEQUI"}, "NEQUI"},
		{"solo daviplata", models.Sale{TransferAmount: 10000, TransferDaviplata: 10000, TransferSource: "DAVIPLATA"}, "DAVIPLATA"},
		{"solo fiado", models.Sale{CreditAmount: 10000}, "FIADO"},
		{"transferencia generica", models.Sale{TransferAmount: 10000, TransferSource: "BANCOLOMBIA"}, "BANCOLOMBIA"},
		{"transferencia sin source", models.Sale{TransferAmount: 10000}, "TRANSFERENCIA"},
	}
	for _, tt := range cases {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := deriveSalePaymentMethod(&tt.sale)
			if got != tt.want {
				t.Errorf("deriveSalePaymentMethod = %q; want %q", got, tt.want)
			}
		})
	}
}

func TestDeriveSalePaymentMethod_NequiDaviplata(t *testing.T) {
	t.Parallel()
	// El caso raiz del bug: venta corregida a mitad Nequi y mitad Daviplata.
	// Antes devolvia "MIXTO" (texto generico). Ahora debe devolver los dos
	// nombres unidos en orden canonico.
	sale := models.Sale{
		TotalAmount:       20000,
		AmountPaid:        20000,
		TransferAmount:    20000,
		TransferNequi:     10000,
		TransferDaviplata: 10000,
		TransferSource:    "MIXTO",
	}
	got := deriveSalePaymentMethod(&sale)
	if got != "NEQUI + DAVIPLATA" {
		t.Fatalf("deriveSalePaymentMethod = %q; want \"NEQUI + DAVIPLATA\"", got)
	}
	if strings.Contains(got, "MIXTO") {
		t.Fatalf("la salida no debe contener 'MIXTO': %q", got)
	}
}

func TestDeriveSalePaymentMethod_EfectivoNequi(t *testing.T) {
	t.Parallel()
	sale := models.Sale{
		TotalAmount:    20000,
		AmountPaid:     20000,
		CashAmount:     5000,
		TransferAmount: 15000,
		TransferNequi:  15000,
		TransferSource: "NEQUI",
	}
	got := deriveSalePaymentMethod(&sale)
	if got != "EFECTIVO + NEQUI" {
		t.Fatalf("deriveSalePaymentMethod = %q; want \"EFECTIVO + NEQUI\"", got)
	}
}

func TestDeriveSalePaymentMethod_EfectivoNequiDaviplata(t *testing.T) {
	t.Parallel()
	sale := models.Sale{
		CashAmount:        3000,
		TransferAmount:    7000,
		TransferNequi:     4000,
		TransferDaviplata: 3000,
	}
	got := deriveSalePaymentMethod(&sale)
	if got != "EFECTIVO + NEQUI + DAVIPLATA" {
		t.Fatalf("deriveSalePaymentMethod = %q; want \"EFECTIVO + NEQUI + DAVIPLATA\"", got)
	}
}

func TestDeriveSalePaymentMethod_EfectivoFiado(t *testing.T) {
	t.Parallel()
	// Combinacion que aparecia como "MIXTO" antes del fix.
	sale := models.Sale{
		CashAmount:   5000,
		CreditAmount: 5000,
	}
	got := deriveSalePaymentMethod(&sale)
	if got != "EFECTIVO + FIADO" {
		t.Fatalf("deriveSalePaymentMethod = %q; want \"EFECTIVO + FIADO\"", got)
	}
}

func TestDeriveSalePaymentMethod_OrdenEstable(t *testing.T) {
	t.Parallel()
	// Verifica que el orden es siempre canonico independiente del input:
	// EFECTIVO -> NEQUI -> DAVIPLATA -> transferencia generica -> FIADO.
	sale := models.Sale{
		CashAmount:        1000,
		TransferAmount:    4000,
		TransferNequi:     2000,
		TransferDaviplata: 2000,
		CreditAmount:      500,
	}
	// En este caso TransferAmount == Nequi+Daviplata, asi que no hay
	// "otra" transferencia. Resultado esperado: EFECTIVO + NEQUI +
	// DAVIPLATA + FIADO.
	got := deriveSalePaymentMethod(&sale)
	want := "EFECTIVO + NEQUI + DAVIPLATA + FIADO"
	if got != want {
		t.Fatalf("deriveSalePaymentMethod = %q; want %q", got, want)
	}
}

func TestDeriveSalePaymentMethod_SinCanalesCaeAEfectivo(t *testing.T) {
	t.Parallel()
	// Compatibilidad: una venta nueva sin pagos declarados (edge case de
	// edicion que luego se completa) retorna "EFECTIVO" por defecto.
	got := deriveSalePaymentMethod(&models.Sale{})
	if got != "EFECTIVO" {
		t.Fatalf("deriveSalePaymentMethod(vacio) = %q; want \"EFECTIVO\"", got)
	}
}

func TestDeriveSalePaymentMethod_NoEscribeMixtoLegacy(t *testing.T) {
	t.Parallel()
	// Si TransferSource viene como "MIXTO" (ventas antiguas) pero no hay
	// desglose Nequi/Daviplata, la etiqueta generica se traduce a
	// "TRANSFERENCIA" para no reintroducir la palabra 'MIXTO' en la cadena
	// que persiste el sistema. "MIXTO" solo sobrevive si ya estaba en la
	// base.
	sale := models.Sale{
		CashAmount:     1000,
		TransferAmount: 1000,
		TransferSource: "MIXTO",
	}
	got := deriveSalePaymentMethod(&sale)
	if strings.Contains(got, "MIXTO") {
		t.Fatalf("salida contiene 'MIXTO' pese a que la funcion no debe reescribirlo: %q", got)
	}
	if got != "EFECTIVO + TRANSFERENCIA" {
		t.Fatalf("deriveSalePaymentMethod = %q; want \"EFECTIVO + TRANSFERENCIA\"", got)
	}
}
