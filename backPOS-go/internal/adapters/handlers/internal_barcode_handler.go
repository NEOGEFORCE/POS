// Handler del módulo de códigos internos propios (namespace POSINT-).
//
// Reglas HTTP:
//
//   - POST /api/labels/internal-codes/reserve     (empleado+admin)
//     Reserva un código nuevo. Devuelve el shape:
//     { "code": "POSINT-ABCDEF01",
//     "expiresAt": "2026-10-12T18:45:00Z",
//     "source": "product_form",
//     "status": "RESERVED" }
//     El frontend inserta `code` en el campo "Código" del ProductFormModal.
//
//   - GET  /api/labels/internal-codes/:code       (empleado+admin)
//     Consulta el estado de una reserva. Útil para que la UI muestre
//     "ya consumida" o "expirada" sin tener que crear el producto.
//
// La ruta de CONSUMO vive dentro de ProductHandler.Create: cuando el
// barcode del producto cae en el namespace POSINT-, el flujo se desvía
// a `InternalBarcodeRepository.CreateProductConsumingReservation`, que
// hace SELECT FOR UPDATE + INSERT + UPDATE en la misma transacción.
//
// Contrato de códigos de error (parte del front):
//
//	INTERNAL_RESERVATION_NOT_FOUND
//	INTERNAL_RESERVATION_EXPIRED
//	INTERNAL_RESERVATION_ALREADY_USED
//	INTERNAL_BARCODE_FORMAT_INVALID
//	INTERNAL_BARCODE_REQUIRES_RESERVATION
//	INTERNAL_PRODUCT_BARCODE_IN_USE
package handlers

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"

	"github.com/gin-gonic/gin"
)

// InternalBarcodeHandler agrupa las rutas de /api/labels/internal-codes/*.
// El repo es la única dependencia: toda la lógica de generación,
// colisión y consumo vive ahí; el handler sólo traduce HTTP.
type InternalBarcodeHandler struct {
	repo *repositories.InternalBarcodeRepository
}

// NewInternalBarcodeHandler construye el handler.
func NewInternalBarcodeHandler(repo *repositories.InternalBarcodeRepository) *InternalBarcodeHandler {
	return &InternalBarcodeHandler{repo: repo}
}

// reserveRequest es el payload esperado por POST /internal-codes/reserve.
// Todos los campos son opcionales; sin ellos se usan defaults sanos.
type reserveRequest struct {
	// Source: 'product_form' (default), 'reception', 'other'.
	Source string `json:"source"`
	// Note: observación libre, se guarda tal cual en la fila (sin filtrar
	// por BD a la vista del cliente — SendError sanitiza salida).
	Note string `json:"note"`
	// HexLen: longitud del cuerpo hex (8..24). 0 → default 12.
	HexLen int `json:"hexLen"`
	// TTLSeconds: tiempo de vida de la reserva en segundos.
	//   0  → DefaultInternalBarcodeTTL (15 min).
	//   <0 → sin expiración (uso administrativo; el handler lo acepta
	//        pero mapea a TTL=0 por ahora para evitar reservas eternas
	//        creadas por error desde el frontend).
	TTLSeconds int `json:"ttlSeconds"`
}

// reserveResponse es el shape del 200 OK. El frontend condiciona por
// `code` para llenar el campo del modal. Si en el futuro se le añaden
// campos, deben ser aditivos: no renombrar los existentes.
type reserveResponse struct {
	Code       string     `json:"code"`
	Status     string     `json:"status"`
	Source     string     `json:"source"`
	ExpiresAt  *time.Time `json:"expiresAt,omitempty"`
	ReservedAt time.Time  `json:"reservedAt"`
}

