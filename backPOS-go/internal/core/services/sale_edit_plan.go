package services

import (
	"errors"
	"fmt"
	"math"
	"strings"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// EDICIÓN DIRECTA DE VENTAS DESDE EL HISTORIAL
// ============================================================================
//
// El dueño autorizó que /sales/add-items/:id permita SUMAR y RESTAR productos
// sin redirigir las reducciones a devoluciones. El contrato es:
//
//   items[]: cada item lleva quantity FIRMADA no cero. Positivo agrega,
//            negativo quita.
//   cashAmount, transferAmount, transferNequi, transferDaviplata,
//   creditAmount: magnitudes POSITIVAS que llegan del modal. El servicio
//                 determina el signo según el delta monetario neto:
//                   delta > 0 → suman al canal
//                   delta < 0 → restan del canal
//                   delta = 0 → exige pago cero
//
// Estas funciones son PURAS: no tocan base de datos. La transacción y los
// locks viven en el servicio (SaleService.AddItemsToSale). Estas piezas
// pueden testearse sin GORM ni fixtures.
// ============================================================================

// SaleEditPaymentTolerance define cuántos pesos de diferencia se aceptan
// entre la suma de magnitudes de pago y |deltaMonetario|. Coincide con la
// tolerancia general del sistema (ver TransferBreakdownTolerance).
const SaleEditPaymentTolerance = 5.0

// SaleEditItemInput es el ítem tal como lo recibe el servicio antes de
// resolver precios y stock.
type SaleEditItemInput struct {
	Barcode  string
	Quantity float64 // FIRMADA: positivo agrega, negativo quita
	// Precios opcionales para productos MISC (barcode empieza con MISC- o "0000").
	MISCUnitPrice float64
	MISCCostPrice float64
}

// SaleEditLine es el resultado de resolver un item contra el detalle
// existente y el catálogo. Se usa para decidir qué persistir.
type SaleEditLine struct {
	Barcode       string
	StockBarcode  string  // barcode base para ajuste de stock (packs → base)
	IsMISC        bool    // true para MISC-*/0000
	IsExisting    bool    // había un detalle previo con este barcode
	OldQuantity   float64 // cantidad previa (0 si nueva línea)
	Delta         float64 // cambio firmado en cantidad de detalle
	FinalQuantity float64 // OldQuantity + Delta; >= 0 siempre
	UnitPrice     float64 // precio histórico para líneas existentes; precio actual para nuevas
	CostPrice     float64
	OldSubtotal   float64 // subtotal previo (0 si nueva línea)
	NewSubtotal   float64 // subtotal después del edit
	// EffectiveStockDelta es el cambio firmado en el stock físico (packs
	// expandidos al producto base). Positivo descuenta stock (venta),
	// negativo repone stock (edición hacia abajo).
	EffectiveStockDelta float64
	// DeleteDetail es true si FinalQuantity==0 y hay que borrar el detalle.
	DeleteDetail bool
	// CreateDetail es true si no había detalle previo (nueva línea).
	CreateDetail bool
}

// SaleEditPlan agrega todas las líneas resueltas y calcula el delta monetario
// neto y el ajuste de stock por barcode.
type SaleEditPlan struct {
	Lines         []SaleEditLine
	MonetaryDelta float64            // Σ (NewSubtotal - OldSubtotal)
	StockDelta    map[string]float64 // firmado por barcode base
}

// BuildSaleEditPlan resuelve la solicitud de edición contra el estado actual
// del detalle y del catálogo, y devuelve un plan puro y validable.
//
// Reglas críticas (todas testeadas):
//  1. Un item con quantity == 0 se rechaza (no hay cambio real que aplicar).
//  2. Para barcode YA EXISTENTE en el detalle: se usa UnitPrice/CostPrice
//     históricos del detalle. No se repricion líneas.
//  3. Para barcode NUEVO: se usa SalePrice/PurchasePrice del catálogo.
//  4. La cantidad final nunca puede ser negativa.
//  5. Si la cantidad final es cero, la línea se marca para eliminación.
//  6. Los packs expanden Delta a la base con PackMultiplier.
//  7. Items MISC-*/0000 no ajustan stock ni requieren catálogo.
//  8. Se agrupan deltas duplicados: si dos items apuntan al mismo barcode,
//     se acumulan.
func BuildSaleEditPlan(
	existingDetails []models.SaleDetail,
	items []SaleEditItemInput,
	productLookup map[string]*models.Product,
) (SaleEditPlan, error) {
	plan := SaleEditPlan{StockDelta: map[string]float64{}}

	// Indexar detalle existente por barcode.
	byBarcode := make(map[string]*models.SaleDetail, len(existingDetails))
	for i := range existingDetails {
		d := &existingDetails[i]
		byBarcode[d.Barcode] = d
	}

	// Agrupar items por barcode: dos entradas del mismo producto se suman.
	grouped := make(map[string]*SaleEditItemInput, len(items))
	order := make([]string, 0, len(items))
	for i := range items {
		in := items[i]
		barcode := strings.TrimSpace(in.Barcode)
		if barcode == "" {
			return plan, errors.New("barcode vacío en items")
		}
		if in.Quantity == 0 {
			return plan, fmt.Errorf("cantidad cero no permitida (barcode %s): use quantity firmada distinta de cero", barcode)
		}
		if existing, ok := grouped[barcode]; ok {
			existing.Quantity += in.Quantity
			// Precios MISC del último no ganan silenciosamente; mantenemos el primero.
			continue
		}
		grouped[barcode] = &SaleEditItemInput{
			Barcode:       barcode,
			Quantity:      in.Quantity,
			MISCUnitPrice: in.MISCUnitPrice,
			MISCCostPrice: in.MISCCostPrice,
		}
		order = append(order, barcode)
	}

	for _, barcode := range order {
		in := grouped[barcode]
		line, err := buildSaleEditLine(*in, byBarcode[barcode], productLookup)
		if err != nil {
			return plan, err
		}
		plan.Lines = append(plan.Lines, line)
		plan.MonetaryDelta += line.NewSubtotal - line.OldSubtotal
		if !line.IsMISC && line.StockBarcode != "" && line.EffectiveStockDelta != 0 {
			plan.StockDelta[line.StockBarcode] += line.EffectiveStockDelta
		}
	}

	return plan, nil
}

func buildSaleEditLine(
	in SaleEditItemInput,
	existing *models.SaleDetail,
	productLookup map[string]*models.Product,
) (SaleEditLine, error) {
	line := SaleEditLine{
		Barcode:      in.Barcode,
		StockBarcode: in.Barcode,
		Delta:        in.Quantity,
	}
	isMISC := strings.HasPrefix(in.Barcode, "MISC-") || in.Barcode == "0000"
	line.IsMISC = isMISC

	if existing != nil {
		// Barcode existente: usa precio histórico, NUNCA se reprice.
		line.IsExisting = true
		line.OldQuantity = existing.Quantity
		line.UnitPrice = existing.UnitPrice
		line.CostPrice = existing.CostPrice
		line.OldSubtotal = existing.Subtotal
	} else {
		// Línea nueva.
		line.CreateDetail = true
		if isMISC {
			if in.MISCUnitPrice <= 0 {
				return line, fmt.Errorf("MISC %s requiere precio unitario", in.Barcode)
			}
			line.UnitPrice = in.MISCUnitPrice
			line.CostPrice = in.MISCCostPrice
		} else {
			product, ok := productLookup[in.Barcode]
			if !ok || product == nil {
				return line, fmt.Errorf("producto no encontrado: %s", in.Barcode)
			}
			line.UnitPrice = product.SalePrice
			line.CostPrice = product.PurchasePrice
		}
	}

	line.FinalQuantity = line.OldQuantity + line.Delta
	if line.FinalQuantity < -0.0001 {
		return line, fmt.Errorf("cantidad final negativa para %s: %.2f + (%.2f) = %.2f", in.Barcode, line.OldQuantity, line.Delta, line.FinalQuantity)
	}
	if line.FinalQuantity < 0.0001 {
		line.FinalQuantity = 0
		line.DeleteDetail = line.IsExisting
	}

	// Recalcular subtotal con precio histórico (o actual, para nuevas).
	if line.FinalQuantity <= 0 {
		line.NewSubtotal = 0
	} else {
		line.NewSubtotal = roundSaleLineSubtotal(line.UnitPrice, line.FinalQuantity)
	}

	// Ajuste de stock: solo si NO es MISC.
	if !isMISC {
		// Resolver base product si es pack.
		product := productLookup[in.Barcode]
		if product == nil && existing != nil && existing.Product.Barcode != "" {
			product = &existing.Product
		}
		effectiveDelta := line.Delta
		stockBarcode := in.Barcode
		if product != nil && product.IsPack && product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" {
			stockBarcode = *product.BaseProductBarcode
			effectiveDelta = line.Delta * float64(product.PackMultiplier)
		}
		line.StockBarcode = stockBarcode
		// Convención de BatchAdjustQuantitiesWithTx: `quantity = quantity - delta`.
		// Delta positivo (agrega venta) descuenta stock; delta negativo (quita
		// venta) repone stock.
		line.EffectiveStockDelta = effectiveDelta
	}

	return line, nil
}

