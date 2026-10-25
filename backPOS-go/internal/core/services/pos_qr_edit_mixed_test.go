// Pruebas del sprint "QR en edición + pago mixto" (A1, A2, B).
//
// Ejercen el camino real SaleService.UpdateSale / UpdateSaleFromQR y
// QrPaymentService.DispatchAutoSale contra el driver SQL falso del paquete
// (svcFakeSQL, ver pos_qr_assign_test.go). No hay BD: se verifican los
// statements que GORM emite (UPDATE "sales" con el desglose REEMPLAZADO,
// ajustes de stock por diferencia) y que un segundo webhook no vuelva a
// aplicar la edición.

package services

import (
	"context"
	"database/sql/driver"
	"math"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/sse"

	"gorm.io/gorm"
)

// -----------------------------------------------------------------------------
// Fakes de repositorios (sólo los métodos que UpdateSale usa)
// -----------------------------------------------------------------------------

type editFakeSaleRepo struct {
	ports.SaleRepository
	db   *gorm.DB
	sale *models.Sale
}

func (r *editFakeSaleRepo) GetDB() interface{} { return r.db }
func (r *editFakeSaleRepo) AfterCommit()       {}
func (r *editFakeSaleRepo) GetByID(uint) (*models.Sale, error) {
	cp := *r.sale
	cp.SaleDetails = append([]models.SaleDetail(nil), r.sale.SaleDetails...)
	return &cp, nil
}

type editFakeProductRepo struct {
	ports.ProductRepository
	products    map[string]*models.Product
	adjustments []map[string]float64
}

func (r *editFakeProductRepo) GetByBarcode(barcode string) (*models.Product, error) {
	if p, ok := r.products[barcode]; ok {
		return p, nil
	}
	return nil, gorm.ErrRecordNotFound
}

func (r *editFakeProductRepo) BatchAdjustQuantitiesWithTx(_ interface{}, adj map[string]float64) error {
	cp := make(map[string]float64, len(adj))
	for k, v := range adj {
		cp[k] = v
	}
	r.adjustments = append(r.adjustments, cp)
	return nil
}

type editFakeMovementRepo struct {
	ports.StockMovementRepository
	saved int
}

func (r *editFakeMovementRepo) BatchSaveWithTx(_ interface{}, m []models.StockMovement) error {
	r.saved += len(m)
	return nil
}

// -----------------------------------------------------------------------------
// Escenario SQL
// -----------------------------------------------------------------------------

// editScenario describe la BD simulada: una venta existente, el rol del
// actor y (opcional) una intención QR aprobada con snapshot de edición.
type editScenario struct {
	sale          *models.Sale // nil = la venta no existe
	saleDeleted   bool
	actorRole     string
	intentTotals  string
	intentCart    string
	intentCreator string
}

func (sc *editScenario) responder(f *svcFakeSQL) func(q string, _ []interface{}) svcFakeResult {
	return func(q string, _ []interface{}) svcFakeResult {
		up := strings.ToUpper(q)
		if !strings.HasPrefix(strings.TrimSpace(up), "SELECT") {
			return svcFakeResult{}
		}
		switch {
		case strings.Contains(up, `FROM "POS_QR_PAYMENT_INTENTS"`):
			return sc.intentRow(f)
		case strings.Contains(up, `FROM "EMPLOYEES"`):
			return svcFakeResult{Columns: []string{"role"}, Rows: [][]driver.Value{{sc.actorRole}}}
		case strings.Contains(up, `FROM "SALE_DETAILS"`):
			if sc.sale == nil {
				return svcFakeResult{}
			}
			rows := make([][]driver.Value, 0, len(sc.sale.SaleDetails))
			for i, d := range sc.sale.SaleDetails {
				rows = append(rows, []driver.Value{int64(i + 1), int64(sc.sale.SaleID), d.Barcode, d.Quantity, d.UnitPrice, d.CostPrice, d.Subtotal, nil})
			}
			return svcFakeResult{
				Columns: []string{"id", "saleId", "barcode", "quantity", "price", "costPrice", "subtotal", "deleted_at"},
				Rows:    rows,
			}
		case strings.Contains(up, `FROM "PRODUCTS"`):
			return svcFakeResult{}
		case strings.Contains(up, `FROM "SALES"`):
			if sc.sale == nil {
				return svcFakeResult{}
			}
			s := sc.sale
			var deleted driver.Value
			if sc.saleDeleted {
				deleted = time.Date(2026, 10, 24, 9, 0, 0, 0, time.UTC)
			}
			return svcFakeResult{
				Columns: []string{"saleId", "employeeDni", "clientDni", "totalAmount", "cashAmount",
					"transferAmount", "transferNequi", "transferDaviplata", "transferSource",
					"creditAmount", "debtPending", "status", "deleted_at"},
				Rows: [][]driver.Value{{int64(s.SaleID), s.EmployeeDNI, s.ClientDNI, s.TotalAmount, s.CashAmount,
					s.TransferAmount, s.TransferNequi, s.TransferDaviplata, s.TransferSource,
					s.CreditAmount, s.DebtPending, s.Status, deleted}},
			}
		}
		return svcFakeResult{}
	}
}

