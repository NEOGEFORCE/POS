-- Sprint 11: Alias de recepción para productos cuyo código de barras
-- SOLO aparece impreso en el paquete (caja/display), no en cada unidad.
--
-- POR QUÉ existe esta migración
-- ============================================================================
-- En el flujo de recepción, muchos productos (ej. cajas de chicles, bandejas
-- de huevo, blister de dulces) traen el código de barras únicamente en el
-- empaque exterior. Hoy no hay forma de registrar "este paquete trae N
-- unidades" sin inventar un producto "pack" sellable (IsPack=true), lo que
-- cambia la semántica de ventas: escanear ese código en caja cobraría el
-- paquete completo, no una unidad.
--
-- La solución es dar al código del paquete una tabla propia que:
--
--   1) NUNCA alimente el buildProductLookup de ventas (ni products.barcode
--      ni products.alternateCodes). Imposible por diseño cobrar un paquete
--      como una unidad o vender una unidad al precio del pack.
--   2) Transporte el campo units_per_pack para que al escanear el código
--      el sistema sepa (o aprenda) cuántas unidades físicas entran al
--      inventario como stock del producto base.
--   3) Permita auditar el proveedor que lo trajo (supplier_id) y el conteo
--      de veces que se usó (seen_count), para mostrar al operador "esto
--      lo trae tal proveedor cada semana".
--
-- La UI de recepción:
--
--   - Resolver GET /inventory/package-barcode/resolve?code=X responde tres
--     estados:
--       exact   → ya existe un alias para ese código, con units_per_pack.
--       new     → el código es un product.barcode o alternateCode conocido;
--                  es la primera vez que se usa como paquete y hay que pedir
--                  units_per_pack al usuario.
--       unknown → no hay match en ningún lado; cae al NotFoundDialog clásico.
--   - Al confirmar la cantidad de paquetes, el modal POSTea a
--     POST /inventory/package-barcode para persistir el alias (idempotente)
--     y luego llama a /products/bulk-receive con addedQuantity = packs × units.
--
-- QUÉ SE CREA
-- ============================================================================
-- Una sola tabla, package_barcode_aliases, con unicidad global del
-- package_code vía UNIQUE (package_code). La validación de colisiones
-- cruzadas (barcode, alternateCodes, label_codes) la hace el handler Go
-- dentro de una transacción, igual que label_repository.codeExistsAnywhereTx.
--
-- No se añaden FKs duras a label_codes porque esa tabla es creada por la
-- migración 016 (también sin FK dura), y seguimos esa misma estrategia:
-- validaciones cruzadas vivas a nivel código, no a nivel esquema.
--
-- QUÉ NO HACE
-- ============================================================================
-- - No toca products.AlternateCodes. El código de paquete JAMÁS debe
--   terminar ahí, porque alternateCodes alimenta la búsqueda de ventas en
--   buildProductLookup (sale_service.go). El guardián estático en el
--   backend garantiza que ninguna ruta nueva lo escriba.
-- - No marca IsPack=true automáticamente. Marcar un producto como pack
--   cambia el precio de venta cobrado en caja; el dueño debe hacerlo
--   explícitamente desde el modal de productos si quiere vender el paquete
--   completo. Un alias de recepción NO es un producto sellable.
-- - No crea label_codes para las unidades. La impresión de etiquetas
--   unitarias usa el flujo existente POST /labels/codes +
--   POST /labels/print-jobs (migración 016), que ya es idempotente por
--   product_barcode. Reimprimir devuelve el mismo code persistente.
--
-- TRANSACCIONAL: SÍ
-- ============================================================================
-- No usa CREATE INDEX CONCURRENTLY. Todo corre dentro de la transacción por
-- defecto del runner. Las tablas son nuevas, así que ningún CREATE INDEX
-- bloquea tablas calientes. La 017 NO se añade a la lista de excepciones
-- transaccionales en catalog.go.
--
-- NO MODIFICA DATOS DE NEGOCIO
-- ============================================================================
-- Puramente DDL: CREATE TABLE, CREATE INDEX y COMMENT. Ni un UPDATE, ni un
-- DELETE, ni un INSERT. Las filas las crea el handler Go cuando el usuario
-- confirma por primera vez el alias en el modal de recepción.

-- ----------------------------------------------------------------------------
-- package_barcode_aliases: código del paquete + producto unitario asociado
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS package_barcode_aliases (
    id               BIGSERIAL     PRIMARY KEY,
    product_barcode  VARCHAR(64)   NOT NULL
                         REFERENCES products(barcode) ON DELETE CASCADE,
    package_code     VARCHAR(64)   NOT NULL,
    units_per_pack   INTEGER       NOT NULL CHECK (units_per_pack >= 1),
    supplier_id      INTEGER       REFERENCES suppliers(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by_dni   VARCHAR(32)   NOT NULL,
    last_seen_at     TIMESTAMPTZ,
    seen_count       INTEGER       NOT NULL DEFAULT 0 CHECK (seen_count >= 0),
    CONSTRAINT uq_package_barcode_aliases_code UNIQUE (package_code)
);

CREATE INDEX IF NOT EXISTS ix_pba_product
    ON package_barcode_aliases (product_barcode);

CREATE INDEX IF NOT EXISTS ix_pba_supplier
    ON package_barcode_aliases (supplier_id)
    WHERE supplier_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_pba_last_seen
    ON package_barcode_aliases (last_seen_at DESC)
    WHERE last_seen_at IS NOT NULL;

COMMENT ON TABLE package_barcode_aliases IS
    'Alias de código de barras usado ÚNICAMENTE durante recepción: productos cuyo código solo aparece en el paquete, no en cada unidad. El código JAMÁS debe caer en products.alternateCodes (eso lo haría escaneable en caja). Validaciones de unicidad cruzada contra products.barcode, products.alternateCodes y label_codes.code viven en el handler Go.';
COMMENT ON COLUMN package_barcode_aliases.product_barcode IS
    'Barcode del producto UNITARIO asociado. FK dura con ON DELETE CASCADE: si el producto se elimina físicamente, el alias cae con él. Para soft-delete (DeletedAt), el alias queda referenciando una fila con deleted_at pero el producto sigue existiendo en la tabla.';
COMMENT ON COLUMN package_barcode_aliases.package_code IS
    'El código impreso en el empaque exterior. UNIQUE a nivel global: un mismo código solo puede pertenecer a un producto. Las colisiones con products.barcode, products.alternateCodes y label_codes.code las valida el handler dentro de una transacción.';
COMMENT ON COLUMN package_barcode_aliases.units_per_pack IS
    'Unidades físicas que entran al stock del producto base por cada paquete escaneado. CHECK >= 1: no tiene sentido un paquete que no trae nada.';
COMMENT ON COLUMN package_barcode_aliases.supplier_id IS
    'Proveedor que trajo el paquete por primera vez. Opcional: si el alias se registra fuera de un flujo con proveedor seleccionado, queda NULL. ON DELETE SET NULL para no perder el alias si se elimina al proveedor.';
COMMENT ON COLUMN package_barcode_aliases.seen_count IS
    'Veces que la recepción ha usado este alias. Lo actualiza POST /inventory/package-barcode/seen cuando se confirma una recepción. Útil para la UI "lo trae X cada Y días".';
