package services

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ============================================================================
// CORRECCION DE MEDIO DE PAGO POR EMPLEADO
// ============================================================================
//
// REGLA DEL DUENO (septiembre 2026): un cajero puede corregir un error de
// medio de pago en una venta que RECIEN hizo, sin tener que llamar al dueno.
// Pero el espacio donde ese cambio es seguro es muy chico, asi que el
// endpoint es acotado por diseno:
//
//   1. La venta tiene que ser del MISMO empleado (sale.employeeDni = requester).
//   2. Tiene que caer dentro del turno abierto AHORA (ActiveShift.StartTime
//      <= sale.saleDate).
//   3. NO permite cambiar el total, el cliente, los productos ni mover
//      dinero hacia/desde FIADO. Solo redistribuye el mismo total entre
//      EFECTIVO y canales de transferencia (Nequi, Daviplata, generico).
//   4. Bloquea cualquier venta con DEVOLUCIONES o con ABONOS registrados:
//      en esos casos el ajuste de medio de pago tiene efectos financieros
//      que trascienden la caja.
//   5. Transaccion + SELECT FOR UPDATE: la fuente de verdad es la fila
//      bloqueada; cualquier concurrencia espera.
//   6. Auditoria CRITICA con before/after real (no "changes={}").
//
// Antes esto solo se podia hacer con PUT /sales/update-payment/:id, que es
// admin-only. Un empleado que se equivocaba al cobrar tenia que llamar al
// dueno, o anular la venta y rehacerla. Las dos opciones ensuciaban el
// cierre del dia; la primera ademas interrumpia el flujo de atencion.
//
// Este endpoint NO es una puerta trasera a UpdateSalePayment: hay reglas
// estrictas que no se pueden saltar aun si el cliente las intenta.

// CorrectPaymentChannelRequest son las magnitudes positivas que llegan del
// modal. El servicio decide como se reparten las validaciones; no acepta
// un total nuevo ni cambios de cliente.
type CorrectPaymentChannelRequest struct {
	CashAmount        float64
	TransferAmount    float64 // TOTAL de transferencias (generico + Nequi + Davi)
	TransferNequi     float64
	TransferDaviplata float64
	TransferSource    string
}

// CorrectPaymentChannelResult reporta el before/after real para que el
// handler escriba una auditoria con cambios reales (no "{}") y para que la
// UI pueda mostrar un confirmation detallado.
type CorrectPaymentChannelResult struct {
	SaleID            uint
	TotalAmount       float64
	Before            SaleChannelSnapshot
	After             SaleChannelSnapshot
	NewPaymentMethod  string
	EmployeeDNI       string
}

// SaleChannelSnapshot es el estado de los canales de pago de una venta en
// un momento dado, pensado para auditoria. Contiene exactamente los campos
// que el endpoint puede modificar.
type SaleChannelSnapshot struct {
	CashAmount        float64 `json:"cashAmount"`
	TransferAmount    float64 `json:"transferAmount"`
	TransferNequi     float64 `json:"transferNequi"`
	TransferDaviplata float64 `json:"transferDaviplata"`
	TransferSource    string  `json:"transferSource"`
	PaymentMethod     string  `json:"paymentMethod"`
}

// paymentCorrectionTolerance es la tolerancia aritmetica aceptada entre
// la suma de los canales corregidos y el total existente de la venta.
// Se alinea con las tolerancias ya usadas en el proyecto (ver
// TransferBreakdownTolerance y SaleEditPaymentTolerance): 5 pesos.
const paymentCorrectionTolerance = 5.0

// errCorrectPaymentChannelNoChange se usa para rechazar correcciones vacias
// (sin cambio real). El handler lo traduce como 400 claro.
var errCorrectPaymentChannelNoChange = errors.New("la correccion no cambia los canales de pago")

