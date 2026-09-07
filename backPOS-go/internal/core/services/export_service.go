package services

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"

	"github.com/xuri/excelize/v2"
	"gorm.io/gorm"
)

// =============================================================
// ExportService — generación de reportes PDF/Excel + datos para
// los 3 reportes nuevos (rentabilidad, mermas, rotación) y los
// cuadres reales (general + por día).
//
// Diseñado para NO tocar la lógica viva del cierre de caja.
// =============================================================

type ExportService struct {
	db          *gorm.DB
	dashService *DashboardService
}

func NewExportService(db *gorm.DB, dashService *DashboardService) *ExportService {
	return &ExportService{db: db, dashService: dashService}
}

// ReportPayload representa los datos genéricos de un reporte para
// renderizar en PDF/Excel/CSV.
type ReportPayload struct {
	Title    string
	Subtitle string
	From     time.Time
	To       time.Time
	Headers  []string
	// Rows[i] es una fila con n columnas alineadas a Headers
	Rows [][]string
	// Totals opcional al final
	Totals []string
	// Notas/footer
	Footer string
}

// =============================================================
// Reporte: Rentabilidad y Margen Bruto
// =============================================================

type ProfitabilityRow struct {
	ProductName string  `json:"productName"`
	Barcode     string  `json:"barcode"`
	UnitsSold   float64 `json:"unitsSold"`
	GrossSales  float64 `json:"grossSales"`
	GrossCost   float64 `json:"grossCost"`
	GrossProfit float64 `json:"grossProfit"`
	MarginPct   float64 `json:"marginPct"`
	MeetsTarget bool    `json:"meetsTarget"` // margen >= TargetMargin
	IsQuickSale bool    `json:"isQuickSale"` // costo estimado con el 20% del local
}

type CreditReceivableRow struct {
	ClientName string  `json:"clientName"`
	ClientDNI  string  `json:"clientDni"`
	Phone      string  `json:"phone"`
	Balance    float64 `json:"balance"`
}

type DebtPayableRow struct {
	Concept      string  `json:"concept"`
	ProviderName string  `json:"providerName"`
	Balance      float64 `json:"balance"`
	Status       string  `json:"status"`
}

type OpExpenseRow struct {
	Date          time.Time `json:"date"`
	Category      string    `json:"category"`
	Description   string    `json:"description"`
	PaymentSource string    `json:"paymentSource"`
	Amount        float64   `json:"amount"`
}

type ProfitabilityReport struct {
	From         time.Time `json:"from"`
	To           time.Time `json:"to"`
	TargetMargin float64   `json:"targetMargin"` // ej. 0.17 = 17%

	// Totales Generales
	// TotalSales es el PASO 1: el 100% de los ingresos auditados del
	// período según los cierres de caja.
	TotalSales    float64 `json:"totalSales"`
	TotalCost     float64 `json:"totalCost"`
	GrossProfit   float64 `json:"grossProfit"`
	OverallMargin float64 `json:"overallMargin"`

	// Tramo medido con costo real de compra y margen real del negocio.
	KnownSales  float64 `json:"knownSales"`
	KnownCost   float64 `json:"knownCost"`
	KnownProfit float64 `json:"knownProfit"`
	KnownMargin float64 `json:"knownMargin"`

	// Tramo extrapolado con el margen real medido (ventas rápidas
	// MISC/0000, flujos de caja y diferencias de registro).
	UncostedSales  float64 `json:"uncostedSales"`
	UncostedCost   float64 `json:"uncostedCost"`
	UncostedProfit float64 `json:"uncostedProfit"`
	QuickSales     float64 `json:"quickSales"`

	// Trazabilidad de las fuentes de ingresos del período
	SalesFromRegister float64 `json:"salesFromRegister"` // tabla sales
	SalesFromClosures float64 `json:"salesFromClosures"` // cierres: total_sales
	SalesFromDetails  float64 `json:"salesFromDetails"`  // detalle por producto

	// Desglose de los ingresos auditados y saldos al cierre del mes
	Audited *AuditedIncome `json:"audited,omitempty"`

	// Variación patrimonial: dónde quedó la plata de la ganancia
	WorkingCapital *WorkingCapital `json:"workingCapital,omitempty"`

	// Desglose de Pagos e Ingresos
	CashSales          float64 `json:"cashSales"`
	TransferSales      float64 `json:"transferSales"`
	CreditSales        float64 `json:"creditSales"`
	CreditPaymentsCash float64 `json:"creditPaymentsCash"`
	TotalCashInflows   float64 `json:"totalCashInflows"`
	CashExpenses       float64 `json:"cashExpenses"`

	// Gastos Operativos (Excluyendo compras a proveedores)
	PublicServicesExp float64 `json:"publicServicesExp"`
	RentExp           float64 `json:"rentExp"`
	MaintenanceExp    float64 `json:"maintenanceExp"`
	PayrollExp        float64 `json:"payrollExp"`
	FinancialExp      float64 `json:"financialExp"` // cuotas de banco y obligaciones
	OtherOpExp        float64 `json:"otherOpExp"`
	TotalOpExpenses   float64 `json:"totalOpExpenses"`
	OpExpenses        float64 `json:"opExpenses"` // compatibilidad legacy

	// Lista de Gastos Operativos
	OpExpenseItems []OpExpenseRow `json:"opExpenseItems"`

	// Cartera (Plata prestada a clientes / Fiados activos)
	TotalCreditReceivable float64               `json:"totalCreditReceivable"`
	CreditReceivables     []CreditReceivableRow `json:"creditReceivables"`

	// Deudas del negocio
	TotalDebtsPayable float64          `json:"totalDebtsPayable"`
	DebtsPayable      []DebtPayableRow `json:"debtsPayable"`

	// Resultados Finales
	NetProfit      float64 `json:"netProfit"`
	NetMargin      float64 `json:"netMargin"`
	NetCashBalance float64 `json:"netCashBalance"`

	// Tabla por producto
	Rows []ProfitabilityRow `json:"rows"`
}

