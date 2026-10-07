// Repositorio del módulo de alias de código de barras de PAQUETE
// (recepción de productos cuyo código solo viene en el empaque, no en
// cada unidad).
//
// Decisiones clave:
//
//   - EnsureAlias es IDEMPOTENTE por (product_barcode, package_code).
//     Dos llamadas con el mismo payload son no-op después de la primera;
//     la segunda solo actualiza last_seen_at y units_per_pack si cambió.
//
//   - Resolve consulta cuatro fuentes en orden:
//     1. package_barcode_aliases.package_code         → exact (ya existe)
//     2. products.barcode                             → new   (primer uso como paquete)
//     3. products.alternateCodes (token exacto)       → new
//     Si no hay hit, devuelve unknown y el frontend cae al diálogo
//     "producto no encontrado" existente.
//
//   - EnsureAlias valida colisión global dentro de la MISMA transacción
//     contra cuatro fuentes:
//     1. products.barcode (otro producto)
//     2. products.alternateCodes (otro producto, token exacto)
//     3. label_codes.code (si la tabla existe — tolerante a 016 no aplicada)
//     4. package_barcode_aliases.package_code de OTRO product_barcode
//     La única rama válida de "mismo código" es un alias ya registrado
//     para el MISMO product_barcode (UPDATE in-place).
//
//   - Nunca se escribe el package_code a products.alternateCodes. Un
//     guardián estático de los tests comprueba esta invariante.
package repositories

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"

	"gorm.io/gorm"
)

// PackageBarcodeAliasRepository agrupa la persistencia del módulo.
type PackageBarcodeAliasRepository struct {
	db *gorm.DB
}

func NewPackageBarcodeAliasRepository(db *gorm.DB) *PackageBarcodeAliasRepository {
	return &PackageBarcodeAliasRepository{db: db}
}

// ProductBrief es una proyección mínima del producto para que el
// handler responda al frontend sin cargar la relación completa de
// categorías/proveedores.
type ProductBrief struct {
	Barcode       string  `json:"barcode"`
	ProductName   string  `json:"productName"`
	Quantity      float64 `json:"quantity"`
	SalePrice     float64 `json:"salePrice"`
	PurchasePrice float64 `json:"purchasePrice"`
	Unit          string  `json:"unit,omitempty"`
	IsWeighted    bool    `json:"isWeighted"`
	IsPack        bool    `json:"isPack"`
}

// ResolveMatch indica cómo se resolvió un código escaneado.
type ResolveMatch string

const (
	ResolveMatchExact   ResolveMatch = "exact"   // alias ya registrado
	ResolveMatchNew     ResolveMatch = "new"     // producto conocido, primer uso como paquete
	ResolveMatchUnknown ResolveMatch = "unknown" // no hay hit en ningún lado
)

// ResolveResult es el shape que devuelve Resolve(code). Diseñado para
// serializarse directo a JSON del handler.
type ResolveResult struct {
	Match        ResolveMatch                `json:"match"`
	Code         string                      `json:"code"`
	Product      *ProductBrief               `json:"product,omitempty"`
	Alias        *models.PackageBarcodeAlias `json:"alias,omitempty"`
	UnitsPerPack *int                        `json:"unitsPerPack,omitempty"`
	LastSeenAt   *time.Time                  `json:"lastSeenAt,omitempty"`
}

// OtherProductHit describe la colisión cuando un código ya pertenece a
// un producto distinto; se usa para construir el 409 claro del handler.
type OtherProductHit struct {
	ProductBarcode string
	ProductName    string
	Source         string // "barcode" | "alternateCodes" | "label_code" | "other_alias"
}

// ErrPackageCodeBelongsToOtherProduct es el sentinel que el handler
// convierte en 409 con code=PACKAGE_CODE_BELONGS_TO_OTHER_PRODUCT.
type ErrPackageCodeBelongsToOtherProduct struct {
	Hit OtherProductHit
}

func (e *ErrPackageCodeBelongsToOtherProduct) Error() string {
	// El message del error va a los logs; el handler compone un mensaje
	// humano para el usuario a partir de Hit.
	return fmt.Sprintf(
		"código ya pertenece a otro producto: %s (%s), fuente=%s",
		e.Hit.ProductBarcode, e.Hit.ProductName, e.Hit.Source,
	)
}

// =========================================================================
// Resolve: GET /inventory/package-barcode/resolve
// =========================================================================

