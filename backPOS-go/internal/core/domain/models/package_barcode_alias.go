// Package models — alias de código de barras usado durante la recepción
// de productos cuyo código solo viene impreso en el paquete, no en cada
// unidad.
//
// IMPORTANTE: este modelo NO forma parte de schemaModels() en
// migrations/catalog.go. La tabla física la crea exclusivamente la
// migración `017_package_barcode_aliases.sql`. Mantenerlo fuera de
// schemaModels protege el checksum de la migración 002 (model_schema)
// y respeta la política del runner: la BD la mutan sólo migraciones
// explícitas durante una ventana aprobada.
//
// Semántica crítica: este código JAMÁS participa en buildProductLookup
// de ventas. Alias de recepción, no código escaneable en caja. El
// handler Go garantiza que ninguna ruta nueva escriba este código a
// products.alternateCodes.
package models

import "time"

// PackageBarcodeAlias relaciona un código de paquete con el producto
// UNITARIO al que corresponde y cuántas unidades físicas trae cada
// paquete. Lo usa /inventory/package-barcode durante la recepción:
// el usuario escanea el código del paquete y el modal propone
// addedQuantity = packs × units_per_pack sobre el producto base.
//
// NO lleva relación con label_codes (migración 016); la etiqueta
// unitaria para pegar en los frascos se genera por el flujo
// /labels/codes existente, idempotente por product_barcode.
type PackageBarcodeAlias struct {
	ID             uint       `gorm:"primaryKey;autoIncrement" json:"id"`
	ProductBarcode string     `gorm:"column:product_barcode;type:varchar(64);not null;index" json:"productBarcode"`
	PackageCode    string     `gorm:"column:package_code;type:varchar(64);not null;uniqueIndex:uq_package_barcode_aliases_code" json:"packageCode"`
	UnitsPerPack   int        `gorm:"column:units_per_pack;not null" json:"unitsPerPack"`
	SupplierID     *uint      `gorm:"column:supplier_id" json:"supplierId,omitempty"`
	CreatedAt      time.Time  `gorm:"column:created_at;not null;default:now()" json:"createdAt"`
	CreatedByDNI   string     `gorm:"column:created_by_dni;type:varchar(32);not null" json:"createdByDni"`
	LastSeenAt     *time.Time `gorm:"column:last_seen_at" json:"lastSeenAt,omitempty"`
	SeenCount      int        `gorm:"column:seen_count;not null;default:0" json:"seenCount"`
}

// TableName fija la tabla física creada por la migración 017.
func (PackageBarcodeAlias) TableName() string { return "package_barcode_aliases" }

// Códigos de error del handler, estables para que el frontend los
// matchee por string literal en el ApiError.data.code.
const (
	// PackageCodeBelongsToOtherProduct: el código ya está en uso por
	// otro producto (products.barcode, alternateCodes, label_codes o
	// package_barcode_aliases.package_code de otro producto).
	ErrCodePackageBelongsToOther = "PACKAGE_CODE_BELONGS_TO_OTHER_PRODUCT"
)