// GetProfitabilityReport retorna análisis detallado de rentabilidad, gastos operativos (sin proveedores), dinero prestado y flujo de dinero.
func (s *ExportService) GetProfitabilityReport(from, to time.Time, targetMargin float64) (*ProfitabilityReport, error) {
	report := &ProfitabilityReport{
		From: from, To: to, TargetMargin: targetMargin,
		CreditReceivables: []CreditReceivableRow{},
		DebtsPayable:      []DebtPayableRow{},
		OpExpenseItems:    []OpExpenseRow{},
		Rows:              []ProfitabilityRow{},
	}

	fromDateStr := from.Format("2006-01-02")
	toDateStr := to.Format("2006-01-02")

	// 1. Ventas Totales reales directamente de la tabla sales y cierres de caja en horario Colombia
	var realTotalSales float64
	s.db.Model(&models.Sale{}).
		Where(`DATE("saleDate" AT TIME ZONE 'America/Bogota') BETWEEN ? AND ?`, fromDateStr, toDateStr).
		Where(`(status IS NULL OR UPPER(status) <> 'CANCELLED')`).
		Select(`COALESCE(SUM("totalAmount"), 0)`).
		Scan(&realTotalSales)

	// Cifra informativa de los cierres de caja del período. NO se usa para
	// calcular las Ventas Totales del reporte (ver ResolveTotalSales): se
	// muestra solo como referencia de auditoría. Antes se sumaba
	// GREATEST(total_sales, physical_cash + total_card + total_transfer +
	// total_expenses), lo que duplicaba montos (total_transfer ya incluye
	// tarjeta/Nequi/Daviplata) e inflaba la cifra hasta ~$74M.
	var closureSales float64
	s.db.Model(&models.CashierClosure{}).
		Where(`DATE(end_date AT TIME ZONE 'America/Bogota') BETWEEN ? AND ?`, fromDateStr, toDateStr).
		Select(`COALESCE(SUM("total_sales"), 0)`).
		Scan(&closureSales)

	// Ventas detalladas por producto. Se separa, línea por línea, la parte
	// con costo de compra registrado de la que no lo tiene (ventas rápidas
	// MISC-/0000 o costPrice = 0).
	quickExpr := `(sd.barcode IS NULL OR TRIM(sd.barcode) = '' OR TRIM(sd.barcode) = '0000' OR UPPER(TRIM(sd.barcode)) LIKE 'MISC-%')`
	uncostedExpr := `(` + quickExpr + ` OR COALESCE(sd."costPrice", 0) <= 0)`
	groupBarcodeExpr := `CASE WHEN ` + quickExpr + ` THEN '` + QuickSaleGroupBarcode + `' ELSE sd.barcode END`
	groupNameExpr := `CASE WHEN ` + quickExpr + ` THEN '` + QuickSaleGroupName + `' ELSE COALESCE(p."productName", '(producto sin registro)') END`

	type aggRow struct {
		Barcode       string
		Name          string
		UnitsSold     float64
		GrossSales    float64
		CostedSales   float64
		KnownCost     float64
		UncostedSales float64
	}
	var rows []aggRow

	err := s.db.Table("sale_details AS sd").
		Select(groupBarcodeExpr+` AS barcode,
				`+groupNameExpr+` AS name,
				COALESCE(SUM(sd.quantity), 0) AS units_sold,
				COALESCE(SUM(sd.subtotal), 0) AS gross_sales,
				COALESCE(SUM(CASE WHEN `+uncostedExpr+` THEN 0 ELSE sd.subtotal END), 0) AS costed_sales,
				COALESCE(SUM(CASE WHEN `+uncostedExpr+` THEN 0 ELSE sd.quantity * sd."costPrice" END), 0) AS known_cost,
				COALESCE(SUM(CASE WHEN `+uncostedExpr+` THEN sd.subtotal ELSE 0 END), 0) AS uncosted_sales`).
		Joins(`JOIN sales s ON s."saleId" = sd."saleId"`).
		Joins(`LEFT JOIN products p ON p.barcode = sd.barcode`).
		Where(`DATE(s."saleDate" AT TIME ZONE 'America/Bogota') BETWEEN ? AND ?`, fromDateStr, toDateStr).
		Where(`(s.status IS NULL OR UPPER(s.status) <> 'CANCELLED')`).
		Group(groupBarcodeExpr + `, ` + groupNameExpr).
		Order(`gross_sales DESC`).
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("profitability query: %w", err)
	}

	lines := make([]ProfitLine, 0, len(rows))
	for _, r := range rows {
		lines = append(lines, ProfitLine{
			Barcode:       r.Barcode,
			Name:          r.Name,
			Units:         r.UnitsSold,
			Sales:         r.GrossSales,
			CostedSales:   r.CostedSales,
			KnownCost:     r.KnownCost,
			UncostedSales: r.UncostedSales,
		})
	}

	// PASO 1: ingresos auditados del período (100% de los cierres de caja),
	// con la misma fórmula que el PDF consolidado de cierres.
	audited, err := s.GetAuditedIncome(from, to)
	if err != nil {
		return nil, err
	}
	report.Audited = audited

	auditedIncome := audited.Total
	if auditedIncome <= 0 {
		// Sin cierres en el período: se audita lo registrado en ventas.
		auditedIncome = realTotalSales
	}

	// El costo se mide con el margen real del negocio y se extrapola al
	// resto de los ingresos auditados.
	agg := AggregateProfitAudited(lines, auditedIncome)

	for _, l := range lines {
		cost := l.CostAt(agg.KnownMargin)
		gp := l.Sales - cost
		var margin float64
		if l.Sales > 0 {
			margin = gp / l.Sales
		}
		report.Rows = append(report.Rows, ProfitabilityRow{
			ProductName: l.Name,
			Barcode:     l.Barcode,
			UnitsSold:   l.Units,
			GrossSales:  l.Sales,
			GrossCost:   cost,
			GrossProfit: gp,
			MarginPct:   margin,
			MeetsTarget: margin >= targetMargin,
			IsQuickSale: l.IsQuickSale(),
		})
	}

	report.SalesFromRegister = realTotalSales
	report.SalesFromClosures = closureSales
	report.SalesFromDetails = agg.DetailSales
	report.TotalSales = agg.AuditedIncome
	report.TotalCost = agg.TotalCost
	report.GrossProfit = agg.GrossProfit
	report.KnownSales = agg.KnownSales
	report.KnownCost = agg.KnownCost
	report.KnownProfit = agg.KnownProfit
	report.KnownMargin = agg.KnownMargin
	report.UncostedSales = agg.UncostedSales
	report.UncostedCost = agg.UncostedCost
	report.UncostedProfit = agg.UncostedProfit
	report.QuickSales = agg.QuickSales

	// 2. Desglose de Métodos de Pago e Ingresos de Dinero en el Rango
	var cashSales, transferSales, creditSales float64
	s.db.Model(&models.Sale{}).
		Where(`DATE("saleDate" AT TIME ZONE 'America/Bogota') BETWEEN ? AND ?`, fromDateStr, toDateStr).
		Where(`(status IS NULL OR UPPER(status) <> 'CANCELLED')`).
		Select(`COALESCE(SUM(GREATEST(0, "cashAmount" - change)), 0)`).
		Scan(&cashSales)

	s.db.Model(&models.Sale{}).
		Where(`DATE("saleDate" AT TIME ZONE 'America/Bogota') BETWEEN ? AND ?`, fromDateStr, toDateStr).
		Where(`(status IS NULL OR UPPER(status) <> 'CANCELLED')`).
		Select(`COALESCE(SUM("transferAmount" + "transferNequi" + "transferDaviplata"), 0)`).
		Scan(&transferSales)

	s.db.Model(&models.Sale{}).
		Where(`DATE("saleDate" AT TIME ZONE 'America/Bogota') BETWEEN ? AND ?`, fromDateStr, toDateStr).
		Where(`(status IS NULL OR UPPER(status) <> 'CANCELLED')`).
		Select(`COALESCE(SUM("creditAmount"), 0)`).
		Scan(&creditSales)

	var creditPaymentsCash float64
	s.db.Table("credit_payments").
		Where(`DATE("paymentDate" AT TIME ZONE 'America/Bogota') BETWEEN ? AND ?`, fromDateStr, toDateStr).
		Where(`deleted_at IS NULL`).
		Select(`COALESCE(SUM("amountCash"), 0)`).
		Scan(&creditPaymentsCash)

	report.CashSales = cashSales
	report.TransferSales = transferSales
	report.CreditSales = creditSales
	report.CreditPaymentsCash = creditPaymentsCash
	report.TotalCashInflows = cashSales + creditPaymentsCash

	// 3. Egresos Operativos del Local (Excluyendo compras a proveedores, recepciones y devoluciones)
	var expList []models.Expense
	s.db.Preload("Supplier").
		Where(`DATE(date AT TIME ZONE 'America/Bogota') BETWEEN ? AND ?`, fromDateStr, toDateStr).
		Where(`(status IS NULL OR UPPER(status) IN ('PAID', 'COMPLETED', 'SETTLED', ''))`).
		Where(`(reference_id IS NULL OR reference_id NOT LIKE 'RECP-%')`).
		Order(`date DESC`).
		Find(&expList)

	var cashExpenses float64
	for _, e := range expList {
		hasSupplier := e.SupplierID != nil || (e.Supplier != nil && e.Supplier.ID > 0)

		// Exclusión estricta: mercancía, pagos a proveedores, recepciones,
		// devoluciones y abonos a préstamos de inventario. Ese costo ya se
		// descontó al calcular el costo de lo vendido.
		if IsMerchandiseExpense(e.Category, e.Description, hasSupplier) {
			continue
		}

		amt := e.Amount + e.TaxAmount
		report.TotalOpExpenses += amt

		c, _, _, _, _ := parseExpenseChannels(&e)
		cashExpenses += c

		switch ClassifyOpExpense(e.Category, e.Description) {
		case OpExpenseRent:
			report.RentExp += amt
		case OpExpenseServices:
			report.PublicServicesExp += amt
		case OpExpenseMaintenance:
			report.MaintenanceExp += amt
		case OpExpensePayroll:
			report.PayrollExp += amt
		case OpExpenseFinancial:
			report.FinancialExp += amt
		default:
			report.OtherOpExp += amt
		}

		report.OpExpenseItems = append(report.OpExpenseItems, OpExpenseRow{
			Date:          e.Date,
			Category:      e.Category,
			Description:   e.Description,
			PaymentSource: e.PaymentSource,
			Amount:        amt,
		})
	}
	report.OpExpenses = report.TotalOpExpenses
	report.CashExpenses = cashExpenses

	// 4. Cartera Total Activa (Plata prestada a clientes / Fiados pendientes)
	var activeClients []models.Client
	s.db.Where(`deleted_at IS NULL AND "currentCredit" > 0`).
		Order(`"currentCredit" DESC`).
		Find(&activeClients)

	for _, c := range activeClients {
		report.TotalCreditReceivable += c.CurrentCredit
		phoneStr := c.Phone
		if phoneStr == "" {
			phoneStr = "Sin teléfono"
		}
		report.CreditReceivables = append(report.CreditReceivables, CreditReceivableRow{
			ClientName: c.Name,
			ClientDNI:  c.DNI,
			Phone:      phoneStr,
			Balance:    c.CurrentCredit,
		})
	}

	// 5. Deudas Activas del Negocio (Centro de Pagos)
	// Se replica EXACTAMENTE la consulta autoritativa del Centro de Pagos
	// (PostgresExpenseRepository.GetPendingDebtsSummary) para que el total
	// del reporte coincida con el que ve el usuario en pantalla:
	//   filtro : (status = PENDING OR paymentSource IN (PRESTAMO, PREST.))
	//            AND status NOT IN (PAID, SETTLED)
	//   saldo  : CASE WHEN remaining_amount > 0 THEN remaining_amount
	//                 ELSE amount END + tax_amount
	var pendingExps []models.Expense
	s.db.Preload("Supplier").
		Where(`(UPPER(status) = ? OR UPPER("paymentSource") IN ('PRESTAMO', 'PREST.')) AND UPPER(status) NOT IN ('PAID', 'SETTLED')`, "PENDING").
		Order(`date DESC`).
		Find(&pendingExps)

	for _, pe := range pendingExps {
		bal := pe.RemainingAmount
		if bal <= 0 {
			bal = pe.Amount
		}
		bal += pe.TaxAmount

		provName := ""
		if pe.LenderName != "" {
			provName = pe.LenderName
		} else if pe.Supplier != nil && pe.Supplier.Name != "" {
			provName = pe.Supplier.Name
		}

		concept := strings.TrimSpace(pe.Description)
		if concept == "" {
			concept = pe.Category
		}

		if provName == "" {
			if strings.Contains(concept, "-") {
				parts := strings.SplitN(concept, "-", 2)
				provName = strings.TrimSpace(parts[0])
			} else if strings.Contains(concept, "(") {
				idx := strings.Index(concept, "(")
				provName = strings.TrimSpace(concept[:idx])
			} else {
				provName = concept
			}
		}

		if provName == "" {
			provName = "Acreedor Varios"
		}

		report.TotalDebtsPayable += bal
		report.DebtsPayable = append(report.DebtsPayable, DebtPayableRow{
			Concept:      concept,
			ProviderName: provName,
			Balance:      bal,
			Status:       pe.Status,
		})
	}

	// 6. Cálculos Finales
	// Ganancia Libre = Ganancia Bruta - SOLO gastos operativos del local.
	report.NetProfit = FreeProfit(report.GrossProfit, report.TotalOpExpenses)
	if report.TotalSales > 0 {
		report.OverallMargin = report.GrossProfit / report.TotalSales
		report.NetMargin = report.NetProfit / report.TotalSales
	}
	report.NetCashBalance = report.TotalCashInflows - report.TotalOpExpenses

	// 7. Variación Patrimonial: ¿dónde quedó la plata de la ganancia?
	// Compara la fotografía del inicio del período contra la del cierre.
	var closingBalances ClosingBalances
	if report.Audited != nil {
		closingBalances = report.Audited.Closing
	}
	if wc, err := s.GetWorkingCapital(from, to, report.TotalDebtsPayable, report.NetProfit, closingBalances); err == nil {
		report.WorkingCapital = wc
	}

	return report, nil
}

