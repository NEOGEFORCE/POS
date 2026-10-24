// Repositorio del módulo de códigos internos propios (namespace POSINT-).
//
// Responsabilidades:
//
//   - Reservar un código nuevo en forma persistente y atómica. El generador
//     usa `crypto/rand` para 48 bits de entropía (12 nibbles hex) y
//     reintenta hasta 25 veces ante colisión. La PK sobre reserved_code es
//     la última defensa: dos reservas simultáneas con el mismo valor
//     terminan con una violación de PK y el repo reintenta.
//
//   - Consumir una reserva dentro de la misma transacción que inserta el
//     producto. El flujo es: SELECT FOR UPDATE sobre la reserva, verificar
//     status=RESERVED y no expirada, INSERT en products, UPDATE
//     status=CONSUMED. Si cualquier paso falla, el ROLLBACK deja la reserva
//     intacta y el código sigue vivo para el próximo intento.
//
//   - Validar colisión contra CINCO fuentes antes de reservar:
//     1) products.barcode
//     2) tokens exactos de products.alternate_codes (vía string_to_array)
//     3) label_codes.code (migración 016; tolerante a tabla ausente)
//     4) package_barcode_aliases.package_code (migración 017; tolerante)
//     5) internal_barcode_reservations.reserved_code (incluye todos los
//     statuses: una reserva CONSUMED/EXPIRED sigue ocupando el valor)
//
// Decisiones clave:
//
//   - El repo NO decide políticas de rol ni autenticación: eso vive en el
//     handler. Aquí sólo persistimos lo que el handler ya validó.
//   - Sin FK dura a products (mismo patrón que label_codes y
//     cash_drawer_opens): preserva el audit ante soft delete y marcadores
//     [HISTORICO].
//   - crypto/rand es la única fuente de entropía. Nunca se cae a
//     time.Now() porque dos pestañas abiertas podrían producir el mismo
//     valor por azar de milisegundos.
package repositories

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/refresher"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// InternalBarcodeRepository agrupa la persistencia de reservas y el
// consumo atómico al crear productos con namespace POSINT-.
type InternalBarcodeRepository struct {
	db *gorm.DB
}

// NewInternalBarcodeRepository construye el repositorio.
func NewInternalBarcodeRepository(db *gorm.DB) *InternalBarcodeRepository {
	return &InternalBarcodeRepository{db: db}
}

// DefaultInternalBarcodeTTL es la vida por defecto de una reserva fresca.
// El modal del front puede estar abierto varios minutos mientras el
// operador completa precios/categoría; 15 minutos cubre el caso normal
// y permite que el job de expiración limpie reservas abandonadas sin
// quemar codificación disponible.
const DefaultInternalBarcodeTTL = 15 * time.Minute

// internalBarcodeMaxReserveAttempts es el techo de reintentos del
// generador. Con 48 bits de entropía por candidato y <1M códigos en
// catálogo, el chance de necesitar más de 2 intentos es despreciable.
const internalBarcodeMaxReserveAttempts = 25

// Errores sentinela del dominio. El handler los traduce a códigos HTTP y
// cuerpos JSON estables para el frontend.
var (
	// ErrInternalBarcodeInvalidSource se devuelve cuando el payload pide
	// una reserva con un `source` fuera del enum conocido.
	ErrInternalBarcodeInvalidSource = errors.New("internal barcode: source inválido")

	// ErrInternalBarcodeInvalidActor se devuelve cuando no hay DNI del
	// usuario (el handler protege con AuthMiddleware, esto es defensa
	// en profundidad).
	ErrInternalBarcodeInvalidActor = errors.New("internal barcode: actorDNI requerido")

	// ErrInternalBarcodeExhausted se devuelve cuando el generador agotó
	// todos sus intentos. En la práctica implica un bug (universo
	// sobre-poblado), no un fallo transitorio.
	ErrInternalBarcodeExhausted = errors.New("internal barcode: no se pudo generar un código único tras los reintentos máximos")

	// ErrInternalBarcodeReservationNotFound: el código del payload no
	// está registrado en internal_barcode_reservations.
	ErrInternalBarcodeReservationNotFound = errors.New("internal barcode: reserva no encontrada")

	// ErrInternalBarcodeReservationExpired: la reserva existe pero ya
	// no es consumible (expires_at < now o status=EXPIRED).
	ErrInternalBarcodeReservationExpired = errors.New("internal barcode: reserva expirada")

	// ErrInternalBarcodeReservationAlreadyUsed: la reserva ya fue
	// consumida por un producto previo.
	ErrInternalBarcodeReservationAlreadyUsed = errors.New("internal barcode: reserva ya consumida")

	// ErrInternalBarcodeFormat: el código no cumple el shape POSINT-<hex>.
	// La BD también lo rechaza vía CHECK, pero el servicio aborta antes.
	ErrInternalBarcodeFormat = errors.New("internal barcode: formato inválido (esperado ^POSINT-[0-9A-F]{8,24}$)")

	// ErrInternalProductBarcodeInUse: el barcode del producto ya existe.
	// Imposible si la reserva estaba limpia, pero defensa final por si una
	// semilla legacy incompatible ocupó el valor.
	ErrInternalProductBarcodeInUse = errors.New("internal barcode: el código del producto ya está en uso")

	// ErrInternalNamespaceForbidden: alguien intentó registrar un valor
	// del namespace POSINT- en un camino que no debe aceptarlo (alias de
	// paquete, alterno, label_code libre, etc.). El servicio aborta antes
	// de llegar a los CHECK de la migración.
	ErrInternalNamespaceForbidden = errors.New("internal barcode: el namespace POSINT- está reservado para products.barcode y requiere reserva válida")
)

