package services

import (
	"math"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// DESGLOSE DEL EGRESO POR TIPO DE GASTO
// ============================================================================
//
// Pedido del dueño (2026-09-04): en el total final del reporte desglosado
// quiere una fila de PROVEEDORES y otra de gastos que NO son proveedores, cada
// una sumando todos los canales de pago.
//
// LA INVARIANTE QUE PROTEGEN ESTOS TESTS: proveedores + otros == EgresosTotales.
// Si las dos filas no suman el total, el reporte deja de poder cuadrarse a mano
// y pierde su razón de ser. Por eso SplitExpensesByKind reutiliza
// isOperationalExpense y parseExpenseChannels en vez de tener criterios propios.

func supplierID(id uint) *uint { return &id }

func TestSplitExpensesByKind_SumaExactamenteElEgresoTotal(t *testing.T) {
	expenses := []models.Expense{
		// Proveedor explícito (tiene supplier_id): mercancía.
		{Status: "PAID", Amount: 120000, CashAmount: 120000, Category: "Proveedores", SupplierID: supplierID(9)},
		// Mercancía por categoría, pagada por Nequi.
		{Status: "PAID", Amount: 80000, NequiAmount: 80000, Category: "Compras", PaymentSource: "NEQUI"},
		// Gasto del local: nómina en efectivo.
		{Status: "PAID", Amount: 95000, CashAmount: 95000, Category: "Nomina"},
		// Gasto del local: servicios pagados del fondo.
		{Status: "PAID", Amount: 300000, FondoAmount: 300000, Category: "Servicios", PaymentSource: "FONDO"},
		// Gasto del local pagado con la alcancía (canal que se olvidaba antes).
		{Status: "PAID", Amount: 15000, CoinsAmount: 15000, Category: "Otros Gastos", PaymentSource: "ALCANCIA"},
		// RUIDO: nada de esto debe aportar a ninguna de las dos bolsas.
		{Status: "PENDING", Amount: 500000, CashAmount: 500000, Category: "Proveedores"},
		{Status: "PAID", Amount: 200000, CashAmount: 200000, Category: "Proveedores", PaymentSource: "PRESTAMO"},
		{Status: "PAID", Amount: 20000, CashAmount: 20000, Category: "DEVOLUCIONES"},
	}

	suppliers, others := SplitExpensesByKind(expenses)
	total, _ := ComputeShiftExpenseTotals(expenses)

	if math.Abs((suppliers+others)-total) > 0.01 {
		t.Fatalf("proveedores (%v) + otros (%v) = %v; debe ser igual al egreso total %v",
			suppliers, others, suppliers+others, total)
	}
	if math.Abs(suppliers-200000) > 0.01 {
		t.Errorf("proveedores = %v; want 200000 (120000 efectivo + 80000 Nequi)", suppliers)
	}
	if math.Abs(others-410000) > 0.01 {
		t.Errorf("otros = %v; want 410000 (95000 nomina + 300000 fondo + 15000 alcancia)", others)
	}
}

func TestSplitExpensesByKind_UnMismoGastoSumaTodosSusCanales(t *testing.T) {
	// Un solo egreso de proveedor pagado en cuatro canales a la vez. Debe caer
	// COMPLETO en la bolsa de proveedores, sin importar por dónde salió.
	expenses := []models.Expense{{
		Status:          "PAID",
		Amount:          100000,
		CashAmount:      25000,
		NequiAmount:     25000,
		DaviplataAmount: 25000,
		FondoAmount:     25000,
		Category:        "Proveedores",
		SupplierID:      supplierID(3),
	}}

	suppliers, others := SplitExpensesByKind(expenses)
	if math.Abs(suppliers-100000) > 0.01 {
		t.Fatalf("proveedores = %v; want 100000 sumando los cuatro canales", suppliers)
	}
	if others != 0 {
		t.Fatalf("otros = %v; want 0", others)
	}
}

func TestSplitExpensesByKind_ExcluyeLoMismoQueElEgresoTotal(t *testing.T) {
	// Sólo ruido: pendientes, préstamos y devoluciones. Las dos bolsas y el
	// total deben quedar en cero, no en "algo".
	expenses := []models.Expense{
		{Status: "PENDING", Amount: 500000, CashAmount: 500000, Category: "Proveedores"},
		{Status: "PAID", Amount: 200000, CashAmount: 200000, PaymentSource: "PREST."},
		{Status: "PAID", Amount: 20000, CashAmount: 20000, Category: "DEVOLUCIONES"},
	}

	suppliers, others := SplitExpensesByKind(expenses)
	total, count := ComputeShiftExpenseTotals(expenses)

	if suppliers != 0 || others != 0 {
		t.Fatalf("proveedores=%v otros=%v; ambos deben ser 0", suppliers, others)
	}
	if total != 0 || count != 0 {
		t.Fatalf("total=%v count=%d; ambos deben ser 0", total, count)
	}
}

func TestSplitExpensesByKind_ListaVaciaNoExplota(t *testing.T) {
	suppliers, others := SplitExpensesByKind(nil)
	if suppliers != 0 || others != 0 {
		t.Fatalf("con lista vacía debe dar 0 y 0; dio %v y %v", suppliers, others)
	}
}

func TestSplitExpensesByKind_GastoDeLocalSinCategoriaCaeEnOtros(t *testing.T) {
	// Un gasto sin categoría ni proveedor no es mercancía: es gasto del local.
	// Importa que el criterio por defecto NO infle proveedores, porque eso
	// distorsionaría la lectura de cuánto se gasta en mercancía.
	expenses := []models.Expense{
		{Status: "PAID", Amount: 30000, CashAmount: 30000, Description: "TRANSPORTE"},
	}
	suppliers, others := SplitExpensesByKind(expenses)
	if suppliers != 0 {
		t.Errorf("proveedores = %v; want 0", suppliers)
	}
	if math.Abs(others-30000) > 0.01 {
		t.Errorf("otros = %v; want 30000", others)
	}
}
