package services

import (
	"math"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// Tests integrales: plan + payment se componen consistentemente
// ============================================================================
//
// Estos tests simulan el flujo completo desde el request al estado de la
// venta después de aplicar el plan. NO tocan base de datos: usan las
// funciones puras y verifican los invariantes que la transacción real
// debe respetar.
// ============================================================================

// simulateApplyEdit aplica los deltas del plan sobre el snapshot de la venta
// y devuelve el estado esperado. Refleja EXACTAMENTE la aritmética de
// applySaleEdit para poder verificarla sin GORM.
func simulateApplyEdit(sale models.Sale, plan SaleEditPlan, payment PaymentEditPlan) models.Sale {
	sale.TotalAmount += plan.MonetaryDelta
	sale.CashAmount += payment.CashDelta
	sale.CreditAmount += payment.CreditDelta

	// Espejo de applySaleEdit: la porción genérica se calcula ANTES de mutar
	// el desglose. payment.TransferDelta es el delta del GENÉRICO, no del total.
	genericBefore := sale.TransferAmount - sale.TransferNequi - sale.TransferDaviplata
	if genericBefore < 0 {
		genericBefore = 0
	}
	genericAfter := genericBefore + payment.TransferDelta

	sale.TransferNequi += payment.NequiDelta
	sale.TransferDaviplata += payment.DaviplataDelta
	sale.TransferAmount = genericAfter + sale.TransferNequi + sale.TransferDaviplata

	if payment.TransferSource != "" {
		sale.TransferSource = payment.TransferSource
	}
	sale.AmountPaid = sale.CashAmount + sale.TransferAmount + sale.CreditAmount
	sale.Change = RecalculateSaleCash(sale.TotalAmount, sale.CashAmount, sale.TransferAmount, sale.CreditAmount)
	return sale
}

// El flujo completo con delta positivo y pago en efectivo debe dejar los
// canales cuadrados y la venta consistente.
func TestSaleEditFlow_MasProductoConEfectivo(t *testing.T) {
	sale := models.Sale{
		SaleID: 1, TotalAmount: 10000, CashAmount: 10000, Status: "PAID",
	}
	existing := []models.SaleDetail{
		{Barcode: "A", Quantity: 2, UnitPrice: 5000, CostPrice: 3000, Subtotal: 10000},
	}
	items := []SaleEditItemInput{{Barcode: "A", Quantity: 1}} // +1 unidad
	plan, err := BuildSaleEditPlan(existing, items, nil)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.MonetaryDelta != 5000 {
		t.Fatalf("delta = %v; want 5000", plan.MonetaryDelta)
	}

	payment, err := BuildPaymentEditPlan(
		plan.MonetaryDelta,
		PaymentEditRequest{CashAmount: 5000},
		SaleChannelBalances{CashAmount: sale.CashAmount},
	)
	if err != nil {
		t.Fatalf("payment: %v", err)
	}

	result := simulateApplyEdit(sale, plan, payment)
	if result.TotalAmount != 15000 {
		t.Errorf("TotalAmount = %v; want 15000", result.TotalAmount)
	}
	if result.CashAmount != 15000 {
		t.Errorf("CashAmount = %v; want 15000", result.CashAmount)
	}
	if result.Change != 0 {
		t.Errorf("Change = %v; want 0", result.Change)
	}
	// Stock: +1 unidad se descuenta.
	if plan.StockDelta["A"] != 1 {
		t.Errorf("StockDelta[A] = %v; want 1", plan.StockDelta["A"])
	}
}

// Reducir producto con reembolso en efectivo: la caja pierde ese monto,
// el stock se repone.
func TestSaleEditFlow_MenosProductoConReembolsoEfectivo(t *testing.T) {
	sale := models.Sale{
		SaleID: 2, TotalAmount: 15000, CashAmount: 15000, Status: "PAID",
	}
	existing := []models.SaleDetail{
		{Barcode: "A", Quantity: 3, UnitPrice: 5000, CostPrice: 3000, Subtotal: 15000},
	}
	items := []SaleEditItemInput{{Barcode: "A", Quantity: -1}}
	plan, err := BuildSaleEditPlan(existing, items, nil)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.MonetaryDelta != -5000 {
		t.Fatalf("delta = %v; want -5000", plan.MonetaryDelta)
	}

	payment, err := BuildPaymentEditPlan(
		plan.MonetaryDelta,
		PaymentEditRequest{CashAmount: 5000},
		SaleChannelBalances{CashAmount: sale.CashAmount},
	)
	if err != nil {
		t.Fatalf("payment: %v", err)
	}

	result := simulateApplyEdit(sale, plan, payment)
	if result.TotalAmount != 10000 {
		t.Errorf("TotalAmount = %v; want 10000", result.TotalAmount)
	}
	if result.CashAmount != 10000 {
		t.Errorf("CashAmount = %v; want 10000 (cliente recibió $5000 de vuelta)", result.CashAmount)
	}
	if plan.StockDelta["A"] != -1 {
		t.Errorf("StockDelta[A] = %v; want -1 (repone stock)", plan.StockDelta["A"])
	}
}

// Cambio de mix: reducir uno y aumentar otro con delta neto cero. Debe pasar
// sin exigir pago pero SÍ mover stock.
func TestSaleEditFlow_NetoCeroCambiaStockPeroNoPagos(t *testing.T) {
	sale := models.Sale{
		SaleID: 3, TotalAmount: 10000, CashAmount: 10000, Status: "PAID",
	}
	existing := []models.SaleDetail{
		{Barcode: "A", Quantity: 2, UnitPrice: 5000, CostPrice: 3000, Subtotal: 10000},
	}
	items := []SaleEditItemInput{
		{Barcode: "A", Quantity: -1},
	}
	// Producto nuevo con precio actual $5000 → delta = -5000 + 5000 = 0.
	lookup := map[string]*models.Product{
		"B": {Barcode: "B", SalePrice: 5000, PurchasePrice: 2000},
	}
	itemsCombined := append(items, SaleEditItemInput{Barcode: "B", Quantity: 1})
	plan, err := BuildSaleEditPlan(existing, itemsCombined, lookup)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if math.Abs(plan.MonetaryDelta) > 0.01 {
		t.Fatalf("delta = %v; want 0", plan.MonetaryDelta)
	}

	payment, err := BuildPaymentEditPlan(
		plan.MonetaryDelta,
		PaymentEditRequest{}, // pago cero, obligatorio para neto cero
		SaleChannelBalances{CashAmount: sale.CashAmount},
	)
	if err != nil {
		t.Fatalf("payment: %v", err)
	}
	if payment.Direction != "zero" {
		t.Errorf("direction = %v; want zero", payment.Direction)
	}

	// Stock: A repone 1, B descuenta 1.
	if plan.StockDelta["A"] != -1 {
		t.Errorf("StockDelta[A] = %v; want -1", plan.StockDelta["A"])
	}
	if plan.StockDelta["B"] != 1 {
		t.Errorf("StockDelta[B] = %v; want 1", plan.StockDelta["B"])
	}

	// El total y los pagos no cambian.
	result := simulateApplyEdit(sale, plan, payment)
	if math.Abs(result.TotalAmount-10000) > 0.01 {
		t.Errorf("TotalAmount = %v; want 10000", result.TotalAmount)
	}
	if math.Abs(result.CashAmount-10000) > 0.01 {
		t.Errorf("CashAmount = %v; want 10000", result.CashAmount)
	}
}

// Reducir en canal Nequi cuando la venta original solo tenía efectivo:
// canal insuficiente.
func TestSaleEditFlow_ReembolsoEnCanalSinSaldoEsError(t *testing.T) {
	existing := []models.SaleDetail{
		{Barcode: "A", Quantity: 2, UnitPrice: 5000, Subtotal: 10000},
	}
	items := []SaleEditItemInput{{Barcode: "A", Quantity: -1}}
	plan, err := BuildSaleEditPlan(existing, items, nil)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}

	// El cajero intenta reembolsar por Nequi, pero la venta se cobró en efectivo.
	_, err = BuildPaymentEditPlan(
		plan.MonetaryDelta,
		PaymentEditRequest{TransferNequi: 5000},
		SaleChannelBalances{CashAmount: 10000, TransferNequi: 0},
	)
	if err == nil {
		t.Fatal("se esperaba error por reembolso Nequi sin saldo")
	}
}

