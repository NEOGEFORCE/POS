// Handler del módulo de generación/gestión de códigos de barras y
// auditoría del cajón de dinero.
//
// Reglas HTTP:
//
//   - GET  /api/labels/sizes               list (empleado + admin)
//   - POST /api/labels/sizes               upsert (admin)
//   - GET  /api/labels/printers            list (empleado + admin)
//   - POST /api/labels/printers            upsert (admin)
//   - GET  /api/labels/codes/search?q=     search (empleado + admin)
//   - POST /api/labels/codes               ensure code for product/libre
//   - POST /api/labels/print-jobs          record print job
//   - POST /api/cash-drawer/open           abrir cajón (regla sale/admin)
//
// La regla "no abrir sin venta salvo admin" se aplica aquí:
//
//	403 { code: "CASH_DRAWER_REQUIRES_SALE_OR_ADMIN", ... }
//
// La respuesta de /labels/codes es idempotente: si el barcode ya tiene
// un código activo, lo reutilizamos. El flag `created` lo indica.
package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"

	"github.com/gin-gonic/gin"
)

type LabelHandler struct {
	repo *repositories.LabelRepository
}

func NewLabelHandler(repo *repositories.LabelRepository) *LabelHandler {
	return &LabelHandler{repo: repo}
}

// --- helpers ---------------------------------------------------------------

func actorDNI(c *gin.Context) string {
	v, exists := c.Get("userDni")
	if exists {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	// Fallback a header para pruebas; en producción el middleware auth
	// siempre setea userDni.
	return strings.TrimSpace(c.GetHeader("X-Actor-DNI"))
}

func actorIsAdmin(c *gin.Context) bool {
	v, exists := c.Get("role")
	if !exists {
		return false
	}
	s, _ := v.(string)
	normalized := strings.ToLower(strings.TrimSpace(s))
	return normalized == "admin" || normalized == "administrador" || normalized == "superadmin"
}

// --- plantillas ------------------------------------------------------------

func (h *LabelHandler) ListSizes(c *gin.Context) {
	rows, err := h.repo.ListSizeTemplates(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"templates": rows})
}

type upsertSizeRequest struct {
	ID            uint    `json:"id"`
	Name          string  `json:"name"`
	WidthMM       float64 `json:"widthMm"`
	HeightMM      float64 `json:"heightMm"`
	MarginMM      float64 `json:"marginMm"`
	ColumnsCount  int     `json:"columnsCount"`
	DPI           int     `json:"dpi"`
	BarcodeFormat string  `json:"barcodeFormat"`
	ShowName      bool    `json:"showName"`
	ShowPrice     bool    `json:"showPrice"`
	IsDefault     bool    `json:"isDefault"`
}

func (h *LabelHandler) UpsertSize(c *gin.Context) {
	var req upsertSizeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido", "detail": err.Error()})
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || req.WidthMM <= 0 || req.HeightMM <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nombre, widthMm y heightMm son obligatorios"})
		return
	}
	fmtCode := strings.ToUpper(strings.TrimSpace(req.BarcodeFormat))
	switch fmtCode {
	case "", "CODE128":
		fmtCode = "CODE128"
	case "EAN13", "EAN8", "QR":
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "barcodeFormat inválido", "allowed": []string{"CODE128", "EAN13", "EAN8", "QR"}})
		return
	}
	tpl := models.LabelSizeTemplate{
		ID:            req.ID,
		Name:          name,
		WidthMM:       req.WidthMM,
		HeightMM:      req.HeightMM,
		MarginMM:      req.MarginMM,
		ColumnsCount:  max1(req.ColumnsCount),
		DPI:           orDefault(req.DPI, 203),
		BarcodeFormat: fmtCode,
		ShowName:      req.ShowName,
		ShowPrice:     req.ShowPrice,
		IsDefault:     req.IsDefault,
		UpdatedByDNI:  actorDNI(c),
	}
	if err := h.repo.UpsertSizeTemplate(c.Request.Context(), &tpl); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"template": tpl})
}