// =========================================================================
// Reserva
// =========================================================================

// ReserveOptions parametriza la emisión del código. Los defaults sanos
// cubren el caso del modal; `TTL=0` significa "usar DefaultInternalBarcodeTTL",
// y `TTL<0` deja la reserva sin expiración (uso administrativo).
type ReserveOptions struct {
	Source   string
	ActorDNI string
	Note     string
	HexLen   int           // 0 → InternalBarcodeDefaultHexLen
	TTL      time.Duration // 0 → DefaultInternalBarcodeTTL; <0 → sin expiración
}

// Reserve emite un código nuevo del namespace POSINT- y persiste la fila
// RESERVED. Toda la operación va dentro de una transacción:
//
//  1. crypto/rand produce un candidato hex uppercase.
//  2. `candidateCollidesTx` consulta las cinco fuentes de colisión.
//  3. Si no colisiona, INSERT. Si otro proceso lo tomó entre pasos 2 y 3,
//     la PK falla con error 23505 y reintentamos con otro candidato.
//
// El `note` es opcional y se guarda para auditoría.
func (r *InternalBarcodeRepository) Reserve(ctx context.Context, opts ReserveOptions) (*models.InternalBarcodeReservation, error) {
	source := strings.TrimSpace(opts.Source)
	if source == "" {
		source = models.InternalBarcodeSourceProductForm
	}
	if !models.IsValidInternalSource(source) {
		return nil, ErrInternalBarcodeInvalidSource
	}

	actor := strings.TrimSpace(opts.ActorDNI)
	if actor == "" {
		return nil, ErrInternalBarcodeInvalidActor
	}

	hexLen := opts.HexLen
	if hexLen <= 0 {
		hexLen = models.InternalBarcodeDefaultHexLen
	}
	if hexLen < models.InternalBarcodeHexMin || hexLen > models.InternalBarcodeHexMax {
		return nil, fmt.Errorf("internal barcode: hexLen=%d fuera de [%d..%d]",
			hexLen, models.InternalBarcodeHexMin, models.InternalBarcodeHexMax)
	}

	var expiresAt *time.Time
	switch {
	case opts.TTL == 0:
		exp := time.Now().Add(DefaultInternalBarcodeTTL)
		expiresAt = &exp
	case opts.TTL > 0:
		exp := time.Now().Add(opts.TTL)
		expiresAt = &exp
	}

	note := strings.TrimSpace(opts.Note)

	var out *models.InternalBarcodeReservation
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for attempt := 0; attempt < internalBarcodeMaxReserveAttempts; attempt++ {
			candidate, err := generateInternalBarcode(hexLen)
			if err != nil {
				// crypto/rand falla sólo si el SO está roto. No se cae a
				// time.Now() a propósito: dos pestañas podrían producir el
				// mismo valor por azar de milisegundos.
				return fmt.Errorf("internal barcode: crypto/rand no disponible: %w", err)
			}
			colisiona, err := candidateCollidesTx(ctx, tx, candidate)
			if err != nil {
				return err
			}
			if colisiona {
				continue
			}
			row := models.InternalBarcodeReservation{
				ReservedCode:  candidate,
				Status:        models.InternalBarcodeStatusReserved,
				Source:        source,
				ReservedAt:    time.Now(),
				ReservedByDNI: actor,
				ExpiresAt:     expiresAt,
			}
			if note != "" {
				n := note
				row.Note = &n
			}
			if err := tx.Create(&row).Error; err != nil {
				// 23505 unique_violation: carrera contra otra tx que acaba
				// de persistir el mismo valor. Reintentamos con otro
				// candidato en lugar de propagar.
				if isUniqueViolationErr(err) {
					continue
				}
				return err
			}
			out = &row
			return nil
		}
		return ErrInternalBarcodeExhausted
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// =========================================================================
// Lookup
// =========================================================================

// GetByCode devuelve la reserva por su PK, con la normalización canónica
// aplicada (TrimSpace + ToUpper). gorm.ErrRecordNotFound se traduce a
// ErrInternalBarcodeReservationNotFound para que el handler produzca
// 404 con código estable.
func (r *InternalBarcodeRepository) GetByCode(ctx context.Context, code string) (*models.InternalBarcodeReservation, error) {
	normalized := models.NormalizeInternalBarcode(code)
	if normalized == "" {
		return nil, ErrInternalBarcodeReservationNotFound
	}
	var row models.InternalBarcodeReservation
	err := r.db.WithContext(ctx).
		Where("reserved_code = ?", normalized).
		First(&row).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrInternalBarcodeReservationNotFound
		}
		return nil, err
	}
	return &row, nil
}

