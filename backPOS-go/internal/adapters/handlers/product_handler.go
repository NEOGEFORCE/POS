package handlers

import (
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/core/services"
	"backPOS-go/internal/infrastructure/sse"
	"encoding/csv"
	"io"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-playground/validator/v10"
)

type ProductHandler struct {
	service          *services.ProductService
	inventoryService *services.InventoryService
	auditService     *services.AuditService
}

func NewProductHandler(s *services.ProductService, i *services.InventoryService, a *services.AuditService) *ProductHandler {
	return &ProductHandler{service: s, inventoryService: i, auditService: a}
}

func parseValidationErrors(err error) map[string]string {
	fieldErrors := make(map[string]string)

	if validationErrors, ok := err.(validator.ValidationErrors); ok {
		for _, e := range validationErrors {
			field := strings.ToLower(e.Field())
			switch field {
			case "barcode":
				fieldErrors[field] = "Código de barras requerido"
			case "productname":
				fieldErrors[field] = "Nombre de producto requerido"
			case "purchaseprice":
				fieldErrors[field] = "Precio de compra inválido"
			case "saleprice":
				fieldErrors[field] = "Precio de venta inválido"
			case "quantity":
				fieldErrors[field] = "Cantidad debe ser un número válido"
			case "minstock":
				fieldErrors[field] = "Stock mínimo debe ser un número válido"
			default:
				fieldErrors[field] = "Valor inválido"
			}
		}
	} else if strings.Contains(err.Error(), "json: cannot unmarshal") {
		// Errores de unmarshalling de JSON (ej. enviar string a campo numérico)
		msg := err.Error()
		if strings.Contains(msg, "purchasePrice") || strings.Contains(msg, "purchase_price") {
			fieldErrors["purchasePrice"] = "Formato numérico inválido (ejemplo válido: 1300)"
		} else if strings.Contains(msg, "salePrice") || strings.Contains(msg, "sale_price") {
			fieldErrors["salePrice"] = "Formato numérico inválido (ejemplo válido: 1500)"
		} else if strings.Contains(msg, "quantity") {
			fieldErrors["quantity"] = "Stock debe ser un número (sin símbolos de moneda)"
		} else if strings.Contains(msg, "minStock") || strings.Contains(msg, "min_stock") {
			fieldErrors["minStock"] = "Stock mínimo debe ser un número"
		} else if strings.Contains(msg, "marginPercentage") {
			fieldErrors["marginPercentage"] = "Margen debe ser un número"
		} else {
			fieldErrors["general"] = "Formato de datos inválido. Verifique que los números no contengan símbolos de moneda"
		}
	}

	return fieldErrors
}

// SendValidationError envía error con detalles por campo
func SendValidationError(c *gin.Context, fieldErrors map[string]string) {
	c.JSON(http.StatusBadRequest, gin.H{
		"error": gin.H{
			"code":    ErrBadRequest,
			"message": "Validación fallida",
			"fields":  fieldErrors,
		},
	})
}