// Resolve busca el código en el orden descrito en el header del paquete.
// No muta estado. Devuelve siempre un ResolveResult; el `Match` indica
// cómo se resolvió. Un error retornado implica fallo de BD.
func (r *PackageBarcodeAliasRepository) Resolve(ctx context.Context, code string) (*ResolveResult, error) {
	normalized := strings.TrimSpace(code)
	if normalized == "" {
		return &ResolveResult{Match: ResolveMatchUnknown, Code: ""}, nil
	}

	// 1) package_barcode_aliases
	var alias models.PackageBarcodeAlias
	err := r.db.WithContext(ctx).
		Where("package_code = ?", normalized).
		First(&alias).Error
	if err == nil {
		product, perr := r.findProductBrief(ctx, alias.ProductBarcode)
		if perr != nil {
			return nil, perr
		}
		units := alias.UnitsPerPack
		return &ResolveResult{
			Match:        ResolveMatchExact,
			Code:         normalized,
			Product:      product,
			Alias:        &alias,
			UnitsPerPack: &units,
			LastSeenAt:   alias.LastSeenAt,
		}, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("resolve alias: %w", err)
	}

	// 2) products.barcode
	product, found, err := r.findProductByBarcode(ctx, normalized)
	if err != nil {
		return nil, err
	}
	if found {
		return &ResolveResult{Match: ResolveMatchNew, Code: normalized, Product: product}, nil
	}

	// 3) products.alternateCodes (token exacto para evitar falsos positivos)
	product, found, err = r.findProductByAlternateCode(ctx, normalized)
	if err != nil {
		return nil, err
	}
	if found {
		return &ResolveResult{Match: ResolveMatchNew, Code: normalized, Product: product}, nil
	}

	return &ResolveResult{Match: ResolveMatchUnknown, Code: normalized}, nil
}

// =========================================================================
// EnsureAlias: POST /inventory/package-barcode (upsert)
// =========================================================================