// =========================================================================
// Consumo atómico (al crear producto)
// =========================================================================

// CreateProductConsumingReservation inserta el producto `product` en la
// MISMA transacción en la que marca su reserva como CONSUMED. Pasos:
//
//  1. SELECT FOR UPDATE sobre la fila de la reserva (serializa dos
//     intentos de consumo del mismo código).
//  2. Validar status=RESERVED y !expirada.
//  3. Validar que ningún producto exista ya con ese barcode.
//  4. INSERT en products (con la misma política de Suppliers que
//     PostgresProductRepository.Save: Omit en el INSERT, luego Replace
//     en la asociación m2m).
//  5. UPDATE de la reserva: status=CONSUMED, consumed_at=now,
//     consumed_product_barcode=product.Barcode, consumed_by_dni=actor.
//
// Si cualquier paso falla, el ROLLBACK deja la reserva intacta en
// RESERVED y el código sigue vivo. La invalidación de caches ocurre SÓLO
// después del COMMIT exitoso.
//
// El handler le pasa un *models.Product ya sanitizado (barcode en
// mayúsculas, nombre uppercase, metadatos del actor, etc.).
func (r *InternalBarcodeRepository) CreateProductConsumingReservation(
	ctx context.Context,
	product *models.Product,
	actorDNI string,
) error {
	if product == nil {
		return fmt.Errorf("internal barcode: product requerido")
	}
	actor := strings.TrimSpace(actorDNI)
	if actor == "" {
		return ErrInternalBarcodeInvalidActor
	}
	normalized := models.NormalizeInternalBarcode(product.Barcode)
	if normalized == "" || !models.IsValidInternalBarcode(normalized) {
		return ErrInternalBarcodeFormat
	}
	// Fuerza la normalización en el campo del struct para que el INSERT y el
	// UPDATE queden coherentes aun si el caller pasó espacios o minúsculas.
	product.Barcode = normalized

	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1) Lock de la reserva.
		var res models.InternalBarcodeReservation
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("reserved_code = ?", normalized).
			First(&res).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrInternalBarcodeReservationNotFound
			}
			return err
		}
		// 2) Validaciones de disponibilidad.
		switch res.Status {
		case models.InternalBarcodeStatusConsumed:
			return ErrInternalBarcodeReservationAlreadyUsed
		case models.InternalBarcodeStatusExpired:
			return ErrInternalBarcodeReservationExpired
		case models.InternalBarcodeStatusReserved:
			// ok
		default:
			// Status desconocido en BD (debería ser imposible por el CHECK),
			// pero rechazamos defensivamente.
			return fmt.Errorf("internal barcode: estado inesperado %q", res.Status)
		}
		if res.ExpiresAt != nil && !time.Now().Before(*res.ExpiresAt) {
			return ErrInternalBarcodeReservationExpired
		}

		// 3) Nadie más usó ya ese barcode como producto (defensa final).
		// Unscoped para contar incluso productos soft-deleted con el mismo
		// barcode: no queremos reemitir sobre un marcador [HISTORICO] vivo.
		var count int64
		if err := tx.Unscoped().Table("products").
			Where("barcode = ?", normalized).
			Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return ErrInternalProductBarcodeInUse
		}

		// 4) Insert del producto. Replicamos la política de Save: Omit
		// Suppliers en el INSERT y luego Replace la asociación m2m.
		suppliers := product.Suppliers
		product.Suppliers = nil
		if err := tx.Omit("Suppliers").Create(product).Error; err != nil {
			if isUniqueViolationErr(err) {
				return ErrInternalProductBarcodeInUse
			}
			return err
		}
		if len(suppliers) > 0 {
			if err := tx.Model(product).Association("Suppliers").Replace(suppliers); err != nil {
				return err
			}
			product.Suppliers = suppliers
		}

		// 5) Marcar la reserva como consumida. Las columnas se escriben
		// JUNTAS para no violar el CHECK ck_ibr_consumed_coherent.
		now := time.Now()
		updates := map[string]interface{}{
			"status":                   models.InternalBarcodeStatusConsumed,
			"consumed_at":              now,
			"consumed_product_barcode": normalized,
			"consumed_by_dni":          actor,
		}
		result := tx.Model(&models.InternalBarcodeReservation{}).
			Where("reserved_code = ? AND status = ?", normalized, models.InternalBarcodeStatusReserved).
			Updates(updates)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			// La reserva cambió de estado entre el SELECT FOR UPDATE y
			// este UPDATE. En Postgres no debería ocurrir (FOR UPDATE la
			// mantiene bloqueada hasta el COMMIT), pero validamos para no
			// cerrar la tx creyendo que todo salió bien.
			return ErrInternalBarcodeReservationAlreadyUsed
		}
		return nil
	})
	if err != nil {
		return err
	}

	// Caches: la escritura exitosa afecta el catálogo. Replicamos la misma
	// política que PostgresProductRepository.Save pero fuera de la tx.
	cache.InvalidateCache(cache.CacheKeyProducts)
	cache.InvalidateCache(cache.CacheKeyProductCount)
	cache.InvalidateCache(fmt.Sprintf("product_barcode_%s", product.Barcode))
	cache.InvalidateDashboard()
	cache.InvalidateSavingsOpportunities()
	refresher.GetRefresherService(r.db).RequestRefresh("mv_dashboard_stats_monthly")

	return nil
}