// intentRow devuelve la intención con el estado de finalización
// derivado de los statements ya ejecutados (máquina de estados real del
// repo: NOT_STARTED → IN_PROGRESS → SUCCEEDED).
func (sc *editScenario) intentRow(f *svcFakeSQL) svcFakeResult {
	status := models.QRFinalizationStatusNotStarted
	attempts := int64(0)
	for _, st := range f.stmts {
		up := strings.ToUpper(st.SQL)
		if !strings.HasPrefix(strings.TrimSpace(up), `UPDATE "POS_QR_PAYMENT_INTENTS"`) {
			continue
		}
		switch {
		case strings.Contains(up, `"RELATED_SALE_ID"`):
			status = models.QRFinalizationStatusSucceeded
		case strings.Contains(up, `"FINALIZATION_STARTED_AT"`):
			status = models.QRFinalizationStatusInProgress
			attempts++
		case strings.Contains(up, `"FINALIZATION_NEXT_RETRY_AT"`):
			status = models.QRFinalizationStatusFailed
		}
	}
	now := time.Date(2026, 10, 24, 15, 22, 0, 0, time.UTC)
	return svcFakeResult{
		Columns: []string{"id", "venta_temp_id", "caja_id", "created_by_dni", "amount_cop", "status",
			"created_at", "expires_at", "cart_snapshot", "totals_snapshot", "client_snapshot",
			"sale_client_tx_id", "finalization_status", "finalization_attempts", "finalization_started_at"},
		Rows: [][]driver.Value{{int64(77), "temp-edit-500", "CAJA-1", sc.intentCreator, int64(16000),
			models.QRIntentStatusApproved, now.Add(-time.Minute), now.Add(10 * time.Minute),
			sc.intentCart, sc.intentTotals, `{"dni":"0000","name":""}`,
			"qr-edit-tx-0000001", status, attempts, nil}},
	}
}

type editHarness struct {
	f        *svcFakeSQL
	sale     *SaleService
	products *editFakeProductRepo
	qr       *QrPaymentService
	hub      *sse.QRHub
}

func newEditHarness(t *testing.T, sc *editScenario) *editHarness {
	t.Helper()
	f := &svcFakeSQL{}
	f.respond = sc.responder(f)
	db := newSvcGormDB(t, f)
	products := &editFakeProductRepo{products: map[string]*models.Product{
		"ARROZ": {Barcode: "ARROZ", SalePrice: 8000, PurchasePrice: 6000},
		"PAN":   {Barcode: "PAN", SalePrice: 2000, PurchasePrice: 1200},
	}}
	saleRepo := &editFakeSaleRepo{db: db, sale: sc.sale}
	if sc.sale == nil {
		saleRepo.sale = &models.Sale{}
	}
	saleSvc := NewSaleService(saleRepo, products, nil, &editFakeMovementRepo{}, nil, nil, nil)
	hub := sse.NewQRHub()
	qr := NewQrPaymentService(repositories.NewQrPaymentRepository(db), hub, nil).
		WithSaleService(saleSvc).
		WithClock(func() time.Time { return time.Date(2026, 10, 24, 15, 22, 0, 0, time.UTC) })
	return &editHarness{f: f, sale: saleSvc, products: products, qr: qr, hub: hub}
}

