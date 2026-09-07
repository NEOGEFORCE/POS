package handlers

import (
	"log"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// APIError define el formato estándar de errores para el frontend
type APIError struct {
	Code     string `json:"code"`
	Message  string `json:"message"`
	Details  string `json:"details,omitempty"`
	Metadata any    `json:"metadata,omitempty"`
}

// ErrorResponse envuelve el APIError y añade campos de éxito globales
type ErrorResponse struct {
	Success bool     `json:"success"`
	Message string   `json:"message"`
	Error   APIError `json:"error"`
}

// dbErrorFingerprints son marcas inequívocas de que un texto viene del driver
// de PostgreSQL, de GORM o del runtime de Go y NO de una regla de negocio.
//
// Cualquier detalle que contenga una de estas marcas se queda en el log del
// servidor: al cliente sólo viaja el mensaje traducido o uno genérico. Filtrar
// esto importa porque el texto crudo de Postgres revela nombres de tablas,
// columnas, constraints y hasta fragmentos del SQL, que es material de reconocimiento
// para un atacante.
var dbErrorFingerprints = []string{
	"sqlstate",
	"pq:",
	"pgconn",
	"pgx",
	"gorm",
	"column",
	"relation ",
	"constraint",
	"violates",
	"duplicate key",
	"table ",
	"select ",
	"insert into",
	"update ",
	"delete from",
	"syntax error at or near",
	"sql:",
	"dial tcp",
	"goroutine",
	".go:",
	"/internal/",
}

// containsDBFingerprint indica si un texto parece provenir de la base de datos
// o del runtime en vez de ser un mensaje de negocio escrito para el usuario.
func containsDBFingerprint(s string) bool {
	lower := strings.ToLower(s)
	for _, fp := range dbErrorFingerprints {
		if strings.Contains(lower, fp) {
			return true
		}
	}
	return false
}

// sanitizeClientMessage devuelve el texto tal cual si es seguro para el usuario,
// o el reemplazo genérico si huele a error técnico.
func sanitizeClientMessage(s, fallback string) string {
	if s == "" || containsDBFingerprint(s) {
		return fallback
	}
	return s
}

// SendError centraliza la respuesta de errores en el backend.
//
// Contrato de seguridad: NUNCA viaja al cliente texto crudo del driver de base
// de datos. El detalle técnico completo se registra en el log del servidor; al
// cliente le llega, en este orden de preferencia:
//  1. la traducción amigable de TranslateDBError, si reconoció el error;
//  2. el mensaje de negocio tal cual, si el error lo escribió el dominio
//     (validaciones tipo "el monto debe ser mayor a cero"), que es útil y seguro;
//  3. nada, si el detalle contiene marcas técnicas (SQLSTATE, pq:, gorm, column…).
func SendError(c *gin.Context, status int, code, message string, errOrMeta any) {
	technical := ""
	var metadata any

	if errOrMeta != nil {
		if e, ok := errOrMeta.(error); ok {
			technical = e.Error()
		} else {
			metadata = errOrMeta
		}
	}

	details := ""
	if technical != "" {
		friendlyTitle, friendlyDetails := TranslateDBError(technical)
		if friendlyTitle != "" {
			// Traducción reconocida: título y explicación curados en español.
			message = friendlyTitle
			details = friendlyDetails
		} else {
			// Sin traducción: sólo se propaga si es un mensaje de negocio.
			details = sanitizeClientMessage(technical, "")
		}
	}

	// El mensaje también se filtra: algunos handlers lo construyen
	// concatenando err.Error(), y eso sería la misma fuga por otra puerta.
	message = sanitizeClientMessage(message, "Ocurrió un error procesando la solicitud. Intente de nuevo.")

	log.Printf("❌ [API_ERROR] %d | Code: %s | Message: %s | Cliente: %s | Técnico: %s",
		status, code, message, details, technical)

	c.JSON(status, ErrorResponse{
		Success: false,
		Message: message,
		Error: APIError{
			Code:     code,
			Message:  message,
			Details:  details,
			Metadata: metadata,
		},
	})
}

// Códigos de error comunes
const (
	ErrBadRequest               = "ERR_BAD_REQUEST"
	ErrUnauthorized             = "ERR_UNAUTHORIZED"
	ErrForbidden                = "ERR_FORBIDDEN"
	ErrNotFound                 = "ERR_NOT_FOUND"
	ErrDuplicateEntry           = "ERR_DUPLICATE_ENTRY"
	ErrConflict                 = "ERR_CONFLICT"
	ErrInternalServer           = "ERR_INTERNAL_ERROR"
	ErrHistoricalMarkerReserved = "HISTORICAL_MARKER_RESERVED"
)

func parseDate(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	// Try full format first
	t, err := time.Parse("2006-01-02 15:04:05", s)
	if err == nil {
		return t, nil
	}
	// Try datetime-local format from frontend
	t, err = time.Parse("2006-01-02T15:04", s)
	if err == nil {
		return t, nil
	}
	// Try ISO format with seconds
	t, err = time.Parse("2006-01-02T15:04:05", s)
	if err == nil {
		return t, nil
	}
	// Try date only
	return time.Parse("2006-01-02", s)
}