// =========================================================================
// Helpers: generación y verificación de colisión
// =========================================================================

// generateInternalBarcode produce un candidato POSINT-<HEX> de longitud
// `hexLen` nibbles usando crypto/rand. Siempre uppercase: empata con el
// CHECK ck_ibr_namespace_shape y con la normalización ToUpper del handler.
func generateInternalBarcode(hexLen int) (string, error) {
	if hexLen <= 0 {
		hexLen = models.InternalBarcodeDefaultHexLen
	}
	// Cada byte produce 2 nibbles. Para longitudes impares pedimos 1 byte
	// extra y recortamos al largo exacto.
	byteLen := (hexLen + 1) / 2
	buf := make([]byte, byteLen)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	hexBody := strings.ToUpper(hex.EncodeToString(buf))[:hexLen]
	return models.InternalBarcodePrefix + hexBody, nil
}

// internalBarcodeAlternateCodesContainsSQL replica el patrón de
// alternateCodesContainsSQL pero para el namespace interno: comparación
// case-insensitive por token exacto. En el repo interno siempre comparamos
// upper(?) para empatar la normalización canónica.
const internalBarcodeAlternateCodesContainsSQL = `EXISTS (SELECT 1 FROM unnest(string_to_array(COALESCE(alternate_codes, ''), ',')) AS ac WHERE upper(trim(ac)) = upper(?))`

