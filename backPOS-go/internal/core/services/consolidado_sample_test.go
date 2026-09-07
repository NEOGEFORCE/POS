package services

import (
	"os"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// TestGenerarMuestraConsolidado genera el PDF de FLUJO DESGLOSADO (el que sale
// del botón del mismo nombre, que internamente usa GenerateConsolidatedClosurePDF)
// para revisar el formato antes de desplegarlo.
//
//	$env:POS_CONSOLIDADO_OUT="C:\ruta\muestra.pdf"
//	go test ./internal/core/services/ -run TestGenerarMuestraConsolidado -v
func TestGenerarMuestraConsolidado(t *testing.T) {
	dst := os.Getenv("POS_CONSOLIDADO_OUT")
	if dst == "" {
		t.Skip("definí POS_CONSOLIDADO_OUT para generar la muestra del consolidado")
	}

	loc := time.FixedZone("America/Bogota", -5*60*60)
	from := time.Date(2026, 8, 1, 0, 0, 0, 0, loc)
	to := time.Date(2026, 8, 31, 23, 59, 59, 0, loc)

	sup := func(id uint) *uint { return &id }

	// Egresos repartidos en VARIOS canales a propósito, para comprobar que en el
	// consolidado cada concepto sale UNA vez con la suma de todos.
	expenses := []models.Expense{
		// Proveedores: uno partido entre efectivo y Nequi.
		{ID: 1, Status: "PAID", Description: "PAGO PROVEEDOR - PLAZA", Category: "Proveedores", SupplierID: sup(1),
			Amount: 1685100, CashAmount: 1000000, NequiAmount: 685100, Date: from},
		{ID: 2, Status: "PAID", Description: "PAGO PROVEEDOR - LA NIEVE CIGARRILLOS", Category: "Proveedores", SupplierID: sup(2),
			Amount: 800000, CashAmount: 800000, Date: from},
		{ID: 3, Status: "PAID", Description: "PAGO PROVEEDOR - MARGARITA", Category: "Proveedores", SupplierID: sup(3),
			Amount: 533000, DaviplataAmount: 533000, Date: from},
		{ID: 4, Status: "PAID", Description: "PAGO PROVEEDOR - QUALA", Category: "Proveedores", SupplierID: sup(4),
			Amount: 418000, FondoAmount: 418000, Date: from},
		// Gastos del negocio, también en canales distintos.
		{ID: 5, Status: "PAID", Description: "CUOTA BANCO / OBLIGACIONES", Category: "Otros Gastos",
			Amount: 390600, FondoAmount: 390600, Date: from},
		{ID: 6, Status: "PAID", Description: "PAGO DE NOMINA", Category: "Nomina",
			Amount: 95000, CashAmount: 95000, Date: from},
		{ID: 7, Status: "PAID", Description: "SERVICIOS PUBLICOS - LUZ", Category: "Servicios",
			Amount: 1004890, FondoAmount: 1004890, Date: from},
		{ID: 8, Status: "PAID", Description: "ALMUERZOS AGOSTO", Category: "Otros Gastos",
			Amount: 140000, CashAmount: 100000, CoinsAmount: 40000, Date: from},
		// RUIDO: no debe aparecer en ninguna de las dos listas.
		{ID: 9, Status: "PENDING", Description: "DEUDA PENDIENTE PROVEEDOR X", Category: "Proveedores",
			Amount: 500000, Date: from},
		{ID: 10, Status: "PAID", Description: "PRESTAMO RECIBIDO", PaymentSource: "PRESTAMO",
			Amount: 200000, CashAmount: 200000, Date: from},
		{ID: 11, Status: "PAID", Description: "DEVOLUCION A CLIENTE", Category: "DEVOLUCIONES",
			Amount: 20000, CashAmount: 20000, Date: from},
	}

	closures := []models.CashierClosure{
		{
			// CASO REAL CC-166: la jornada es del 28, pero el cierre se hizo el 29
			// a las 07:38 a.m. El PDF debe decir 28/08/2026, igual que /reports.
			ID: 166, Date: time.Date(2026, 8, 28, 0, 0, 0, 0, loc),
			StartDate:    time.Date(2026, 8, 28, 7, 30, 0, 0, loc),
			EndDate:      time.Date(2026, 8, 29, 7, 38, 6, 0, loc),
			ClosedByName: "SEBASTIAN", PhysicalCash: 247000, TotalCash: 1002650,
			TotalNequi: 200000, TotalDaviplata: 185000, TotalSales: 1387650,
			OpeningCash: 0, TotalReturns: 0, TotalExpenses: 797317,
			Expenses: expenses,
		},
		{
			// Este es MAS VIEJO pero va segundo en el slice a proposito: el PDF
			// debe reordenarlo y sacarlo ANTES del 166.
			ID: 165, Date: time.Date(2026, 8, 27, 0, 0, 0, 0, loc),
			StartDate:    time.Date(2026, 8, 27, 8, 0, 0, 0, loc),
			EndDate:      time.Date(2026, 8, 27, 21, 9, 40, 0, loc),
			ClosedByName: "FABIAN", PhysicalCash: 288500, TotalCash: 703114,
			TotalNequi: 112000, TotalDaviplata: 90000, TotalSales: 905114,
			OpeningCash: 0, TotalReturns: 0, TotalExpenses: 602014,
		},
	}

	svc := &ExportService{}
	buf, err := svc.GenerateConsolidatedClosurePDF(closures, expenses, nil, from, to)
	if err != nil {
		t.Fatalf("GenerateConsolidatedClosurePDF: %v", err)
	}
	if err := os.WriteFile(dst, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("escribiendo %s: %v", dst, err)
	}
	t.Logf("muestra del consolidado en %s (%d bytes)", dst, buf.Len())

	// Verificación de la invariante: en el consolidado las dos bolsas deben
	// sumar el mismo egreso operativo total que calcula el resto del sistema.
	suppliers, others := SplitExpensesByKind(expenses)
	total, _ := ComputeShiftExpenseTotals(expenses)
	if suppliers+others != total {
		t.Fatalf("proveedores %v + negocio %v != total %v", suppliers, others, total)
	}
	t.Logf("proveedores=%v  negocio=%v  total=%v", suppliers, others, total)
}