// =============================================================
// Reporte: Mermas y Averías
// =============================================================

type ShrinkageRow struct {
	Date        time.Time
	ProductName string
	Reason      string
	Quantity    float64
	CostAtTime  float64
	TotalLoss   float64 // quantity * cost
	UserDNI     string
	Notes       string
}

type ShrinkageReport struct {
	From       time.Time
	To         time.Time
	Rows       []ShrinkageRow
	TotalUnits float64
	TotalLoss  float64
	ByReason   map[string]float64 // reason -> totalLoss
}

func (s *ExportService) GetShrinkageReport(from, to time.Time) (*ShrinkageReport, error) {
	rep := &ShrinkageReport{From: from, To: to, ByReason: map[string]float64{}}

	type sRow struct {
		Date        time.Time
		ProductName string
		Reason      string
		Quantity    float64
		CostAtTime  float64
		UserID      string
		Notes       string
	}
	var rows []sRow

	err := s.db.Table("shrinkages AS sh").
		Select(`sh.date,
				COALESCE(p."productName", '(producto eliminado)') AS product_name,
				sh.reason,
				sh.quantity,
				sh.cost_at_time,
				sh.user_id,
				sh.notes`).
		Joins(`LEFT JOIN products p ON p.barcode = sh.product_id`).
		Where(`sh.date BETWEEN ? AND ?`, from, to).
		Where(`sh.deleted_at IS NULL`).
		Order(`sh.date DESC`).
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("shrinkage query: %w", err)
	}

	for _, r := range rows {
		loss := r.Quantity * r.CostAtTime
		rep.Rows = append(rep.Rows, ShrinkageRow{
			Date:        r.Date,
			ProductName: r.ProductName,
			Reason:      r.Reason,
			Quantity:    r.Quantity,
			CostAtTime:  r.CostAtTime,
			TotalLoss:   loss,
			UserDNI:     r.UserID,
			Notes:       r.Notes,
		})
		rep.TotalUnits += r.Quantity
		rep.TotalLoss += loss
		rep.ByReason[r.Reason] += loss
	}
	return rep, nil
}

