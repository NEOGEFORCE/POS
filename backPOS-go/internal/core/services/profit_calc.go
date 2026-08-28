package services

import "strings"

// =============================================================
// profit_calc.go — Reglas puras (sin base de datos) de la Auditoría
// Integral del supermercado.
//
// Reglas del negocio implementadas aquí:
//
//  1. PASO 1 audita el 100% de los ingresos consolidados del período
//     (cierres de caja), no solo lo que quedó con detalle de producto.
//  2. El costo de la mercancía se mide con el MARGEN REAL del negocio:
//     se calcula sobre los productos que sí tienen costo registrado y
//     ese mismo margen se aplica al resto de los ingresos auditados
//     (ventas rápidas MISC/0000 y diferencias de registro). No hay
//     porcentajes inventados ni fijos.
//  3. De la ganancia bruta solo se restan gastos OPERATIVOS del local.
//     Los pagos de mercancía a proveedores y los abonos a préstamos de
//     inventario NO se restan (el costo de la mercancía ya se descontó).
// =============================================================

// DefaultFallbackMargin es el margen de respaldo que se usa ÚNICAMENTE
// cuando el período no tiene ninguna venta con costo registrado y por lo
// tanto es imposible medir el margen real del negocio.
const DefaultFallbackMargin = 0.20

// QuickSaleGroupBarcode es el código con el que se agrupan todas las
// ventas rápidas en el reporte por producto.
const QuickSaleGroupBarcode = "MISC-"

// QuickSaleGroupName es la etiqueta legible del grupo de ventas rápidas.
const QuickSaleGroupName = "Ventas rápidas (productos sin código)"

// IsQuickSaleBarcode indica si un código de barras corresponde a una
// venta rápida / producto genérico sin código real.
func IsQuickSaleBarcode(barcode string) bool {
	b := strings.ToUpper(strings.TrimSpace(barcode))
	if b == "" || b == "0000" || b == "MISC" {
		return true
	}
	return strings.HasPrefix(b, "MISC-")
}

// ComputeKnownMargin mide el margen REAL del negocio a partir de las
// ventas que tienen costo de compra registrado.
//
//	margen = (ventas con costo - costo de esas ventas) / ventas con costo
//
// Si no hay ventas con costo (o el dato es inconsistente) devuelve el
// margen de respaldo.
func ComputeKnownMargin(knownSales, knownCost float64) float64 {
	if knownSales <= 0 {
		return DefaultFallbackMargin
	}
	margin := (knownSales - knownCost) / knownSales
	if margin <= 0 || margin >= 1 {
		// Costo mayor que la venta o costo cero: el dato no sirve para
		// extrapolar, se usa el margen de respaldo.
		return DefaultFallbackMargin
	}
	return margin
}

// ProfitAggregate es el estado de resultados consolidado del período.
type ProfitAggregate struct {
	// AuditedIncome es el PASO 1: el 100% de los ingresos consolidados
	// del período según los cierres de caja.
	AuditedIncome float64
	TotalCost     float64 // PASO 2
	GrossProfit   float64 // PASO 3 = AuditedIncome - TotalCost

	// Tramo medido: productos con costo de compra registrado.
	KnownSales  float64
	KnownCost   float64
	KnownProfit float64
	// KnownMargin es el margen real medido, que se extrapola al resto.
	KnownMargin float64

	// Tramo extrapolado: ingresos auditados sin costo conocido (ventas
	// rápidas MISC/0000, flujos de caja y diferencias de registro).
	UncostedSales  float64
	UncostedCost   float64
	UncostedProfit float64

	// QuickSales es la parte del tramo extrapolado que sí está
	// identificada como venta rápida en el detalle (informativo).
	QuickSales float64
	// DetailSales es la suma del detalle de productos (informativo).
	DetailSales float64
}

// ProfitLine es una línea agregada por producto lista para calcular.
type ProfitLine struct {
	Barcode string
	Name    string
	Units   float64
	// Sales es el total vendido de la línea.
	Sales float64
	// CostedSales es la parte vendida que SÍ tiene costo registrado.
	CostedSales float64
	// KnownCost es el costo de esas unidades (cantidad * costPrice).
	KnownCost float64
	// UncostedSales es la parte vendida sin costo registrado (o de
	// ventas rápidas), que se valora con el margen real medido.
	UncostedSales float64
}

// CostAt devuelve el costo de la línea: costo real de lo que lo tiene,
// más el resto valorado con el margen indicado.
func (l ProfitLine) CostAt(margin float64) float64 {
	return l.KnownCost + l.UncostedSales*(1-margin)
}

