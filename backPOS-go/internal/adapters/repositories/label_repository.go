// Repositorio del módulo de etiquetas (códigos de barras internos) y
// auditoría del cajón de dinero.
//
// Decisiones clave:
//
//   - EnsureCodeForProduct es IDEMPOTENTE: si el producto ya tiene un
//     label_code activo, se reutiliza. Esto garantiza que reimprimir el
//     mismo producto no genera códigos duplicados.
//
//   - GenerateUniqueCode valida colisión contra TRES fuentes dentro de
//     la misma transacción:
//     1. products.barcode (código original del producto).
//     2. products.alternateCodes (array/CSV de alias).
//     3. label_codes.code (códigos ya generados internamente).
//     Si cualquiera colisiona, se reintenta con otro candidato.
//
//   - RecordPrintJob persiste el snapshot JSONB del lote y actualiza
//     print_count/last_printed_at de cada LabelCode en una sola
//     transacción.
//
//   - RecordCashDrawerOpen añade la fila de auditoría. Las validaciones
//     "sin venta → requiere admin" viven en el handler, no aquí: este
//     repo registra lo que el handler ya decidió.
package repositories

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// jsonUnmarshalString es un wrapper fino para decodificar un string
// JSON hacia un target. Centralizado para que las pruebas estáticas
// localicen fácilmente el único punto donde el repo decodifica payloads
// de la BD.
func jsonUnmarshalString(payload string, target any) error {
	return json.Unmarshal([]byte(payload), target)
}

// LabelRepository agrupa toda la persistencia del módulo etiquetas +
// cajón de dinero.
type LabelRepository struct {
	db *gorm.DB
}

func NewLabelRepository(db *gorm.DB) *LabelRepository {
	return &LabelRepository{db: db}
}

// =========================================================================
// Plantillas de tamaño
// =========================================================================

func (r *LabelRepository) ListSizeTemplates(ctx context.Context) ([]models.LabelSizeTemplate, error) {
	var out []models.LabelSizeTemplate
	if err := r.db.WithContext(ctx).Order("is_default DESC, name ASC").Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

func (r *LabelRepository) UpsertSizeTemplate(ctx context.Context, tpl *models.LabelSizeTemplate) error {
	if tpl == nil {
		return errors.New("template nulo")
	}
	// Si marcamos esta plantilla como default, limpiar la bandera en las
	// demás dentro de la misma transacción (índice parcial único).
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if tpl.IsDefault {
			if err := tx.Model(&models.LabelSizeTemplate{}).Where("is_default = TRUE").Update("is_default", false).Error; err != nil {
				return err
			}
		}
		tpl.UpdatedAt = time.Now()
		if tpl.ID == 0 {
			tpl.CreatedAt = tpl.UpdatedAt
			return tx.Create(tpl).Error
		}
		return tx.Save(tpl).Error
	})
}

// =========================================================================
// Perfiles de impresora
// =========================================================================

func (r *LabelRepository) ListPrinterProfiles(ctx context.Context) ([]models.LabelPrinterProfile, error) {
	var out []models.LabelPrinterProfile
	if err := r.db.WithContext(ctx).Order("is_default DESC, name ASC").Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

func (r *LabelRepository) UpsertPrinterProfile(ctx context.Context, p *models.LabelPrinterProfile) error {
	if p == nil {
		return errors.New("perfil nulo")
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if p.IsDefault {
			if err := tx.Model(&models.LabelPrinterProfile{}).Where("is_default = TRUE").Update("is_default", false).Error; err != nil {
				return err
			}
		}
		p.UpdatedAt = time.Now()
		if p.ID == 0 {
			p.CreatedAt = p.UpdatedAt
			return tx.Create(p).Error
		}
		return tx.Save(p).Error
	})
}

// =========================================================================
// Códigos
// =========================================================================

