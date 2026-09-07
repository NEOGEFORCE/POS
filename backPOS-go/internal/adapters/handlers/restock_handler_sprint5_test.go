package handlers

import (
	"strings"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

func TestNeedsInTransitConfirmationAllowsExplicitOverride(t *testing.T) {
	t.Parallel()

	products := []models.InTransitProduct{{
		ProductID:   "770123",
		ProductName: "Producto pedido",
		Quantity:    12,
	}}
	if !needsInTransitConfirmation(products, false) {
		t.Fatal("se esperaba advertencia cuando existe tránsito y no hay override")
	}
	if needsInTransitConfirmation(products, true) {
		t.Fatal("el override explícito no debe quedar bloqueado")
	}
	if needsInTransitConfirmation(nil, false) {
		t.Fatal("no debe advertir cuando no hay productos en tránsito")
	}
}

// ============================================================================
// PEDIDO SIN PRODUCTOS DESGLOSADOS PERO CON VALOR
// ============================================================================
//
// Regla del dueño (agosto 2026): si no selecciona ningún producto pero le pone
// un valor al pedido, debe poder enviarlo igual. El caso real es el preventista
// que pasa, acuerdan un monto, y el dueño no quiere listar producto por
// producto: necesita dejar registrado el compromiso y la fecha de llegada.

func TestValidateConfirmOrder(t *testing.T) {
	t.Parallel()

	unItem := []ConfirmOrderItemReq{{
		ProductID: "770123", Barcode: "770123", Quantity: 2, UnitCost: 1500,
	}}

	tests := []struct {
		name    string
		req     ConfirmOrderReq
		wantErr string
	}{
		{
			name:    "sin proveedor no se acepta",
			req:     ConfirmOrderReq{SupplierID: 0, Items: unItem},
			wantErr: "El proveedor es obligatorio",
		},
		{
			name:    "sin productos y sin valor no registra nada",
			req:     ConfirmOrderReq{SupplierID: 7},
			wantErr: "Agrega al menos un producto o escribe el valor del pedido",
		},
		{
			// EL PEDIDO DEL DUEÑO.
			name: "sin productos pero con valor en real_invoice_total",
			req:  ConfirmOrderReq{SupplierID: 7, RealInvoiceTotal: 500000},
		},
		{
			name: "sin productos pero con valor en estimated_total",
			req:  ConfirmOrderReq{SupplierID: 7, EstimatedTotal: 500000},
		},
		{
			name: "con productos y sin valor sigue siendo valido",
			req:  ConfirmOrderReq{SupplierID: 7, Items: unItem},
		},
		{
			name: "con productos y con valor",
			req:  ConfirmOrderReq{SupplierID: 7, Items: unItem, RealInvoiceTotal: 3000},
		},
		{
			name:    "un valor en cero no habilita el pedido vacio",
			req:     ConfirmOrderReq{SupplierID: 7, RealInvoiceTotal: 0, EstimatedTotal: 0},
			wantErr: "Agrega al menos un producto o escribe el valor del pedido",
		},
		{
			name:    "un valor negativo no habilita el pedido vacio",
			req:     ConfirmOrderReq{SupplierID: 7, RealInvoiceTotal: -100},
			wantErr: "Agrega al menos un producto o escribe el valor del pedido",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := validateConfirmOrder(tt.req); got != tt.wantErr {
				t.Fatalf("validateConfirmOrder = %q; want %q", got, tt.wantErr)
			}
		})
	}
}

func TestDeclaredOrderValuePrefiereElTotalReal(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		req  ConfirmOrderReq
		want float64
	}{
		{name: "sin nada", req: ConfirmOrderReq{}, want: 0},
		{name: "solo real", req: ConfirmOrderReq{RealInvoiceTotal: 1200}, want: 1200},
		{name: "solo estimado", req: ConfirmOrderReq{EstimatedTotal: 900}, want: 900},
		{
			name: "el real manda sobre el estimado",
			req:  ConfirmOrderReq{RealInvoiceTotal: 1200, EstimatedTotal: 900},
			want: 1200,
		},
		{
			name: "un real invalido cae al estimado",
			req:  ConfirmOrderReq{RealInvoiceTotal: -5, EstimatedTotal: 900},
			want: 900,
		},
		{name: "negativos dan cero", req: ConfirmOrderReq{RealInvoiceTotal: -5, EstimatedTotal: -9}, want: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := declaredOrderValue(tt.req); got != tt.want {
				t.Fatalf("declaredOrderValue = %v; want %v", got, tt.want)
			}
		})
	}
}

// ============================================================================
// LA ALERTA DE DIFERENCIA DE PRECIOS IDENTIFICA AL PROVEEDOR POR NOMBRE
// ============================================================================
//
// Reclamo del dueño (2026-09-04): la alerta decía "PEDIDO PROVEEDOR 9" y él no
// tiene por qué saber qué proveedor es el 9. Los mensajes que lee una persona
// llevan el nombre; el ID interno se queda en los logs.

func TestSupplierAlertLabelPrefiereElNombre(t *testing.T) {
	t.Parallel()

	if got := supplierAlertLabel(9, "DISTRIBUIDORA HERMARLY"); got != "DISTRIBUIDORA HERMARLY" {
		t.Fatalf("label = %q; want el nombre del proveedor", got)
	}
}

func TestSupplierAlertLabelRecortaEspacios(t *testing.T) {
	t.Parallel()

	if got := supplierAlertLabel(9, "  RINVAL  "); got != "RINVAL" {
		t.Fatalf("label = %q; want \"RINVAL\" sin espacios sobrantes", got)
	}
}

func TestSupplierAlertLabelCaeAlIDCuandoNoHayNombre(t *testing.T) {
	t.Parallel()

	// Proveedor borrado o consulta fallida: la alerta NO puede quedar sin
	// identificar, así que se muestra el ID.
	for _, name := range []string{"", "   ", "\t\n"} {
		got := supplierAlertLabel(9, name)
		if got != "PROVEEDOR #9" {
			t.Fatalf("label con nombre %q = %q; want \"PROVEEDOR #9\"", name, got)
		}
	}
}

func TestSupplierAlertLabelNuncaImprimeElIDDesnudo(t *testing.T) {
	t.Parallel()

	// Guardián de la regresión concreta: el texto viejo era "PROVEEDOR 9"
	// (sin #) porque venía de un %d directo. Con nombre resuelto el ID no
	// debe aparecer en absoluto.
	got := supplierAlertLabel(9, "SOFT & FRESH")
	if strings.Contains(got, "9") {
		t.Fatalf("label = %q; el ID no debe filtrarse cuando hay nombre", got)
	}
}