// =============================================================
// Reporte: Inventario Actual (snapshot + valorización)
// =============================================================

// InventoryRow es una línea del reporte de inventario. Guarda los valores
// numéricos, no cadenas formateadas, para que los totales se calculen sobre lo
// mismo que se imprime y no haya forma de que la suma no cuadre con el listado.
type InventoryRow struct {
	Barcode       string
	ProductName   string
	CategoryName  string
	Stock         float64
	MinStock      float64
	PurchasePrice float64
	SalePrice     float64
	// CostValue = Stock × PurchasePrice. Es la valorización de esta línea.
	CostValue float64
	// RetailValue = Stock × SalePrice.
	RetailValue float64
	// MarginPct sobre precio de venta: (venta - costo) / venta.
	MarginPct float64
}

// InventoryReport es el snapshot completo con su valorización.
type InventoryReport struct {
	GeneratedAt time.Time
	Rows        []InventoryRow

	// TotalProducts es cuántas referencias activas hay (no unidades).
	TotalProducts int
	// TotalUnits es la suma del stock físico.
	TotalUnits float64
	// TotalCostValue es el VALOR DEL INVENTARIO a costo: SUM(stock × compra).
	// Es la misma definición que GetGlobalInventoryValue y que el KPI del
	// dashboard.
	TotalCostValue float64
	// TotalRetailValue es el valor a precio de venta: SUM(stock × venta).
	TotalRetailValue float64
	// PotentialProfit es la utilidad bruta si se vendiera todo el stock.
	PotentialProfit float64
	// GlobalMarginPct es el margen ponderado del inventario completo.
	GlobalMarginPct float64

	// Señales de calidad del dato, para explicar por qué un total sorprende.
	NegativeStockCount int
	ZeroCostCount      int
	OutOfStockCount    int
	BelowMinStockCount int
}