// EnsureAlias crea o actualiza el alias. Reglas:
//
//   - Normaliza inputs: TRIMs y mayúsculas (los códigos de barras se
//     comparan case-insensitive en el POS).
//   - Verifica unicidad cruzada contra cuatro fuentes dentro de una
//     transacción. Si colisiona con OTRO producto → *ErrPackageCodeBelongsToOtherProduct.
//   - Si existe para el MISMO producto → UPDATE (idempotente),
//     devuelve created=false.
//   - Si no existe → INSERT, devuelve created=true.
//
// La transacción asegura que entre el SELECT y el INSERT nadie meta un
// alias competidor; la UNIQUE constraint es el último seguro.
func (r *PackageBarcodeAliasRepository) EnsureAlias(
	ctx context.Context,
	productBarcode, packageCode string,
	unitsPerPack int,
	supplierID *uint,
	createdByDNI string,
) (*models.PackageBarcodeAlias, bool, error) {
	pb := strings.ToUpper(strings.TrimSpace(productBarcode))
	pc := strings.ToUpper(strings.TrimSpace(packageCode))
	actor := strings.TrimSpace(createdByDNI)
	if pb == "" || pc == "" {
		return nil, false, errors.New("productBarcode y packageCode son obligatorios")
	}
	if actor == "" {
		return nil, false, errors.New("createdByDNI obligatorio")
	}
	if unitsPerPack < 1 {
		return nil, false, errors.New("unitsPerPack debe ser >= 1")
	}

	var out *models.PackageBarcodeAlias
	var created bool
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 0) El producto base debe existir y estar vigente (no DeletedAt).
		var exists int64
		if err := tx.Table("products").
			Where("barcode = ?", pb).
			Where(`"deletedAt" IS NULL OR "deletedAt" = '0001-01-01'::timestamp`).
			Count(&exists).Error; err != nil {
			// Si la columna "deletedAt" no existe aún o tiene otro nombre,
			// caemos a conteo simple. Esto hace que la validación sea
			// tolerante a esquemas antiguos sin romper el flujo.
			if err := tx.Table("products").Where("barcode = ?", pb).Count(&exists).Error; err != nil {
				return fmt.Errorf("verificar producto base: %w", err)
			}
		}
		if exists == 0 {
			return fmt.Errorf("producto base %q no existe", pb)
		}

		// 1) Colisión en products.barcode (otro producto)
		var otherBarcode string
		if err := tx.Raw(`SELECT barcode FROM products WHERE barcode = ? AND barcode <> ? LIMIT 1`, pc, pb).
			Scan(&otherBarcode).Error; err != nil {
			return fmt.Errorf("colisión barcode: %w", err)
		}
		if otherBarcode != "" {
			name, _ := r.lookupProductName(tx, otherBarcode)
			return &ErrPackageCodeBelongsToOtherProduct{Hit: OtherProductHit{
				ProductBarcode: otherBarcode,
				ProductName:    name,
				Source:         "barcode",
			}}
		}

		// 2) Colisión en products.alternateCodes (otro producto)
		// Usamos string_to_array para token exacto, igual que postgres_product_repository.
		var altBarcode string
		if err := tx.Raw(`
			SELECT barcode FROM products
			WHERE barcode <> ?
			  AND "alternate_codes" IS NOT NULL
			  AND "alternate_codes" <> ''
			  AND ? = ANY(string_to_array(upper("alternate_codes"), ','))
			LIMIT 1
		`, pb, pc).Scan(&altBarcode).Error; err != nil {
			// Si la columna "alternate_codes" no existe por esquema legacy,
			// fallback a ILIKE con delimitadores. Ninguna ruta debe caer en
			// un falso negativo silencioso: si ambos fallan, propagamos.
			var fallback string
			if ferr := tx.Raw(`
				SELECT barcode FROM products
				WHERE barcode <> ?
				  AND ("alternateCodes" ILIKE ? OR "alternateCodes" ILIKE ? OR "alternateCodes" ILIKE ? OR "alternateCodes" = ?)
				LIMIT 1
			`,
				pb,
				"%,"+pc+",%",
				pc+",%",
				"%,"+pc,
				pc,
			).Scan(&fallback).Error; ferr != nil {
				return fmt.Errorf("colisión alternateCodes: %w", ferr)
			}
			altBarcode = fallback
		}
		if altBarcode != "" {
			name, _ := r.lookupProductName(tx, altBarcode)
			return &ErrPackageCodeBelongsToOtherProduct{Hit: OtherProductHit{
				ProductBarcode: altBarcode,
				ProductName:    name,
				Source:         "alternateCodes",
			}}
		}

		// 3) Colisión en label_codes.code (si la tabla existe tras 016).
		// La existencia se verifica en una sentencia aparte: un CASE con
		// to_regclass dentro de la misma consulta no evita el error de
		// tabla inexistente (Postgres resuelve nombres al analizar).
		var labelHit string
		labelsExist, err := labelCodesTableExists(tx)
		if err != nil {
			return fmt.Errorf("colisión label_codes: %w", err)
		}
		if labelsExist {
			if err := tx.Raw(`
				SELECT COALESCE((
					SELECT product_barcode
					  FROM label_codes
					 WHERE code = ? AND voided_at IS NULL
					 LIMIT 1
				), '')
			`, pc).Scan(&labelHit).Error; err != nil {
				return fmt.Errorf("colisión label_codes: %w", err)
			}
		}
		if labelHit != "" && labelHit != pb {
			name, _ := r.lookupProductName(tx, labelHit)
			return &ErrPackageCodeBelongsToOtherProduct{Hit: OtherProductHit{
				ProductBarcode: labelHit,
				ProductName:    name,
				Source:         "label_code",
			}}
		}

		// 4) Alias ya registrado: upsert o 409
		var existing models.PackageBarcodeAlias
		switch err := tx.Where("package_code = ?", pc).First(&existing).Error; {
		case err == nil:
			if existing.ProductBarcode != pb {
				name, _ := r.lookupProductName(tx, existing.ProductBarcode)
				return &ErrPackageCodeBelongsToOtherProduct{Hit: OtherProductHit{
					ProductBarcode: existing.ProductBarcode,
					ProductName:    name,
					Source:         "other_alias",
				}}
			}
			// Mismo producto → UPDATE idempotente
			now := time.Now()
			updates := map[string]interface{}{
				"units_per_pack": unitsPerPack,
				"last_seen_at":   now,
				"seen_count":     gorm.Expr("seen_count + 1"),
			}
			if supplierID != nil {
				updates["supplier_id"] = *supplierID
			}
			if err := tx.Model(&existing).Updates(updates).Error; err != nil {
				return fmt.Errorf("update alias: %w", err)
			}
			// Recargar para devolver estado consistente
			if err := tx.Where("id = ?", existing.ID).First(&existing).Error; err != nil {
				return fmt.Errorf("reload alias: %w", err)
			}
			out = &existing
			created = false
			return nil
		case errors.Is(err, gorm.ErrRecordNotFound):
			// INSERT
			row := models.PackageBarcodeAlias{
				ProductBarcode: pb,
				PackageCode:    pc,
				UnitsPerPack:   unitsPerPack,
				SupplierID:     supplierID,
				CreatedByDNI:   actor,
				CreatedAt:      time.Now(),
				SeenCount:      1,
			}
			now := time.Now()
			row.LastSeenAt = &now
			if err := tx.Create(&row).Error; err != nil {
				return fmt.Errorf("insert alias: %w", err)
			}
			out = &row
			created = true
			return nil
		default:
			return fmt.Errorf("buscar alias: %w", err)
		}
	})
	if err != nil {
		return nil, false, err
	}
	return out, created, nil
}