// PaymentEditRequest son las magnitudes positivas que llegan del modal.
//
// SEMÁNTICA DE TransferAmount: es el TOTAL de transferencias, es decir
// genérico + Nequi + Daviplata. Es la MISMA convención que usan
// models.Sale.TransferAmount, SaleChannelBalances.TransferAmount y el
// payload que arma el frontend (buildEditSalePayload). La porción
// "genérica" (Bancolombia, tarjeta, otros) se DERIVA restando el
// desglose: generic = TransferAmount − TransferNequi − TransferDaviplata.
//
// Tratar TransferAmount como un canal adicional al desglose contaría el
// dinero dos veces y haría rebotar toda edición con pago digital.
type PaymentEditRequest struct {
	CashAmount        float64
	TransferAmount    float64 // TOTAL: genérico + Nequi + Daviplata
	TransferNequi     float64
	TransferDaviplata float64
	TransferSource    string
	CreditAmount      float64
}

// splitTransferRequest normaliza el bloque de transferencias del request y
// devuelve la porción genérica y el total efectivo.
//
// Casos que cubre:
//   - Total >= desglose: generic = total − desglose (caso normal).
//   - Total ausente (0) con desglose presente: cliente legacy que sólo manda
//     el desglose. El total se deriva del desglose y generic = 0.
//   - Total < desglose (payload incoherente por redondeo o bug del cliente):
//     el desglose manda, generic = 0 y el total se corrige hacia arriba. No
//     se rechaza: perder la edición es peor que absorber ruido de centavos,
//     y el desglose es el dato que el dueño concilia contra los celulares.
func splitTransferRequest(req PaymentEditRequest) (generic, total float64) {
	breakdown := req.TransferNequi + req.TransferDaviplata
	total = req.TransferAmount
	if total < breakdown {
		// Incluye el caso total == 0 con desglose presente.
		total = breakdown
	}
	generic = total - breakdown
	if generic < 0 {
		generic = 0
	}
	return generic, total
}