// InventoryQueryRow es la fila cruda que devuelve la consulta de inventario,
// antes de calcular valorizaciones. Existe separada de InventoryRow para que la
// agregación sea una función pura y testeable sin base de datos.
type InventoryQueryRow struct {
	Barcode       string
	ProductName   string
	CategoryName  string
	Stock         float64
	MinStock      float64
	PurchasePrice float64
	SalePrice     float64
}

// GetInventoryReport arma el snapshot del inventario activo con su valorización.
//
// Antes esta consulta vivía suelta en el handler de exportación con el filtro
// `"isActive" = true`, sin traer la categoría y sin totalizar nada: el reporte
// listaba precios unitarios pero nunca decía cuánto valía el inventario, y se
// comía las filas legadas con isActive NULL. Ahora usa ports.SQLActiveProduct,
// que es el mismo predicado del KPI del dashboard.
func (s *ExportService) GetInventoryReport() (*InventoryReport, error) {
	var rows []InventoryQueryRow

	// LEFT JOIN a categories: un producto sin categoría (categoryId 0, o
	// apuntando a una categoría borrada) TIENE que seguir apareciendo en el
	// inventario. Con INNER JOIN desaparecería, que es justo la clase de fuga
	// silenciosa que este reporte ya tenía.
	//
	// El `c.deleted_at IS NULL` va en la condición del JOIN y no en el WHERE a
	// propósito: en el WHERE convertiría el LEFT JOIN en INNER y volvería a
	// perder productos. Puesto aquí, una categoría borrada simplemente cae en
	// "(sin categoría)", que es la señal de que ese producto hay que
	// recategorizarlo.
	err := s.db.Table("products AS p").
		Select(`p.barcode,
				p."productName"    AS product_name,
				COALESCE(c.name, '(sin categoría)') AS category_name,
				p.quantity         AS stock,
				COALESCE(p."minStock", 0)      AS min_stock,
				COALESCE(p."purchasePrice", 0) AS purchase_price,
				COALESCE(p."salePrice", 0)     AS sale_price`).
		Joins(`LEFT JOIN categories c ON c.id = p."categoryId" AND c.deleted_at IS NULL`).
		Where(ports.SQLActiveProductAliased("p")).
		Where(`p.deleted_at IS NULL`).
		Order(`p."productName" ASC`).
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("inventory query: %w", err)
	}

	return AggregateInventory(rows, time.Now()), nil
}

// AggregateInventory valoriza cada línea y totaliza el inventario.
//
// Es pura a propósito: el VALOR DEL INVENTARIO es la cifra por la que se pide
// este reporte, y tiene que poder verificarse con un test sin depender de
// Postgres. La invariante que sostiene es que el total del pie es exactamente la
// suma de las líneas impresas arriba.
func AggregateInventory(rows []InventoryQueryRow, generatedAt time.Time) *InventoryReport {
	rep := &InventoryReport{GeneratedAt: generatedAt}

	for _, r := range rows {
		costValue := r.Stock * r.PurchasePrice
		retailValue := r.Stock * r.SalePrice

		margin := 0.0
		if r.SalePrice > 0 {
			margin = (r.SalePrice - r.PurchasePrice) / r.SalePrice
		}

		rep.Rows = append(rep.Rows, InventoryRow{
			Barcode:       r.Barcode,
			ProductName:   r.ProductName,
			CategoryName:  r.CategoryName,
			Stock:         r.Stock,
			MinStock:      r.MinStock,
			PurchasePrice: r.PurchasePrice,
			SalePrice:     r.SalePrice,
			CostValue:     costValue,
			RetailValue:   retailValue,
			MarginPct:     margin,
		})

		rep.TotalUnits += r.Stock
		rep.TotalCostValue += costValue
		rep.TotalRetailValue += retailValue

		switch {
		case r.Stock < 0:
			rep.NegativeStockCount++
		case r.Stock == 0:
			rep.OutOfStockCount++
		}
		if r.PurchasePrice <= 0 {
			rep.ZeroCostCount++
		}
		if r.MinStock > 0 && r.Stock <= r.MinStock {
			rep.BelowMinStockCount++
		}
	}

	rep.TotalProducts = len(rep.Rows)
	rep.PotentialProfit = rep.TotalRetailValue - rep.TotalCostValue
	if rep.TotalRetailValue > 0 {
		rep.GlobalMarginPct = rep.PotentialProfit / rep.TotalRetailValue
	}

	return rep
}

// =============================================================
// Reporte: Rotación de Inventario
// =============================================================

type RotationRow struct {
	Barcode        string
	ProductName    string
	CurrentStock   float64
	UnitsSold      float64 // en el rango
	SalesValue     float64
	DaysCovered    float64 // ventas/día * stock = días de cobertura
	AvgSalesPerDay float64
	Classification string // HIGH | MEDIUM | LOW | STAGNANT (sin ventas en N días)
	LastSaleDate   *time.Time
}

type RotationReport struct {
	From              time.Time
	To                time.Time
	Rows              []RotationRow
	StagnantCount     int
	HighRotationCount int
	TotalProducts     int
}