// --- impresoras ------------------------------------------------------------

func (h *LabelHandler) ListPrinters(c *gin.Context) {
	rows, err := h.repo.ListPrinterProfiles(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"profiles": rows})
}

type upsertPrinterRequest struct {
	ID              uint     `json:"id"`
	Name            string   `json:"name"`
	Protocol        string   `json:"protocol"`
	Target          string   `json:"target"`
	RollWidthMM     *float64 `json:"rollWidthMm"`
	Model           string   `json:"model"`
	DrawerConnected bool     `json:"drawerConnected"`
	IsDefault       bool     `json:"isDefault"`
}

var allowedPrinterProtocols = map[string]bool{
	"escpos": true, "tspl": true, "zpl": true, "pdf": true, "system": true,
}

func (h *LabelHandler) UpsertPrinter(c *gin.Context) {
	var req upsertPrinterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido", "detail": err.Error()})
		return
	}
	name := strings.TrimSpace(req.Name)
	proto := strings.ToLower(strings.TrimSpace(req.Protocol))
	target := strings.TrimSpace(req.Target)
	if name == "" || target == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nombre y target son obligatorios"})
		return
	}
	if !allowedPrinterProtocols[proto] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "protocolo inválido", "allowed": []string{"escpos", "tspl", "zpl", "pdf", "system"}})
		return
	}
	p := models.LabelPrinterProfile{
		ID:              req.ID,
		Name:            name,
		Protocol:        proto,
		Target:          target,
		RollWidthMM:     req.RollWidthMM,
		Model:           strings.TrimSpace(req.Model),
		DrawerConnected: req.DrawerConnected,
		IsDefault:       req.IsDefault,
		UpdatedByDNI:    actorDNI(c),
	}
	if err := h.repo.UpsertPrinterProfile(c.Request.Context(), &p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"profile": p})
}

// --- códigos ---------------------------------------------------------------

type ensureCodeRequest struct {
	ProductBarcode string `json:"productBarcode"`
	Note           string `json:"note"`
	SizeTemplateID *uint  `json:"sizeTemplateId"`
}

func (h *LabelHandler) EnsureCode(c *gin.Context) {
	var req ensureCodeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido", "detail": err.Error()})
		return
	}
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida"})
		return
	}
	code, created, err := h.repo.EnsureCodeForProduct(
		c.Request.Context(),
		strings.TrimSpace(req.ProductBarcode),
		req.SizeTemplateID,
		strings.TrimSpace(req.Note),
		dni,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": code, "created": created})
}

func (h *LabelHandler) SearchCodes(c *gin.Context) {
	q := c.Query("q")
	rows, err := h.repo.SearchCodes(c.Request.Context(), q, 50)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"results": rows})
}

// ResolveCode responde la resolución EXACTA del código de etiqueta
// unitaria usado en caja. Shape:
//
//   - 200 { match: "label_code", code, productBarcode, product: {...} }
//     cuando hay un label_codes.code VIVO con product_barcode poblado
//     y un producto activo detrás.
//   - 200 { match: "unknown", code } cuando el código no existe, está
//     anulado, es "libre" sin producto, el producto fue borrado o la
//     migración 016 aún no está aplicada.
//   - 400 si falta `code`.
//   - 401 si no hay sesión (contexto sin userDni).
//   - 500 si la BD cae con un error no esperado.
//
// Contrato estable para el frontend:
//   - La clave `match` existe SIEMPRE en 200.
//   - Los literales "label_code" y "unknown" son parte del contrato.
//   - Este handler NUNCA referencia package_barcode_aliases ni devuelve
//     códigos de error del alias de paquete (p.ej. PACKAGE_CODE_...).
func (h *LabelHandler) ResolveCode(c *gin.Context) {
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida"})
		return
	}
	code := strings.TrimSpace(c.Query("code"))
	if code == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "code requerido"})
		return
	}
	result, err := h.repo.ResolveLabelCode(c.Request.Context(), code)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// result nunca es nil cuando err==nil; defensa barata contra regresión.
	if result == nil {
		c.JSON(http.StatusOK, gin.H{"match": "unknown", "code": code})
		return
	}
	c.JSON(http.StatusOK, result)
}