// EnsureCodeForProduct asegura que exista un LabelCode asociado al
// barcode del producto (idempotente).
//
//   - Si productBarcode está vacío, siempre crea un código nuevo
//     (etiqueta "libre": granel, lote interno, etc.) usando el generador
//     comercial LC-<hex>.
//   - Si existe un LabelCode con ese productBarcode y !voided_at, lo
//     devuelve tal cual (idempotencia por producto).
//   - Si no existe y el barcode está en el namespace POSINT- (producto
//     interno de la migración 024), persiste `code = product_barcode =
//     POSINT-<hex>` LITERAL, sin invocar al generador LC-<hex>. Es el
//     flujo audit-first de LabelPrintSheet para productos internos: la
//     etiqueta que se imprime ES el barcode del producto, de modo que
//     ResolveLabelCode al escanear encuentra la fila por `code =
//     POSINT-X` y hace JOIN `products.barcode = product_barcode` sobre
//     el mismo valor. Los productos comerciales siguen con LC-<hex>.
//   - Si no existe y el barcode es comercial, genera un LC-<hex> único
//     contra las cuatro fuentes de colisión (products.barcode,
//     alternate_codes, label_codes.code, package_barcode_aliases.package_code).
//
// Devuelve el LabelCode final + un flag `created` que indica si acaba de
// crearse.
//
// CONCURRENCIA: antes de buscar, la transacción toma
// `pg_advisory_xact_lock` sobre una clave derivada del barcode. Dos
// pestañas que piden "ensure" sobre el mismo barcode a la vez quedan
// serializadas: la segunda espera el COMMIT de la primera y luego ve el
// label_code ya persistido. Un SELECT ... FOR SHARE no bastaba porque no
// bloquea nada cuando todavía no existe fila. El lock se libera solo al
// terminar la tx. Mitiga la falta de un UNIQUE parcial
// `(product_barcode) WHERE voided_at IS NULL` sin requerir migración.
//
// RAMA POSINT (migración 024): además de la coherencia intra-fila
// garantizada por `ck_label_codes_posint_matches_product_barcode`
// (code = product_barcode cuando code empieza por POSINT-), aquí se
// validan DOS invariantes extra antes del INSERT:
//
//  1. El producto POSINT-X debe existir en `products.barcode`. La
//     etiqueta sólo tiene sentido si hay un producto real que
//     ResolveLabelCode pueda resolver. Esto refleja que la reserva en
//     `internal_barcode_reservations` ya fue consumida.
//  2. Si existe una fila previa con `code = POSINT-X` que no cumple el
//     lookup idempotente (voided o con product_barcode distinto), el
//     INSERT choca por PK (23505) y se traduce en un error legible. No
//     se intenta "resucitar" la fila ni silenciar la colisión: un POSINT
//     no puede mapearse a otro product_barcode y una vez anulado el
//     admin debe revisar manualmente antes de reimprimir.
func (r *LabelRepository) EnsureCodeForProduct(
	ctx context.Context,
	productBarcode string,
	sizeTemplateID *uint,
	note string,
	createdByDNI string,
) (*models.LabelCode, bool, error) {
	normalized := strings.TrimSpace(productBarcode)
	actor := strings.TrimSpace(createdByDNI)
	if actor == "" {
		return nil, false, errors.New("createdByDNI obligatorio")
	}

	// Detectamos el namespace reservado ANTES de abrir la transacción
	// para rechazar inputs mal formados sin pegarle a la BD. La
	// normalización canónica (TrimSpace + ToUpper) empata con la que
	// product_handler.Create aplica a products.barcode: ambos valores
	// deben ser idénticos para que ResolveLabelCode haga JOIN exitoso.
	isInternal := normalized != "" && models.IsInternalBarcode(normalized)
	if isInternal {
		normalized = models.NormalizeInternalBarcode(normalized)
		if !models.IsValidInternalBarcode(normalized) {
			return nil, false, fmt.Errorf(
				"label code POSINT inválido %q: esperado ^POSINT-[0-9A-F]{8,24}$ (ver migración 024)",
				productBarcode,
			)
		}
	}

	var final *models.LabelCode
	var created bool
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if normalized != "" {
			if err := lockProductBarcodeTx(tx, normalized); err != nil {
				return fmt.Errorf("bloqueando barcode %q: %w", normalized, err)
			}
			var existing models.LabelCode
			err := tx.
				Where("product_barcode = ? AND voided_at IS NULL", normalized).
				Order("created_at DESC").
				First(&existing).Error
			if err == nil {
				// Defensa en profundidad para POSINT: el CHECK
				// `ck_label_codes_posint_matches_product_barcode` ya
				// garantiza que una fila con code POSINT- tenga
				// product_barcode == code. Verificamos aquí también para
				// dar un error claro si por alguna ruta administrativa
				// quedara una fila incoherente en la BD.
				if isInternal && existing.Code != normalized {
					return fmt.Errorf(
						"colisión POSINT: label_codes.code=%q no coincide con product_barcode=%q (deben ser iguales por ck_label_codes_posint_matches_product_barcode)",
						existing.Code, normalized,
					)
				}
				final = &existing
				created = false
				return nil
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
		}

		// Rama POSINT: el `code` es LITERALMENTE el product_barcode. No
		// se emite LC-<hex> ni se consulta al generador comercial. La
		// biyección "etiqueta impresa == barcode del producto" es lo
		// que hace que ResolveLabelCode funcione al escanear.
		if isInternal {
			// Validar que el producto POSINT-X exista. Sin producto no
			// hay etiqueta que imprimir (y ResolveLabelCode exige el
			// JOIN con products.barcode para resolver un escaneo). Esto
			// cubre la validación "reserva/producto": la reserva en
			// internal_barcode_reservations se traduce en una fila de
			// products.barcode = POSINT-X al consumirse; verificando el
			// producto cubrimos la cadena completa.
			var cnt int64
			if err := tx.Table("products").
				Where("barcode = ?", normalized).
				Count(&cnt).Error; err != nil {
				return fmt.Errorf("validando producto POSINT %q: %w", normalized, err)
			}
			if cnt == 0 {
				return fmt.Errorf(
					"no existe producto con barcode %q (POSINT): la reserva debe estar CONSUMED antes de generar la etiqueta",
					normalized,
				)
			}
			bc := normalized
			row := models.LabelCode{
				Code:           normalized,
				ProductBarcode: &bc,
				SizeTemplateID: sizeTemplateID,
				Note:           note,
				CreatedByDNI:   actor,
				CreatedAt:      time.Now(),
			}
			if err := tx.Create(&row).Error; err != nil {
				if isUniqueViolationErr(err) {
					// Existe otra fila con code=POSINT-X que no pasó el
					// lookup idempotente (voided, o product_barcode
					// nulo, etc.). No la reutilizamos ni la "resucitamos"
					// aquí: queda a decisión administrativa qué hacer.
					return fmt.Errorf(
						"ya existe un label_code con code=%q (posiblemente anulado o incoherente); un POSINT no puede mapearse a otro product_barcode, revisar manualmente antes de reimprimir",
						normalized,
					)
				}
				return err
			}
			final = &row
			created = true
			return nil
		}

		// Rama comercial: genera LC-<hex> único y lo asocia al producto
		// (si productBarcode != ""). La idempotencia por producto ya se
		// evaluó arriba; aquí llegamos sólo cuando no había código vivo.
		code, err := r.generateUniqueCodeTx(ctx, tx, normalized)
		if err != nil {
			return err
		}
		row := models.LabelCode{
			Code:           code,
			SizeTemplateID: sizeTemplateID,
			Note:           note,
			CreatedByDNI:   actor,
			CreatedAt:      time.Now(),
		}
		if normalized != "" {
			bc := normalized
			row.ProductBarcode = &bc
		}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		final = &row
		created = true
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	return final, created, nil
}

// VoidCode anula un código de etiqueta (marca voided_at y voided_by_dni).
// Si el código no existe o ya está anulado, devuelve nil sin modificar
// nada: la operación es idempotente para que un segundo clic no falle.
//
// La política detrás de las columnas voided_at/voided_by_dni ya vive en
// la migración 016 (CHECK ck_label_codes_void_dni). Este método rellena
// ambas columnas atómicamente para no violar ese CHECK.
//
// EFECTO: tras anular, SearchCodes y ResolveLabelCode ya no reconocen el
// código. Una reimpresión del producto genera uno NUEVO (porque la
// consulta de "label vivo del producto" filtra por voided_at IS NULL).
// El código queda en la tabla como registro histórico.
func (r *LabelRepository) VoidCode(ctx context.Context, code, actorDNI string) (voided bool, err error) {
	normalized := strings.TrimSpace(code)
	if normalized == "" {
		return false, errors.New("code requerido")
	}
	actor := strings.TrimSpace(actorDNI)
	if actor == "" {
		return false, errors.New("actorDNI requerido")
	}
	err = r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row models.LabelCode
		if err := tx.Where("code = ?", normalized).First(&row).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		if row.VoidedAt != nil {
			// Ya anulado: idempotente.
			return nil
		}
		now := time.Now()
		if err := tx.Model(&models.LabelCode{}).
			Where("code = ? AND voided_at IS NULL", normalized).
			Updates(map[string]interface{}{
				"voided_at":     now,
				"voided_by_dni": actor,
			}).Error; err != nil {
			return err
		}
		voided = true
		return nil
	})
	return voided, err
}

