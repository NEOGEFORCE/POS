package services

import (
	"errors"
	"testing"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

func TestSprint2DeriveSalePaymentMethod(t *testing.T) {
	tests := []struct {
		name string
		sale models.Sale
		want string
	}{
		{name: "efectivo", sale: models.Sale{CashAmount: 100}, want: "EFECTIVO"},
		{name: "nequi", sale: models.Sale{TransferAmount: 100, TransferNequi: 100}, want: "NEQUI"},
		{name: "daviplata", sale: models.Sale{TransferAmount: 100, TransferDaviplata: 100}, want: "DAVIPLATA"},
		{name: "fuente transferencia", sale: models.Sale{TransferAmount: 100, TransferSource: "bancolombia"}, want: "BANCOLOMBIA"},
		{name: "fiado", sale: models.Sale{CreditAmount: 100}, want: "FIADO"},
		{name: "mixto", sale: models.Sale{CashAmount: 40, TransferAmount: 60, TransferNequi: 60}, want: "MIXTO"},
		{name: "sin desglose conserva fallback", sale: models.Sale{}, want: "EFECTIVO"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := deriveSalePaymentMethod(&test.sale); got != test.want {
				t.Fatalf("deriveSalePaymentMethod() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestSprint2ValidateItemsAgainstSaleAcumulaLineasDuplicadas(t *testing.T) {
	sale := &models.Sale{
		SaleID: 9,
		SaleDetails: []models.SaleDetail{{
			Barcode: "A", Quantity: 2, ReturnedQty: 0.5,
		}},
	}

	err := validateItemsAgainstSale(sale, []ports.ReturnItemReq{
		{Barcode: "A", Qty: 1},
		{Barcode: "A", Qty: 1},
	})
	if err == nil {
		t.Fatal("se esperaba error porque 2 unidades solicitadas exceden 1.5 disponibles")
	}
}

func TestSprint2ValidateItemsAgainstSaleRespetaDisponible(t *testing.T) {
	sale := &models.Sale{
		SaleID: 10,
		SaleDetails: []models.SaleDetail{{
			Barcode: "A", Quantity: 2, ReturnedQty: 0.5,
		}},
	}
	if err := validateItemsAgainstSale(sale, []ports.ReturnItemReq{
		{Barcode: "A", Qty: 1},
		{Barcode: "A", Qty: 0.5},
	}); err != nil {
		t.Fatalf("devolución dentro del disponible fue rechazada: %v", err)
	}
}

func TestSprint2UniqueViolationDetection(t *testing.T) {
	if !isUniqueViolation(errors.New(`ERROR: duplicate key value violates unique constraint "idx_sales_client_tx_id_unique" (SQLSTATE 23505)`)) {
		t.Fatal("no se reconoció una violación única PostgreSQL")
	}
	if isUniqueViolation(errors.New("connection refused")) {
		t.Fatal("un error de red no debe tratarse como duplicado idempotente")
	}
}

func TestSprint2RefundPolicy(t *testing.T) {
	if err := validateRefundAllowed(&models.Sale{PaymentMethod: "EFECTIVO"}); err != nil {
		t.Fatalf("refund en efectivo fue rechazado: %v", err)
	}
	if err := validateRefundAllowed(&models.Sale{PaymentMethod: "NEQUI"}); err == nil {
		t.Fatal("refund por transferencia debió ser rechazado")
	}
	if err := validateRefundAllowed(nil); err == nil {
		t.Fatal("refund sin factura debió ser rechazado")
	}
}