// --- impresión -------------------------------------------------------------

type printJobRequest struct {
	PrinterProfileID *uint                       `json:"printerProfileId"`
	SizeTemplateID   *uint                       `json:"sizeTemplateId"`
	TriggerSource    string                      `json:"triggerSource"`
	Items            []repositories.PrintJobLine `json:"items"`
	Meta             map[string]any              `json:"meta"`
}

func (h *LabelHandler) RecordPrint(c *gin.Context) {
	var req printJobRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido", "detail": err.Error()})
		return
	}
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida"})
		return
	}
	if len(req.Items) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "sin líneas"})
		return
	}
	payload, _ := json.Marshal(gin.H{"items": req.Items, "meta": req.Meta})
	id, err := h.repo.RecordPrintJob(
		c.Request.Context(),
		dni,
		req.PrinterProfileID,
		req.SizeTemplateID,
		req.TriggerSource,
		req.Items,
		string(payload),
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": id, "status": models.PrintJobStatusQueued})
}

// --- cajón de dinero -------------------------------------------------------

type openDrawerRequest struct {
	SaleID           *uint  `json:"saleId"`
	ReturnID         *uint  `json:"returnId"`
	Reason           string `json:"reason"`
	Note             string `json:"note"`
	Override         bool   `json:"override"`
	PrinterProfileID *uint  `json:"printerProfileId"`
}

// OpenCashDrawer aplica la regla "sin venta → requiere admin".
//
// Reglas:
//   - Si la petición trae saleId o returnId: OK con reason=sale/return.
//   - Si NO trae nada:
//   - Admin: OK con reason=admin_override y authorized_by_dni=admin.
//   - Empleado con venta reciente (<=90s): OK con reason=sale (deducida
//     de la última venta del cajero).
//   - Empleado SIN venta reciente y SIN override: 403.
//
// La ventana de 90s es conservadora: cubre el delay normal entre cerrar
// la venta y abrir el cajón para dar vueltas. Un abuso sostenido quedaría
// visible en cash_drawer_opens.
func (h *LabelHandler) OpenCashDrawer(c *gin.Context) {
	var req openDrawerRequest
	if err := c.ShouldBindJSON(&req); err != nil && !errors.Is(err, http.ErrBodyReadAfterClose) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido", "detail": err.Error()})
		return
	}
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida"})
		return
	}
	admin := actorIsAdmin(c)

	open := &models.CashDrawerOpen{
		ActorDNI:         dni,
		SaleID:           req.SaleID,
		ReturnID:         req.ReturnID,
		Note:             strings.TrimSpace(req.Note),
		PrinterProfileID: req.PrinterProfileID,
	}

	// FIX 2026-10-04 (brecha auditoria_impresion_codigos): si un empleado
	// no-admin manda un saleId, debe ser una venta SUYA. Antes aceptábamos
	// cualquier saleId del body sin cross-check contra sales.employeeDni,
	// así que un empleado podía abrir el cajón citando la venta de un
	// compañero y la auditoría quedaba con un pretexto falso. La
	// verificación corre antes del INSERT para dar 403 claro.
	if !admin && req.SaleID != nil {
		owned, err := h.repo.IsSaleOwnedByCashier(c.Request.Context(), *req.SaleID, dni)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if !owned {
			c.JSON(http.StatusForbidden, gin.H{
				"error": "La venta citada no pertenece al cajero actual.",
				"code":  "CASH_DRAWER_SALE_NOT_OWNED",
			})
			return
		}
	}

	switch {
	case req.SaleID != nil:
		open.Reason = models.CashDrawerReasonSale
	case req.ReturnID != nil:
		open.Reason = models.CashDrawerReasonReturn
	case admin && req.Override:
		open.Reason = models.CashDrawerReasonAdminOverride
		open.OverrideAdmin = true
		open.AuthorizedByDNI = dni
	default:
		// Buscar una venta reciente del propio cajero (ventana 90s).
		hasRecent, err := h.repo.HasRecentSaleByCashier(c.Request.Context(), dni, 90*time.Second)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if hasRecent {
			open.Reason = models.CashDrawerReasonSale
		} else if admin {
			// Admin sin flag override: lo tratamos como override implícito,
			// porque la ergonomía de un botón "Abrir cajón" para admin no
			// debe pedir confirmación extra.
			open.Reason = models.CashDrawerReasonAdminOverride
			open.OverrideAdmin = true
			open.AuthorizedByDNI = dni
		} else {
			c.JSON(http.StatusForbidden, gin.H{
				"error": "El cajero debe tener una venta reciente o pedir autorización de admin para abrir el cajón.",
				"code":  "CASH_DRAWER_REQUIRES_SALE_OR_ADMIN",
			})
			return
		}
	}

	if err := h.repo.RecordCashDrawerOpen(c.Request.Context(), open); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":              true,
		"opened":          open,
		"driverAvailable": false,
		"note":            "El pulso de kickout físico requiere bridge local (ESC/POS/TSPL). Este endpoint registra la autorización; el bridge envía el pulso.",
	})
}