func (h *ProductHandler) Create(c *gin.Context) {
	var product models.Product
	if err := c.ShouldBindJSON(&product); err != nil {
		fieldErrors := parseValidationErrors(err)
		SendValidationError(c, fieldErrors)
		return
	}

	// Mayúsculas, Sanitización y Metadatos
	product.Barcode = strings.ToUpper(strings.TrimSpace(product.Barcode))
	product.ProductName = strings.ToUpper(strings.TrimSpace(product.ProductName))

	// 1. Verificar Duplicados (Barcode)
	if existing, err := h.service.GetProduct(product.Barcode); err == nil && existing != nil {
		SendError(c, http.StatusConflict, ErrDuplicateEntry, "El código de barras ya existe en el sistema", gin.H{
			"barcode": existing.Barcode,
			"name":    existing.ProductName,
			"active":  existing.IsActive,
		})
		return
	}

	// 2. Verificar Duplicados (Nombre)
	if existing, err := h.service.GetProductByName(product.ProductName); err == nil && existing != nil {
		SendError(c, http.StatusConflict, ErrDuplicateEntry, "Ya existe un producto con este nombre", gin.H{
			"barcode": existing.Barcode,
			"name":    existing.ProductName,
			"active":  existing.IsActive,
		})
		return
	}
	dniStr, nameStr := GetContextUser(c)
	product.CreatedByDNI = dniStr
	product.UpdatedByDNI = dniStr

	if err := h.service.CreateProduct(&product); err != nil {
		errStr := strings.ToLower(err.Error())
		if strings.Contains(errStr, "1062") || strings.Contains(errStr, "unique") ||
			strings.Contains(errStr, "duplicate") || strings.Contains(errStr, "duplicada") {
			SendError(c, http.StatusConflict, ErrDuplicateEntry, "El código de barras ya está registrado", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al crear producto", err)
		return
	}
	c.JSON(http.StatusCreated, product)
	
	// AVISO GLOBAL: Nuevo producto en el catálogo
	go sse.GetSSEService().BroadcastProductUpdate(product)
	
	// Auditoría de Creación
	h.auditService.Log(dniStr, nameStr, "CREATE_PRODUCT", "INVENTORY", 
		fmt.Sprintf("Creado producto: %s (%s)", product.ProductName, product.Barcode),
		fmt.Sprintf("Se registró un nuevo producto: %s con código %s", product.ProductName, product.Barcode),
		"", c.ClientIP(), c.Request.UserAgent(), false)
}

func (h *ProductHandler) GetAll(c *gin.Context) {
	products, err := h.service.GetAllProducts()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener catálogo de productos", err)
		return
	}
	c.JSON(http.StatusOK, products)
}

func (h *ProductHandler) GetAllPaginated(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("pageSize", "100"))
	search := c.Query("q")

	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 || pageSize > 10000 {
		pageSize = 100
	}

	products, total, err := h.service.GetPaginatedProducts(page, pageSize, search)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener productos paginados", err)
		return
	}

	// Dynamic calculation of NetProfit and Pack Stock
	for i := range products {
		products[i].NetProfit = products[i].SalePrice - products[i].PurchasePrice
		if products[i].IsPack && products[i].BaseProduct != nil && products[i].PackMultiplier > 0 {
			products[i].Quantity = math.Floor(products[i].BaseProduct.Quantity / float64(products[i].PackMultiplier))
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"items":      products,
		"total":      total,
		"page":       page,
		"pageSize":   pageSize,
		"totalPages": int(math.Ceil(float64(total) / float64(pageSize))),
	})
}

func (h *ProductHandler) GetByBarcode(c *gin.Context) {
	barcode := c.Param("barcode")
	// Preload Category AND BaseProduct for pack logic
	product, err := h.service.GetProductWithPreloads(barcode, "Category", "BaseProduct")
	if err != nil {
		SendError(c, http.StatusNotFound, ErrNotFound, "Producto no encontrado", err)
		return
	}

	// Recalculate stock if it's a pack
	if product.IsPack && product.BaseProduct != nil && product.PackMultiplier > 0 {
		product.Quantity = math.Floor(product.BaseProduct.Quantity / float64(product.PackMultiplier))
	}

	c.JSON(http.StatusOK, product)
}

func (h *ProductHandler) GetInventory(c *gin.Context) {
	from := c.Query("from")
	to := c.Query("to")
	fromDate, _ := parseDate(from)
	toDate, _ := parseDate(to)

	data, err := h.inventoryService.GetInventory(fromDate, toDate)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener inventario", err)
		return
	}
	c.JSON(http.StatusOK, data)
}

func (h *ProductHandler) Update(c *gin.Context) {
	barcode := c.Param("barcode")
	var product models.Product
	if err := c.ShouldBindJSON(&product); err != nil {
		fmt.Printf("[ERROR] ShouldBindJSON failed: %v\n", err)
		fieldErrors := parseValidationErrors(err)
		SendValidationError(c, fieldErrors)
		return
	}

	// Sanitización
	product.ProductName = strings.ToUpper(strings.TrimSpace(product.ProductName))
	// Capturar estado anterior para auditoría forense
	existing, _ := h.service.GetProduct(barcode)

	if err := h.service.UpdateProduct(barcode, &product); err != nil {
		fmt.Printf("[ERROR] UpdateProduct failed for barcode %s: %v\n", barcode, err)
		errStr := strings.ToLower(err.Error())
		if strings.Contains(errStr, "not found") {
			SendError(c, http.StatusNotFound, ErrNotFound, "Producto no encontrado", err)
			return
		}
		// TEMPORAL: Devolver error REAL al frontend para diagnóstico
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "UPDATE_FAILED",
			"message": err.Error(),
			"detail":  fmt.Sprintf("Barcode: %s | Error: %v", barcode, err),
		})
		return
	}

	// Auditoría de Cambio de Precio (CRÍTICO)
	if existing != nil && existing.SalePrice != product.SalePrice {
		dniStr, nameStr := GetContextUser(c)

		if dniStr == "" {
			dniStr = "SISTEMA"
		}
		if nameStr == "" {
			nameStr = "SISTEMA"
		}

		h.auditService.Log(dniStr, nameStr, "PRICE_CHANGE", "INVENTORY",
			fmt.Sprintf("Cambio precio %s: %f -> %f", barcode, existing.SalePrice, product.SalePrice),
			fmt.Sprintf("Se modificó el precio de venta de %s de $%s a $%s", existing.ProductName, fmt.Sprintf("%.2f", existing.SalePrice), fmt.Sprintf("%.2f", product.SalePrice)),
			fmt.Sprintf(`{"before": {"price": %f}, "after": {"price": %f}}`, existing.SalePrice, product.SalePrice),
			c.ClientIP(), c.Request.UserAgent(), true)
	}

	c.JSON(http.StatusOK, product)

	// AVISO GLOBAL: Producto actualizado
	go sse.GetSSEService().BroadcastProductUpdate(product)
}

