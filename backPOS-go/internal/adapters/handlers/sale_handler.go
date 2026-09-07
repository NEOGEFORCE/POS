package handlers

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/core/services"
	"backPOS-go/internal/infrastructure/sse"
	"github.com/gin-gonic/gin"
)

type SaleHandler struct {
	service      *services.SaleService
	auditService *services.AuditService
}

func NewSaleHandler(s *services.SaleService, a *services.AuditService) *SaleHandler {
	return &SaleHandler{service: s, auditService: a}
}

func (h *SaleHandler) Create(c *gin.Context) {
	var sale models.Sale
	if err := c.ShouldBindJSON(&sale); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos de venta inválido", err)
		return
	}

	// Inyectar metadatos de forma segura usando el helper
	dniStr, nameStr := GetContextUser(c)
	sale.EmployeeDNI = dniStr
	sale.Employee.Name = nameStr

	if err := h.service.CreateSale(&sale); err != nil {
		// Diferenciar errores de negocio (400) de errores de servidor (500)
		msg := err.Error()
		if containsBusinessError(msg) {
			SendError(c, http.StatusBadRequest, ErrBadRequest, msg, nil)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al registrar venta", err)
		return
	}

	// ULTRA-INSTINTO: Broadcast SSE para actualización en tiempo real del Dashboard
	// Protegido con recovery para evitar que un fallo en SSE tumbe el registro de la venta
	go func() {
		defer func() {
			if r := recover(); r != nil {
				fmt.Printf("⚠️ [SSE-Sale] Recovery from panic: %v\n", r)
			}
		}()
		sse.GetSSEService().BroadcastNewSale(sale)
		sse.GetSSEService().BroadcastDashboardUpdate()
	}()

	c.JSON(http.StatusCreated, sale)

	// Auditoría de Venta (Segundo Plano)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				fmt.Printf("⚠️ [Audit-Sale] Recovery from panic: %v\n", r)
			}
		}()
		h.auditService.Log(dniStr, nameStr, "CREATE_SALE", "SALES",
			fmt.Sprintf("Venta registrada: #%d", sale.SaleID),
			fmt.Sprintf("Se registró una nueva venta (#%d) por valor de $%s", sale.SaleID, fmt.Sprintf("%.2f", sale.TotalAmount)),
			"", c.ClientIP(), c.Request.UserAgent(), false)
	}()
}

func (h *SaleHandler) GetAll(c *gin.Context) {
	page := QueryPage(c, "page")
	// Tope compartido: ver MaxPageSize en pagination.go. Sin él,
	// ?pageSize=999999 traía el histórico completo de ventas con sus detalles.
	pageSize := QueryPageSize(c, "pageSize", 10)
	from := c.Query("from")
	to := c.Query("to")
	clientDni := c.Query("clientDni")
	employeeDni := c.Query("employeeDni")
	search := c.Query("search")
	minTotal, _ := strconv.ParseFloat(c.DefaultQuery("minTotal", "0"), 64)
	maxTotal, _ := strconv.ParseFloat(c.DefaultQuery("maxTotal", "0"), 64)

	filter := ports.SaleFilter{
		Page:        page,
		PageSize:    pageSize,
		From:        from,
		To:          to,
		ClientDNI:   clientDni,
		EmployeeDNI: employeeDni,
		MinTotal:    minTotal,
		MaxTotal:    maxTotal,
		Search:      search,
	}

	sales, total, err := h.service.ListSales(filter)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener ventas", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"items":    sales,
		"total":    total,
		"page":     page,
		"pageSize": pageSize,
	})
}

func (h *SaleHandler) GetByID(c *gin.Context) {
	idStr := c.Param("id")
	id, _ := strconv.ParseUint(idStr, 10, 32)
	sale, err := h.service.GetSale(uint(id))
	if err != nil {
		SendError(c, http.StatusNotFound, ErrNotFound, "Venta no encontrada", err)
		return
	}
	c.JSON(http.StatusOK, sale)
}

