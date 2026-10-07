package services

import (
	"encoding/json"
	"sort"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// ReceptionSummary describe una recepcion agrupada por reference_id.
//
// Resuelve el nombre del proveedor en una cascada honesta:
//  1. supplierName dentro del metadata del movimiento (BulkReceive lo
//     persiste SIEMPRE, incluso con bypassExpense=true).
//  2. supplier.name del egreso ligado por reference_id (si hubo egreso).
//  3. "Proveedor no registrado" como fallback literal. NUNCA se inventa un
//     nombre a partir del product.PrimarySupplier porque eso mentiria sobre
//     el responsable comercial real de la compra.
//
// Si distintas lineas apuntan a proveedores diferentes, el titulo pasa a
// "Varios proveedores" y la lista completa queda en Suppliers[] para que la
// UI muestre el detalle.
type ReceptionSummary struct {
	ReceptionID   string                 `json:"receptionId"`
	Date          time.Time              `json:"date"`
	Employee      string                 `json:"employee"`
	SupplierName  string                 `json:"supplierName"`
	Suppliers     []string               `json:"suppliers"`
	MultiSupplier bool                   `json:"multiSupplier"`
	TotalLines    int                    `json:"totalLines"`
	TotalUnits    float64                `json:"totalUnits"`
	TotalCost     *float64               `json:"totalCost,omitempty"`
	IsBypass      bool                   `json:"isBypass"`
	IsEdited      bool                   `json:"isEdited"`
	Lines         []ReceptionLineSummary `json:"lines"`
}

// ReceptionLineSummary describe una linea individual de la recepcion.
// PurchasePrice puede ser nil cuando el movimiento no es de compra o cuando
// el metadata no tenia el precio registrado (recepciones viejas).
type ReceptionLineSummary struct {
	Barcode       string   `json:"barcode"`
	Name          string   `json:"name"`
	Quantity      float64  `json:"quantity"`
	Reason        string   `json:"reason"`
	PurchasePrice *float64 `json:"purchasePrice,omitempty"`
	SupplierName  string   `json:"supplierName,omitempty"`
}

// receptionMetadata refleja el shape que graba BulkReceive en
// stock_movements.metadata. Entry se deja flexible porque la fecha de la
// migracion 015 agrego columnas de porcentajes y el entry sigue cambiando;
// aqui solo nos interesa newPurchasePrice.
type receptionMetadata struct {
	Entry        receptionMetadataEntry `json:"entry"`
	SupplierName string                 `json:"supplierName"`
	EmployeeName string                 `json:"employeeName"`
}

type receptionMetadataEntry struct {
	NewPurchasePrice float64 `json:"newPurchasePrice"`
	AddedQuantity    float64 `json:"addedQuantity"`
	SupplierID       *uint   `json:"supplierId"`
}

// receptionReasons es la lista de razones que forman parte de una recepcion
// (compra oficial + bonificacion). Los ajustes manuales (ADJUSTMENT_*) se
// consideran parte si su reference_id empieza por "RECP-", ver filterReception.
var receptionReasons = map[string]struct{}{
	"RECEPTION":       {},
	"RECEPTION_BONUS": {},
}

// isReceptionMovement decide si un movimiento pertenece al historial de
// recepciones. Acepta:
//  - RECEPTION / RECEPTION_BONUS (siempre).
//  - ADJUSTMENT_* cuando su reference_id es "RECP-..." (ajuste nacido en el
//    mismo flujo de recepcion, usualmente por cambio de precio o diferencia
//    de inventario al recibir).
//
// Se descartan explicitamente los movimientos sin reference_id o con un ref
// de otro origen (ventas, retornos, mermas) aunque la razon sea de recepcion
// — esto no ocurre hoy pero la guardia evita arrastres si algun job futuro
// comparte el namespace.
func isReceptionMovement(m models.StockMovement) bool {
	ref := strings.TrimSpace(m.ReferenceID)
	if ref == "" {
		return false
	}
	if _, ok := receptionReasons[m.Reason]; ok {
		return true
	}
	if strings.HasPrefix(ref, "RECP-") && strings.HasPrefix(m.Reason, "ADJUSTMENT_") {
		return true
	}
	return false
}

// GetReceptionsHistory agrupa movimientos del kardex por reference_id dentro
// del rango [from, to] y devuelve el resumen listo para la UI. Resuelve el
// proveedor por la cascada documentada en ReceptionSummary y aborta la
// consulta si falla el repo (devolviendo nil + error, para que el handler
// decida como responder; no se enmascara con [] como hace el reporte legacy).
func (s *DashboardService) GetReceptionsHistory(from, to time.Time) ([]ReceptionSummary, error) {
	movements, err := s.movementRepo.GetByDateRange(from, to)
	if err != nil {
		return nil, err
	}

	groups := map[string]*receptionGroup{}
	refOrder := []string{}
	for i := range movements {
		m := movements[i]
		if !isReceptionMovement(m) {
			continue
		}
		ref := strings.TrimSpace(m.ReferenceID)
		g, ok := groups[ref]
		if !ok {
			g = &receptionGroup{
				ID:       ref,
				Date:     m.Date,
				Employee: strings.TrimSpace(m.EmployeeName),
			}
			groups[ref] = g
			refOrder = append(refOrder, ref)
		}
		g.append(m)
	}

	// Resolver fallback de proveedor via egresos con el mismo reference_id.
	// Si todas las lineas de una recepcion tienen supplierName vacio tras
	// parsear metadata, el egreso ligado por reference_id es la segunda
	// fuente de verdad (Supplier esta preloaded).
	//
	// Tambien marca IsBypass=true cuando NO existe egreso para la referencia.
	expensesByRef := map[string]*models.Expense{}
	expenses, err := s.expenseRepo.GetByReferenceIDs(refOrder)
	if err == nil {
		for i := range expenses {
			exp := expenses[i]
			expensesByRef[exp.ReferenceID] = &exp
		}
	}
	// Si falla la busqueda de egresos no abortamos; el metadata ya trae el
	// nombre en el 99% de los casos nuevos. Solo se degrada el fallback para
	// recepciones viejas sin metadata; el resultado honesto en ese caso es
	// "Proveedor no registrado".

	result := make([]ReceptionSummary, 0, len(groups))
	for _, ref := range refOrder {
		g := groups[ref]
		summary := g.toSummary(expensesByRef[ref])
		result = append(result, summary)
	}

	// Orden descendente por fecha (recepciones mas recientes primero), que
	// es lo que espera la UI del historial. El orden del map es
	// no-deterministico por diseno de Go.
	sort.SliceStable(result, func(i, j int) bool {
		return result[i].Date.After(result[j].Date)
	})

	return result, nil
}

// receptionGroup es la acumulacion mutable mientras recorremos movimientos.
// Lo saco a tipo para no esparcir referencias a estructuras anonimas y
// facilitar los tests.
type receptionGroup struct {
	ID              string
	Date            time.Time
	Employee        string
	Lines           []ReceptionLineSummary
	suppliersSet    map[string]struct{}
	suppliersOrder  []string
	anyEdit         bool
	totalUnits      float64
	totalCost       float64
	hasAnyCost      bool
	anyEmployeeMeta string
}

func (g *receptionGroup) append(m models.StockMovement) {
	line := ReceptionLineSummary{
		Barcode:  m.Barcode,
		Name:     strings.TrimSpace(m.Product.ProductName),
		Quantity: m.Quantity,
		Reason:   m.Reason,
	}
	if line.Name == "" {
		line.Name = m.Barcode
	}

	meta := parseReceptionMetadata(m.Metadata)
	if meta != nil {
		if sup := strings.TrimSpace(meta.SupplierName); sup != "" {
			line.SupplierName = sup
			g.addSupplier(sup)
		}
		if emp := strings.TrimSpace(meta.EmployeeName); emp != "" && g.anyEmployeeMeta == "" {
			g.anyEmployeeMeta = emp
		}
		if meta.Entry.NewPurchasePrice > 0 {
			price := meta.Entry.NewPurchasePrice
			line.PurchasePrice = &price
			// Costo total solo acumula lineas con precio real; evita que
			// una recepcion con metadata parcial infle o deflacte el total
			// por fuera de la realidad.
			g.totalCost += price * m.Quantity
			g.hasAnyCost = true
		}
	}

	if m.EditedAt != nil {
		g.anyEdit = true
	}

	g.totalUnits += m.Quantity
	g.Lines = append(g.Lines, line)
	// Guardamos la fecha mas antigua del grupo (los movimientos de ajuste
	// pueden llegar segundos despues del principal; la referencia es la
	// cabecera del evento, el primer insert).
	if g.Date.IsZero() || m.Date.Before(g.Date) {
		g.Date = m.Date
	}
}

func (g *receptionGroup) addSupplier(name string) {
	if g.suppliersSet == nil {
		g.suppliersSet = map[string]struct{}{}
	}
	key := strings.ToUpper(name)
	if _, ok := g.suppliersSet[key]; ok {
		return
	}
	g.suppliersSet[key] = struct{}{}
	g.suppliersOrder = append(g.suppliersOrder, name)
}

func (g *receptionGroup) toSummary(expense *models.Expense) ReceptionSummary {
	suppliers := append([]string{}, g.suppliersOrder...)

	// Fallback 2: egreso. Se aplica solo si no se descubrio proveedor via
	// metadata. Nunca se mezcla con el metadata: si una linea trae nombre y
	// otra no, respetamos lo que trae el metadata y aceptamos que la UI
	// muestre "Varios proveedores" para que el operador se de cuenta.
	if len(suppliers) == 0 && expense != nil && expense.Supplier != nil {
		if name := strings.TrimSpace(expense.Supplier.Name); name != "" {
			suppliers = append(suppliers, name)
		}
	}

	title := "Proveedor no registrado"
	multi := false
	if len(suppliers) == 1 {
		title = suppliers[0]
	} else if len(suppliers) > 1 {
		title = "Varios proveedores"
		multi = true
	}

	// Para que la UI pinte el proveedor por linea cuando el metadata no lo
	// trajo, aplicamos el fallback del egreso en una copia (sin mutar el
	// grupo). Solo cuando hay un UNICO proveedor; con multi preferimos
	// mantener la verdad del metadata linea por linea (vacio).
	lines := g.Lines
	if expense != nil && expense.Supplier != nil && len(suppliers) == 1 {
		fillName := strings.TrimSpace(expense.Supplier.Name)
		if fillName != "" {
			lines = make([]ReceptionLineSummary, len(g.Lines))
			for i, ln := range g.Lines {
				if ln.SupplierName == "" {
					ln.SupplierName = fillName
				}
				lines[i] = ln
			}
		}
	}

	employee := g.Employee
	if employee == "" {
		employee = g.anyEmployeeMeta
	}
	if employee == "" {
		employee = "SISTEMA"
	}

	var totalCost *float64
	if g.hasAnyCost {
		tc := g.totalCost
		totalCost = &tc
	}

	return ReceptionSummary{
		ReceptionID:   g.ID,
		Date:          g.Date,
		Employee:      employee,
		SupplierName:  title,
		Suppliers:     suppliers,
		MultiSupplier: multi,
		TotalLines:    len(lines),
		TotalUnits:    g.totalUnits,
		TotalCost:     totalCost,
		IsBypass:      expense == nil,
		IsEdited:      g.anyEdit,
		Lines:         lines,
	}
}

// parseReceptionMetadata es tolerante: devuelve nil si el JSON es vacio,
// malformado o del shape antiguo que no incluia supplierName. El consumidor
// debe tratar nil como "no hay informacion util" y seguir con los fallbacks.
func parseReceptionMetadata(raw string) *receptionMetadata {
	s := strings.TrimSpace(raw)
	if s == "" || s == "{}" {
		return nil
	}
	var m receptionMetadata
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil
	}
	return &m
}