// candidateCollidesTx verifica si `candidate` ya está en uso en alguna de
// las cinco fuentes. Devuelve `true` ante CUALQUIER hit para que el
// generador reintente con otro candidato.
//
// La verificación de existencia de tablas opcionales usa `to_regclass` en
// sentencias aparte (Postgres resuelve nombres al analizar, un CASE WHEN
// embebido no evita el error).
//
// La función es tolerante a label_codes (migración 016) y
// package_barcode_aliases (migración 017) ausentes: la asume no aplicada
// y simplemente omite esa fuente. En producción con la 024 aplicada, las
// tres migraciones conviven; en entornos antiguos, degrada sin romper.
func candidateCollidesTx(ctx context.Context, tx *gorm.DB, candidate string) (bool, error) {
	// 1) products.barcode (match exacto). Unscoped: también considera
	// productos soft-deleted — un barcode "libre" según la vista pero
	// retenido por una fila con deleted_at NOT NULL sigue siendo un
	// riesgo de colisión al cambiar DeletedAt.
	var cnt int64
	if err := tx.WithContext(ctx).
		Unscoped().
		Table("products").
		Where("barcode = ?", candidate).
		Count(&cnt).Error; err != nil {
		return false, fmt.Errorf("colisión internal barcode (products.barcode): %w", err)
	}
	if cnt > 0 {
		return true, nil
	}

	// 2) products.alternate_codes (token exacto).
	if err := tx.WithContext(ctx).
		Unscoped().
		Table("products").
		Where(internalBarcodeAlternateCodesContainsSQL, candidate).
		Count(&cnt).Error; err != nil {
		return false, fmt.Errorf("colisión internal barcode (alternate_codes): %w", err)
	}
	if cnt > 0 {
		return true, nil
	}

	// 3) label_codes.code (migración 016). Tolerante a tabla ausente.
	labelsExist, err := labelCodesTableExists(tx)
	if err != nil {
		return false, fmt.Errorf("colisión internal barcode (label_codes probe): %w", err)
	}
	if labelsExist {
		if err := tx.WithContext(ctx).
			Table("label_codes").
			Where("code = ?", candidate).
			Count(&cnt).Error; err != nil {
			return false, fmt.Errorf("colisión internal barcode (label_codes): %w", err)
		}
		if cnt > 0 {
			return true, nil
		}
	}

	// 4) package_barcode_aliases.package_code (migración 017). Tolerante.
	pbaExist, err := packageBarcodeAliasesTableExists(tx)
	if err != nil {
		return false, fmt.Errorf("colisión internal barcode (package_barcode_aliases probe): %w", err)
	}
	if pbaExist {
		if err := tx.WithContext(ctx).
			Table("package_barcode_aliases").
			Where("package_code = ?", candidate).
			Count(&cnt).Error; err != nil {
			return false, fmt.Errorf("colisión internal barcode (package_barcode_aliases): %w", err)
		}
		if cnt > 0 {
			return true, nil
		}
	}

	// 5) internal_barcode_reservations.reserved_code. CUALQUIER status
	// cuenta: una reserva CONSUMED/EXPIRED sigue ocupando el valor por la
	// PK. Si la propia tabla no existe (024 aún no aplicada), degradamos
	// a false para que el repo pueda operar en entornos de prueba sin BD
	// completa — el INSERT fallará igual más adelante.
	ibrExist, err := internalBarcodeReservationsTableExists(tx)
	if err != nil {
		return false, fmt.Errorf("colisión internal barcode (self probe): %w", err)
	}
	if ibrExist {
		if err := tx.WithContext(ctx).
			Table("internal_barcode_reservations").
			Where("reserved_code = ?", candidate).
			Count(&cnt).Error; err != nil {
			return false, fmt.Errorf("colisión internal barcode (self): %w", err)
		}
		if cnt > 0 {
			return true, nil
		}
	}

	return false, nil
}

// packageBarcodeAliasesExistsSQL replica el patrón de labelCodesExistsSQL.
const packageBarcodeAliasesExistsSQL = `SELECT to_regclass('public.package_barcode_aliases') IS NOT NULL`

func packageBarcodeAliasesTableExists(db *gorm.DB) (bool, error) {
	var exists bool
	if err := db.Raw(packageBarcodeAliasesExistsSQL).Scan(&exists).Error; err != nil {
		return false, fmt.Errorf("verificando tabla package_barcode_aliases: %w", err)
	}
	return exists, nil
}

const internalBarcodeReservationsExistsSQL = `SELECT to_regclass('public.internal_barcode_reservations') IS NOT NULL`

func internalBarcodeReservationsTableExists(db *gorm.DB) (bool, error) {
	var exists bool
	if err := db.Raw(internalBarcodeReservationsExistsSQL).Scan(&exists).Error; err != nil {
		return false, fmt.Errorf("verificando tabla internal_barcode_reservations: %w", err)
	}
	return exists, nil
}

// isUniqueViolationErr detecta la violación de unicidad de Postgres.
// Lo hacemos por marcas de texto (SQLSTATE 23505, "duplicate key",
// "unique") en vez de depender de un tipo concreto del driver para
// mantener la portabilidad entre pgx/lib-pq. El error completo nunca
// viaja al cliente (SendError lo sanitiza antes de responder).
func isUniqueViolationErr(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "23505") ||
		strings.Contains(s, "duplicate key") ||
		strings.Contains(s, "unique constraint") ||
		strings.Contains(s, "unique violation")
}