// IsQuickSale indica si la línea es (mayoritariamente) venta rápida.
func (l ProfitLine) IsQuickSale() bool {
	if IsQuickSaleBarcode(l.Barcode) {
		return true
	}
	return l.KnownCost <= 0 && l.UncostedSales > 0
}

// AggregateProfitAudited construye el estado de resultados del período
// auditando el 100% de los ingresos.
//
//	KnownMargin    = margen real de los productos con costo registrado
//	UncostedSales  = ingresos auditados - ventas con costo registrado
//	UncostedProfit = UncostedSales * KnownMargin
//	TotalCost      = KnownCost + (UncostedSales - UncostedProfit)
//	GrossProfit    = AuditedIncome - TotalCost
func AggregateProfitAudited(lines []ProfitLine, auditedIncome float64) ProfitAggregate {
	agg := ProfitAggregate{}

	for _, l := range lines {
		agg.DetailSales += l.Sales
		agg.KnownSales += l.CostedSales
		agg.KnownCost += l.KnownCost
		if l.IsQuickSale() {
			agg.QuickSales += l.Sales
		}
	}

	agg.KnownProfit = agg.KnownSales - agg.KnownCost
	agg.KnownMargin = ComputeKnownMargin(agg.KnownSales, agg.KnownCost)

	// El Paso 1 nunca puede quedar por debajo de lo que ya está medido
	// con costo real: eso produciría un costo mayor que el ingreso.
	agg.AuditedIncome = auditedIncome
	if agg.AuditedIncome < agg.KnownSales {
		agg.AuditedIncome = agg.KnownSales
	}
	if agg.AuditedIncome < 0 {
		agg.AuditedIncome = 0
	}

	agg.UncostedSales = agg.AuditedIncome - agg.KnownSales
	agg.UncostedProfit = agg.UncostedSales * agg.KnownMargin
	agg.UncostedCost = agg.UncostedSales - agg.UncostedProfit

	agg.TotalCost = agg.KnownCost + agg.UncostedCost
	agg.GrossProfit = agg.AuditedIncome - agg.TotalCost
	return agg
}

// OverallMargin devuelve el margen general del período.
func (a ProfitAggregate) OverallMargin() float64 {
	if a.AuditedIncome <= 0 {
		return 0
	}
	return a.GrossProfit / a.AuditedIncome
}

// FreeProfit calcula la Ganancia Libre del mes: ganancia bruta menos
// exclusivamente los gastos operativos del local.
func FreeProfit(grossProfit, operatingExpenses float64) float64 {
	return grossProfit - operatingExpenses
}

// =============================================================
// Clasificación de egresos
// =============================================================

// Categorías de gasto operativo del local.
const (
	OpExpenseRent        = "RENT"
	OpExpenseServices    = "SERVICES"
	OpExpensePayroll     = "PAYROLL"
	OpExpenseMaintenance = "MAINTENANCE"
	OpExpenseFinancial   = "FINANCIAL"
	OpExpenseOther       = "OTHER"
)

// merchandiseKeywords son textos que identifican compras de mercancía,
// insumos para la venta, pagos a proveedores, recepciones o devoluciones.
// Estos egresos NO se restan de la ganancia bruta porque el costo de la
// mercancía ya se descontó al calcular el costo de lo vendido.
var merchandiseKeywords = []string{
	"PROVEEDOR", "PROVEEDORES", "COMPRA", "MERCANCIA", "MERCANCÍA",
	"RECEPCION", "RECEPCIÓN", "DEVOLUCION", "DEVOLUCIÓN", "DESCUADRE",
	"INVENTARIO", "SURTIDO", "INSUMO", "INSUMOS",
	// Financiación de mercancía (préstamos / abonos de inventario)
	"PRESTAMO", "PRÉSTAMO", "PREST.", "ABONO A DEUDA", "ABONO DEUDA",
	"PAGO A DEUDA", "PAGO DEUDA", "CUOTA PRESTAMO", "CUOTA PRÉSTAMO",
	// Insumos alimenticios comprados para revender (carnes, lácteos, etc.)
	"MANTEQUILLA", "CERDO", "POLLO", "CARNE", "HUEVOS", "QUESO",
	"SALCHICHA", "CHORIZO", "JAMON", "JAMÓN", "COSTILLA", "PESCADO",
	"VERDURA", "FRUTA", "PANELA", "AREPA", "YOGURT",
	// Proveedores frecuentes del local
	"POSTOBON", "AGUA MIA", "TRONEX", "SUPER RICAS", "PURO CLOR",
	"ZENU", "ALQUERIA", "ALPINA", "COCACOLA", "COCA COLA", "HERMARLY",
	"LA NIEVE", "TRILLADORA", "ALTIPAL", "COLOMBINA", "RAMO",
	"MAXGOL", "DISTRILLANO", "PLASTICOS", "PULPAS",
}

