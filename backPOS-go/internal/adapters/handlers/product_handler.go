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

	// Mayúsculas y Metadatos
	product.Barcode = strings.ToUpper(product.Barcode)
	product.ProductName = strings.ToUpper(product.ProductName)
	dni, _ := c.Get("dni")
	dniStr := fmt.Sprintf("%v", dni)
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
	if pageSize <= 0 || pageSize > 1000 {
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
		"items":    products,
		"total":    total,
		"page":     page,
		"pageSize": pageSize,
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

	data, err := h.inventoryService.GetInventory(from, to)
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

	// Capturar estado anterior para auditoría forense
	existing, _ := h.service.GetProduct(barcode)

	if err := h.service.UpdateProduct(barcode, &product); err != nil {
		fmt.Printf("[ERROR] UpdateProduct failed: %v\n", err)
		errStr := strings.ToLower(err.Error())
		if strings.Contains(errStr, "not found") {
			SendError(c, http.StatusNotFound, ErrNotFound, "Producto no encontrado", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al actualizar producto", err)
		return
	}

	// Auditoría de Cambio de Precio (CRÍTICO)
	if existing != nil && existing.SalePrice != product.SalePrice {
		dni, _ := c.Get("dni")
		name, _ := c.Get("userName")
		h.auditService.Log(dni.(string), name.(string), "PRICE_CHANGE", "INVENTORY", 
			fmt.Sprintf("Cambio precio %s: %f -> %f", barcode, existing.SalePrice, product.SalePrice),
			fmt.Sprintf("Se modificó el precio de venta de %s de $%s a $%s", existing.ProductName, fmt.Sprintf("%.2f", existing.SalePrice), fmt.Sprintf("%.2f", product.SalePrice)),
			fmt.Sprintf(`{"before": {"price": %f}, "after": {"price": %f}}`, existing.SalePrice, product.SalePrice),
			c.ClientIP(), c.Request.UserAgent(), true)
	}

	c.JSON(http.StatusOK, product)
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
	dni, _ := c.Get("dni")
	name, _ := c.Get("userName")
	productName := barcode
	if existing != nil { productName = existing.ProductName }
	
	h.auditService.Log(dni.(string), name.(string), "DELETE_PRODUCT", "INVENTORY", 
		fmt.Sprintf("Eliminado producto: %s", barcode),
		fmt.Sprintf("Se eliminó permanentemente el producto: %s (%s)", productName, barcode),
		"", c.ClientIP(), c.Request.UserAgent(), true)

	c.JSON(http.StatusOK, gin.H{"message": "Product deleted"})
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
	employeeDNI, _ := c.Get("dni")
	employeeName, _ := c.Get("name")
	dniStr := fmt.Sprintf("%v", employeeDNI)
	nameStr := fmt.Sprintf("%v", employeeName)

	if err := h.service.AdjustStock(barcode, body.Amount, dniStr, nameStr); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al ajustar stock", err)
		return
	}

	product, _ := h.service.GetProduct(barcode)
	c.JSON(http.StatusOK, product)
}

func (h *ProductHandler) BulkReceive(c *gin.Context) {
	var body struct {
		OrderID *uint                `json:"orderId"`
		Entries []ports.ReceiveEntry `json:"entries" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	if err := h.service.BulkReceiveStock(body.Entries, body.OrderID); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al procesar recepción masiva", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Bulk receive processed successfully"})
}
func (h *ProductHandler) FixPrices(c *gin.Context) {
	if err := h.service.FixAllProductPrices(); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al corregir precios", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Precios corregidos y redondeados exitosamente"})
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
