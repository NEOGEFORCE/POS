package services

import (
	"context"
	"errors"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// Caso real: cobro en espera de $30.800 (intención #96) con 2 productos.
func intentEnEspera() *models.QrPaymentIntent {
	return &models.QrPaymentIntent{
		ID: 96, VentaTempID: "4b1f-espera-30800", AmountCOP: 30600,
		CartSnapshot: `[{"barcode":"PAPA","quantity":1.67,"unitPrice":3600,"subtotal":6000},
			{"barcode":"7501033959967","quantity":1,"unitPrice":11300,"subtotal":11300}]`,
		ClientSnapshot: `{"dni":"CL-7","name":"Doña Rosa"}`,
		TotalsSnapshot: `{"totalAmount":30800,"cashAmount":200,"transferAmount":30600,"editSaleId":33400}`,
	}
}

func TestDecodeEditPending_DevuelveProductosClienteYPagoPrevio(t *testing.T) {
	out, err := decodeEditPending(intentEnEspera())
	if err != nil {
		t.Fatalf("decodeEditPending: %v", err)
	}
	if len(out.Items) != 2 || out.Items[0].Barcode != "PAPA" || out.Items[0].Quantity != 1.67 {
		t.Errorf("items = %+v", out.Items)
	}
	if out.ClientDNI != "CL-7" || out.ClientName != "Doña Rosa" {
		t.Errorf("cliente = %q / %q", out.ClientDNI, out.ClientName)
	}
	if out.EditSaleID != 33400 || out.CashAmount != 200 || out.AmountCOP != 30600 {
		t.Errorf("edit/pago previo = %+v", out)
	}
}

func TestDecodeEditPending_ConsumidorFinalNoSeDevuelveComoCliente(t *testing.T) {
	i := intentEnEspera()
	i.ClientSnapshot = `{"dni":"0","name":""}`
	out, err := decodeEditPending(i)
	if err != nil {
		t.Fatal(err)
	}
	if out.ClientDNI != "" {
		t.Errorf("consumidor final no debe volver como cliente: %q", out.ClientDNI)
	}
}

func TestDecodeEditPending_SinProductosOEnlaceNoSeReabre(t *testing.T) {
	sinCart := intentEnEspera()
	sinCart.CartSnapshot = ""
	if _, err := decodeEditPending(sinCart); !errors.Is(err, ErrQRNoSnapshot) {
		t.Errorf("sin carrito: %v", err)
	}
	enlace := intentEnEspera()
	enlace.TotalsSnapshot = `{"editSaleId":5,"linkPaymentOnly":true}`
	if _, err := decodeEditPending(enlace); !errors.Is(err, ErrQRNoSnapshot) {
		t.Errorf("un enlace de pago no es editable: %v", err)
	}
}

func TestEditPending_ValidaEntrada(t *testing.T) {
	svc := NewQrPaymentService(nil, nil, nil)
	if _, err := svc.EditPending(context.Background(), "x", "EMP-1"); !errors.Is(err, ErrQRInvalidInput) {
		t.Errorf("venta_temp_id inválido: %v", err)
	}
	if _, err := svc.EditPending(context.Background(), "temp-valido-123", ""); !errors.Is(err, ErrQRInvalidInput) {
		t.Errorf("sin DNI: %v", err)
	}
}