// GetRotationReport calcula la rotación en el rango especificado.
// Clasifica:
//   - STAGNANT: sin ventas en el rango
//   - LOW: <= 1 venta/día promedio o cobertura > 60 días
//   - MEDIUM: cobertura 15-60 días
//   - HIGH: cobertura < 15 días
func (s *ExportService) GetRotationReport(from, to time.Time) (*RotationReport, error) {
	rep := &RotationReport{From: from, To: to}

	days := to.Sub(from).Hours() / 24
	if days < 1 {
		days = 1
	}

	type rRow struct {
		Barcode      string
		ProductName  string
		CurrentStock float64
		UnitsSold    float64
		SalesValue   float64
		LastSaleDate *time.Time
	}
	var rows []rRow

	// LEFT JOIN para incluir productos sin ventas (stagnant)
	err := s.db.Table("products AS p").
		Select(`p.barcode,
				p."productName" AS product_name,
				p.quantity AS current_stock,
				COALESCE(sales_agg.units, 0) AS units_sold,
				COALESCE(sales_agg.value, 0) AS sales_value,
				sales_agg.last_sale AS last_sale_date`).
		Joins(`LEFT JOIN (
			SELECT sd.barcode,
				   SUM(sd.quantity) AS units,
				   SUM(sd.subtotal) AS value,
				   MAX(s."saleDate") AS last_sale
			  FROM sale_details sd
			  JOIN sales s ON s."saleId" = sd."saleId"
			 WHERE s."saleDate" BETWEEN ? AND ?
			   AND (s.status IS NULL OR UPPER(s.status) <> 'CANCELLED')
			 GROUP BY sd.barcode
		) AS sales_agg ON sales_agg.barcode = p.barcode`, from, to).
		Where(`p."isActive" = true`).
		Where(`p.deleted_at IS NULL`).
		Order(`COALESCE(sales_agg.units, 0) DESC, p."productName" ASC`).
		Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("rotation query: %w", err)
	}

	for _, r := range rows {
		avg := r.UnitsSold / days
		var coverage float64
		if avg > 0 {
			coverage = r.CurrentStock / avg
		} else {
			coverage = 9999 // sin ventas → infinito
		}

		var class string
		switch {
		case r.UnitsSold == 0:
			class = "STAGNANT"
			rep.StagnantCount++
		case coverage < 15:
			class = "HIGH"
			rep.HighRotationCount++
		case coverage <= 60:
			class = "MEDIUM"
		default:
			class = "LOW"
		}

		rep.Rows = append(rep.Rows, RotationRow{
			Barcode:        r.Barcode,
			ProductName:    r.ProductName,
			CurrentStock:   r.CurrentStock,
			UnitsSold:      r.UnitsSold,
			SalesValue:     r.SalesValue,
			DaysCovered:    coverage,
			AvgSalesPerDay: avg,
			Classification: class,
			LastSaleDate:   r.LastSaleDate,
		})
	}
	rep.TotalProducts = len(rep.Rows)
	return rep, nil
}

// =============================================================
// Reporte: Cuadre Real (General y por Día)
// Fórmula: Balance Real = Efectivo Real + Transferencias - Egresos
// =============================================================

type RealCashCutRow struct {
	Date          time.Time
	StartDate     time.Time
	EndDate       time.Time
	ClosureID     uint
	ClosedByName  string
	PhysicalCash  float64 // Efectivo real
	NequiReal     float64
	DaviplataReal float64
	TotalTransfer float64 // suma digital
	Expenses      float64
	BalanceReal   float64 // = PhysicalCash + TotalTransfer - Expenses
	Difference    float64 // diferencia teórica registrada
}

type RealCashReport struct {
	From             time.Time
	To               time.Time
	Rows             []RealCashCutRow
	TotalPhysical    float64
	TotalTransfer    float64
	TotalExpenses    float64
	TotalBalanceReal float64
}

// GetRealCashReportByRange consolida los cierres en el rango aplicando
// la fórmula Balance Real = Efectivo Real + Transferencias - Egresos.
func (s *ExportService) GetRealCashReportByRange(from, to time.Time) (*RealCashReport, error) {
	rep := &RealCashReport{From: from, To: to}

	var closures []models.CashierClosure
	if err := s.db.
		Where(`date BETWEEN ? AND ?`, from, to).
		Order(`date ASC, id ASC`).
		Find(&closures).Error; err != nil {
		return nil, fmt.Errorf("closures query: %w", err)
	}

	for i := range closures {
		c := &closures[i]

		// FUENTE ÚNICA: mismo efectivo contado y mismos egresos de caja que el
		// historial en pantalla. Antes usaba la columna cruda PhysicalCash y
		// TotalExpenses, que en los cierres editados incluye los egresos de
		// fondo y por eso el balance salía más bajo de lo real.
		m := ComputeClosureMetrics(c)

		transfer := c.TotalNequiReal + c.TotalDaviplataReal
		balance := m.PhysicalCash + transfer - m.EgresosCaja

		rep.Rows = append(rep.Rows, RealCashCutRow{
			Date:          c.Date,
			StartDate:     c.StartDate,
			EndDate:       c.EndDate,
			ClosureID:     c.ID,
			ClosedByName:  c.ClosedByName,
			PhysicalCash:  m.PhysicalCash,
			NequiReal:     c.TotalNequiReal,
			DaviplataReal: c.TotalDaviplataReal,
			TotalTransfer: transfer,
			Expenses:      m.EgresosCaja,
			BalanceReal:   balance,
			Difference:    c.Difference,
		})
		rep.TotalPhysical += m.PhysicalCash
		rep.TotalTransfer += transfer
		rep.TotalExpenses += m.EgresosCaja
		rep.TotalBalanceReal += balance
	}
	return rep, nil
}

// GetRealCashReportByDay devuelve el cuadre real consolidado de UN solo día,
// agrupando todos los cierres de ese día y los egresos pagados en él.
func (s *ExportService) GetRealCashReportByDay(day time.Time) (*RealCashReport, error) {
	loc := day.Location()
	start := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, loc)
	end := start.Add(24*time.Hour - time.Nanosecond)
	return s.GetRealCashReportByRange(start, end)
}

// fmtMoney formatea un valor en moneda bogotana: "$ 1.234.567".
func fmtMoney(v float64) string {
	return fmtCOP(v)
}

func fmtPct(v float64) string {
	return fmtPercent(v)
}

func reverseStr(s string) string {
	r := []rune(s)
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	return string(r)
}