// ValidateCorrectPaymentChannelRequest comprueba las magnitudes del request
// SIN acceder a la base de datos. Devuelve el error de negocio apropiado o
// nil si las magnitudes son coherentes para intentar la correccion.
//
// Es publica (en el paquete services) para poder cubrirla con tests puros.
// La elegibilidad REAL de la venta se sigue validando dentro de la
// transaccion de CorrectPaymentChannel (empleado dueno, turno abierto,
// sin devoluciones, sin fiado).
func ValidateCorrectPaymentChannelRequest(req CorrectPaymentChannelRequest) error {
	if req.CashAmount < 0 || req.TransferAmount < 0 ||
		req.TransferNequi < 0 || req.TransferDaviplata < 0 {
		return errors.New("los montos deben ser magnitudes positivas")
	}
	breakdown := req.TransferNequi + req.TransferDaviplata
	if req.TransferAmount+paymentCorrectionTolerance < breakdown {
		return errors.New("el desglose de transferencia (Nequi+Daviplata) supera el total de transferencia")
	}
	return nil
}

// isSaleEligibleForEmployeeCorrection evalua si una venta cae en el espacio
// donde la correccion de medio de pago por EMPLEADO es segura. Pura, sin
// base de datos. Es un predicado explicito para que los tests cubran las
// cuatro condiciones por separado:
//
//   - requester es el mismo cajero que registro la venta,
//   - la venta pertenece al turno activo,
//   - no tiene devoluciones aplicadas,
//   - no tiene fiado (CREDIT, CreditAmount, DebtPending).
//
// Retorna un error claro para que el handler lo traduzca a 403/409.
func isSaleEligibleForEmployeeCorrection(sale *models.Sale, requesterDNI string, shiftStart time.Time) error {
	if strings.TrimSpace(sale.EmployeeDNI) != strings.TrimSpace(requesterDNI) {
		return errors.New("solo el cajero que registro la venta puede corregir su medio de pago")
	}
	if sale.SaleDate.Before(shiftStart) {
		return errors.New("la venta no pertenece al turno abierto actual")
	}
	if sale.HasReturn || sale.ReturnRef != 0 || sale.ParentReturnRef != nil {
		return errors.New("la venta tiene devoluciones; use el flujo de devoluciones para ajustar")
	}
	status := strings.ToUpper(strings.TrimSpace(sale.Status))
	if status == "CREDIT" || sale.CreditAmount > 0.001 || sale.DebtPending > 0.001 {
		return errors.New("la venta tiene fiado; corrija el medio de pago desde cartera")
	}
	if math.Abs(sale.AmountPaid-sale.TotalAmount) > paymentCorrectionTolerance {
		return errors.New("la venta tiene desbalance historico; corrija por admin")
	}
	return nil
}