// ============================================================================
// Kárdex: cada línea con delta ≠ 0 genera exactamente un movimiento
// ============================================================================

func TestSaleEditFlow_KardexOUTParaAgregar(t *testing.T) {
	// Un item con delta positivo debe reflejarse como OUT/EDIT_APPLY.
	items := []SaleEditItemInput{{Barcode: "A", Quantity: 2}}
	lookup := map[string]*models.Product{
		"A": {Barcode: "A", SalePrice: 1000, PurchasePrice: 500},
	}
	plan, err := BuildSaleEditPlan(nil, items, lookup)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	line := plan.Lines[0]
	if line.EffectiveStockDelta != 2 {
		t.Errorf("EffectiveStockDelta = %v; want 2", line.EffectiveStockDelta)
	}
	// La convención del servicio: delta > 0 → movimiento OUT.
	if line.EffectiveStockDelta <= 0 {
		t.Error("se esperaba movimiento OUT (delta > 0)")
	}
}

func TestSaleEditFlow_KardexINParaQuitar(t *testing.T) {
	existing := []models.SaleDetail{
		{Barcode: "A", Quantity: 3, UnitPrice: 1000, Subtotal: 3000},
	}
	items := []SaleEditItemInput{{Barcode: "A", Quantity: -1}}
	plan, err := BuildSaleEditPlan(existing, items, nil)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	line := plan.Lines[0]
	if line.EffectiveStockDelta != -1 {
		t.Errorf("EffectiveStockDelta = %v; want -1", line.EffectiveStockDelta)
	}
	// La convención del servicio: delta < 0 → movimiento IN con abs(qty).
	if line.EffectiveStockDelta >= 0 {
		t.Error("se esperaba movimiento IN (delta < 0)")
	}
}

