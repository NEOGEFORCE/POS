// Package models — tipo del dominio para reservas de códigos internos
// propios (namespace `POSINT-<hex>`) solicitadas desde ProductFormModal
// cuando el producto no tiene código de barras comercial.
//
// IMPORTANTE: este modelo NO forma parte de schemaModels() en
// migrations/catalog.go. La tabla física la crea exclusivamente la
// migración `024_internal_barcode_reservations.sql`. Mantenerlo fuera de
// schemaModels protege el checksum de la migración 002 (model_schema) y
// respeta la política del runner: la BD la mutan sólo migraciones
// explícitas durante una ventana aprobada.
//
// Mapping snake_case ↔ Go sigue la convención GORM con `column:` explícito.
package models

import (
	"regexp"
	"strings"
	"time"
)

// InternalBarcodePrefix es el namespace reservado para códigos internos.
//
// Decisiones clave:
//
//   - Prefijo ASCII puro `POSINT-`, visible y distintivo. Ningún esquema
//     comercial GS1/GTIN/UPC empieza por "POSINT": una colisión futura con
//     un barcode real es imposible por construcción.
//   - CODE128 válido (todos los caracteres son imprimibles ASCII).
//   - Hex en MAYÚSCULAS porque `product_handler.Create` aplica
//     `strings.ToUpper(strings.TrimSpace(product.Barcode))`. Si el
//     generador emitiera minúsculas, el UPPER del handler mutaría el valor
//     y la consulta `reserved_code = ?` no encontraría la reserva (lookup
//     case-sensitive por PK).
const (
	InternalBarcodePrefix = "POSINT-"

	// InternalBarcodeHexMin y InternalBarcodeHexMax definen el rango de
	// longitudes aceptadas tras el prefijo (en nibbles hex). Deben COINCIDIR
	// exactamente con el CHECK ck_ibr_namespace_shape de la migración 024
	// (`^POSINT-[0-9A-F]{8,24}$`).
	InternalBarcodeHexMin = 8
	InternalBarcodeHexMax = 24

	// InternalBarcodeDefaultHexLen es la longitud por defecto del cuerpo hex
	// que emite el generador (12 nibbles = 48 bits de entropía por candidato,
	// más que suficientes para 1e6 códigos con < 1e-4 de colisión por intento).
	InternalBarcodeDefaultHexLen = 12
)

// internalBarcodeShape replica el CHECK ck_ibr_namespace_shape. Lo
// mantenemos duplicado a propósito: la BD es la última defensa, pero el
// servicio debe rechazar entradas inválidas antes de llegar al INSERT.
var internalBarcodeShape = regexp.MustCompile(`^POSINT-[0-9A-F]{8,24}$`)

// IsInternalBarcode reporta si `code` cae dentro del namespace reservado
// POSINT-. Compara en mayúsculas tras TrimSpace, consistente con la
// normalización de `product_handler.Create` sobre products.barcode.
func IsInternalBarcode(code string) bool {
	return strings.HasPrefix(strings.ToUpper(strings.TrimSpace(code)), InternalBarcodePrefix)
}

// IsValidInternalBarcode valida que `code` cumple el formato EXACTO del
// namespace (prefijo literal + 8..24 nibbles hex uppercase). Útil para
// rechazar early en el servicio antes de abrir la transacción.
func IsValidInternalBarcode(code string) bool {
	return internalBarcodeShape.MatchString(strings.ToUpper(strings.TrimSpace(code)))
}

// NormalizeInternalBarcode aplica la normalización canónica (TrimSpace +
// ToUpper) para empatar con lo que product_handler escribe en
// products.barcode. Devuelve "" si queda vacío.
func NormalizeInternalBarcode(code string) string {
	return strings.ToUpper(strings.TrimSpace(code))
}

// Estados de reserva. Diferencian la fila "viva pendiente de consumo",
// la "ya consumida" (vinculada a un producto creado) y la "expirada por
// timeout" (modal abandonado). Jamás se borra una fila: la unicidad del
// código vive para siempre vía la PK aun después de la expiración.
const (
	InternalBarcodeStatusReserved = "RESERVED"
	InternalBarcodeStatusConsumed = "CONSUMED"
	InternalBarcodeStatusExpired  = "EXPIRED"
)