func (h *SaleHandler) Delete(c *gin.Context) {
	idStr := c.Param("id")
	id, _ := strconv.ParseUint(idStr, 10, 32)

	var req struct {
		Reason string `json:"reason" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Debe proporcionar una justificación para anular la venta", err)
		return
	}

	dniStr, nameStr := GetContextUser(c)

	if err := h.service.DeleteSale(uint(id), req.Reason, dniStr); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al eliminar venta", err)
		return
	}

	// Auditoría de Anulación de Venta (MUY CRÍTICO)
	details := fmt.Sprintf("Venta #%d eliminada/anulada. Motivo: %s", id, req.Reason)
	human := fmt.Sprintf("Se eliminó/anuló permanentemente la venta #%d", id)

	h.auditService.Log(dniStr, nameStr, "VOID_SALE", "SALES", details, human, "{}", c.ClientIP(), c.Request.UserAgent(), true)

	go func() {
		defer func() { recover() }()
		sse.GetSSEService().BroadcastDashboardUpdate()
	}()

	c.JSON(http.StatusOK, gin.H{"message": "Venta anulada correctamente"})

	// AVISO GLOBAL: Venta anulada (Devolver Stock y Dinero)
	go sse.GetSSEService().BroadcastNewSale(models.Sale{SaleID: uint(id)})
}

func (h *SaleHandler) UpdatePayment(c *gin.Context) {
	idStr := c.Param("id")
	id, _ := strconv.ParseUint(idStr, 10, 32)
	var sale models.Sale
	if err := c.ShouldBindJSON(&sale); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos de pago inválido", err)
		return
	}
	if err := h.service.UpdateSalePayment(uint(id), &sale); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al actualizar pago", err)
		return
	}

	dniStr, nameStr := GetContextUser(c)

	// Auditoría de Cambio de Pago
	h.auditService.Log(dniStr, nameStr, "UPDATE_PAYMENT", "SALES",
		fmt.Sprintf("Actualizado pago venta #%d", id),
		fmt.Sprintf("Se modificó la información de pago para la venta #%d", id),
		"{}", c.ClientIP(), c.Request.UserAgent(), true)

	go func() {
		defer func() { recover() }()
		sse.GetSSEService().BroadcastDashboardUpdate()
	}()

	c.JSON(http.StatusOK, gin.H{"message": "Pago actualizado correctamente"})
}

// AddSaleItemsReq define el contrato del endpoint /sales/add-items/:id.
//
// items[].quantity es FIRMADA: positivo agrega, negativo quita. Item con
// quantity == 0 se rechaza.
//
// cashAmount, transferAmount, transferNequi, transferDaviplata y creditAmount
// llegan como MAGNITUDES POSITIVAS elegidas en el modal. El servicio
// determina el signo según el delta monetario neto:
//   - delta > 0 → suman al canal correspondiente.
//   - delta < 0 → restan (reembolso) del canal correspondiente.
//   - delta = 0 → exige suma de magnitudes cero.
type AddSaleItemsItem struct {
	Barcode       string  `json:"barcode"`
	Quantity      float64 `json:"quantity"`
	MISCUnitPrice float64 `json:"unitPrice,omitempty"`
	MISCCostPrice float64 `json:"costPrice,omitempty"`
}

type AddSaleItemsReq struct {
	Items             []AddSaleItemsItem `json:"items"`
	CashAmount        float64            `json:"cashAmount"`
	TransferAmount    float64            `json:"transferAmount"`
	TransferNequi     float64            `json:"transferNequi"`
	TransferDaviplata float64            `json:"transferDaviplata"`
	CreditAmount      float64            `json:"creditAmount"`
	TransferSource    string             `json:"transferSource"`
}

func (h *SaleHandler) AddItems(c *gin.Context) {
	saleIDStr := c.Param("id")
	var saleID uint
	fmt.Sscanf(saleIDStr, "%d", &saleID)

	var req AddSaleItemsReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Datos inválidos", "details": err.Error()})
		return
	}

	if len(req.Items) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No hay productos para procesar"})
		return
	}

	// Validar magnitudes positivas antes de tocar servicio.
	if req.CashAmount < 0 || req.TransferAmount < 0 || req.TransferNequi < 0 ||
		req.TransferDaviplata < 0 || req.CreditAmount < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "los montos deben ser magnitudes positivas"})
		return
	}

	items := make([]services.SaleEditItemInput, 0, len(req.Items))
	for _, it := range req.Items {
		items = append(items, services.SaleEditItemInput{
			Barcode:       strings.TrimSpace(it.Barcode),
			Quantity:      it.Quantity,
			MISCUnitPrice: it.MISCUnitPrice,
			MISCCostPrice: it.MISCCostPrice,
		})
	}

	dni, name := GetContextUser(c)
	summary, err := h.service.AddItemsToSaleV2(
		saleID, items,
		req.CashAmount, req.TransferAmount, req.TransferNequi, req.TransferDaviplata, req.CreditAmount,
		req.TransferSource, dni,
	)
	if err != nil {
		// Todos los errores del servicio son de negocio: 400.
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "Venta actualizada correctamente",
		"summary": summary,
	})

	// Auditoría crítica post-commit: DNI/nombre + delta + canales.
	go func() {
		defer func() {
			if r := recover(); r != nil {
				fmt.Printf("⚠️ [Audit-EditSale] Recovery from panic: %v\n", r)
			}
		}()
		direction := summary.Direction
		details := fmt.Sprintf(
			"Venta #%d editada (%s). Delta=$%.2f. Canales: cash=$%.2f nequi=$%.2f davi=$%.2f transfer=$%.2f credit=$%.2f",
			summary.SaleID, direction, summary.MonetaryDelta,
			summary.CashDelta, summary.NequiDelta, summary.DaviplataDelta,
			summary.TransferDelta, summary.CreditDelta,
		)
		human := fmt.Sprintf("El cajero %s editó la venta #%d: %s $%.2f (líneas +%d -%d ×%d)",
			name, summary.SaleID, direction, summary.MonetaryDelta,
			summary.LinesAdded, summary.LinesReduced, summary.LinesRemoved)
		h.auditService.Log(dni, name, "EDIT_SALE_ITEMS", "SALES", details, human, "{}", c.ClientIP(), c.Request.UserAgent(), true)
	}()

	// SSE dashboard tras commit para refresco en tiempo real.
	go func() {
		defer func() {
			if r := recover(); r != nil {
				fmt.Printf("⚠️ [SSE-EditSale] Recovery from panic: %v\n", r)
			}
		}()
		sse.GetSSEService().BroadcastDashboardUpdate()
		sse.GetSSEService().BroadcastNewSale(models.Sale{SaleID: summary.SaleID})
	}()
}

func containsBusinessError(msg string) bool {
	businessErrors := []string{
		"insuficiente",
		"debe seleccionar",
		"supera su límite",
		"no encontrado",
		"formato",
	}
	for _, e := range businessErrors {
		if strings.Contains(strings.ToLower(msg), e) {
			return true
		}
	}
	return false
}

func (h *SaleHandler) Update(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "ID inválido", err)
		return
	}

	var newSale models.Sale
	if err := c.ShouldBindJSON(&newSale); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	dniStr, nameStr := GetContextUser(c)
	role := strings.ToLower(c.GetString("role"))
	isAdmin := role == "admin" || role == "administrador" || role == "superadmin"

	if err := h.service.UpdateSale(uint(id), &newSale, dniStr, isAdmin); err != nil {
		msg := err.Error()
		if containsBusinessError(msg) || strings.Contains(msg, "administradores") || strings.Contains(msg, "disminuir") {
			SendError(c, http.StatusBadRequest, ErrBadRequest, msg, nil)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al actualizar venta", err)
		return
	}

	h.auditService.Log(dniStr, nameStr, "UPDATE_SALE", "SALES", fmt.Sprintf("Venta %d actualizada", id), "Edición de venta", "{}", c.ClientIP(), c.Request.UserAgent(), true)

	go func() {
		defer func() {
			if r := recover(); r != nil {
				fmt.Printf("⚠️ [SSE-SaleUpdate] Recovery from panic: %v\n", r)
			}
		}()
		sse.GetSSEService().BroadcastDashboardUpdate()
	}()

	c.JSON(http.StatusOK, gin.H{"message": "Venta actualizada correctamente", "sale_id": id})
}
