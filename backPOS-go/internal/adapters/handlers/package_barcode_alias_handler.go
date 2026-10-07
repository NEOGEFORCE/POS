// Handler del módulo de alias de código de barras de PAQUETE
// (recepción de productos cuyo código solo viene en el empaque).
//
// Reglas HTTP:
//
//   - GET  /api/inventory/package-barcode/resolve?code=XXX
//     resuelve un código (empleado+admin).
//   - POST /api/inventory/package-barcode
//     crea/actualiza alias idempotente (empleado+admin).
//   - POST /api/inventory/package-barcode/seen
//     marca el alias como visto (empleado+admin).
//
// Las colisiones con otro producto se traducen a 409 estable:
//
//	409 { code: "PACKAGE_CODE_BELONGS_TO_OTHER_PRODUCT", ... }
//
// El frontend hace matching por `code` literal en ApiError.data.code.
package handlers

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"

	"github.com/gin-gonic/gin"
)

type PackageBarcodeAliasHandler struct {
	repo *repositories.PackageBarcodeAliasRepository
}

func NewPackageBarcodeAliasHandler(repo *repositories.PackageBarcodeAliasRepository) *PackageBarcodeAliasHandler {
	return &PackageBarcodeAliasHandler{repo: repo}
}

// GET /api/inventory/package-barcode/resolve
func (h *PackageBarcodeAliasHandler) Resolve(c *gin.Context) {
	code := strings.TrimSpace(c.Query("code"))
	if code == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "code requerido"})
		return
	}
	result, err := h.repo.Resolve(c.Request.Context(), code)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, result)
}

type ensureAliasRequest struct {
	ProductBarcode string `json:"productBarcode"`
	PackageCode    string `json:"packageCode"`
	UnitsPerPack   int    `json:"unitsPerPack"`
	SupplierID     *uint  `json:"supplierId"`
}

// POST /api/inventory/package-barcode
func (h *PackageBarcodeAliasHandler) Ensure(c *gin.Context) {
	var req ensureAliasRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido", "detail": err.Error()})
		return
	}
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida"})
		return
	}
	if strings.TrimSpace(req.ProductBarcode) == "" || strings.TrimSpace(req.PackageCode) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "productBarcode y packageCode son obligatorios"})
		return
	}
	if req.UnitsPerPack < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unitsPerPack debe ser >= 1"})
		return
	}

	alias, created, err := h.repo.EnsureAlias(
		c.Request.Context(),
		req.ProductBarcode,
		req.PackageCode,
		req.UnitsPerPack,
		req.SupplierID,
		dni,
	)
	if err != nil {
		var collision *repositories.ErrPackageCodeBelongsToOtherProduct
		if errors.As(err, &collision) {
			name := collision.Hit.ProductName
			if name == "" {
				name = collision.Hit.ProductBarcode
			}
			msg := fmt.Sprintf(
				"El código %q ya está asociado al producto %s (%s) como %s. Para registrarlo como paquete de otro producto, primero quítalo del catálogo actual.",
				req.PackageCode,
				collision.Hit.ProductBarcode,
				name,
				humanizeCollisionSource(collision.Hit.Source),
			)
			c.JSON(http.StatusConflict, gin.H{
				"code":           models.ErrCodePackageBelongsToOther,
				"message":        msg,
				"productBarcode": collision.Hit.ProductBarcode,
				"productName":    name,
				"source":         collision.Hit.Source,
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"created": created, "alias": alias})
}

type seenRequest struct {
	PackageCode string `json:"packageCode"`
	// AliasID queda aceptado en el payload por compatibilidad con clientes
	// antiguos, pero ya no se usa: la ruta canónica para marcar visto es
	// enviar `packageCode`. Si solo llega `aliasId`, el handler responde
	// 400 con un mensaje claro para no fingir que actualizó la fila.
	AliasID uint `json:"aliasId"`
}

// POST /api/inventory/package-barcode/seen
// Permite al frontend reportar que un alias se utilizó en una recepción.
// Fire-and-forget desde el cliente: incrementa seen_count y sella
// last_seen_at. No pelea por consistencia porque la UNIQUE constraint
// garantiza que no haya duplicados.
//
// Contrato público: el request DEBE incluir `packageCode`. El campo
// `aliasId` se tolera para no romper clientes antiguos pero NO es
// un identificador funcional; sin `packageCode` la operación no puede
// resolver qué fila actualizar y devuelve 400.
func (h *PackageBarcodeAliasHandler) MarkSeen(c *gin.Context) {
	var req seenRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "payload inválido", "detail": err.Error()})
		return
	}
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida"})
		return
	}
	code := strings.TrimSpace(req.PackageCode)
	if code == "" {
		// Rechazo explícito: antes convertíamos aliasId → string y lo
		// buscábamos como package_code, lo que NUNCA matcheaba y devolvía
		// 200 silenciosamente sin actualizar nada. Ahora el cliente ve
		// un 400 claro y puede corregir el payload.
		c.JSON(http.StatusBadRequest, gin.H{"error": "packageCode es obligatorio"})
		return
	}
	if err := h.repo.MarkSeen(c.Request.Context(), code); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func humanizeCollisionSource(source string) string {
	switch source {
	case "barcode":
		return "código principal"
	case "alternateCodes":
		return "código alterno"
	case "label_code":
		return "etiqueta impresa"
	case "other_alias":
		return "alias de recepción"
	default:
		return source
	}
}