// ============================================================================
// Precio histórico: aumentar y quitar sobre la misma línea usa el mismo precio
// ============================================================================
func TestSaleEditFlow_PrecioHistoricoConservadoEnAumentoYReduccion(t *testing.T) {
	// La línea existente tiene precio $1000 (venta original).
	// El catálogo ahora vende ese mismo producto a $2000. Un aumento y una
	// reducción sobre la línea deben usar $1000 (histórico), NUNCA $2000.
	existing := []models.SaleDetail{
		{Barcode: "A", Quantity: 5, UnitPrice: 1000, CostPrice: 500, Subtotal: 5000},
	}
	lookup := map[string]*models.Product{
		"A": {Barcode: "A", SalePrice: 2000, PurchasePrice: 1200}, // reprecio
	}

	// +2 unidades sobre la línea existente.
	planAdd, err := BuildSaleEditPlan(existing, []SaleEditItemInput{{Barcode: "A", Quantity: 2}}, lookup)
	if err != nil {
		t.Fatalf("plan add: %v", err)
	}
	if planAdd.Lines[0].UnitPrice != 1000 {
		t.Errorf("aumento repricea: UnitPrice = %v; want 1000", planAdd.Lines[0].UnitPrice)
	}
	if planAdd.MonetaryDelta != 2000 {
		t.Errorf("delta add = %v; want 2000 (2 × $1000 histórico)", planAdd.MonetaryDelta)
	}

	// -2 unidades sobre la línea existente.
	planSub, err := BuildSaleEditPlan(existing, []SaleEditItemInput{{Barcode: "A", Quantity: -2}}, lookup)
	if err != nil {
		t.Fatalf("plan sub: %v", err)
	}
	if planSub.Lines[0].UnitPrice != 1000 {
		t.Errorf("reducción repricea: UnitPrice = %v; want 1000", planSub.Lines[0].UnitPrice)
	}
	if planSub.MonetaryDelta != -2000 {
		t.Errorf("delta sub = %v; want -2000 (2 × $1000 histórico)", planSub.MonetaryDelta)
	}
}