// PaymentEditPlan es el resultado firmado que se aplica a los campos de la
// venta (sale.CashAmount, sale.TransferAmount, sale.CreditAmount, etc.).
type PaymentEditPlan struct {
	// Deltas firmados. Se SUMAN al campo correspondiente de la venta.
	CashDelta float64
	// TransferDelta es el delta de la porción GENÉRICA de transferencias
	// (Bancolombia, tarjeta, otros): NO incluye Nequi ni Daviplata. El
	// llamador debe reconstruir el total de la venta como
	// generic + TransferNequi + TransferDaviplata.
	TransferDelta  float64
	NequiDelta     float64
	DaviplataDelta float64
	CreditDelta    float64
	// TransferSource nuevo (opcional): solo se sobrescribe si el request lo trae.
	TransferSource string
	// Direction identifica el signo aplicado: "add", "subtract" o "zero".
	Direction string
}

// SaleChannelBalances son los saldos actuales de la venta que se validan
// contra los deltas para asegurar que ningún canal quede negativo.
type SaleChannelBalances struct {
	CashAmount        float64
	TransferAmount    float64
	TransferNequi     float64
	TransferDaviplata float64
	CreditAmount      float64
	// DebtPending permite validar que la reducción de crédito no baje debajo
	// de lo ya abonado (alreadyPaid = CreditAmount - DebtPending).
	DebtPending float64
	CreditLimit float64 // cero significa "sin límite conocido" (no bloquea)
	// CurrentCredit del cliente, para validar que un aumento no supere el
	// límite. Se pasa por separado porque puede haber otras deudas.
	CurrentCredit float64
}