// CorrectPaymentChannel aplica una correccion de medio de pago sobre una
// venta propiedad del empleado requester. Devuelve un resultado con
// before/after para auditoria. Si la venta no es elegible retorna un error
// de negocio para que el handler lo traduzca a 403/409.
func (s *SaleService) CorrectPaymentChannel(
	saleID uint,
	req CorrectPaymentChannelRequest,
	requesterDNI string,
	shiftRepo ports.ActiveShiftRepository,
) (*CorrectPaymentChannelResult, error) {
	requesterDNI = strings.TrimSpace(requesterDNI)
	if requesterDNI == "" {
		return nil, errors.New("usuario no autenticado")
	}

	// Validaciones estaticas sobre las magnitudes.
	if err := ValidateCorrectPaymentChannelRequest(req); err != nil {
		return nil, err
	}

	rawDB, ok := s.saleRepo.GetDB().(*gorm.DB)
	if !ok {
		return nil, errors.New("error de sistema: base de datos invalida")
	}

	// El turno activo se consulta ANTES de abrir la transaccion porque
	// solo se usa para validar; su contenido no se modifica.
	activeShift, err := shiftRepo.GetActive()
	if err != nil {
		return nil, fmt.Errorf("error consultando turno activo: %w", err)
	}
	if activeShift == nil {
		return nil, errors.New("no hay un turno abierto; abra el turno para corregir el medio de pago")
	}

	result := &CorrectPaymentChannelResult{SaleID: saleID, EmployeeDNI: requesterDNI}

	txErr := rawDB.Transaction(func(tx *gorm.DB) error {
		var sale models.Sale
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("\"saleId\" = ?", saleID).First(&sale).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errors.New("venta no encontrada")
			}
			return fmt.Errorf("error bloqueando venta: %w", err)
		}

		// ===================================================================
		// VALIDACIONES DE ELEGIBILIDAD (todas devuelven errores claros)
		// ===================================================================
		//
		// La correccion es un atajo cerrado. El handler traduce estos errores
		// a 403 (no autorizado) o 409 (conflicto de estado). La logica
		// completa esta aislada en isSaleEligibleForEmployeeCorrection para
		// que los tests la cubran sin montar GORM.
		if err := isSaleEligibleForEmployeeCorrection(&sale, requesterDNI, activeShift.StartTime); err != nil {
			return err
		}

		// ===================================================================
		// VALIDAR SUMA FINAL == TOTAL
		// ===================================================================
		//
		// Reconstruimos el desglose con la misma logica que CreateSale (via
		// ReconcileTransferBreakdown) para que el campo transferNequi /
		// Daviplata quede sano aunque el cliente mande algo raro. La suma
		// resultante debe igualar el TotalAmount de la venta.
		reconciled := ReconcileTransferBreakdown(
			req.TransferAmount, req.TransferNequi, req.TransferDaviplata, req.TransferSource,
		)
		newCash := req.CashAmount
		newTransfer := reconciled.TransferAmount
		newNequi := reconciled.TransferNequi
		newDavi := reconciled.TransferDaviplata
		newSource := strings.ToUpper(strings.TrimSpace(reconciled.SourceUsed))

		newTotal := newCash + newTransfer
		if math.Abs(newTotal-sale.TotalAmount) > paymentCorrectionTolerance {
			return fmt.Errorf("la suma de canales ($%.2f) no coincide con el total de la venta ($%.2f)",
				newTotal, sale.TotalAmount)
		}

		// Snapshot before: estado real de la venta tal como esta hoy. Se
		// captura ANTES de cualquier mutacion para la auditoria.
		result.TotalAmount = sale.TotalAmount
		result.Before = SaleChannelSnapshot{
			CashAmount:        sale.CashAmount,
			TransferAmount:    sale.TransferAmount,
			TransferNequi:     sale.TransferNequi,
			TransferDaviplata: sale.TransferDaviplata,
			TransferSource:    sale.TransferSource,
			PaymentMethod:     sale.PaymentMethod,
		}

		// Si el estado nuevo es identico al existente (dentro de tolerancia)
		// no hay nada que hacer. Mejor devolver un error de negocio claro
		// que persistir una actualizacion vacia que ensucia la auditoria.
		if math.Abs(newCash-sale.CashAmount) < 0.01 &&
			math.Abs(newTransfer-sale.TransferAmount) < 0.01 &&
			math.Abs(newNequi-sale.TransferNequi) < 0.01 &&
			math.Abs(newDavi-sale.TransferDaviplata) < 0.01 {
			return errCorrectPaymentChannelNoChange
		}

		// Mutar la venta: AmountPaid conserva el total porque fue siempre
		// pagado completo; Change se recalcula.
		sale.CashAmount = newCash
		sale.TransferAmount = newTransfer
		sale.TransferNequi = newNequi
		sale.TransferDaviplata = newDavi
		if req.TransferSource != "" {
			// Solo se sobreescribe cuando el request trae un source explicito.
			// Si solo cambio EFECTIVO <-> otro, source puede quedar vacio y
			// usamos el reconciliado.
			sale.TransferSource = strings.TrimSpace(req.TransferSource)
		}
		// SourceUsed del reconciliador ("explicit"/"normalized"/"fallback") es
		// metadato de observabilidad, NO un canal visible. No se persiste:
		// se usa solo durante el calculo. Si la venta no traia source y el
		// reconciliador generaba el desglose Nequi/Daviplata, lo correcto es
		// mantener el source previo (si lo habia) o dejar vacio.
		_ = newSource

		sale.AmountPaid = sale.CashAmount + sale.TransferAmount
		cashNeeded := sale.TotalAmount - sale.TransferAmount
		if cashNeeded < 0 {
			cashNeeded = 0
		}
		sale.Change = sale.CashAmount - cashNeeded
		if sale.Change < 0 {
			sale.Change = 0
		}
		sale.PaymentMethod = deriveSalePaymentMethod(&sale)

		result.After = SaleChannelSnapshot{
			CashAmount:        sale.CashAmount,
			TransferAmount:    sale.TransferAmount,
			TransferNequi:     sale.TransferNequi,
			TransferDaviplata: sale.TransferDaviplata,
			TransferSource:    sale.TransferSource,
			PaymentMethod:     sale.PaymentMethod,
		}
		result.NewPaymentMethod = sale.PaymentMethod

		// Persistir SOLO las columnas tocadas. Nada de total, cliente,
		// productos ni crédito; el admin UpdateSalePayment es otro camino.
		return tx.Model(&models.Sale{}).Where("\"saleId\" = ?", saleID).Updates(map[string]interface{}{
			"cashAmount":        sale.CashAmount,
			"transferAmount":    sale.TransferAmount,
			"transferNequi":     sale.TransferNequi,
			"transferDaviplata": sale.TransferDaviplata,
			"transferSource":    sale.TransferSource,
			"paymentMethod":     sale.PaymentMethod,
			"amountPaid":        sale.AmountPaid,
			"change":            sale.Change,
		}).Error
	})
	if txErr != nil {
		return nil, txErr
	}

	// Invalidar cache: no afecta catalogo ni cartera (no se tocaron
	// clientes). El cache del dashboard lo refresca el broadcast SSE que
	// hace el handler despues de retornar.
	_ = cache.CacheManager // ensure import used
	s.saleRepo.AfterCommit()

	// Un log compacto facilita rastrear correcciones en los logs del
	// servidor sin exponerlo al cliente.
	if s.telegramService != nil {
		msg := fmt.Sprintf("💳 *CORRECCION DE PAGO (CAJERO)*\n"+
			"*Venta:* #%d\n"+
			"*Antes:* %s\n"+
			"*Despues:* %s\n"+
			"*Cajero:* %s\n"+
			"*Fecha:* %s",
			saleID,
			describePaymentSnapshot(result.Before),
			describePaymentSnapshot(result.After),
			requesterDNI,
			time.Now().Format("2006-01-02 15:04:05"),
		)
		s.telegramService.SendMarkdownAlert(msg)
	}

	return result, nil
}

// describePaymentSnapshot arma un resumen humano para logs y Telegram.
// No es un contrato con el frontend; es solo para que el dueno pueda leer
// de un vistazo que paso.
func describePaymentSnapshot(s SaleChannelSnapshot) string {
	parts := make([]string, 0, 4)
	if s.CashAmount > 0 {
		parts = append(parts, fmt.Sprintf("EFECTIVO $%.0f", s.CashAmount))
	}
	if s.TransferNequi > 0 {
		parts = append(parts, fmt.Sprintf("NEQUI $%.0f", s.TransferNequi))
	}
	if s.TransferDaviplata > 0 {
		parts = append(parts, fmt.Sprintf("DAVIPLATA $%.0f", s.TransferDaviplata))
	}
	generic := s.TransferAmount - s.TransferNequi - s.TransferDaviplata
	if generic > 0.01 {
		label := strings.ToUpper(strings.TrimSpace(s.TransferSource))
		if label == "" {
			label = "TRANSFERENCIA"
		}
		parts = append(parts, fmt.Sprintf("%s $%.0f", label, generic))
	}
	if len(parts) == 0 {
		return "(sin pagos)"
	}
	return strings.Join(parts, " · ")
}