func (h *ProductHandler) Delete(c *gin.Context) {
	barcode := c.Param("barcode")
	existing, _ := h.service.GetProduct(barcode)

	if err := h.service.DeleteProduct(barcode); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			SendError(c, http.StatusNotFound, ErrNotFound, "Producto no encontrado", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al eliminar producto", err)
		return
	}

	// Auditoría de Eliminación (CRÍTICO)
	dniStr, nameStr := GetContextUser(c)
	productName := barcode
	if existing != nil { productName = existing.ProductName }
	
	h.auditService.Log(dniStr, nameStr, "DELETE_PRODUCT", "INVENTORY", 
		fmt.Sprintf("Desactivado producto: %s", barcode),
		fmt.Sprintf("Se desactivó el producto: %s (%s)", productName, barcode),
		"", c.ClientIP(), c.Request.UserAgent(), true)

	c.JSON(http.StatusOK, gin.H{"message": "Product deleted"})

	// AVISO GLOBAL: Producto eliminado/desactivado
	go sse.GetSSEService().BroadcastProductUpdate(barcode)
}

func (h *ProductHandler) ReceiveStock(c *gin.Context) {
	var body struct {
		Barcode          string  `json:"barcode" binding:"required"`
		AddedQuantity    float64 `json:"addedQuantity" binding:"required"`
		NewPurchasePrice float64 `json:"newPurchasePrice"`
		NewSalePrice     float64 `json:"newSalePrice"`
		SupplierID       *uint   `json:"supplierId"`
		Iva              float64 `json:"iva"`
		Icui             float64 `json:"icui"`
		Ibua             float64 `json:"ibua"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	if err := h.service.ReceiveStock(body.Barcode, body.AddedQuantity, body.NewPurchasePrice, body.NewSalePrice, body.SupplierID, body.Iva, body.Icui, body.Ibua); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al registrar entrada de stock", err)
		return
	}

	product, _ := h.service.GetProduct(body.Barcode)
	c.JSON(http.StatusOK, product)

	// AVISO GLOBAL: Cambio en inventario
	go sse.GetSSEService().BroadcastInventoryUpdate(product)
	go sse.GetSSEService().BroadcastProductUpdate(product)

	// Auditoría de Recepción Individual
	dniStr, nameStr := GetContextUser(c)
	h.auditService.Log(dniStr, nameStr, "RECEIVE_STOCK", "INVENTORY", 
		fmt.Sprintf("Entrada stock: %s (+%.2f)", body.Barcode, body.AddedQuantity),
		fmt.Sprintf("Se registró entrada de %.2f unidades para el producto %s", body.AddedQuantity, product.ProductName),
		"", c.ClientIP(), c.Request.UserAgent(), false)
}

func (h *ProductHandler) AdjustStock(c *gin.Context) {
	barcode := c.Param("barcode")
	var body struct {
		Amount float64 `json:"amount"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	// Extraer información del empleado del JWT context
	dniStr, nameStr := GetContextUser(c)

	if err := h.service.AdjustStock(barcode, body.Amount, dniStr, nameStr); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al ajustar stock", err)
		return
	}

	product, _ := h.service.GetProduct(barcode)
	c.JSON(http.StatusOK, product)

	// AVISO GLOBAL: Ajuste de stock manual
	go sse.GetSSEService().BroadcastInventoryUpdate(product)
	go sse.GetSSEService().BroadcastProductUpdate(product)
}