// GenerateProfitabilityPDF genera el PDF de rentabilidad usando la plantilla ejecutiva de 5 secciones.
func (s *ExportService) GenerateProfitabilityPDFBytes(r *ProfitabilityReport) ([]byte, error) {
	buf, err := s.GenerateProfitabilityPDF(r)
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// =============================================================
// Renderizadores PDF / Excel / CSV
// =============================================================

// RenderPDF dibuja cualquier reporte tabular con el mismo estilo
// ejecutivo del reporte de Rentabilidad: encabezado corporativo,
// títulos en azul oscuro, filas alternadas y dinero a la derecha.
func (s *ExportService) RenderPDF(p ReportPayload) ([]byte, error) {
	d := newExecPDF("L", p.Title)
	d.addPage()
	d.hero(p.Title, p.Subtitle, p.From, p.To)

	if len(p.Headers) > 0 {
		n := len(p.Headers)
		bands := map[int]bool{}
		rows := make([][]string, len(p.Rows))
		for i, row := range p.Rows {
			clean := make([]string, len(row))
			copy(clean, row)
			if isBandRow(row) {
				bands[i] = true
				for j := range clean {
					clean[j] = strings.TrimSpace(strings.Trim(clean[j], "= "))
				}
			}
			rows[i] = clean
		}

		d.table(execTable{
			Headers:  p.Headers,
			Weights:  columnWeights(p.Headers, p.Rows),
			Aligns:   columnAligns(p.Headers, p.Rows),
			Rows:     rows,
			Total:    p.Totals,
			FontSize: tableFontSize(n),
			BandRows: bands,
		})
	}

	if len(p.Rows) == 0 {
		d.hint("No hay movimientos registrados en el período seleccionado.")
	}

	if p.Footer != "" {
		d.hint(p.Footer)
	}

	buf, err := d.buffer()
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// isBandRow detecta las filas separadoras "=== TÍTULO ===".
func isBandRow(row []string) bool {
	nonEmpty := 0
	hasMarker := false
	for _, c := range row {
		t := strings.TrimSpace(c)
		if t == "" {
			continue
		}
		nonEmpty++
		if strings.HasPrefix(t, "===") {
			hasMarker = true
		}
	}
	return hasMarker && nonEmpty == 1
}

// isMoneyCell indica si el contenido de una celda es un monto.
func isMoneyCell(v string) bool {
	t := strings.TrimSpace(v)
	return strings.HasPrefix(t, "$") || strings.HasPrefix(t, "-$") ||
		strings.HasSuffix(t, "%")
}

// columnAligns alinea a la derecha las columnas de dinero/porcentaje.
func columnAligns(headers []string, rows [][]string) []string {
	aligns := make([]string, len(headers))
	for i := range headers {
		money, total := 0, 0
		for _, row := range rows {
			if i >= len(row) {
				continue
			}
			t := strings.TrimSpace(row[i])
			if t == "" || t == "-" {
				continue
			}
			total++
			if isMoneyCell(t) {
				money++
			}
		}
		if total > 0 && float64(money)/float64(total) >= 0.5 {
			aligns[i] = "R"
		} else {
			aligns[i] = "L"
		}
	}
	return aligns
}

// columnWeights reparte el ancho según el largo típico del contenido.
func columnWeights(headers []string, rows [][]string) []float64 {
	weights := make([]float64, len(headers))
	for i, h := range headers {
		maxLen := float64(len(h))
		var sum, count float64
		for _, row := range rows {
			if i >= len(row) {
				continue
			}
			l := float64(len(strings.TrimSpace(row[i])))
			sum += l
			count++
			if l > maxLen {
				maxLen = l
			}
		}
		avg := maxLen
		if count > 0 {
			avg = (sum/count)*0.65 + maxLen*0.35
		}
		if avg < 8 {
			avg = 8
		}
		if avg > 34 {
			avg = 34
		}
		weights[i] = avg
	}
	return weights
}

// tableFontSize ajusta el tamaño de letra al número de columnas.
func tableFontSize(cols int) float64 {
	switch {
	case cols >= 9:
		return 7.2
	case cols >= 7:
		return 7.8
	case cols >= 5:
		return 8.2
	default:
		return 9
	}
}

// RenderExcel genera un .xlsx con header + filas + fila de totales.
func (s *ExportService) RenderExcel(p ReportPayload) ([]byte, error) {
	f := excelize.NewFile()
	defer f.Close()

	sheet := "Reporte"
	idx, _ := f.NewSheet(sheet)
	f.SetActiveSheet(idx)
	_ = f.DeleteSheet("Sheet1")

	// colName convierte un índice (0-based) a letra de columna Excel.
	// 0=A, 25=Z, 26=AA, 27=AB, 51=AZ, 52=BA, etc.
	colName := func(i int) string {
		name := ""
		i = i + 1 // pasar a 1-indexed para el algoritmo Excel
		for i > 0 {
			i--
			name = string(rune('A'+(i%26))) + name
			i /= 26
		}
		return name
	}

	lastCol := colName(len(p.Headers) - 1)

	// Título
	f.SetCellValue(sheet, "A1", p.Title)
	f.MergeCell(sheet, "A1", lastCol+"1")

	titleStyle, _ := f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Size: 16, Color: "0F1F1A"},
		Alignment: &excelize.Alignment{Horizontal: "left", Vertical: "center"},
	})
	f.SetCellStyle(sheet, "A1", "A1", titleStyle)
	f.SetRowHeight(sheet, 1, 28)

	// Subtítulo
	if p.Subtitle != "" {
		f.SetCellValue(sheet, "A2", p.Subtitle)
		f.MergeCell(sheet, "A2", lastCol+"2")
		subtitleStyle, _ := f.NewStyle(&excelize.Style{
			Font:      &excelize.Font{Italic: true, Size: 10, Color: "646464"},
			Alignment: &excelize.Alignment{Horizontal: "left"},
		})
		f.SetCellStyle(sheet, "A2", "A2", subtitleStyle)
	}

	headerRow := 4
	if !p.From.IsZero() && !p.To.IsZero() {
		f.SetCellValue(sheet, "A3", fmt.Sprintf("Rango: %s a %s",
			p.From.Format("02/01/2006"), p.To.Format("02/01/2006")))
		f.MergeCell(sheet, "A3", lastCol+"3")
		headerRow = 4
	}

	// Headers
	headerStyle, _ := f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Color: "FFFFFF", Size: 11},
		Fill:      excelize.Fill{Type: "pattern", Color: []string{"10B981"}, Pattern: 1},
		Alignment: &excelize.Alignment{Horizontal: "center", Vertical: "center"},
		Border: []excelize.Border{
			{Type: "left", Color: "0A0F0D", Style: 1},
			{Type: "right", Color: "0A0F0D", Style: 1},
			{Type: "top", Color: "0A0F0D", Style: 1},
			{Type: "bottom", Color: "0A0F0D", Style: 1},
		},
	})

	for i, h := range p.Headers {
		col := colName(i)
		cell := fmt.Sprintf("%s%d", col, headerRow)
		f.SetCellValue(sheet, cell, h)
		f.SetCellStyle(sheet, cell, cell, headerStyle)
	}
	f.SetRowHeight(sheet, headerRow, 22)

	// Filas
	rowStyle, _ := f.NewStyle(&excelize.Style{
		Border: []excelize.Border{
			{Type: "left", Color: "DCDCDC", Style: 1},
			{Type: "right", Color: "DCDCDC", Style: 1},
			{Type: "bottom", Color: "DCDCDC", Style: 1},
		},
	})
	for ri, row := range p.Rows {
		for ci, cell := range row {
			col := colName(ci)
			pos := fmt.Sprintf("%s%d", col, headerRow+1+ri)
			f.SetCellValue(sheet, pos, cell)
			f.SetCellStyle(sheet, pos, pos, rowStyle)
		}
	}

	// Totales
	if len(p.Totals) > 0 {
		totalRow := headerRow + 1 + len(p.Rows)
		totalStyle, _ := f.NewStyle(&excelize.Style{
			Font: &excelize.Font{Bold: true, Color: "FFFFFF"},
			Fill: excelize.Fill{Type: "pattern", Color: []string{"059669"}, Pattern: 1},
		})
		for i, t := range p.Totals {
			col := colName(i)
			pos := fmt.Sprintf("%s%d", col, totalRow)
			f.SetCellValue(sheet, pos, t)
			f.SetCellStyle(sheet, pos, pos, totalStyle)
		}
	}

	// Auto width aproximado
	for i := range p.Headers {
		col := colName(i)
		f.SetColWidth(sheet, col, col, 22)
	}

	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		return nil, fmt.Errorf("xlsx write: %w", err)
	}
	return buf.Bytes(), nil
}