// MarkSeen actualiza last_seen_at e incrementa seen_count. No requiere
// transacción: la consistencia la garantiza la UNIQUE constraint.
func (r *PackageBarcodeAliasRepository) MarkSeen(ctx context.Context, packageCode string) error {
	pc := strings.ToUpper(strings.TrimSpace(packageCode))
	if pc == "" {
		return errors.New("packageCode obligatorio")
	}
	return r.db.WithContext(ctx).
		Model(&models.PackageBarcodeAlias{}).
		Where("package_code = ?", pc).
		Updates(map[string]interface{}{
			"last_seen_at": time.Now(),
			"seen_count":   gorm.Expr("seen_count + 1"),
		}).Error
}

// =========================================================================
// Helpers internos
// =========================================================================

func (r *PackageBarcodeAliasRepository) findProductBrief(ctx context.Context, barcode string) (*ProductBrief, error) {
	var product models.Product
	err := r.db.WithContext(ctx).
		Select(`barcode, "productName", quantity, "salePrice", "purchasePrice", "isWeighted", "isPack"`).
		Where("barcode = ?", barcode).
		First(&product).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	brief := &ProductBrief{
		Barcode:       product.Barcode,
		ProductName:   product.ProductName,
		Quantity:      product.Quantity,
		SalePrice:     product.SalePrice,
		PurchasePrice: product.PurchasePrice,
		IsWeighted:    product.IsWeighted,
		IsPack:        product.IsPack,
	}
	if product.IsWeighted {
		brief.Unit = "KG"
	} else {
		brief.Unit = "UND"
	}
	return brief, nil
}

func (r *PackageBarcodeAliasRepository) findProductByBarcode(ctx context.Context, barcode string) (*ProductBrief, bool, error) {
	brief, err := r.findProductBrief(ctx, barcode)
	if err != nil {
		return nil, false, err
	}
	return brief, brief != nil, nil
}

func (r *PackageBarcodeAliasRepository) findProductByAlternateCode(ctx context.Context, code string) (*ProductBrief, bool, error) {
	var barcode string
	err := r.db.WithContext(ctx).Raw(`
		SELECT barcode FROM products
		WHERE "alternate_codes" IS NOT NULL
		  AND "alternate_codes" <> ''
		  AND ? = ANY(string_to_array(upper("alternate_codes"), ','))
		LIMIT 1
	`, code).Scan(&barcode).Error
	if err != nil {
		// Fallback a columna legacy "alternateCodes"
		var fallback string
		if ferr := r.db.WithContext(ctx).Raw(`
			SELECT barcode FROM products
			WHERE ("alternateCodes" ILIKE ? OR "alternateCodes" ILIKE ? OR "alternateCodes" ILIKE ? OR "alternateCodes" = ?)
			LIMIT 1
		`,
			"%,"+code+",%",
			code+",%",
			"%,"+code,
			code,
		).Scan(&fallback).Error; ferr != nil {
			return nil, false, fmt.Errorf("buscar alternateCodes: %w", ferr)
		}
		barcode = fallback
	}
	if barcode == "" {
		return nil, false, nil
	}
	brief, err := r.findProductBrief(ctx, barcode)
	if err != nil {
		return nil, false, err
	}
	return brief, brief != nil, nil
}

func (r *PackageBarcodeAliasRepository) lookupProductName(tx *gorm.DB, barcode string) (string, error) {
	var name string
	err := tx.Table("products").
		Select(`"productName"`).
		Where("barcode = ?", barcode).
		Limit(1).
		Scan(&name).Error
	if err != nil {
		return "", err
	}
	return name, nil
}
