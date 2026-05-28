package handlers

import (
	"fmt"
	"net/http"
	"strings"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/core/services"

	"backPOS-go/internal/infrastructure/sse"
	"github.com/gin-gonic/gin"
)

type ReturnHandler struct {
	service      *services.ReturnService
	auditService *services.AuditService
}

func NewReturnHandler(s *services.ReturnService, a *services.AuditService) *ReturnHandler {
	return &ReturnHandler{service: s, auditService: a}
}

func (h *ReturnHandler) Create(c *gin.Context) {
	var ret models.Return
	if err := c.ShouldBindJSON(&ret); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	// Mayúsculas y Metadatos
	ret.Reason = strings.ToUpper(ret.Reason)
	ret.ReturnType = strings.ToUpper(ret.ReturnType)
	dni, _ := c.Get("dni")
	name, _ := c.Get("name")
	dniStr := dni.(string)
	nameStr := ""
	if name != nil {
		nameStr = name.(string)
	}
	ret.EmployeeDNI = dniStr

	if err := h.service.CreateReturn(&ret, dniStr, nameStr); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al registrar devolución", err)
		return
	}
	c.JSON(http.StatusCreated, ret)

	h.auditService.Log(dniStr, nameStr, "CREATE_RETURN", "INVENTORY", 
		fmt.Sprintf("Devolución venta #%d: $%.2f", ret.SaleID, ret.TotalReturned),
		fmt.Sprintf("Se registró una devolución para la venta #%d. Total devuelto: $%s. Motivo: %s", ret.SaleID, fmt.Sprintf("%.2f", ret.TotalReturned), ret.Reason),
		"", c.ClientIP(), c.Request.UserAgent(), true)

	go func() {
		sse.GetSSEService().BroadcastDashboardUpdate()
		sse.GetSSEService().BroadcastInventoryUpdate(nil)
		sse.GetSSEService().BroadcastProductUpdate(nil)
	}()
}

func (h *ReturnHandler) GetAll(c *gin.Context) {
	returns, err := h.service.ListReturns()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener devoluciones", err)
		return
	}
	c.JSON(http.StatusOK, returns)
}

func (h *ReturnHandler) GetByInvoice(c *gin.Context) {
	refStr := c.Param("ref")
	sale, err := h.service.GetSaleForReturn(refStr)
	if err != nil {
		SendError(c, http.StatusNotFound, ErrNotFound, "Factura no encontrada", err)
		return
	}
	
	// Ensure product names are included for the frontend
	type itemWithProductName struct {
		models.SaleDetail
		ProductName string `json:"productName"`
	}
	
	var items []itemWithProductName
	for _, d := range sale.SaleDetails {
		items = append(items, itemWithProductName{
			SaleDetail: d,
			ProductName: d.Product.ProductName,
		})
	}
	
	c.JSON(http.StatusOK, gin.H{
		"sale": sale,
		"items": items,
	})
}

func (h *ReturnHandler) GetBlind(c *gin.Context) {
	barcode := c.Query("barcode")
	if barcode == "" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Código de barras requerido", nil)
		return
	}
	result, err := h.service.GetBlindReturnData(barcode)
	if err != nil {
		if strings.Contains(err.Error(), "no fue vendido") {
			SendError(c, http.StatusNotFound, ErrNotFound, err.Error(), nil)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Error al buscar historial del producto", err)
		return
	}
	
	c.JSON(http.StatusOK, gin.H{
		"sale": gin.H{
			"id":            result["lastSaleId"],
			"paymentMethod": result["lastPaymentMethod"],
			"total":         result["cashRefundable"],
		},
		"item": gin.H{
			"barcode":     result["barcode"],
			"productName": result["productName"],
			"quantity":    result["validQty"],
			"unitPrice":   result["unitPrice"],
		},
	})
}

func (h *ReturnHandler) ProcessReturn(c *gin.Context) {
	var req ports.ProcessReturnReq
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	dni, _ := c.Get("dni")
	name, _ := c.Get("name")
	dniStr := dni.(string)
	nameStr := ""
	if name != nil {
		nameStr = name.(string)
	}

	err := h.service.ProcessAdvancedReturn(req, dniStr, nameStr)
	if err != nil {
		if strings.Contains(err.Error(), "solo se permite reembolso en efectivo") {
			SendError(c, http.StatusBadRequest, ErrBadRequest, err.Error(), nil)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al procesar devolución", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Devolución procesada correctamente"})

	h.auditService.Log(dniStr, nameStr, "ADVANCED_RETURN", "SALES", 
		fmt.Sprintf("Devolución Tipo: %s. Reembolso: %.2f. Cobro: %.2f", req.Type, req.RefundAmount, req.ChargeAmount),
		fmt.Sprintf("Se registró una devolución avanzada. Tipo: %s", req.Type),
		"", c.ClientIP(), c.Request.UserAgent(), true)

	go func() {
		sse.GetSSEService().BroadcastDashboardUpdate()
		sse.GetSSEService().BroadcastInventoryUpdate(nil)
		sse.GetSSEService().BroadcastProductUpdate(nil)
	}()
}

