package handlers

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
	"github.com/gin-gonic/gin"
)

type ProductHandler struct {
	service          *services.ProductService
	inventoryService *services.InventoryService
}

func NewProductHandler(s *services.ProductService, i *services.InventoryService) *ProductHandler {
	return &ProductHandler{service: s, inventoryService: i}
}

func (h *ProductHandler) Create(c *gin.Context) {
	var product models.Product
	if err := c.ShouldBindJSON(&product); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
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

	// Dynamic calculation of NetProfit
	for i := range products {
		products[i].NetProfit = products[i].SalePrice - products[i].PurchasePrice
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
	product, err := h.service.GetProduct(barcode)
	if err != nil {
		SendError(c, http.StatusNotFound, ErrNotFound, "Producto no encontrado", err)
		return
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
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}
	if err := h.service.UpdateProduct(barcode, &product); err != nil {
		errStr := strings.ToLower(err.Error())
		if strings.Contains(errStr, "not found") {
			SendError(c, http.StatusNotFound, ErrNotFound, "Producto no encontrado", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al actualizar producto", err)
		return
	}
	c.JSON(http.StatusOK, product)
}

func (h *ProductHandler) Delete(c *gin.Context) {
	barcode := c.Param("barcode")
	if err := h.service.DeleteProduct(barcode); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			SendError(c, http.StatusNotFound, ErrNotFound, "Producto no encontrado", err)
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al eliminar producto", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "Product deleted"})
}

func (h *ProductHandler) ReceiveStock(c *gin.Context) {
	var body struct {
		Barcode          string   `json:"barcode" binding:"required"`
		AddedQuantity    float64  `json:"addedQuantity" binding:"required"`
		NewPurchasePrice float64  `json:"newPurchasePrice"`
		NewSalePrice     float64  `json:"newSalePrice"`
		SupplierID       *uint    `json:"supplierId"`
		Iva              float64  `json:"iva"`
		Icui             float64  `json:"icui"`
		Ibua             float64  `json:"ibua"`
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

	if err := h.service.AdjustStock(barcode, body.Amount); err != nil {
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "Fallo al ajustar stock", err)
		return
	}

	product, _ := h.service.GetProduct(barcode)
	c.JSON(http.StatusOK, product)
}

func (h *ProductHandler) BulkReceive(c *gin.Context) {
	var body struct {
		Entries []services.ReceiveEntry `json:"entries" binding:"required"`
	}

	if err := c.ShouldBindJSON(&body); err != nil {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "Formato de datos inválido", err)
		return
	}

	if err := h.service.BulkReceiveStock(body.Entries); err != nil {
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