var setColRe = regexp.MustCompile(`"(\w+)"=\$(\d+)`)

// salesUpdates devuelve cada UPDATE "sales" como mapa columna → valor.
func (h *editHarness) salesUpdates() []map[string]interface{} {
	var out []map[string]interface{}
	for _, st := range h.f.stmts {
		if !strings.HasPrefix(strings.TrimSpace(st.SQL), `UPDATE "sales" SET`) {
			continue
		}
		set := st.SQL[:strings.Index(st.SQL, " WHERE ")]
		row := map[string]interface{}{}
		for _, m := range setColRe.FindAllStringSubmatch(set, -1) {
			idx, _ := strconv.Atoi(m[2])
			if idx-1 < len(st.Vars) {
				row[m[1]] = st.Vars[idx-1]
			}
		}
		out = append(out, row)
	}
	return out
}

func asFloat(t *testing.T, v interface{}) float64 {
	t.Helper()
	switch n := v.(type) {
	case float64:
		return n
	case int64:
		return float64(n)
	}
	t.Fatalf("valor no numérico: %#v", v)
	return 0
}

// Venta #500 del caso real: 2 × ARROZ a $8.000 = $16.000 en efectivo.
func sale500() *models.Sale {
	return &models.Sale{
		SaleID: 500, EmployeeDNI: "CAJERA-1", ClientDNI: "0000",
		TotalAmount: 16000, CashAmount: 16000, AmountPaid: 16000, Status: "PAID",
		SaleDetails: []models.SaleDetail{{Barcode: "ARROZ", Quantity: 2, UnitPrice: 8000, CostPrice: 6000, Subtotal: 16000}},
	}
}

// -----------------------------------------------------------------------------
// A1 — PUT /sales/update/:id REEMPLAZA el desglose y ajusta stock
// -----------------------------------------------------------------------------

func TestUpdateSale_ReemplazaDesgloseYRecalculaCambio(t *testing.T) {
	h := newEditHarness(t, &editScenario{sale: sale500(), actorRole: "admin"})
	// Se quitó 1 ARROZ por error y se agregó 1 PAN: total nuevo $10.000.
	// Paga $20.000 en efectivo: el servidor recalcula cambio $10.000.
	newSale := &models.Sale{
		ClientDNI:  "0000",
		CashAmount: 20000,
		SaleDetails: []models.SaleDetail{
			{Barcode: "ARROZ", Quantity: 1},
			{Barcode: "PAN", Quantity: 1},
		},
	}
	if err := h.sale.UpdateSale(500, newSale, "ADMIN-1", true); err != nil {
		t.Fatalf("UpdateSale: %v", err)
	}
	ups := h.salesUpdates()
	if len(ups) != 1 {
		t.Fatalf("se esperaba 1 UPDATE sales, got %d", len(ups))
	}
	u := ups[0]
	if got := asFloat(t, u["totalAmount"]); got != 10000 {
		t.Errorf("totalAmount=%v, want 10000 (total NUEVO, no delta)", got)
	}
	if got := asFloat(t, u["cashAmount"]); got != 20000 {
		t.Errorf("cashAmount=%v, want 20000 (REEMPLAZA, no suma al 16000 previo)", got)
	}
	if got := asFloat(t, u["change"]); got != 10000 {
		t.Errorf("change=%v, want 10000 recalculado en servidor", got)
	}
	if got := u["paymentMethod"]; got != "EFECTIVO" {
		t.Errorf("paymentMethod=%v, want EFECTIVO", got)
	}
	// Stock: revierte 2 ARROZ y aplica 1 ARROZ + 1 PAN.
	if len(h.products.adjustments) != 2 {
		t.Fatalf("se esperaban 2 ajustes (revert+apply), got %d", len(h.products.adjustments))
	}
	if h.products.adjustments[0]["ARROZ"] != -2 {
		t.Errorf("revert ARROZ=%v, want -2", h.products.adjustments[0]["ARROZ"])
	}
	if h.products.adjustments[1]["ARROZ"] != 1 || h.products.adjustments[1]["PAN"] != 1 {
		t.Errorf("apply=%v, want ARROZ:1 PAN:1", h.products.adjustments[1])
	}
}