// BuildPaymentEditPlan reparte las magnitudes del request según el signo del
// delta monetario neto y valida:
//   - Neto cero exige suma de magnitudes cero.
//   - Suma de magnitudes debe cuadrar con |delta| dentro de la tolerancia
//     (para permitir sobre-pago que se convierte en cambio de efectivo).
//   - Ningún canal (cash/nequi/davi/generic transfer/credit) queda negativo.
//   - Al restar de crédito, no se baja de lo ya abonado.
//   - Al sumar en crédito, no se supera el límite del cliente.
//
// Reglas específicas del delta positivo (venta crece):
//   - La suma de pagos debe cubrir |delta| (con tolerancia): igual que la
//     validación original de "pago adicional insuficiente".
//   - Se acepta sobre-pago cuando hay efectivo: el excedente aparece en el
//     Change (recalculado por el llamador).
//
// Reglas específicas del delta negativo (venta baja):
//   - La suma de pagos representa el reembolso a devolver al cliente.
//   - Debe cuadrar con |delta| dentro de tolerancia.
//   - Cada canal (cash/nequi/davi/generic/credit) tras restar no puede ser
//     negativo respecto a los saldos previos de la venta.
func BuildPaymentEditPlan(
	monetaryDelta float64,
	req PaymentEditRequest,
	current SaleChannelBalances,
) (PaymentEditPlan, error) {
	plan := PaymentEditPlan{TransferSource: strings.TrimSpace(req.TransferSource)}

	// Sanitización: magnitudes negativas son bug del payload; rechazamos.
	if req.CashAmount < 0 || req.TransferAmount < 0 || req.TransferNequi < 0 ||
		req.TransferDaviplata < 0 || req.CreditAmount < 0 {
		return plan, errors.New("los montos del modal deben ser magnitudes positivas")
	}

	// Separar la porción genérica del desglose. TransferAmount es el TOTAL,
	// así que sumarlo junto a Nequi/Daviplata contaría el dinero dos veces.
	transferGeneric, transferTotal := splitTransferRequest(req)

	// Suma neta de magnitudes: efectivo + TOTAL de transferencias + crédito.
	// El desglose ya está dentro de transferTotal.
	magnitudeSum := req.CashAmount +
		transferTotal +
		req.CreditAmount

	absDelta := math.Abs(monetaryDelta)

	// Caso 1: neto cero. Ni pagos ni reembolsos.
	if absDelta < SaleEditPaymentTolerance {
		if magnitudeSum > SaleEditPaymentTolerance {
			return plan, fmt.Errorf("delta neto cero: no debe registrarse pago (recibido $%.2f)", magnitudeSum)
		}
		plan.Direction = "zero"
		return plan, nil
	}

	// Caso 2: delta positivo → suma de pagos.
	if monetaryDelta > 0 {
		// El pago debe cubrir el delta. Aceptamos sobre-pago en efectivo
		// (se refleja como cambio recalculado por el llamador).
		if magnitudeSum+SaleEditPaymentTolerance < absDelta {
			return plan, fmt.Errorf("pago adicional insuficiente: delta $%.2f, pagado $%.2f", absDelta, magnitudeSum)
		}
		// Sobre-pago solo se permite en efectivo (change del cajero); en el
		// resto de canales sería una anomalía.
		nonCashSum := transferTotal + req.CreditAmount
		if nonCashSum-absDelta > SaleEditPaymentTolerance && req.CashAmount == 0 {
			return plan, fmt.Errorf("sobre-pago en canales digitales sin efectivo: delta $%.2f, no-efectivo $%.2f", absDelta, nonCashSum)
		}

		plan.CashDelta = req.CashAmount
		// TransferDelta es la porción GENÉRICA (no Nequi/Daviplata). El
		// llamador reconstruye el total como generic + nequi + daviplata.
		plan.TransferDelta = transferGeneric
		plan.NequiDelta = req.TransferNequi
		plan.DaviplataDelta = req.TransferDaviplata
		plan.CreditDelta = req.CreditAmount
		plan.Direction = "add"

		if req.CreditAmount > 0 {
			// El nuevo saldo del cliente no puede superar el límite.
			newCurrentCredit := current.CurrentCredit + req.CreditAmount
			if current.CreditLimit > 0 && newCurrentCredit > current.CreditLimit+0.01 {
				return plan, fmt.Errorf("límite de crédito superado: actual $%.2f + nuevo $%.2f > límite $%.2f",
					current.CurrentCredit, req.CreditAmount, current.CreditLimit)
			}
		}
		return plan, nil
	}

	// Caso 3: delta negativo → resta de pagos (reembolso).
	// Validar que la suma cuadre con |delta| dentro de tolerancia.
	if math.Abs(magnitudeSum-absDelta) > SaleEditPaymentTolerance {
		return plan, fmt.Errorf("reembolso incoherente: delta $%.2f, reembolso $%.2f",
			absDelta, magnitudeSum)
	}

	// Validar canal por canal: saldo actual - magnitud debe ser >= 0.
	if req.CashAmount-current.CashAmount > SaleEditPaymentTolerance {
		return plan, fmt.Errorf("canal EFECTIVO insuficiente: saldo $%.2f, reembolso $%.2f",
			current.CashAmount, req.CashAmount)
	}
	// El canal "transferencia genérica" es TransferAmount − TransferNequi − TransferDaviplata.
	// Es el saldo real disponible para reembolsos que no vayan por Nequi/Daviplata
	// (típicamente Bancolombia, tarjeta u otros). Sin este chequeo, un reembolso
	// que llega solo a través de req.TransferAmount pasaría porque la validación
	// vería el TOTAL de transferencias, no la porción genérica.
	genericBalance := current.TransferAmount - current.TransferNequi - current.TransferDaviplata
	if genericBalance < 0 {
		genericBalance = 0
	}
	if transferGeneric-genericBalance > SaleEditPaymentTolerance {
		return plan, fmt.Errorf("canal TRANSFERENCIA insuficiente: saldo genérico $%.2f, reembolso $%.2f",
			genericBalance, transferGeneric)
	}
	if req.TransferNequi-current.TransferNequi > SaleEditPaymentTolerance {
		return plan, fmt.Errorf("canal NEQUI insuficiente: saldo $%.2f, reembolso $%.2f",
			current.TransferNequi, req.TransferNequi)
	}
	if req.TransferDaviplata-current.TransferDaviplata > SaleEditPaymentTolerance {
		return plan, fmt.Errorf("canal DAVIPLATA insuficiente: saldo $%.2f, reembolso $%.2f",
			current.TransferDaviplata, req.TransferDaviplata)
	}
	if req.CreditAmount > 0 {
		// El crédito nunca puede bajar debajo de lo ya abonado.
		alreadyPaid := current.CreditAmount - current.DebtPending
		if alreadyPaid < 0 {
			alreadyPaid = 0
		}
		newCreditAmount := current.CreditAmount - req.CreditAmount
		if newCreditAmount+0.01 < alreadyPaid {
			return plan, fmt.Errorf("no se puede reducir el crédito debajo de los abonos ya registrados: crédito $%.2f - $%.2f < abonos $%.2f",
				current.CreditAmount, req.CreditAmount, alreadyPaid)
		}
	}

	plan.CashDelta = -req.CashAmount
	// TransferDelta es la porción GENÉRICA en negativo. El llamador
	// reconstruye el total como generic + nequi + daviplata.
	plan.TransferDelta = -transferGeneric
	plan.NequiDelta = -req.TransferNequi
	plan.DaviplataDelta = -req.TransferDaviplata
	plan.CreditDelta = -req.CreditAmount
	plan.Direction = "subtract"
	return plan, nil
}

// RecalculateSaleCash recomputa CashAmount, cashNeeded y Change tras aplicar
// un PaymentEditPlan y un delta de TotalAmount. Es la misma fórmula que usa
// CreateSale, aislada para test.
func RecalculateSaleCash(newTotal, cashAmount, transferAmount, creditAmount float64) (change float64) {
	cashNeeded := newTotal - transferAmount - creditAmount
	if cashNeeded < 0 {
		cashNeeded = 0
	}
	change = cashAmount - cashNeeded
	if change < 0 {
		change = 0
	}
	return change
}
