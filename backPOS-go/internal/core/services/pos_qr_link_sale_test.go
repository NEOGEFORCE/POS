package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// Venta #33376 del caso real: $16.000 en efectivo, consumidor final "0".
func sale33376() *models.Sale {
	return &models.Sale{
		SaleID: 33376, ClientDNI: "0", TotalAmount: 16000, CashAmount: 16000, AmountPaid: 16000, Status: "PAID",
		SaleDetails: []models.SaleDetail{
			{Barcode: "7702027435362", Quantity: 2, UnitPrice: 2500, Subtotal: 5000},
			{Barcode: "0000", Quantity: 1, UnitPrice: 400, Subtotal: 400},
			{Barcode: "PLATANO", Quantity: 0.35, UnitPrice: 4200, Subtotal: 1500},
		},
	}
}

func TestBuildLinkSnapshots_PagoCompletoPasaEfectivoABold(t *testing.T) {
	cart, totals, client, err := buildLinkSnapshots(sale33376(), 16000, "ADMIN-1")
	if err != nil {
		t.Fatalf("buildLinkSnapshots: %v", err)
	}
	var tt qrSaleTotals
	if err := json.Unmarshal(totals, &tt); err != nil {
		t.Fatal(err)
	}
	if tt.CashAmount != 0 || tt.TransferAmount != 16000 || tt.TotalAmount != 16000 {
		t.Errorf("totals = %+v, want cash 0 / transfer 16000 / total 16000", tt)
	}
	if !tt.LinkPaymentOnly || tt.EditTargetSaleID != 33376 || tt.TransferSource != "DAVIPLATA" {
		t.Errorf("flags = %+v", tt)
	}
	var items []qrSaleCartItem
	_ = json.Unmarshal(cart, &items)
	if len(items) != 3 || items[2].Subtotal != 1500 {
		t.Errorf("cart = %+v", items)
	}
	if !strings.Contains(string(client), `"dni":"0"`) {
		t.Errorf("client = %s", client)
	}
}

func TestBuildLinkSnapshots_ConservaNequiYUsaEfectivoNeto(t *testing.T) {
	s := &models.Sale{SaleID: 7, ClientDNI: "0", TotalAmount: 21000,
		CashAmount: 20000, Change: 4000, TransferAmount: 5000, TransferNequi: 5000,
		SaleDetails: []models.SaleDetail{{Barcode: "A", Quantity: 1, Subtotal: 21000}}}
	_, totals, _, err := buildLinkSnapshots(s, 10000, "ADMIN-1")
	if err != nil {
		t.Fatalf("buildLinkSnapshots: %v", err)
	}
	var tt qrSaleTotals
	_ = json.Unmarshal(totals, &tt)
	if tt.CashAmount != 6000 || tt.TransferAmount != 15000 || tt.TransferNequi != 5000 {
		t.Errorf("totals = %+v, want cash 6000 / transfer 15000 / nequi 5000", tt)
	}
}

func TestBuildLinkSnapshots_EfectivoInsuficiente(t *testing.T) {
	s := sale33376()
	s.CashAmount = 5000
	s.TransferAmount = 11000
	if _, _, _, err := buildLinkSnapshots(s, 16000, "ADMIN-1"); !errors.Is(err, ErrQRLinkInsufficientCash) {
		t.Fatalf("se esperaba ErrQRLinkInsufficientCash, got %v", err)
	}
}

func TestLinkYCandidatas_SoloAdmin(t *testing.T) {
	svc := NewQrPaymentService(nil, nil, nil)
	if _, err := svc.ListSaleCandidatesForEvent(context.Background(), 38, false); !errors.Is(err, ErrQRLinkForbidden) {
		t.Errorf("candidatas sin admin: %v", err)
	}
	if _, err := svc.LinkEventToSale(context.Background(), LinkEventToSaleInput{EventID: 38, SaleID: 33376, ActorDNI: "EMP-1"}); !errors.Is(err, ErrQRLinkForbidden) {
		t.Errorf("enlace sin admin: %v", err)
	}
}

// El materializador con linkPaymentOnly cambia SOLO el pago: no hay ajustes
// de stock ni borrado/creación de detalles, y la venta queda Bold.
func TestDispatchAutoSale_LinkPaymentOnly_NoTocaProductos(t *testing.T) {
	sale := sale33376()
	cart, totals, _, err := buildLinkSnapshots(sale, 16000, "ADMIN-1")
	if err != nil {
		t.Fatal(err)
	}
	h := newEditHarness(t, &editScenario{sale: sale, actorRole: "admin", intentCreator: "ADMIN-1",
		intentCart: string(cart), intentTotals: string(totals)})
	h.qr.DispatchAutoSale(context.Background(), &models.QrPaymentIntent{ID: 77, VentaTempID: "temp-edit-500"})

	if len(h.products.adjustments) != 0 {
		t.Fatalf("no debe ajustar stock: %+v", h.products.adjustments)
	}
	for _, st := range h.f.stmts {
		if strings.Contains(st.SQL, `"sale_details"`) && !strings.HasPrefix(strings.TrimSpace(st.SQL), "SELECT") {
			t.Fatalf("no debe tocar detalles: %s", st.SQL)
		}
	}
	ups := h.salesUpdates()
	if len(ups) != 1 {
		t.Fatalf("UPDATE sales = %d, want 1", len(ups))
	}
	u := ups[0]
	if asFloat(t, u["cashAmount"]) != 0 || asFloat(t, u["transferDaviplata"]) != 16000 || u["transferSource"] != "DAVIPLATA" {
		t.Errorf("pago = %+v", u)
	}
	if u["paymentMethod"] != "DAVIPLATA" {
		t.Errorf("paymentMethod = %v", u["paymentMethod"])
	}
}