// Reserve maneja POST /api/labels/internal-codes/reserve.
//
// Reglas:
//   - 401 si no hay sesión (defensa: AuthMiddleware ya protege la ruta).
//   - 400 si el body está malformado o el source es inválido.
//   - 503 si el generador no logra producir un código único tras los
//     reintentos máximos (bug operativo, no transitorio).
//   - 500 ante cualquier otro fallo (BD, crypto). SendError sanitiza
//     detalles técnicos antes de responder.
//   - 200 con `reserveResponse`.
func (h *InternalBarcodeHandler) Reserve(c *gin.Context) {
	// 1) Sesión obligatoria. El middleware ya protege la ruta, pero el
	// handler es defensivo: así una regresión del wiring sigue devolviendo
	// 401 claro en vez de un 500 por falta de DNI.
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida"})
		return
	}

	// 2) Body opcional: `c.ShouldBindJSON` con body vacío devuelve EOF; lo
	// toleramos para que un `POST` sin cuerpo use los defaults.
	var req reserveRequest
	if c.Request.ContentLength > 0 {
		if err := c.ShouldBindJSON(&req); err != nil {
			SendError(c, http.StatusBadRequest, ErrBadRequest, "payload inválido", err)
			return
		}
	}

	// 3) Normalización del source (default product_form).
	source := strings.TrimSpace(req.Source)
	if source == "" {
		source = models.InternalBarcodeSourceProductForm
	}
	if !models.IsValidInternalSource(source) {
		SendError(c, http.StatusBadRequest, ErrBadRequest,
			"source inválido (allowed: product_form, reception, other)", nil)
		return
	}

	// 4) TTL: positivos van tal cual (en segundos); 0 o negativos usan el
	// default. Sin TTL negativo (reservas eternas) para que un cliente
	// malicioso no pueda bloquear códigos permanentemente.
	ttl := time.Duration(0)
	if req.TTLSeconds > 0 {
		ttl = time.Duration(req.TTLSeconds) * time.Second
	}

	// 5) Reserva atómica.
	res, err := h.repo.Reserve(c.Request.Context(), repositories.ReserveOptions{
		Source:   source,
		ActorDNI: dni,
		Note:     req.Note,
		HexLen:   req.HexLen,
		TTL:      ttl,
	})
	if err != nil {
		switch {
		case errors.Is(err, repositories.ErrInternalBarcodeInvalidSource):
			SendError(c, http.StatusBadRequest, ErrBadRequest, "source inválido", nil)
			return
		case errors.Is(err, repositories.ErrInternalBarcodeInvalidActor):
			// AuthMiddleware ya exige actor; esto es defensa en profundidad.
			SendError(c, http.StatusUnauthorized, ErrUnauthorized, "sesión requerida", nil)
			return
		case errors.Is(err, repositories.ErrInternalBarcodeExhausted):
			// 503 porque la operación puede reintentarse si se cambia la
			// longitud del cuerpo hex o si se purga el histórico.
			SendError(c, http.StatusServiceUnavailable, ErrInternalServer,
				"no se pudo generar un código único; intente de nuevo en unos segundos", nil)
			return
		default:
			SendError(c, http.StatusInternalServerError, ErrInternalServer,
				"no se pudo reservar el código interno", err)
			return
		}
	}

	c.JSON(http.StatusOK, reserveResponse{
		Code:       res.ReservedCode,
		Status:     res.Status,
		Source:     res.Source,
		ExpiresAt:  res.ExpiresAt,
		ReservedAt: res.ReservedAt,
	})
}

// GetByCode maneja GET /api/labels/internal-codes/:code.
//
// Útil para que la UI consulte el estado antes de crear el producto, o
// para depurar reservas abandonadas. El handler devuelve el shape de la
// reserva tal como está en BD (incluyendo consumed_product_barcode si
// está consumida); el frontend decide qué mostrar según `status`.
func (h *InternalBarcodeHandler) GetByCode(c *gin.Context) {
	dni := actorDNI(c)
	if dni == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "sesión requerida"})
		return
	}
	raw := strings.TrimSpace(c.Param("code"))
	if raw == "" {
		SendError(c, http.StatusBadRequest, ErrBadRequest, "code requerido", nil)
		return
	}
	// Rechazo temprano de códigos fuera del namespace: si alguien pide
	// `EAN12345` nunca estará aquí; devolver 404 ahorra un query.
	if !models.IsInternalBarcode(raw) {
		c.JSON(http.StatusNotFound, gin.H{
			"error": "código fuera del namespace POSINT-",
			"code":  models.ErrCodeInternalReservationNotFound,
		})
		return
	}
	res, err := h.repo.GetByCode(c.Request.Context(), raw)
	if err != nil {
		if errors.Is(err, repositories.ErrInternalBarcodeReservationNotFound) {
			c.JSON(http.StatusNotFound, gin.H{
				"error": "reserva no encontrada",
				"code":  models.ErrCodeInternalReservationNotFound,
			})
			return
		}
		SendError(c, http.StatusInternalServerError, ErrInternalServer,
			"no se pudo consultar la reserva", err)
		return
	}
	c.JSON(http.StatusOK, res)
}