func TestUpdateSale_ReducirTotalYaNoSeBloquea(t *testing.T) {
	h := newEditHarness(t, &editScenario{sale: sale500(), actorRole: "admin"})
	newSale := &models.Sale{ClientDNI: "0000", CashAmount: 8000,
		SaleDetails: []models.SaleDetail{{Barcode: "ARROZ", Quantity: 1}}}
	if err := h.sale.UpdateSale(500, newSale, "ADMIN-1", true); err != nil {
		t.Fatalf("quitar un producto de una venta cobrada debe permitirse: %v", err)
	}
}

func TestUpdateSale_PagoInsuficiente(t *testing.T) {
	h := newEditHarness(t, &editScenario{sale: sale500(), actorRole: "admin"})
	newSale := &models.Sale{ClientDNI: "0000", CashAmount: 1000,
		SaleDetails: []models.SaleDetail{{Barcode: "ARROZ", Quantity: 2}}}
	err := h.sale.UpdateSale(500, newSale, "ADMIN-1", true)
	if err == nil || !strings.Contains(err.Error(), "pago insuficiente") {
		t.Fatalf("se esperaba 'pago insuficiente', got %v", err)
	}
	if len(h.salesUpdates()) != 0 {
		t.Error("no debe mutar la venta")
	}
}

func TestUpdateSale_ConAbonosDeFiado_ErrorClaro(t *testing.T) {
	s := sale500()
	s.ClientDNI = "CL-9"
	s.CashAmount = 0
	s.CreditAmount = 16000
	s.DebtPending = 6000 // ya abonó $10.000
	s.Status = "CREDIT"
	h := newEditHarness(t, &editScenario{sale: s, actorRole: "admin"})
	newSale := &models.Sale{ClientDNI: "CL-9", CreditAmount: 16000,
		SaleDetails: []models.SaleDetail{{Barcode: "ARROZ", Quantity: 2}}}
	err := h.sale.UpdateSale(500, newSale, "ADMIN-1", true)
	if err == nil || !strings.Contains(err.Error(), "abonos de fiado") {
		t.Fatalf("se esperaba error claro por abonos de fiado, got %v", err)
	}
	if len(h.salesUpdates()) != 0 {
		t.Error("no debe mutar la venta con abonos")
	}
}

func TestUpdateSale_NoAdmin_Rechaza(t *testing.T) {
	h := newEditHarness(t, &editScenario{sale: sale500(), actorRole: "empleado"})
	err := h.sale.UpdateSale(500, &models.Sale{CashAmount: 16000,
		SaleDetails: []models.SaleDetail{{Barcode: "ARROZ", Quantity: 2}}}, "CAJERA-1", false)
	if err == nil || !strings.Contains(err.Error(), "administradores") {
		t.Fatalf("se esperaba rechazo por permisos, got %v", err)
	}
}

// -----------------------------------------------------------------------------
// A2 — QR en edición: la aprobación ACTUALIZA la misma venta
// -----------------------------------------------------------------------------

const cart500 = `[{"barcode":"ARROZ","quantity":2,"unitPrice":8000,"costPrice":6000,"subtotal":16000}]`

