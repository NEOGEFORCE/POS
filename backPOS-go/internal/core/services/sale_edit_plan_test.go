package services

import (
	"math"
	"strings"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// BuildSaleEditPlan — cálculo puro del plan de edición
// ============================================================================

func TestBuildSaleEditPlan_AgregaProductoNuevoConPrecioActual(t *testing.T) {
	existing := []models.SaleDetail{
		{Barcode: "A", Quantity: 2, UnitPrice: 1000, CostPrice: 500, Subtotal: 2000},
	}
	items := []SaleEditItemInput{{Barcode: "B", Quantity: 3}}
	lookup := map[string]*models.Product{
		"B": {Barcode: "B", SalePrice: 500, PurchasePrice: 300},
	}
	plan, err := BuildSaleEditPlan(existing, items, lookup)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if len(plan.Lines) != 1 {
		t.Fatalf("lines = %d; want 1", len(plan.Lines))
	}
	line := plan.Lines[0]
	if !line.CreateDetail || line.IsExisting {
		t.Errorf("línea nueva mal marcada: %+v", line)
	}
	if line.UnitPrice != 500 {
		t.Errorf("UnitPrice = %v; want 500 (precio actual)", line.UnitPrice)
	}
	if line.FinalQuantity != 3 {
		t.Errorf("FinalQuantity = %v; want 3", line.FinalQuantity)
	}
	if plan.MonetaryDelta != 1500 {
		t.Errorf("MonetaryDelta = %v; want 1500", plan.MonetaryDelta)
	}
	if plan.StockDelta["B"] != 3 {
		t.Errorf("StockDelta[B] = %v; want 3", plan.StockDelta["B"])
	}
}

func TestBuildSaleEditPlan_AumentaLineaExistenteUsaPrecioHistorico(t *testing.T) {
	// Precio del catálogo cambió de 1000 a 1500, pero la línea existente
	// mantiene $1000. Un aumento no debe repricear.
	existing := []models.SaleDetail{
		{Barcode: "A", Quantity: 2, UnitPrice: 1000, CostPrice: 500, Subtotal: 2000},
	}
	items := []SaleEditItemInput{{Barcode: "A", Quantity: 1}}
	lookup := map[string]*models.Product{
		"A": {Barcode: "A", SalePrice: 1500, PurchasePrice: 800},
	}
	plan, err := BuildSaleEditPlan(existing, items, lookup)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	line := plan.Lines[0]
	if !line.IsExisting {
		t.Fatalf("debe marcarse como existente: %+v", line)
	}
	if line.UnitPrice != 1000 {
		t.Errorf("UnitPrice = %v; want 1000 (histórico, no repricea)", line.UnitPrice)
	}
	if line.FinalQuantity != 3 {
		t.Errorf("FinalQuantity = %v; want 3", line.FinalQuantity)
	}
	if line.NewSubtotal != 3000 {
		t.Errorf("NewSubtotal = %v; want 3000 (con precio histórico)", line.NewSubtotal)
	}
	if plan.MonetaryDelta != 1000 {
		t.Errorf("MonetaryDelta = %v; want 1000", plan.MonetaryDelta)
	}
}

func TestBuildSaleEditPlan_ReduceLineaExistente(t *testing.T) {
	existing := []models.SaleDetail{
		{Barcode: "A", Quantity: 5, UnitPrice: 1000, CostPrice: 500, Subtotal: 5000},
	}
	items := []SaleEditItemInput{{Barcode: "A", Quantity: -2}}
	plan, err := BuildSaleEditPlan(existing, items, nil)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	line := plan.Lines[0]
	if line.FinalQuantity != 3 {
		t.Errorf("FinalQuantity = %v; want 3", line.FinalQuantity)
	}
	if line.NewSubtotal != 3000 {
		t.Errorf("NewSubtotal = %v; want 3000", line.NewSubtotal)
	}
	if plan.MonetaryDelta != -2000 {
		t.Errorf("MonetaryDelta = %v; want -2000", plan.MonetaryDelta)
	}
	if plan.StockDelta["A"] != -2 {
		t.Errorf("StockDelta[A] = %v; want -2 (repone stock)", plan.StockDelta["A"])
	}
}

func TestBuildSaleEditPlan_LlevarLineaACeroLaElimina(t *testing.T) {
	existing := []models.SaleDetail{
		{Barcode: "A", Quantity: 2, UnitPrice: 1000, CostPrice: 500, Subtotal: 2000},
	}
	items := []SaleEditItemInput{{Barcode: "A", Quantity: -2}}
	plan, err := BuildSaleEditPlan(existing, items, nil)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	line := plan.Lines[0]
	if line.FinalQuantity != 0 {
		t.Errorf("FinalQuantity = %v; want 0", line.FinalQuantity)
	}
	if !line.DeleteDetail {
		t.Errorf("línea debe marcarse para eliminación: %+v", line)
	}
	if plan.MonetaryDelta != -2000 {
		t.Errorf("MonetaryDelta = %v; want -2000", plan.MonetaryDelta)
	}
	if plan.StockDelta["A"] != -2 {
		t.Errorf("StockDelta[A] = %v; want -2", plan.StockDelta["A"])
	}
}

func TestBuildSaleEditPlan_CantidadFinalNegativaEsError(t *testing.T) {
	existing := []models.SaleDetail{
		{Barcode: "A", Quantity: 2, UnitPrice: 1000, Subtotal: 2000},
	}
	items := []SaleEditItemInput{{Barcode: "A", Quantity: -5}}
	_, err := BuildSaleEditPlan(existing, items, nil)
	if err == nil {
		t.Fatal("se esperaba error por cantidad final negativa")
	}
	if !strings.Contains(err.Error(), "cantidad final negativa") {
		t.Errorf("error inesperado: %v", err)
	}
}

func TestBuildSaleEditPlan_QuantityCeroEsError(t *testing.T) {
	items := []SaleEditItemInput{{Barcode: "A", Quantity: 0}}
	_, err := BuildSaleEditPlan(nil, items, nil)
	if err == nil {
		t.Fatal("se esperaba error por quantity == 0")
	}
}

func TestBuildSaleEditPlan_AgrupaItemsDuplicados(t *testing.T) {
	// Dos items del mismo barcode deben sumarse en un único delta.
	existing := []models.SaleDetail{
		{Barcode: "A", Quantity: 5, UnitPrice: 1000, Subtotal: 5000},
	}
	items := []SaleEditItemInput{
		{Barcode: "A", Quantity: 2},
		{Barcode: "A", Quantity: -1},
	}
	plan, err := BuildSaleEditPlan(existing, items, nil)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if len(plan.Lines) != 1 {
		t.Fatalf("lines = %d; want 1 (deben agruparse)", len(plan.Lines))
	}
	if plan.Lines[0].Delta != 1 {
		t.Errorf("delta agrupado = %v; want 1", plan.Lines[0].Delta)
	}
	if plan.Lines[0].FinalQuantity != 6 {
		t.Errorf("FinalQuantity = %v; want 6", plan.Lines[0].FinalQuantity)
	}
}

func TestBuildSaleEditPlan_PackExpandeADeltaBase(t *testing.T) {
	basePtr := "BASE-1"
	pack := &models.Product{
		Barcode:            "PACK-1",
		SalePrice:          5000,
		PurchasePrice:      3000,
		IsPack:             true,
		BaseProductBarcode: &basePtr,
		PackMultiplier:     12,
	}
	lookup := map[string]*models.Product{"PACK-1": pack}
	items := []SaleEditItemInput{{Barcode: "PACK-1", Quantity: 2}}

	plan, err := BuildSaleEditPlan(nil, items, lookup)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	line := plan.Lines[0]
	if line.StockBarcode != "BASE-1" {
		t.Errorf("StockBarcode = %v; want BASE-1", line.StockBarcode)
	}
	if line.EffectiveStockDelta != 24 {
		t.Errorf("EffectiveStockDelta = %v; want 24 (2 packs × 12)", line.EffectiveStockDelta)
	}
	if plan.StockDelta["BASE-1"] != 24 {
		t.Errorf("StockDelta[BASE-1] = %v; want 24", plan.StockDelta["BASE-1"])
	}
}

func TestBuildSaleEditPlan_MISCNoTocaStock(t *testing.T) {
	items := []SaleEditItemInput{
		{Barcode: "MISC-tornillo", Quantity: 3, MISCUnitPrice: 100},
		{Barcode: "0000", Quantity: 1, MISCUnitPrice: 500},
	}
	plan, err := BuildSaleEditPlan(nil, items, nil)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if len(plan.StockDelta) != 0 {
		t.Errorf("MISC no debe tocar stock: %+v", plan.StockDelta)
	}
	if plan.MonetaryDelta != 800 {
		t.Errorf("MonetaryDelta = %v; want 800 (300 + 500)", plan.MonetaryDelta)
	}
}

// ============================================================================
// BuildPaymentEditPlan — reparto firmado de pagos
// ============================================================================

func TestBuildPaymentEditPlan_DeltaPositivoAgregaEfectivo(t *testing.T) {
	plan, err := BuildPaymentEditPlan(
		1000,
		PaymentEditRequest{CashAmount: 1000},
		SaleChannelBalances{CashAmount: 5000},
	)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.Direction != "add" {
		t.Errorf("direction = %v; want add", plan.Direction)
	}
	if plan.CashDelta != 1000 {
		t.Errorf("CashDelta = %v; want +1000", plan.CashDelta)
	}
}

func TestBuildPaymentEditPlan_DeltaPositivoAgregaNequi(t *testing.T) {
	plan, err := BuildPaymentEditPlan(
		2000,
		PaymentEditRequest{TransferNequi: 2000},
		SaleChannelBalances{TransferNequi: 500},
	)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.Direction != "add" {
		t.Errorf("direction = %v; want add", plan.Direction)
	}
	if plan.NequiDelta != 2000 {
		t.Errorf("NequiDelta = %v; want +2000", plan.NequiDelta)
	}
	if plan.CashDelta != 0 {
		t.Errorf("CashDelta = %v; want 0", plan.CashDelta)
	}
}

func TestBuildPaymentEditPlan_DeltaNegativoRestaEfectivo(t *testing.T) {
	plan, err := BuildPaymentEditPlan(
		-1000,
		PaymentEditRequest{CashAmount: 1000},
		SaleChannelBalances{CashAmount: 3000},
	)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.Direction != "subtract" {
		t.Errorf("direction = %v; want subtract", plan.Direction)
	}
	if plan.CashDelta != -1000 {
		t.Errorf("CashDelta = %v; want -1000", plan.CashDelta)
	}
}

func TestBuildPaymentEditPlan_DeltaNegativoRestaNequiYDaviplata(t *testing.T) {
	plan, err := BuildPaymentEditPlan(
		-3000,
		PaymentEditRequest{TransferNequi: 1000, TransferDaviplata: 2000},
		SaleChannelBalances{TransferNequi: 1500, TransferDaviplata: 2500},
	)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.Direction != "subtract" {
		t.Errorf("direction = %v; want subtract", plan.Direction)
	}
	if plan.NequiDelta != -1000 {
		t.Errorf("NequiDelta = %v; want -1000", plan.NequiDelta)
	}
	if plan.DaviplataDelta != -2000 {
		t.Errorf("DaviplataDelta = %v; want -2000", plan.DaviplataDelta)
	}
}

// ============================================================================
// SEMÁNTICA DE transferAmount: es el TOTAL, no un canal genérico aparte.
// ============================================================================
//
// El frontend envía transferAmount = Nequi + Daviplata + genérico (la misma
// convención que models.Sale.TransferAmount y que SaleChannelBalances).
// Si BuildPaymentEditPlan sumara transferAmount Y el desglose por separado,
// contaría el dinero dos veces y toda edición con pago digital rebotaría con
// "reembolso incoherente" / "pago adicional insuficiente".
// ============================================================================

func TestBuildPaymentEditPlan_TransferAmountEsTotalNoSeDuplicaEnCobro(t *testing.T) {
	// Payload REAL del frontend: cobro adicional de $2200 pagado mitad
	// Nequi ($1200) mitad Daviplata ($1000). transferAmount es el TOTAL.
	plan, err := BuildPaymentEditPlan(
		2200,
		PaymentEditRequest{
			TransferAmount:    2200, // TOTAL = 1200 + 1000
			TransferNequi:     1200,
			TransferDaviplata: 1000,
			TransferSource:    "MIXTO",
		},
		SaleChannelBalances{},
	)
	if err != nil {
		t.Fatalf("no debe fallar: transferAmount es el total, no un canal extra: %v", err)
	}
	if plan.Direction != "add" {
		t.Errorf("direction = %v; want add", plan.Direction)
	}
	if plan.NequiDelta != 1200 {
		t.Errorf("NequiDelta = %v; want 1200", plan.NequiDelta)
	}
	if plan.DaviplataDelta != 1000 {
		t.Errorf("DaviplataDelta = %v; want 1000", plan.DaviplataDelta)
	}
	// La parte genérica es cero: todo el total está explicado por el desglose.
	if plan.TransferDelta != 0 {
		t.Errorf("TransferDelta (genérico) = %v; want 0 (todo el total es Nequi+Davi)", plan.TransferDelta)
	}
	// Invariante: la suma de deltas de canal debe igualar el delta monetario.
	sum := plan.CashDelta + plan.TransferDelta + plan.NequiDelta + plan.DaviplataDelta + plan.CreditDelta
	if math.Abs(sum-2200) > 0.01 {
		t.Errorf("suma de deltas = %v; want 2200", sum)
	}
}

func TestBuildPaymentEditPlan_TransferAmountEsTotalNoSeDuplicaEnReembolso(t *testing.T) {
	// Reembolso de $2200 por Nequi+Daviplata. transferAmount = TOTAL.
	plan, err := BuildPaymentEditPlan(
		-2200,
		PaymentEditRequest{
			TransferAmount:    2200,
			TransferNequi:     1200,
			TransferDaviplata: 1000,
			TransferSource:    "MIXTO",
		},
		SaleChannelBalances{
			TransferAmount:    5000, // total en la venta
			TransferNequi:     2000,
			TransferDaviplata: 1500,
		},
	)
	if err != nil {
		t.Fatalf("no debe fallar: %v", err)
	}
	if plan.Direction != "subtract" {
		t.Errorf("direction = %v; want subtract", plan.Direction)
	}
	if plan.NequiDelta != -1200 {
		t.Errorf("NequiDelta = %v; want -1200", plan.NequiDelta)
	}
	if plan.DaviplataDelta != -1000 {
		t.Errorf("DaviplataDelta = %v; want -1000", plan.DaviplataDelta)
	}
	if plan.TransferDelta != 0 {
		t.Errorf("TransferDelta (genérico) = %v; want 0", plan.TransferDelta)
	}
	sum := plan.CashDelta + plan.TransferDelta + plan.NequiDelta + plan.DaviplataDelta + plan.CreditDelta
	if math.Abs(sum-(-2200)) > 0.01 {
		t.Errorf("suma de deltas = %v; want -2200", sum)
	}
}

func TestBuildPaymentEditPlan_TransferAmountConParteGenericaSeparaCorrectamente(t *testing.T) {
	// Total $3000: Nequi $1000, Daviplata $500, genérico (Bancolombia) $1500.
	plan, err := BuildPaymentEditPlan(
		3000,
		PaymentEditRequest{
			TransferAmount:    3000,
			TransferNequi:     1000,
			TransferDaviplata: 500,
			TransferSource:    "BANCOLOMBIA",
		},
		SaleChannelBalances{},
	)
	if err != nil {
		t.Fatalf("no debe fallar: %v", err)
	}
	if plan.NequiDelta != 1000 {
		t.Errorf("NequiDelta = %v; want 1000", plan.NequiDelta)
	}
	if plan.DaviplataDelta != 500 {
		t.Errorf("DaviplataDelta = %v; want 500", plan.DaviplataDelta)
	}
	// El resto del total es la parte genérica.
	if math.Abs(plan.TransferDelta-1500) > 0.01 {
		t.Errorf("TransferDelta (genérico) = %v; want 1500", plan.TransferDelta)
	}
	sum := plan.CashDelta + plan.TransferDelta + plan.NequiDelta + plan.DaviplataDelta + plan.CreditDelta
	if math.Abs(sum-3000) > 0.01 {
		t.Errorf("suma de deltas = %v; want 3000", sum)
	}
}

func TestBuildPaymentEditPlan_TransferAmountAusenteSeDerivaDelDesglose(t *testing.T) {
	// Cliente legacy que manda sólo el desglose sin el total.
	plan, err := BuildPaymentEditPlan(
		1500,
		PaymentEditRequest{TransferNequi: 1000, TransferDaviplata: 500},
		SaleChannelBalances{},
	)
	if err != nil {
		t.Fatalf("no debe fallar: %v", err)
	}
	if plan.TransferDelta != 0 {
		t.Errorf("TransferDelta = %v; want 0", plan.TransferDelta)
	}
	sum := plan.CashDelta + plan.TransferDelta + plan.NequiDelta + plan.DaviplataDelta + plan.CreditDelta
	if math.Abs(sum-1500) > 0.01 {
		t.Errorf("suma de deltas = %v; want 1500", sum)
	}
}

func TestBuildPaymentEditPlan_TransferAmountSoloGenericoSinDesglose(t *testing.T) {
	// Pago por un canal que no es Nequi ni Daviplata (tarjeta/Bancolombia).
	plan, err := BuildPaymentEditPlan(
		4000,
		PaymentEditRequest{TransferAmount: 4000, TransferSource: "TARJETA"},
		SaleChannelBalances{},
	)
	if err != nil {
		t.Fatalf("no debe fallar: %v", err)
	}
	if math.Abs(plan.TransferDelta-4000) > 0.01 {
		t.Errorf("TransferDelta = %v; want 4000", plan.TransferDelta)
	}
	if plan.NequiDelta != 0 || plan.DaviplataDelta != 0 {
		t.Errorf("desglose debe quedar en cero: nequi=%v davi=%v", plan.NequiDelta, plan.DaviplataDelta)
	}
}

func TestBuildPaymentEditPlan_NetoCeroExigePagoCero(t *testing.T) {
	_, err := BuildPaymentEditPlan(
		0,
		PaymentEditRequest{CashAmount: 1000},
		SaleChannelBalances{},
	)
	if err == nil {
		t.Fatal("se esperaba error: delta cero con pago > 0")
	}
	if !strings.Contains(err.Error(), "cero") {
		t.Errorf("mensaje debe mencionar 'cero': %v", err)
	}
}

func TestBuildPaymentEditPlan_NetoCeroAceptaPagoCero(t *testing.T) {
	plan, err := BuildPaymentEditPlan(
		0,
		PaymentEditRequest{},
		SaleChannelBalances{},
	)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.Direction != "zero" {
		t.Errorf("direction = %v; want zero", plan.Direction)
	}
}

func TestBuildPaymentEditPlan_CanalEfectivoInsuficiente(t *testing.T) {
	_, err := BuildPaymentEditPlan(
		-1000,
		PaymentEditRequest{CashAmount: 1000},
		SaleChannelBalances{CashAmount: 200}, // solo tenía 200
	)
	if err == nil {
		t.Fatal("se esperaba error por canal EFECTIVO insuficiente")
	}
	if !strings.Contains(err.Error(), "EFECTIVO insuficiente") {
		t.Errorf("mensaje debe mencionar canal EFECTIVO: %v", err)
	}
}

func TestBuildPaymentEditPlan_CanalNequiInsuficiente(t *testing.T) {
	_, err := BuildPaymentEditPlan(
		-1500,
		PaymentEditRequest{TransferNequi: 1500},
		SaleChannelBalances{TransferNequi: 500},
	)
	if err == nil {
		t.Fatal("se esperaba error por canal NEQUI insuficiente")
	}
	if !strings.Contains(err.Error(), "NEQUI") {
		t.Errorf("mensaje debe mencionar NEQUI: %v", err)
	}
}

func TestBuildPaymentEditPlan_ReembolsoNoCuadraConDelta(t *testing.T) {
	// Delta -1000 pero reembolso $500: no cuadra.
	_, err := BuildPaymentEditPlan(
		-1000,
		PaymentEditRequest{CashAmount: 500},
		SaleChannelBalances{CashAmount: 2000},
	)
	if err == nil {
		t.Fatal("se esperaba error por reembolso incoherente")
	}
	if !strings.Contains(err.Error(), "reembolso incoherente") {
		t.Errorf("mensaje debe indicar incoherencia: %v", err)
	}
}

func TestBuildPaymentEditPlan_PagoAdicionalInsuficiente(t *testing.T) {
	// Delta +1000 pero pago $200: no cubre.
	_, err := BuildPaymentEditPlan(
		1000,
		PaymentEditRequest{CashAmount: 200},
		SaleChannelBalances{CashAmount: 5000},
	)
	if err == nil {
		t.Fatal("se esperaba error por pago adicional insuficiente")
	}
	if !strings.Contains(err.Error(), "insuficiente") {
		t.Errorf("mensaje debe mencionar insuficiente: %v", err)
	}
}

func TestBuildPaymentEditPlan_SobrePagoEnEfectivoEsPermitido(t *testing.T) {
	// Delta +1000, cliente paga $1500 en efectivo (se convertirá en $500 change).
	plan, err := BuildPaymentEditPlan(
		1000,
		PaymentEditRequest{CashAmount: 1500},
		SaleChannelBalances{CashAmount: 5000},
	)
	if err != nil {
		t.Fatalf("sobre-pago en efectivo debe permitirse: %v", err)
	}
	if plan.CashDelta != 1500 {
		t.Errorf("CashDelta = %v; want +1500 (todo el efectivo)", plan.CashDelta)
	}
}

func TestBuildPaymentEditPlan_SobrePagoDigitalSinEfectivoEsError(t *testing.T) {
	// Delta +1000, cliente paga $1500 en Nequi (sobre-pago sin cambio posible).
	_, err := BuildPaymentEditPlan(
		1000,
		PaymentEditRequest{TransferNequi: 1500},
		SaleChannelBalances{},
	)
	if err == nil {
		t.Fatal("se esperaba error por sobre-pago digital")
	}
}

func TestBuildPaymentEditPlan_ReducirCreditoDebajoDeAbonosEsError(t *testing.T) {
	// Venta con CreditAmount=$1000, DebtPending=$400 (ya abonaron $600).
	// Intento reducir crédito $500: newCredit = 500, pero abonos = $600 → error.
	_, err := BuildPaymentEditPlan(
		-500,
		PaymentEditRequest{CreditAmount: 500},
		SaleChannelBalances{
			CreditAmount: 1000,
			DebtPending:  400,
		},
	)
	if err == nil {
		t.Fatal("se esperaba error por reducir crédito debajo de abonos")
	}
	if !strings.Contains(err.Error(), "abonos") {
		t.Errorf("mensaje debe mencionar abonos: %v", err)
	}
}

func TestBuildPaymentEditPlan_ReducirCreditoDentroDelSaldoOk(t *testing.T) {
	// Venta con CreditAmount=$1000, DebtPending=$800 (abonos=$200).
	// Reducir $500 deja crédito en $500, que aún cubre abonos $200. Válido.
	plan, err := BuildPaymentEditPlan(
		-500,
		PaymentEditRequest{CreditAmount: 500},
		SaleChannelBalances{
			CreditAmount: 1000,
			DebtPending:  800,
		},
	)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.CreditDelta != -500 {
		t.Errorf("CreditDelta = %v; want -500", plan.CreditDelta)
	}
}

func TestBuildPaymentEditPlan_AumentarCreditoPorEncimaDelLimiteEsError(t *testing.T) {
	_, err := BuildPaymentEditPlan(
		500,
		PaymentEditRequest{CreditAmount: 500},
		SaleChannelBalances{
			CurrentCredit: 800,
			CreditLimit:   1000,
		},
	)
	if err == nil {
		t.Fatal("se esperaba error por superar límite de crédito")
	}
	if !strings.Contains(err.Error(), "límite") {
		t.Errorf("mensaje debe mencionar límite: %v", err)
	}
}

func TestBuildPaymentEditPlan_AumentarCreditoDentroDelLimiteOk(t *testing.T) {
	plan, err := BuildPaymentEditPlan(
		200,
		PaymentEditRequest{CreditAmount: 200},
		SaleChannelBalances{
			CurrentCredit: 800,
			CreditLimit:   1500,
		},
	)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.CreditDelta != 200 {
		t.Errorf("CreditDelta = %v; want +200", plan.CreditDelta)
	}
}

func TestBuildPaymentEditPlan_MagnitudNegativaEsError(t *testing.T) {
	_, err := BuildPaymentEditPlan(
		100,
		PaymentEditRequest{CashAmount: -100},
		SaleChannelBalances{},
	)
	if err == nil {
		t.Fatal("se esperaba error por magnitud negativa")
	}
}

func TestBuildPaymentEditPlan_CanalTransferenciaGenericaInsuficiente(t *testing.T) {
	// La venta tiene $3000 en transferencia total (Bancolombia $500 + Nequi $2000
	// + Daviplata $500). Un reembolso genérico de $600 supera el saldo Bancolombia.
	_, err := BuildPaymentEditPlan(
		-600,
		PaymentEditRequest{TransferAmount: 600, TransferSource: "BANCOLOMBIA"},
		SaleChannelBalances{
			TransferAmount:    3000,
			TransferNequi:     2000,
			TransferDaviplata: 500,
		},
	)
	if err == nil {
		t.Fatal("se esperaba error por canal genérico insuficiente")
	}
	if !strings.Contains(err.Error(), "TRANSFERENCIA insuficiente") {
		t.Errorf("mensaje debe mencionar TRANSFERENCIA: %v", err)
	}
}

func TestBuildPaymentEditPlan_CanalTransferenciaGenericaSuficiente(t *testing.T) {
	// La venta tiene $500 en Bancolombia (genérico). Un reembolso $200 pasa.
	plan, err := BuildPaymentEditPlan(
		-200,
		PaymentEditRequest{TransferAmount: 200, TransferSource: "BANCOLOMBIA"},
		SaleChannelBalances{
			TransferAmount:    3500,
			TransferNequi:     2000,
			TransferDaviplata: 1000,
		},
	)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.TransferDelta != -200 {
		t.Errorf("TransferDelta = %v; want -200", plan.TransferDelta)
	}
}

// ============================================================================
// RecalculateSaleCash — cambio y cashNeeded
// ============================================================================

func TestRecalculateSaleCash_ClienteExactoNoTieneCambio(t *testing.T) {
	if got := RecalculateSaleCash(1000, 1000, 0, 0); got != 0 {
		t.Errorf("change = %v; want 0", got)
	}
}

func TestRecalculateSaleCash_ClientePagaMasEnEfectivoRecibeCambio(t *testing.T) {
	if got := RecalculateSaleCash(1000, 1500, 0, 0); got != 500 {
		t.Errorf("change = %v; want 500", got)
	}
}

func TestRecalculateSaleCash_TransferenciaCubreCashNeededQuedaEnCero(t *testing.T) {
	if got := RecalculateSaleCash(1000, 0, 1000, 0); got != 0 {
		t.Errorf("change = %v; want 0", got)
	}
}

func TestRecalculateSaleCash_CreditoDejaCashNeededEnCero(t *testing.T) {
	if got := RecalculateSaleCash(1000, 0, 0, 1000); got != 0 {
		t.Errorf("change = %v; want 0", got)
	}
}

func TestRecalculateSaleCash_CashNeededNoNegativo(t *testing.T) {
	// TotalAmount 500, cliente pagó $600 en efectivo + $400 en transferencia.
	// cashNeeded = 500 - 400 = 100 → Change = 600 - 100 = 500.
	if got := RecalculateSaleCash(500, 600, 400, 0); got != 500 {
		t.Errorf("change = %v; want 500", got)
	}
}

// ============================================================================
// Test integral: la invariante de canales se mantiene tras aplicar el plan
// ============================================================================

func TestBuildPaymentEditPlan_SumaDeltasCuadraConDelta(t *testing.T) {
	// Delta -1500 dividido entre Nequi y Daviplata.
	plan, err := BuildPaymentEditPlan(
		-1500,
		PaymentEditRequest{TransferNequi: 800, TransferDaviplata: 700},
		SaleChannelBalances{TransferNequi: 1200, TransferDaviplata: 1000},
	)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	sum := plan.CashDelta + plan.TransferDelta + plan.NequiDelta + plan.DaviplataDelta + plan.CreditDelta
	if math.Abs(sum-(-1500)) > 0.01 {
		t.Fatalf("suma de deltas = %v; want -1500", sum)
	}
}