// Origen operativo de la reserva. Útil para auditoría ("¿cuántas reservas
// se piden desde recepción vs desde el modal de productos?").
const (
	InternalBarcodeSourceProductForm = "product_form"
	InternalBarcodeSourceReception   = "reception"
	InternalBarcodeSourceOther       = "other"
)

// Códigos de error estables que el frontend condiciona. Son parte del
// contrato: si alguien los renombra, el UX del modal pierde su rama de
// recuperación específica.
const (
	// Reservation lookup / consumption outcomes.
	ErrCodeInternalReservationNotFound    = "INTERNAL_RESERVATION_NOT_FOUND"
	ErrCodeInternalReservationExpired     = "INTERNAL_RESERVATION_EXPIRED"
	ErrCodeInternalReservationAlreadyUsed = "INTERNAL_RESERVATION_ALREADY_USED"
	ErrCodeInternalBarcodeRequiresReserve = "INTERNAL_BARCODE_REQUIRES_RESERVATION"
	ErrCodeInternalBarcodeFormatInvalid   = "INTERNAL_BARCODE_FORMAT_INVALID"
	ErrCodeInternalProductAlreadyExists   = "INTERNAL_PRODUCT_BARCODE_IN_USE"
	ErrCodeInternalNamespaceForbiddenHere = "INTERNAL_NAMESPACE_FORBIDDEN"
)

// IsValidInternalSource verifica el enum CHECK ck_ibr_source_known.
func IsValidInternalSource(source string) bool {
	switch strings.TrimSpace(source) {
	case InternalBarcodeSourceProductForm,
		InternalBarcodeSourceReception,
		InternalBarcodeSourceOther:
		return true
	default:
		return false
	}
}

// InternalBarcodeReservation es la fila de internal_barcode_reservations.
// El PK es `reserved_code`: unicidad absoluta aun bajo reintentos
// simultáneos del generador (la BD rechaza el segundo INSERT con el mismo
// valor y el generador reintenta con otro candidato).
type InternalBarcodeReservation struct {
	ReservedCode           string     `gorm:"column:reserved_code;type:varchar(64);primaryKey" json:"reservedCode"`
	Status                 string     `gorm:"column:status;type:varchar(16);not null;default:'RESERVED'" json:"status"`
	Source                 string     `gorm:"column:source;type:varchar(16);not null;default:'product_form'" json:"source"`
	ReservedAt             time.Time  `gorm:"column:reserved_at;not null;default:now()" json:"reservedAt"`
	ReservedByDNI          string     `gorm:"column:reserved_by_dni;type:varchar(32);not null" json:"reservedByDni"`
	ExpiresAt              *time.Time `gorm:"column:expires_at" json:"expiresAt,omitempty"`
	ConsumedAt             *time.Time `gorm:"column:consumed_at" json:"consumedAt,omitempty"`
	ConsumedProductBarcode *string    `gorm:"column:consumed_product_barcode;type:varchar(64)" json:"consumedProductBarcode,omitempty"`
	ConsumedByDNI          *string    `gorm:"column:consumed_by_dni;type:varchar(32)" json:"consumedByDni,omitempty"`
	Note                   *string    `gorm:"column:note;type:text" json:"note,omitempty"`
}

// TableName obliga a GORM a usar el nombre exacto creado por la migración.
func (InternalBarcodeReservation) TableName() string {
	return "internal_barcode_reservations"
}

// IsLive reporta si la reserva aún puede consumirse en este instante.
// Combina status=RESERVED con la verificación de expiración; el handler
// la usa para decidir si abrir el flujo de creación o pedir una nueva
// reserva al cliente.
func (r *InternalBarcodeReservation) IsLive(now time.Time) bool {
	if r == nil || r.Status != InternalBarcodeStatusReserved {
		return false
	}
	if r.ExpiresAt != nil && !now.Before(*r.ExpiresAt) {
		return false
	}
	return true
}