func TestDispatchAutoSale_EditSaleID_ActualizaMismaVentaEIdempotente(t *testing.T) {
	sc := &editScenario{
		sale: sale500(), actorRole: "admin", intentCreator: "ADMIN-1",
		intentCart: cart500,
		// Venta #500 re-cobrada 100% por QR (caso del pago de $16.000).
		intentTotals: `{"totalAmount":16000,"amountPaid":16000,"cashAmount":0,"transferAmount":16000,
			"transferNequi":0,"transferDaviplata":0,"creditAmount":0,"transferSource":"BOLD_QR",
			"paymentMethod":"BOLD_QR","employeeDni":"ADMIN-1","editSaleId":500}`,
	}
	h := newEditHarness(t, sc)
	ch, cancel := h.hub.Subscribe("temp-edit-500")
	defer cancel()

	intent := &models.QrPaymentIntent{ID: 77, VentaTempID: "temp-edit-500"}
	h.qr.DispatchAutoSale(context.Background(), intent)
	// Segundo webhook / barrido: el claim ya está SUCCEEDED → no-op.
	h.qr.DispatchAutoSale(context.Background(), intent)

	ups := h.salesUpdates()
	if len(ups) != 1 {
		t.Fatalf("se esperaba exactamente 1 UPDATE sales (idempotente), got %d", len(ups))
	}
	u := ups[0]
	if asFloat(t, u["transferAmount"]) != 16000 || asFloat(t, u["cashAmount"]) != 0 {
		t.Errorf("desglose no reemplazado: %+v", u)
	}
	if u["transferSource"] != "BOLD_QR" || u["paymentMethod"] != "BOLD_QR" {
		t.Errorf("source/método: %v / %v, want BOLD_QR", u["transferSource"], u["paymentMethod"])
	}
	for _, st := range h.f.stmts {
		if strings.HasPrefix(strings.TrimSpace(st.SQL), `INSERT INTO "sales"`) {
			t.Fatal("con editSaleId NUNCA debe crearse una venta nueva")
		}
	}
	// related_sale_id = 500 y APROBADO publicado con ese saleId.
	var linked bool
	for _, st := range h.f.stmts {
		if strings.Contains(st.SQL, `"related_sale_id"`) {
			for _, v := range st.Vars {
				switch n := v.(type) {
				case int64:
					linked = linked || n == 500
				case uint64:
					linked = linked || n == 500
				}
			}
		}
	}
	if !linked {
		t.Error("related_sale_id debe quedar = 500")
	}
	select {
	case ev := <-ch:
		if ev.Status != models.QRStreamStatusApproved || ev.SaleID != 500 {
			t.Errorf("SSE = %+v, want APROBADO saleId=500", ev)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("no se publicó APROBADO")
	}
}

func TestDispatchAutoSale_EditSaleIDInexistente_MarcaFailedSinTocarVentas(t *testing.T) {
	sc := &editScenario{
		sale: nil, actorRole: "admin", intentCreator: "ADMIN-1", intentCart: cart500,
		intentTotals: `{"totalAmount":16000,"transferAmount":16000,"transferSource":"BOLD_QR","editSaleId":999}`,
	}
	h := newEditHarness(t, sc)
	h.qr.DispatchAutoSale(context.Background(), &models.QrPaymentIntent{ID: 77, VentaTempID: "temp-edit-500"})
	if len(h.salesUpdates()) != 0 {
		t.Fatal("editSaleId inexistente no debe actualizar ventas")
	}
	var failed bool
	for _, st := range h.f.stmts {
		if strings.Contains(st.SQL, `"finalization_next_retry_at"`) && strings.HasPrefix(strings.TrimSpace(st.SQL), "UPDATE") {
			for _, v := range st.Vars {
				if s, ok := v.(string); ok && strings.Contains(s, "no existe") {
					failed = true
				}
			}
		}
	}
	if !failed {
		t.Error("la intención debe quedar FAILED con 'la venta #999 a editar no existe'")
	}
}

func TestCheckQREditTarget_Reglas(t *testing.T) {
	cases := []struct {
		name    string
		sc      *editScenario
		wantErr string
	}{
		{"admin sobre venta viva", &editScenario{sale: sale500(), actorRole: "admin"}, ""},
		{"superadmin", &editScenario{sale: sale500(), actorRole: "SuperAdmin"}, ""},
		{"no existe", &editScenario{sale: nil, actorRole: "admin"}, "no existe"},
		{"anulada", &editScenario{sale: sale500(), saleDeleted: true, actorRole: "admin"}, "anulada"},
		{"cajero", &editScenario{sale: sale500(), actorRole: "empleado"}, "administradores"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newEditHarness(t, c.sc)
			_, err := h.sale.CheckQREditTarget(500, "ACTOR-1")
			if c.wantErr == "" && err != nil {
				t.Fatalf("se esperaba OK, got %v", err)
			}
			if c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)) {
				t.Fatalf("se esperaba error con %q, got %v", c.wantErr, err)
			}
		})
	}
}