func (h *ProductHandler) BulkReceive(c *gin.Context) {
	var body struct {
		OrderID       *uint                `json:"orderId"`
		Entries       []ports.ReceiveEntry `json:"entries" binding:"required"`
		BypassExpense bool                 `json:"bypassExpense"`
		PaymentSource string               `json:"paymentSource"`
		SupplierID    *uint                `json:"supplierId"`
		FreightCost   float64              `json:"freightCost"`
		TotalWeight   float64              `json:"totalWeight"`
		IsEgreso      *bool                `json:"isEgreso"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	// Doble Validación de Seguridad: Solo ADMIN/SUPERADMIN pueden omitir egresos
	if body.BypassExpense {
		roleStr := GetContextRole(c)
		if roleStr != "ADMIN" && roleStr != "SUPERADMIN" {
			SendError(c, http.StatusForbidden, ErrForbidden, "No tienes permisos para omitir el registro de egresos", nil)
			return
		}
	}

	employeeDNI, _ := c.Get("dni")
	dniStr := fmt.Sprintf("%v", employeeDNI)

	if body.PaymentSource == "" {
		body.PaymentSource = "EFECTIVO"
	}

	isEgreso := true
	if body.IsEgreso != nil {
		isEgreso = *body.IsEgreso
	}

	if err := h.service.BulkReceiveStock(body.Entries, body.OrderID, body.BypassExpense, body.PaymentSource, dniStr, body.SupplierID, body.FreightCost, body.TotalWeight, isEgreso); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al procesar recepción masiva", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Bulk receive processed successfully"})

	// AVISO GLOBAL: Recepción masiva (Actualiza Dashboard, Inventario y Productos)
	go func() {
		sse.GetSSEService().BroadcastInventoryUpdate(nil)
		sse.GetSSEService().BroadcastDashboardUpdate()
		sse.GetSSEService().BroadcastProductUpdate(nil)
	}()

	// Auditoría de Recepción Masiva
	dniStr, nameStr := GetContextUser(c)
	h.auditService.Log(dniStr, nameStr, "BULK_RECEIVE", "INVENTORY", 
		fmt.Sprintf("Recepción masiva: %d ítems (Egreso: %v)", len(body.Entries), !body.BypassExpense),
		fmt.Sprintf("Se procesó una recepción masiva de %d productos. Origen pago: %s", len(body.Entries), body.PaymentSource),
		"", c.ClientIP(), c.Request.UserAgent(), false)
}
func (h *ProductHandler) FixPrices(c *gin.Context) {
	if err := h.service.FixAllProductPrices(); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al corregir precios", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Precios corregidos y redondeados exitosamente"})

	// AVISO GLOBAL: Corrección masiva de precios realizada
	go sse.GetSSEService().BroadcastProductUpdate(nil)
}

func (h *ProductHandler) GetSavingsOpportunities(c *gin.Context) {
	opportunities, err := h.service.GetSavingsOpportunities()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener oportunidades de ahorro", err)
		return
	}
	c.JSON(http.StatusOK, opportunities)
}

func (h *ProductHandler) GetPriceComparison(c *gin.Context) {
	barcode := c.Param("barcode")
	comparison, err := h.service.GetProductPriceComparison(barcode)
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener comparativa de precios", err)
		return
	}
	c.JSON(http.StatusOK, comparison)
}

func (h *ProductHandler) OpenBulk(c *gin.Context) {
	barcode := c.Param("barcode")
	dniStr, nameStr := GetContextUser(c)

	// Capturar producto para auditoría
	product, err := h.service.GetProduct(barcode)
	if err != nil {
		SendError(c, http.StatusNotFound, ErrNotFound, "Producto no encontrado", err)
		return
	}

	if err := h.service.OpenBulk(barcode, dniStr, nameStr); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al abrir paca/empaque", err)
		return
	}

	// Auditoría de Apertura (Apertura a Venta Libre)
	h.auditService.Log(dniStr, nameStr, "OPEN_BULK", "INVENTORY",
		fmt.Sprintf("Abierta paca: %s (%s)", product.ProductName, barcode),
		fmt.Sprintf("Se descontó 1 unidad de %s para habilitar Venta Rápida de sus componentes.", product.ProductName),
		fmt.Sprintf(`{"before": %f, "after": %f}`, product.Quantity, product.Quantity-1),
		c.ClientIP(), c.Request.UserAgent(), false)

	c.JSON(http.StatusOK, gin.H{"message": "Paca abierta correctamente. Stock actualizado."})

	// AVISO GLOBAL: Apertura de paca (Afecta stock de varios productos)
	go func() {
		sse.GetSSEService().BroadcastInventoryUpdate(nil)
		sse.GetSSEService().BroadcastProductUpdate(nil)
	}()
}
func (h *ProductHandler) ExportCSV(c *gin.Context) {
	products, err := h.service.GetAllProducts()
	if err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al obtener catálogo para exportar", err)
		return
	}

	fileName := fmt.Sprintf("catalogo_productos_%s.csv", time.Now().Format("20060102_150405"))
	c.Header("Content-Disposition", "attachment; filename="+fileName)
	c.Header("Content-Type", "text/csv; charset=utf-8")

	writer := csv.NewWriter(c.Writer)
	writer.Comma = ';' // Delimitador estándar para Excel en español

	// Cabecera: Barcode, Name, Quantity, PurchasePrice, SalePrice, IsWeighted
	writer.Write([]string{"CODIGO", "NOMBRE", "STOCK", "COSTO", "VENTA", "PESABLE"})

	for _, p := range products {
		writer.Write([]string{
			p.Barcode,
			p.ProductName,
			fmt.Sprintf("%.2f", p.Quantity),
			fmt.Sprintf("%.2f", p.PurchasePrice),
			fmt.Sprintf("%.2f", p.SalePrice),
			fmt.Sprintf("%v", p.IsWeighted),
		})
	}
	writer.Flush()
}

func (h *ProductHandler) ImportCSV(c *gin.Context) {
	file, _, err := c.Request.FormFile("file")
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "No se proporcionó ningún archivo", err)
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	// Detectar delimitador (punto y coma o coma)
	reader.Comma = ';' 
	
	// Leer cabecera
	header, err := reader.Read()
	if err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Error leyendo cabecera del CSV", err)
		return
	}

	// Si la cabecera no parece tener ';' probamos con ','
	if len(header) < 2 {
		file.Seek(0, 0)
		reader = csv.NewReader(file)
		header, _ = reader.Read()
	}

	var products []models.Product
	var errors []string
	line := 1

	dniStr, nameStr := GetContextUser(c)

	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		line++
		if err != nil {
			errors = append(errors, fmt.Sprintf("Línea %d: Error de formato", line))
			continue
		}

		// Mapeo básico: Barcode, Name, Quantity, PurchasePrice, SalePrice, IsWeighted
		if len(record) < 5 {
			errors = append(errors, fmt.Sprintf("Línea %d: Columnas insuficientes", line))
			continue
		}

		qty, _ := strconv.ParseFloat(strings.ReplaceAll(record[2], ",", "."), 64)
		pPrice, _ := strconv.ParseFloat(strings.ReplaceAll(record[3], ",", "."), 64)
		sPrice, _ := strconv.ParseFloat(strings.ReplaceAll(record[4], ",", "."), 64)
		isWeighted := false
		if len(record) > 5 {
			isWeighted = strings.ToUpper(record[5]) == "TRUE" || record[5] == "1" || strings.ToUpper(record[5]) == "SI"
		}

		p := models.Product{
			Barcode:       strings.ToUpper(strings.TrimSpace(record[0])),
			ProductName:   strings.ToUpper(strings.TrimSpace(record[1])),
			Quantity:      qty,
			PurchasePrice: pPrice,
			SalePrice:     sPrice,
			IsWeighted:    isWeighted,
			CreatedByDNI:  dniStr,
			UpdatedByDNI:  dniStr,
			IsActive:      true,
		}

		if p.Barcode == "" || p.ProductName == "" {
			errors = append(errors, fmt.Sprintf("Línea %d: Código o Nombre vacío", line))
			continue
		}

		products = append(products, p)
	}

	// Procesar Importación
	successCount := 0
	for _, p := range products {
		if err := h.service.UpsertProduct(&p); err == nil {
			successCount++
		} else {
			errors = append(errors, fmt.Sprintf("Producto %s: %v", p.Barcode, err))
		}
	}

	// Auditoría
	h.auditService.Log(dniStr, nameStr, "IMPORT_CSV", "INVENTORY", 
		fmt.Sprintf("Importación CSV: %d éxitos, %d errores", successCount, len(errors)),
		fmt.Sprintf("Se procesó un archivo CSV. Se crearon/actualizaron %d productos.", successCount),
		"", c.ClientIP(), c.Request.UserAgent(), true)

	// Avisar al frontend
	go sse.GetSSEService().BroadcastProductUpdate(nil)

	c.JSON(http.StatusOK, gin.H{
		"success": successCount,
		"total":   len(products),
		"errors":  errors,
	})
}

func (h *ProductHandler) UpdateMinStock(c *gin.Context) {
	c.JSON(200, gin.H{})
}

func (h *ProductHandler) RegisterShrinkage(c *gin.Context) {
	c.JSON(200, gin.H{})
}

func (h *ProductHandler) SanitizeAllNames(c *gin.Context) {
	h.service.SanitizeAllNames()
	c.JSON(200, gin.H{})
}

func (h *ProductHandler) DeleteReception(c *gin.Context) {
	ref := c.Param("ref")
	h.service.DeleteReception(ref)
	c.JSON(200, gin.H{})
}