// RenderCSV genera CSV sencillo para descargas livianas.
func (s *ExportService) RenderCSV(p ReportPayload) ([]byte, error) {
	var b strings.Builder
	b.WriteString(p.Title + "\n")
	if p.Subtitle != "" {
		b.WriteString(p.Subtitle + "\n")
	}
	if !p.From.IsZero() && !p.To.IsZero() {
		b.WriteString(fmt.Sprintf("Rango,%s,%s\n",
			p.From.Format("2006-01-02"), p.To.Format("2006-01-02")))
	}
	b.WriteString("\n")
	b.WriteString(strings.Join(escapeCSVRow(p.Headers), ",") + "\n")
	for _, r := range p.Rows {
		b.WriteString(strings.Join(escapeCSVRow(r), ",") + "\n")
	}
	if len(p.Totals) > 0 {
		b.WriteString(strings.Join(escapeCSVRow(p.Totals), ",") + "\n")
	}
	if p.Footer != "" {
		b.WriteString("\n" + p.Footer + "\n")
	}
	return []byte(b.String()), nil
}

// GetExpensesReport retorna los egresos filtrados por rango de fechas y opcionalmente por concepto
func (s *ExportService) GetExpensesReport(from, to time.Time, concept string) ([]models.Expense, error) {
	var expenses []models.Expense
	query := s.db.Preload("Creator").
		Where(`date BETWEEN ? AND ?`, from, to)

	if concept != "" {
		query = query.Where(`description ILIKE ?`, "%"+concept+"%")
	}

	err := query.Order(`date ASC`).Find(&expenses).Error
	return expenses, err
}

// =============================================================
// Helpers
// =============================================================

func escapeCSVRow(row []string) []string {
	out := make([]string, len(row))
	for i, c := range row {
		if strings.ContainsAny(c, ",\"\n") {
			c = `"` + strings.ReplaceAll(c, `"`, `""`) + `"`
		}
		out[i] = c
	}
	return out
}

// sanitizePDF reemplaza símbolos no soportados por cp1252 (em-dash, emojis,
// etc.) por equivalentes ASCII. Las tildes y eñe se preservan tal cual; el
// `UnicodeTranslator` de gofpdf se encarga de mapearlos a Latin-1.
func sanitizePDF(s string) string {
	repl := strings.NewReplacer(
		"—", "-",
		"–", "-",
		"…", "...",
		"•", "*",
		"⚠️", "[!]",
		"⚠", "[!]",
		"✅", "[OK]",
		"❌", "[X]",
		"€", "EUR",
		"\u00a0", " ", // nbsp
	)
	out := repl.Replace(s)
	// Filtrar emojis y caracteres > U+FFFF (BMP astral) que cp1252 no cubre.
	// Latin-1 (cp1252) llega hasta U+00FF; sin embargo el UnicodeTranslator
	// también soporta algunos extras como "™", €, etc.
	var b strings.Builder
	for _, r := range out {
		if r > 0x017F && (r < 0x2018 || r > 0x201D) {
			// Fuera del rango Latin Extended-A y de las comillas tipográficas
			// que cp1252 sí mapea: sustituir por '?'.
			b.WriteRune('?')
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// IOReader returns an io.Reader from bytes (for telegram).
func BytesReader(b []byte) io.Reader { return bytes.NewReader(b) }