func TestValidateQREditTarget_SinSaleService(t *testing.T) {
	svc := NewQrPaymentService(nil, nil, nil)
	if err := svc.ValidateQREditTarget(0, "X"); err != nil {
		t.Errorf("editSaleId=0 (venta nueva) no requiere validación: %v", err)
	}
	if err := svc.ValidateQREditTarget(5, "X"); err != ErrQREditUnavailable {
		t.Errorf("sin SaleService debe ErrQREditUnavailable, got %v", err)
	}
}

// -----------------------------------------------------------------------------
// B — Pago mixto: cada parte en su canal
// -----------------------------------------------------------------------------

// QR 6.000 + efectivo 10.000 sobre carrito 16.000.
const totalsMixto = `{"totalAmount":16000,"amountPaid":16000,"cashAmount":10000,"transferAmount":6000,
	"transferNequi":0,"transferDaviplata":0,"creditAmount":0,"transferSource":"BOLD_QR",
	"paymentMethod":"EFECTIVO + BOLD_QR","employeeDni":"ADMIN-1"}`

func TestBuildSaleFromSnapshots_MixtoQR6kEfectivo10k(t *testing.T) {
	sale, edit, err := buildSaleFromSnapshots(&models.QrPaymentIntent{
		ID: 1, AmountCOP: 6000, CartSnapshot: cart500, TotalsSnapshot: totalsMixto,
		SaleClientTxID: "qr-mixto-0000001", CreatedByDNI: "ADMIN-1",
	})
	if err != nil {
		t.Fatalf("buildSaleFromSnapshots: %v", err)
	}
	if edit != 0 {
		t.Errorf("sin editSaleId: %d", edit)
	}
	if sale.TotalAmount != 16000 || sale.CashAmount != 10000 || sale.TransferAmount != 6000 {
		t.Errorf("total/cash/transfer = %v/%v/%v, want 16000/10000/6000", sale.TotalAmount, sale.CashAmount, sale.TransferAmount)
	}
	if sale.TransferSource != "BOLD_QR" || sale.PaymentMethod != "EFECTIVO + BOLD_QR" {
		t.Errorf("source=%q método=%q", sale.TransferSource, sale.PaymentMethod)
	}
}

func TestBuildSaleFromSnapshots_ParteQRSiempreBoldAunqueClienteMandeNequi(t *testing.T) {
	sale, _, err := buildSaleFromSnapshots(&models.QrPaymentIntent{
		ID: 1, AmountCOP: 5000, CartSnapshot: `[{"barcode":"A","quantity":1,"unitPrice":8000,"subtotal":8000}]`,
		TotalsSnapshot: `{"totalAmount":8000,"transferAmount":8000,"transferNequi":3000,"transferSource":"NEQUI"}`,
		SaleClientTxID: "qr-mixto-0000002",
	})
	if err != nil {
		t.Fatalf("buildSaleFromSnapshots: %v", err)
	}
	if sale.TransferSource != "BOLD_QR" {
		t.Errorf("la parte QR ($5.000) debe viajar como BOLD_QR, got %q", sale.TransferSource)
	}
	if sale.PaymentMethod != "NEQUI + BOLD_QR" {
		t.Errorf("paymentMethod=%q, want 'NEQUI + BOLD_QR'", sale.PaymentMethod)
	}
}