// generateUniqueCodeTx produce un candidato aleatorio y comprueba
// colisión contra products.barcode, products.alternateCodes,
// label_codes.code y package_barcode_aliases.package_code en la misma
// transacción. Reintenta hasta 25 veces antes de rendirse; con un espacio
// de 16^12 (hex12), 25 reintentos son más que suficientes incluso con
// millones de códigos.
//
// Este generador es la RAMA COMERCIAL de EnsureCodeForProduct: emite
// SIEMPRE "LC-<hex>". Los productos internos del namespace POSINT-
// (migración 024) NO pasan por aquí: EnsureCodeForProduct detecta
// `models.IsInternalBarcode(productBarcode)` arriba y persiste
// directamente `label_codes.code = product_barcode = POSINT-<hex>` sin
// invocar este generador, para que la etiqueta impresa sea
// LITERALMENTE el barcode del producto.
//
// Blindaje adicional: el prefijo literal "LC-" nunca coincide con
// "POSINT-", así que un LC-<hex> jamás puede caer en el namespace
// interno aun si alguien ajusta la longitud del cuerpo. La coherencia
// intra-fila en BD la fija el CHECK
// `ck_label_codes_posint_matches_product_barcode` de la migración 024:
// una fila con `code` POSINT- debe tener `product_barcode = code`. Para
// filas comerciales LC-<hex> la rama `code !~ '^POSINT-'` del OR aplica
// y no hay restricción adicional.
func (r *LabelRepository) generateUniqueCodeTx(ctx context.Context, tx *gorm.DB, hint string) (string, error) {
	// 12 hex chars → 48 bits de entropía por candidato.
	const attempts = 25
	for i := 0; i < attempts; i++ {
		candidate := "LC-" + randomHex(12)
		conflict, err := codeExistsAnywhereTx(ctx, tx, candidate)
		if err != nil {
			return "", err
		}
		if !conflict {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("no se logró generar un código único tras %d intentos (hint=%q)", attempts, hint)
}

// labelCodesExistsSQL dice si la tabla de la migración 016 existe. Va en
// una sentencia propia: dentro de la misma consulta que lee label_codes no
// protege, porque Postgres resuelve las tablas al analizar la sentencia.
const labelCodesExistsSQL = `SELECT to_regclass('public.label_codes') IS NOT NULL`

func labelCodesTableExists(db *gorm.DB) (bool, error) {
	var exists bool
	if err := db.Raw(labelCodesExistsSQL).Scan(&exists).Error; err != nil {
		return false, fmt.Errorf("verificando tabla label_codes: %w", err)
	}
	return exists, nil
}

// alternateCodesContainsSQL decide si `?` es uno de los códigos de
// products.alternate_codes (CSV). El nombre de columna debe coincidir con
// el tag gorm de models.Product.AlternateCodes (lo verifica un test).
const alternateCodesContainsSQL = `EXISTS (SELECT 1 FROM unnest(string_to_array(COALESCE(alternate_codes, ''), ',')) AS ac WHERE upper(trim(ac)) = upper(?))`

// labelBarcodeLockSQL serializa "ensure" por barcode dentro de la tx.
const labelBarcodeLockSQL = `SELECT pg_advisory_xact_lock(hashtext(?))`

// labelBarcodeLockKey separa el espacio de claves de este lock de
// cualquier otro advisory lock del sistema (p.ej. ClientTxId de ventas).
func labelBarcodeLockKey(barcode string) string {
	return "label_codes:product_barcode:" + barcode
}

func lockProductBarcodeTx(tx *gorm.DB, barcode string) error {
	return tx.Exec(labelBarcodeLockSQL, labelBarcodeLockKey(barcode)).Error
}

// codeExistsAnywhereTx consulta las cuatro fuentes de colisión en una
// transacción:
//
//   - products.barcode = candidate
//   - alternate_codes contiene candidate (CSV, comparación por elemento)
//   - label_codes.code = candidate
//   - package_barcode_aliases.package_code = candidate (migración 017;
//     se consulta directo sin probe to_regclass porque la 017 ya está
//     aplicada en todo ambiente con la 024 disponible — si falla, la
//     tx aborta y la generación de LC- se interrumpe, que es el
//     comportamiento correcto)
//
// La extensión a package_barcode_aliases cierra el hueco "label code vs
// package alias": antes un LC-<hex> podía coincidir por azar con un
// package_code escaneado en recepción. Ahora el generador reintenta.
func codeExistsAnywhereTx(ctx context.Context, tx *gorm.DB, candidate string) (bool, error) {
	// Products por barcode.
	var cnt int64
	if err := tx.WithContext(ctx).
		Table("products").
		Where("barcode = ?", candidate).
		Count(&cnt).Error; err != nil {
		return false, fmt.Errorf("colisión barcode: %w", err)
	}
	if cnt > 0 {
		return true, nil
	}
	// alternate_codes: columna text con códigos separados por coma (ver
	// models.Product.AlternateCodes y postgres_product_repository). Se
	// compara elemento por elemento (trim + upper) para no tener falsos
	// positivos de subcadena. Una sola consulta: un error aquí aborta la tx
	// de Postgres, así que no hay "fallback" posible dentro de la misma tx.
	if err := tx.WithContext(ctx).
		Table("products").
		Where(alternateCodesContainsSQL, candidate).
		Count(&cnt).Error; err != nil {
		return false, fmt.Errorf("colisión alternate_codes: %w", err)
	}
	if cnt > 0 {
		return true, nil
	}
	// label_codes.
	if err := tx.WithContext(ctx).
		Table("label_codes").
		Where("code = ?", candidate).
		Count(&cnt).Error; err != nil {
		return false, fmt.Errorf("colisión label_codes: %w", err)
	}
	if cnt > 0 {
		return true, nil
	}
	// package_barcode_aliases.package_code (fix 2026-10-13): un label_code
	// generado podía chocar por azar con un package alias de recepción.
	// La verificación es simétrica a la del package_barcode_alias_repository,
	// que ya consulta label_codes.
	if err := tx.WithContext(ctx).
		Table("package_barcode_aliases").
		Where("package_code = ?", candidate).
		Count(&cnt).Error; err != nil {
		return false, fmt.Errorf("colisión package_barcode_aliases: %w", err)
	}
	return cnt > 0, nil
}

// randomHex devuelve una cadena hexadecimal de la longitud pedida. Si
// crypto/rand falla (improbable), cae a time-based que al menos no
// repite dentro del mismo milisegundo.
func randomHex(n int) string {
	buf := make([]byte, (n+1)/2)
	if _, err := rand.Read(buf); err == nil {
		return hex.EncodeToString(buf)[:n]
	}
	return fmt.Sprintf("%0*x", n, time.Now().UnixNano())
}

// SearchCodes busca un código por valor exacto o por nombre/barcode del
// producto asociado. Usa un LEFT JOIN con products para enriquecer los
// resultados con el nombre; útil para la pantalla de búsqueda.
type CodeSearchResult struct {
	Code           string     `json:"code"`
	ProductBarcode *string    `json:"productBarcode"`
	ProductName    string     `json:"productName"`
	SalePrice      float64    `json:"salePrice"`
	LastPrintedAt  *time.Time `json:"lastPrintedAt,omitempty"`
	PrintCount     int        `json:"printCount"`
}

func (r *LabelRepository) SearchCodes(ctx context.Context, query string, limit int) ([]CodeSearchResult, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := strings.TrimSpace(query)
	results := make([]CodeSearchResult, 0, limit)
	sql := `
	SELECT lc.code,
	       lc.product_barcode,
	       COALESCE(p."productName", '') AS product_name,
	       COALESCE(p."salePrice", 0)   AS sale_price,
	       lc.last_printed_at,
	       lc.print_count
	  FROM label_codes lc
	  LEFT JOIN products p ON p.barcode = lc.product_barcode
	 WHERE lc.voided_at IS NULL
	`
	args := []interface{}{}
	if q != "" {
		sql += ` AND (lc.code ILIKE ? OR lc.product_barcode ILIKE ? OR p."productName" ILIKE ?)`
		like := "%" + q + "%"
		args = append(args, like, like, like)
	}
	sql += ` ORDER BY lc.last_printed_at DESC NULLS LAST, lc.created_at DESC LIMIT ?`
	args = append(args, limit)
	if err := r.db.WithContext(ctx).Raw(sql, args...).Scan(&results).Error; err != nil {
		return nil, err
	}
	return results, nil
}

// =========================================================================
// Resolución exacta por código impreso (caja / venta)
// =========================================================================

// ResolveLabelResult es el shape JSON que devuelve ResolveLabelCode.
// El `Match` indica cómo se resolvió:
//
//   - "label_code": el código corresponde a una fila VIVA de label_codes
//     con product_barcode poblado y un producto activo detrás.
//   - "unknown":    cualquier otra situación (no existe, anulado, código
//     "libre" sin producto, producto borrado, migración 016 no aplicada).
//
// La UI de caja usa este shape para decidir si agregar al carrito o
// mostrar "producto no existe". Nunca consulta `package_barcode_aliases`.
type ResolveLabelResult struct {
	Match          string        `json:"match"`
	Code           string        `json:"code"`
	ProductBarcode string        `json:"productBarcode,omitempty"`
	Product        *ProductBrief `json:"product,omitempty"`
}

// resolveLabelRow es un helper interno que mapea la fila JSONB del
// SELECT a un ResolveLabelResult. Se declara aquí para que las pruebas
// estáticas que inspeccionan el método no tengan que lidiar con tipos
// anónimos.
type resolveLabelRow struct {
	Code           string  `json:"code"`
	ProductBarcode string  `json:"product_barcode"`
	ProductName    string  `json:"product_name"`
	SalePrice      float64 `json:"sale_price"`
	PurchasePrice  float64 `json:"purchase_price"`
	Quantity       float64 `json:"quantity"`
	IsWeighted     bool    `json:"is_weighted"`
	IsPack         bool    `json:"is_pack"`
}

// ResolveLabelCode busca un `label_codes.code` de forma EXACTA. Esta
// función es la única puerta por la que caja debe aceptar un código
// unitario impreso en etiqueta (LabelPrintSheet). Reglas:
//
//   - Match exacto por PK (`WHERE lc.code = ?`), NUNCA ILIKE/substring:
//     imposible resolver "LC-abc" por un escaneo "ABC" o dos códigos a
//     la vez.
//   - Normalización mínima y segura: `TrimSpace`. No `UPPER()`:
//     `generateUniqueCodeTx` emite minúsculas y el PK es
//     case-sensitive; convertir mataría el índice sin ganar nada.
//   - Códigos anulados no resuelven (`voided_at IS NULL`).
//   - Códigos "libre" (sin product_barcode) no resuelven: en caja no
//     tienen semántica.
//   - Producto desaparecido no resuelve (LEFT JOIN + guard).
//   - Tolerante a migración 016 no aplicada:
//     `to_regclass('public.label_codes') IS NULL` → `payload = NULL`
//     → `match: "unknown"`. Mismo patrón que
//     `package_barcode_alias_repository.go`.
//   - Lectura pura. Ningún INSERT/UPDATE/DELETE. Un guardián estático
//     lo verifica.
//   - NUNCA consulta ni toca `package_barcode_aliases`: el alias de
//     paquete es exclusivo de recepción. Un guardián estático falla si
//     el nombre de esa tabla aparece en el cuerpo de este método.
//
// Devuelve siempre un *ResolveLabelResult; un error retornado implica
// fallo real de BD.
func (r *LabelRepository) ResolveLabelCode(ctx context.Context, raw string) (*ResolveLabelResult, error) {
	normalized := strings.TrimSpace(raw)
	if normalized == "" {
		return &ResolveLabelResult{Match: "unknown", Code: ""}, nil
	}

	// La existencia de label_codes se consulta APARTE: Postgres resuelve
	// los nombres de tabla al analizar la sentencia, así que un
	// `CASE WHEN to_regclass(...) IS NULL` dentro de la misma consulta NO
	// evita el error "relation does not exist" si la 016 no se aplicó.
	exists, err := labelCodesTableExists(r.db.WithContext(ctx))
	if err != nil {
		return nil, fmt.Errorf("resolve label code: %w", err)
	}
	if !exists {
		return &ResolveLabelResult{Match: "unknown", Code: normalized}, nil
	}

	// Un sólo roundtrip, parametrizado, lectura pura.
	const sql = `
SELECT (
        SELECT jsonb_build_object(
            'code', lc.code,
            'product_barcode', lc.product_barcode,
            'product_name', COALESCE(p."productName", ''),
            'sale_price', COALESCE(p."salePrice", 0),
            'purchase_price', COALESCE(p."purchasePrice", 0),
            'quantity', COALESCE(p.quantity, 0),
            'is_weighted', COALESCE(p."isWeighted", FALSE),
            'is_pack', COALESCE(p."isPack", FALSE)
        )
        FROM label_codes lc
        LEFT JOIN products p ON p.barcode = lc.product_barcode
        WHERE lc.code = ?
          AND lc.voided_at IS NULL
          AND lc.product_barcode IS NOT NULL
          AND lc.product_barcode <> ''
          AND p.barcode IS NOT NULL
        LIMIT 1
) AS payload
`

	var payload *string
	if err := r.db.WithContext(ctx).Raw(sql, normalized).Row().Scan(&payload); err != nil {
		// Un fallo real aquí (no "sin filas") debe burbujear: el handler
		// responde 500. No camuflamos como "unknown" para no esconder
		// problemas de conectividad.
		return nil, fmt.Errorf("resolve label code: %w", err)
	}
	if payload == nil || *payload == "" {
		return &ResolveLabelResult{Match: "unknown", Code: normalized}, nil
	}

	var row resolveLabelRow
	if err := jsonUnmarshalString(*payload, &row); err != nil {
		return nil, fmt.Errorf("decode payload resolve label: %w", err)
	}
	if row.ProductBarcode == "" {
		return &ResolveLabelResult{Match: "unknown", Code: normalized}, nil
	}

	brief := &ProductBrief{
		Barcode:       row.ProductBarcode,
		ProductName:   row.ProductName,
		Quantity:      row.Quantity,
		SalePrice:     row.SalePrice,
		PurchasePrice: row.PurchasePrice,
		IsWeighted:    row.IsWeighted,
		IsPack:        row.IsPack,
	}
	if row.IsWeighted {
		brief.Unit = "KG"
	} else {
		brief.Unit = "UND"
	}
	return &ResolveLabelResult{
		Match:          "label_code",
		Code:           row.Code,
		ProductBarcode: row.ProductBarcode,
		Product:        brief,
	}, nil
}

// =========================================================================
// Trabajos de impresión
// =========================================================================

type PrintJobLine struct {
	Code     string `json:"code"`
	Quantity int    `json:"quantity"`
}

// RecordPrintJob persiste la fila en label_print_jobs y actualiza los
// LabelCode involucrados en la misma transacción. Devuelve el ID del
// job creado. Si una línea pide un `code` que no existe aborta y hace
// rollback.
func (r *LabelRepository) RecordPrintJob(
	ctx context.Context,
	createdByDNI string,
	printerID *uint,
	sizeID *uint,
	trigger string,
	lines []PrintJobLine,
	payloadJSON string,
) (uint, error) {
	actor := strings.TrimSpace(createdByDNI)
	if actor == "" {
		return 0, errors.New("createdByDNI obligatorio")
	}
	if len(lines) == 0 {
		return 0, errors.New("sin líneas en el trabajo de impresión")
	}
	var total int
	for _, l := range lines {
		if l.Quantity < 1 {
			return 0, fmt.Errorf("línea con cantidad inválida (%d)", l.Quantity)
		}
		total += l.Quantity
	}
	triggerSrc := strings.TrimSpace(trigger)
	switch triggerSrc {
	case models.PrintTriggerNew, models.PrintTriggerReprint, models.PrintTriggerBulk:
	default:
		triggerSrc = models.PrintTriggerNew
	}

	var jobID uint
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		job := models.LabelPrintJob{
			CreatedAt:        time.Now(),
			CreatedByDNI:     actor,
			PrinterProfileID: printerID,
			SizeTemplateID:   sizeID,
			TriggerSource:    triggerSrc,
			LabelCount:       total,
			Status:           models.PrintJobStatusQueued,
			PayloadJSON:      payloadJSON,
		}
		if err := tx.Create(&job).Error; err != nil {
			return err
		}
		jobID = job.ID

		// Incrementar print_count y last_printed_at por cada código.
		now := time.Now()
		for _, l := range lines {
			if err := tx.Model(&models.LabelCode{}).
				Where("code = ? AND voided_at IS NULL", l.Code).
				Updates(map[string]interface{}{
					"print_count":     gorm.Expr("print_count + ?", l.Quantity),
					"last_printed_at": now,
				}).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return jobID, nil
}

func (r *LabelRepository) MarkPrintJob(ctx context.Context, id uint, status string, errMsg string) error {
	switch status {
	case models.PrintJobStatusPrinted, models.PrintJobStatusFailed, models.PrintJobStatusCancelled:
	default:
		return fmt.Errorf("estado inválido: %q", status)
	}
	updates := map[string]interface{}{"status": status}
	if errMsg != "" {
		updates["error"] = errMsg
	}
	return r.db.WithContext(ctx).Model(&models.LabelPrintJob{}).Where("id = ?", id).Updates(updates).Error
}

// =========================================================================
// Cajón de dinero
// =========================================================================

// RecordCashDrawerOpen inserta el registro de auditoría. Las validaciones
// (sin venta → requiere admin) viven en el handler; aquí garantizamos
// que al menos uno de los CHECKs se cumpla antes de pegarle a la BD,
// para dar error legible en lugar de un CHECK violation genérico.
//
// Migración 025: desde la aplicación de la 025, una apertura puede
// tener su justificación en un `otp_challenge_id` (reason='otp_manual').
// La precondición refleja al CHECK `ck_cash_drawer_opens_sale_admin_return_otp`:
// basta con que esté poblado uno de los cuatro justificativos. El
// servicio OTP escribe el OtpChallengeID en la MISMA transacción en la
// que marca el challenge CONSUMED; este helper se mantiene para los
// otros tres caminos (sale/return/admin_override).
func (r *LabelRepository) RecordCashDrawerOpen(ctx context.Context, open *models.CashDrawerOpen) error {
	if open == nil {
		return errors.New("evento nulo")
	}
	if strings.TrimSpace(open.ActorDNI) == "" {
		return errors.New("actorDNI obligatorio")
	}
	// Precondición: CHECK ck_cash_drawer_opens_sale_admin_return_otp.
	if !open.OverrideAdmin && open.SaleID == nil && open.ReturnID == nil && open.OtpChallengeID == nil {
		return errors.New("apertura sin venta, devolución, override admin ni challenge OTP")
	}
	// Precondición: CHECK ck_cash_drawer_opens_override_requires_authorizer
	if open.OverrideAdmin && strings.TrimSpace(open.AuthorizedByDNI) == "" {
		return errors.New("override admin requiere authorized_by_dni")
	}
	// Precondición: CHECK ck_cash_drawer_opens_otp_reason_coherent — biyección exacta.
	//
	// Un `OtpChallengeID` sin reason='otp_manual' sería basura semántica;
	// una fila con reason='otp_manual' sin su challenge perdería la
	// trazabilidad. El servicio OTP siempre pobla ambos campos juntos;
	// este chequeo es defensa en profundidad para los callers que
	// inicialicen sólo uno.
	if open.OtpChallengeID != nil && open.Reason != "" && open.Reason != models.CashDrawerReasonOtpManual {
		return errors.New("otp_challenge_id requiere reason='otp_manual'")
	}
	if open.Reason == models.CashDrawerReasonOtpManual && open.OtpChallengeID == nil {
		return errors.New("reason='otp_manual' requiere otp_challenge_id")
	}
	if open.Reason == "" {
		switch {
		case open.OverrideAdmin:
			open.Reason = models.CashDrawerReasonAdminOverride
		case open.SaleID != nil:
			open.Reason = models.CashDrawerReasonSale
		case open.ReturnID != nil:
			open.Reason = models.CashDrawerReasonReturn
		case open.OtpChallengeID != nil:
			open.Reason = models.CashDrawerReasonOtpManual
		default:
			open.Reason = models.CashDrawerReasonOther
		}
	}
	open.OpenedAt = time.Now()
	return r.db.WithContext(ctx).Create(open).Error
}

// HasRecentSaleByCashier devuelve true si el cajero indicado tiene una
// venta registrada en los últimos `window`. Se usa para la regla "no
// abrir el cajón sin venta". El handler decide la ventana (default 90s).
func (r *LabelRepository) HasRecentSaleByCashier(ctx context.Context, dni string, window time.Duration) (bool, error) {
	if strings.TrimSpace(dni) == "" {
		return false, nil
	}
	cutoff := time.Now().Add(-window)
	var cnt int64
	err := r.db.WithContext(ctx).
		Table("sales").
		Where(`"employeeDni" = ? AND "saleDate" >= ?`, dni, cutoff).
		Count(&cnt).Error
	if err != nil {
		return false, err
	}
	return cnt > 0, nil
}

// IsSaleOwnedByCashier verifica que la venta `saleID` pertenezca al
// cajero `dni`. Se usa como defensa contra un empleado que envíe el
// saleId de un compañero para abrir el cajón: la auditoría quedaría
// atribuida al empleado real pero bajo pretexto de otra venta ajena.
//
// Devuelve (false, nil) si la venta no existe o no pertenece al cajero;
// (true, nil) si pertenece. Admins/superadmins pasan por otra rama en
// el handler y no llegan a este chequeo.
//
// COLUMNA REAL: la tabla `sales` tiene su clave primaria en la columna
// `saleId` (quoted camelCase, ver models.Sale.SaleID con tag
// `column:saleId`). Un `WHERE id = ?` compilaba pero NO filtraba por la
// venta correcta: Postgres resolvería `id` como una columna inexistente
// y la consulta rompería en runtime, o peor, con una fila basura si
// alguien agrega una columna `id` en el futuro. Usar siempre `"saleId"`
// quoted para empatar con la convención camelCase del esquema. La
// respuesta HTTP 201 de /api/sales/register devuelve `saleId` en el
// body (json tag `id` → valor del campo SaleID), y el frontend lo pasa
// tal cual a /api/cash-drawer/open; el handler recibe req.SaleID y
// llega aquí.
func (r *LabelRepository) IsSaleOwnedByCashier(ctx context.Context, saleID uint, dni string) (bool, error) {
	if saleID == 0 || strings.TrimSpace(dni) == "" {
		return false, nil
	}
	var cnt int64
	if err := r.db.WithContext(ctx).
		Table("sales").
		Where(`"saleId" = ? AND "employeeDni" = ? AND deleted_at IS NULL`, saleID, dni).
		Count(&cnt).Error; err != nil {
		return false, err
	}
	return cnt > 0, nil
}

// Prevent clause unused import warning for clause pkg if removed later.
var _ = clause.OnConflict{}