// merchandiseWords son palabras cortas de mercancía que solo se comparan
// como palabra completa, para no capturar por accidente textos como
// "INTERESES", "PRESUPUESTO" o "PEDIDO DE PAPELERIA".
var merchandiseWords = []string{
	"RES", "PAPA", "PAN", "SAL", "LECHE", "PEDIDO", "DEPOSITO", "IDEAL", "COUNTRY",
}

var merchandiseCategories = map[string]bool{
	"PROVEEDORES": true, "PROVEEDOR": true, "COMPRAS": true,
	"MERCANCIA": true, "MERCANCÍA": true, "RECEPCION": true,
	"RECEPCIÓN": true, "INVENTARIO": true, "PRESTAMOS": true,
	"INSUMOS": true, "CARNES": true,
}

// splitWords parte un texto en palabras en mayúscula, descartando
// signos de puntuación y números.
func splitWords(text string) []string {
	return strings.FieldsFunc(strings.ToUpper(text), func(r rune) bool {
		return !(r >= 'A' && r <= 'Z') && !(r >= 'À' && r <= 'ÿ')
	})
}

// IsMerchandiseExpense indica si un egreso corresponde a mercancía,
// insumos para la venta o financiación de mercancía y por lo tanto debe
// EXCLUIRSE de los gastos operativos del local.
func IsMerchandiseExpense(category, description string, hasSupplier bool) bool {
	if hasSupplier {
		return true
	}
	cat := strings.ToUpper(strings.TrimSpace(category))
	if merchandiseCategories[cat] {
		return true
	}
	combined := cat + " " + strings.ToUpper(description)
	for _, kw := range merchandiseKeywords {
		if strings.Contains(combined, kw) {
			return true
		}
	}
	for _, w := range splitWords(combined) {
		for _, kw := range merchandiseWords {
			if w == kw {
				return true
			}
		}
	}
	return false
}

// ClassifyOpExpense clasifica un gasto operativo del local en una de las
// categorías visibles del reporte.
func ClassifyOpExpense(category, description string) string {
	combined := strings.ToUpper(strings.TrimSpace(category)) + " " + strings.ToUpper(description)

	contains := func(words ...string) bool {
		for _, w := range words {
			if strings.Contains(combined, w) {
				return true
			}
		}
		return false
	}

	switch {
	case contains("SUELDO", "NOMINA", "NÓMINA", "SALARIO", "QUINCENA", "EMPLEADO", "PERSONAL", "LIQUIDACION", "LIQUIDACIÓN"):
		return OpExpensePayroll
	case contains("ARRIENDO", "ALQUILER", "CANON", "INMUEBLE"), strings.Contains(combined, "RENTA") && !strings.Contains(combined, "RENTABILIDAD"):
		return OpExpenseRent
	// Las obligaciones financieras se detectan ANTES que los servicios
	// públicos: una "CUOTA BANCO" registrada en la categoría SERVICIOS no
	// debe sumarse nunca dentro de luz, agua, gas o internet.
	case contains("BANCO", "BANCARIO", "INTERES", "INTERÉS", "OBLIGACION", "OBLIGACIÓN", "FINANCIACION", "FINANCIACIÓN", "TARJETA DE CREDITO", "DAVIVIENDA", "BANCOLOMBIA"):
		return OpExpenseFinancial
	case contains("IMPREVISTO", "ARREGLO", "MANTENIMIENTO", "REPARAC", "DAÑO", "DANO", "DANOS", "ASEO", "LIMPIEZA"):
		return OpExpenseMaintenance
	case contains("SERVICIO", "LUZ", "ENERGIA", "ENERGÍA", "INTERNET", "TELEFONO", "TELÉFONO", "ENEL", "EPM", "VANTI", "GAS", "ACUEDUCTO"):
		return OpExpenseServices
	case strings.Contains(combined, "AGUA") && !strings.Contains(combined, "AGUA MIA"):
		return OpExpenseServices
	case contains("CUOTA"):
		return OpExpenseFinancial
	default:
		return OpExpenseOther
	}
}