// Edición con pago mixto vía QR: la venta queda con total 16.000, efectivo
// 10.000 y Bold 6.000 (caso "enviaron por QR y el resto en efectivo").
func TestDispatchAutoSale_EditMixto_GuardaCadaParteEnSuCanal(t *testing.T) {
	totals := strings.Replace(totalsMixto, `"employeeDni":"ADMIN-1"`, `"employeeDni":"ADMIN-1","editSaleId":500`, 1)
	h := newEditHarness(t, &editScenario{sale: sale500(), actorRole: "admin", intentCreator: "ADMIN-1",
		intentCart: cart500, intentTotals: totals})
	h.qr.DispatchAutoSale(context.Background(), &models.QrPaymentIntent{ID: 77, VentaTempID: "temp-edit-500"})
	ups := h.salesUpdates()
	if len(ups) != 1 {
		t.Fatalf("UPDATE sales = %d, want 1", len(ups))
	}
	u := ups[0]
	if asFloat(t, u["totalAmount"]) != 16000 || asFloat(t, u["cashAmount"]) != 10000 || asFloat(t, u["transferAmount"]) != 6000 {
		t.Errorf("desglose = %+v", u)
	}
	if u["transferSource"] != "BOLD_QR" || u["paymentMethod"] != "EFECTIVO + BOLD_QR" {
		t.Errorf("source/método = %v / %v", u["transferSource"], u["paymentMethod"])
	}
	if asFloat(t, u["change"]) != 0 {
		t.Errorf("change=%v, want 0", u["change"])
	}
}

func TestReconcileTransferBreakdown_BoldMixtoConservaParteQR(t *testing.T) {
	got := ReconcileTransferBreakdown(8000, 3000, 0, "BOLD_QR")
	if got.TransferAmount != 8000 || got.TransferNequi != 3000 || got.TransferDaviplata != 0 {
		t.Fatalf("QR 5k + Nequi 3k no debe colapsar a Nequi: %+v", got)
	}
	// Sin BOLD, la normalización legacy sigue igual (residual al canal).
	legacy := ReconcileTransferBreakdown(8000, 3000, 0, "NEQUI")
	if legacy.TransferNequi != 8000 {
		t.Fatalf("comportamiento legacy alterado: %+v", legacy)
	}
}

func TestDeriveSalePaymentMethod_NequiMasBoldQR(t *testing.T) {
	got := deriveSalePaymentMethod(&models.Sale{CashAmount: 10000, TransferAmount: 8000, TransferNequi: 3000, TransferSource: "BOLD_QR"})
	if got != "EFECTIVO + NEQUI + BOLD_QR" {
		t.Fatalf("got %q", got)
	}
}

// Cierre: efectivo y Bold por separado, Nequi de una venta mixta Bold
// en su bolsillo, sin doble conteo.
func TestClassifySaleTransferToClosure_MixtoBoldSeparaCanales(t *testing.T) {
	var c CashierClosure
	classifySaleTransferToClosure(models.Sale{TransferAmount: 8000, TransferNequi: 3000, TransferSource: "BOLD_QR"}, &c)
	classifySaleTransferToClosure(models.Sale{TransferAmount: 6000, TransferSource: "BOLD_QR"}, &c)
	classifySaleTransferToClosure(models.Sale{TransferAmount: 4000, TransferNequi: 4000, TransferSource: "NEQUI"}, &c)
	if c.TotalNequi != 7000 {
		t.Errorf("TotalNequi=%v, want 7000", c.TotalNequi)
	}
	if c.TotalBoldQr != 11000 || c.TotalOtherTransfer != 11000 {
		t.Errorf("Bold=%v Other=%v, want 11000/11000", c.TotalBoldQr, c.TotalOtherTransfer)
	}
	if total := c.TotalNequi + c.TotalDaviplata + c.TotalOtherTransfer; math.Abs(total-18000) > 0.01 {
		t.Errorf("suma digital=%v, want 18000 (una sola vez)", total)
	}
}