// --- utilidades locales ----------------------------------------------------

func max1(v int) int {
	if v < 1 {
		return 1
	}
	return v
}

func orDefault(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

// =========================================================================
// Anulación de códigos y cierre del ciclo de print jobs
// =========================================================================
//
// Fix 2026-10-04 — brechas detectadas por `auditoria_impresion_codigos`:
//
//   - Las columnas `voided_at` y `voided_by_dni` existían en la 016 pero
//     ningún handler las escribía. Un código impreso mal se quedaba
//     resolviéndose para siempre.
//
//   - `label_repository.MarkPrintJob` existía pero no se exponía: todos
//     los jobs quedaban en `queued` y la auditoría no podía distinguir
//     printed/failed.
//
// Las dos puertas quedan aquí; las rutas se registran en main.go bajo
// `/api/labels/*`.

// VoidCode marca un `label_codes.code` como anulado. admin-only.
// Idempotente: anular dos veces el mismo código responde 200 con
// `alreadyVoided: true` sin volver a tocar la fila.
func (h *LabelHandler) VoidCode(c *gin.Context) {
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida"})
		return
	}
	code := strings.TrimSpace(c.Param("code"))
	if code == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "code requerido"})
		return
	}
	voided, err := h.repo.VoidCode(c.Request.Context(), code, dni)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":            true,
		"voided":        voided,
		"alreadyVoided": !voided,
		"code":          code,
	})
}

// MarkPrintJobStatus cierra el ciclo del print job. empleado+admin.
// Body: {"status": "printed|failed|cancelled", "error": "<opcional>"}.
func (h *LabelHandler) MarkPrintJobStatus(c *gin.Context) {
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida"})
		return
	}
	idStr := strings.TrimSpace(c.Param("id"))
	id64, err := parseUintParam(idStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id inválido"})
		return
	}
	var body struct {
		Status string `json:"status"`
		Error  string `json:"error"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido", "detail": err.Error()})
		return
	}
	status := strings.TrimSpace(body.Status)
	errMsg := strings.TrimSpace(body.Error)
	if err := h.repo.MarkPrintJob(c.Request.Context(), uint(id64), status, errMsg); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": id64, "status": status})
}

// parseUintParam es un helper ligero sobre strconv para parsear ids de
// URL path. 64 bits para no limitar a priori; el caller sabe su rango.
func parseUintParam(s string) (uint64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, errors.New("id vacío")
	}
	n, err := strconvParseUint(s, 10, 64)
	if err != nil {
		return 0, err
	}
	return n, nil
}

func strconvParseUint(s string, base, bitSize int) (uint64, error) {
	return strconv.ParseUint(s, base, bitSize)
}