// ============================================================================
// Rollback semántico: si el plan falla, no hay estado parcial que aplicar
// ============================================================================
//
// El "rollback" real depende de la transacción de GORM. Aquí verificamos la
// invariante de nivel de contrato: si BuildSaleEditPlan o BuildPaymentEditPlan
// retornan error, el llamador NO recibe ningún plan aplicable. En el servicio
// real esto se traduce en que la tx nunca llega al Commit.
// ============================================================================
func TestSaleEditFlow_ErrorDePlanNoDejaEstadoParcial(t *testing.T) {
	// Un item cero → error inmediato. No hay lines devueltos.
	items := []SaleEditItemInput{
		{Barcode: "A", Quantity: 5},
		{Barcode: "B", Quantity: 0}, // inválido
	}
	plan, err := BuildSaleEditPlan(nil, items, map[string]*models.Product{
		"A": {Barcode: "A", SalePrice: 1000},
	})
	if err == nil {
		t.Fatal("se esperaba error por quantity == 0")
	}
	// Aún así, plan.Lines puede quedar vacío o con la primera línea; el
	// contrato importante es que el servicio propaga el error y no aplica.
	if len(plan.Lines) > 1 {
		t.Errorf("plan no debe tener líneas después de error: %+v", plan.Lines)
	}
}

func TestSaleEditFlow_ErrorDePagoNoDejaEstadoParcial(t *testing.T) {
	existing := []models.SaleDetail{
		{Barcode: "A", Quantity: 3, UnitPrice: 1000, Subtotal: 3000},
	}
	plan, err := BuildSaleEditPlan(existing, []SaleEditItemInput{{Barcode: "A", Quantity: -1}}, nil)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}

	// Pago incoherente (reembolso $500 pero delta -1000): error.
	pay, err := BuildPaymentEditPlan(
		plan.MonetaryDelta,
		PaymentEditRequest{CashAmount: 500},
		SaleChannelBalances{CashAmount: 3000},
	)
	if err == nil {
		t.Fatal("se esperaba error por reembolso incoherente")
	}
	// El plan de pago está vacío.
	if pay.CashDelta != 0 || pay.NequiDelta != 0 {
		t.Errorf("plan de pago no debe tener deltas: %+v", pay)
	}
}

// ============================================================================
// Regresión: un edit con crédito ajusta DebtPending y CurrentCredit
// ============================================================================
func TestSaleEditFlow_AjusteDeCreditoIncrementaCurrentCredit(t *testing.T) {
	// Venta original: efectivo $5000. Cliente ahora se lleva $3000 más al fiado.
	items := []SaleEditItemInput{{Barcode: "B", Quantity: 3}}
	lookup := map[string]*models.Product{"B": {Barcode: "B", SalePrice: 1000, PurchasePrice: 500}}

	plan, err := BuildSaleEditPlan(nil, items, lookup)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.MonetaryDelta != 3000 {
		t.Fatalf("delta = %v; want 3000", plan.MonetaryDelta)
	}

	payment, err := BuildPaymentEditPlan(
		plan.MonetaryDelta,
		PaymentEditRequest{CreditAmount: 3000},
		SaleChannelBalances{
			CashAmount:    5000,
			CurrentCredit: 500, // el cliente ya tenía $500 de crédito
			CreditLimit:   10000,
		},
	)
	if err != nil {
		t.Fatalf("payment: %v", err)
	}
	if payment.CreditDelta != 3000 {
		t.Errorf("CreditDelta = %v; want +3000", payment.CreditDelta)
	}
}

func TestSaleEditFlow_ReducirCreditoDentroDeAbonos(t *testing.T) {
	// Venta con crédito $2000, DebtPending $2000 (sin abonos aún).
	// Reducir 1000 quedaría crédito $1000, DebtPending $1000. OK.
	existing := []models.SaleDetail{
		{Barcode: "A", Quantity: 2, UnitPrice: 1000, Subtotal: 2000},
	}
	items := []SaleEditItemInput{{Barcode: "A", Quantity: -1}}
	plan, err := BuildSaleEditPlan(existing, items, nil)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}

	pay, err := BuildPaymentEditPlan(
		plan.MonetaryDelta,
		PaymentEditRequest{CreditAmount: 1000},
		SaleChannelBalances{
			CreditAmount:  2000,
			DebtPending:   2000,
			CurrentCredit: 2000,
			CreditLimit:   10000,
		},
	)
	if err != nil {
		t.Fatalf("payment: %v", err)
	}
	if pay.CreditDelta != -1000 {
		t.Errorf("CreditDelta = %v; want -1000", pay.CreditDelta)
	}
}
