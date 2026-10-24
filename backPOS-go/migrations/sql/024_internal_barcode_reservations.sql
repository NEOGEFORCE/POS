-- Sprint 13: generador de códigos internos propios ("POSINT-<hex>") para
-- productos sin código de barras físico, con reserva persistente y atómica.
--
-- POR QUÉ existe esta migración
-- ============================================================================
-- El modal `ProductFormModal` (alta desde /products y desde /inventory/receive)
-- admite productos cuyo código de barras simplemente no existe: granel,
-- marcas pequeñas sin GTIN, mercancía reempacada en el local, insumos
-- internos, repuestos genéricos, etc. Hoy el cajero rellena a mano "PROD001",
-- "SIN-COD-1", "ABC123" o cualquier cosa que se le ocurra. Problemas
-- repetidos en campo:
--
--   1) COLISIÓN HISTÓRICA.
--      Dos locales distintos han usado "PROD001" en productos distintos; al
--      consolidar reportes o migrar bases se mezclan ventas. Y peor: un día
--      el proveedor trae un producto cuyo GTIN real coincide con el que ya
--      inventamos, y los movimientos quedan contaminados.
--
--   2) COLISIÓN FUTURA.
--      Nada impide que un barcode EAN-13 futuro empiece por "7701234" y
--      el "7701234" inventado hoy colisione mañana. El código inventado
--      vive en products.barcode (PK global), en products.alternate_codes
--      (CSV usado por buildProductLookup de ventas), en label_codes.code
--      (migración 016) y en package_barcode_aliases.package_code (017).
--      Cualquiera de los cuatro basta para un reconocimiento erróneo.
--
--   3) GENERACIÓN SÓLO EN EL CLIENTE.
--      Si el modal genera un UUID en JavaScript y lo mete en el campo, dos
--      pestañas abiertas a la vez pueden generar el mismo valor por el
--      mismo PRNG mal sembrado o por azar en espacios cortos. Más grave: no
--      hay trazabilidad de quién reservó qué y cuándo, y una creación que
--      falla a la mitad deja al operador reintentando con el mismo código
--      que puede o no haber quedado persistido.
--
-- La solución: un NAMESPACE RESERVADO en el servidor, con PERSISTENCIA
-- ATÓMICA, GARANTÍA DE UNICIDAD por PRIMARY KEY, y SEMÁNTICA explícita de
-- "reservado → consumido".
--
-- NAMESPACE RESERVADO: 'POSINT-' + HEX CRIPTOGRÁFICO EN MAYÚSCULAS
-- ============================================================================
-- Prefijo literal 'POSINT-' seguido de 8 a 24 caracteres hexadecimales en
-- mayúsculas: `^POSINT-[0-9A-F]{8,24}$`.
--
-- Por qué este prefijo:
--
--   - "POSINT" (POS INTERNO) es ASCII puro, imprimible en CODE128 (el único
--     formato CODE128 soporta de hecho todo ASCII, pero mantenemos sólo
--     [A-Z0-9-] para no sorprender al operador con caracteres raros ni al
--     bridge de impresión térmica).
--   - Ninguna norma de códigos comerciales (GS1, GTIN-8/12/13/14, UPC, SKU
--     típico de proveedor) empieza por "POSINT". GS1 no asigna prefijos de
--     empresa que empiecen por "P" porque los AI (Application Identifiers)
--     colisionarían, y en GTIN sólo hay dígitos; un barcode comercial
--     JAMÁS podrá empezar por "POSINT-". El namespace es claramente
--     "no comercial" por construcción.
--   - El cuerpo hexadecimal (8 nibbles = 32 bits como mínimo, 24 nibbles =
--     96 bits como máximo) viene de crypto/rand en el handler Go. Con 32
--     bits de entropía y <1M códigos el chance de colisión antes del
--     reintento es inferior a 1e-4; con reintento del generador el
--     repositorio garantiza unicidad absoluta. El operador puede subir la
--     longitud a 12/16 nibbles si el catálogo crece.
--   - El guión '-' separa prefijo de cuerpo para que la UI pueda resaltar
--     visualmente el prefijo (y el operador reconozca de un vistazo que es
--     un código interno, no un código del proveedor).
--
-- MAYÚSCULAS: products.barcode se guarda `strings.ToUpper` en
-- product_handler.go (`product.Barcode = strings.ToUpper(...)`). Si el
-- generador emitiera hex en minúsculas, el UPPER del handler cambiaría el
-- valor y la consulta `WHERE reserved_code = ?` no encontraría la reserva.
-- Por eso el CHECK fija `[0-9A-F]` y el handler debe uppercase el hex
-- aleatorio antes de insertar en esta tabla. Idéntica semántica que la
-- normalización de barcode en caja: una fuente, una forma.
--
-- QUÉ CREA ESTA MIGRACIÓN
-- ============================================================================
-- 1) Tabla `internal_barcode_reservations`:
--    - PK `reserved_code` garantiza que NUNCA se emita dos veces el mismo
--      código, aun ante reintentos simultáneos del handler. Un segundo
--      INSERT con el mismo valor viola la PK y fuerza al generador a
--      reintentar con otro candidato. Esta es la última línea de defensa;
--      el handler además consulta las cuatro fuentes de colisión
--      (products.barcode, tokens exactos de alternate_codes,
--      label_codes.code, package_barcode_aliases.package_code) antes de
--      insertar.
--    - Columna `status` con CHECK IN ('RESERVED','CONSUMED','EXPIRED').
--      Diferencia reservas vivas de las ya aplicadas al producto y de las
--      que expiraron sin consumo. Jamás se borran filas: la unicidad del
--      código vive por siempre, aun después de la expiración, porque la PK
--      sigue siendo `reserved_code`.
--    - `consumed_product_barcode` apunta (soft, sin FK dura) al
--      products.barcode al que se vinculó el código al crearse el producto.
--      Soft igual que label_codes y package_barcode_aliases.product_barcode:
--      la BD guarda la referencia, el handler Go valida en transacción.
--      Mantiene el audit si el producto se purga físicamente.
--    - `expires_at` nullable. Permite que un job marque reservas RESERVED
--      viejas (modal abandonado, pestaña cerrada) como EXPIRED. No se
--      liberan; sólo se marcan para que la UI no las ofrezca.
--    - `source` registra el origen operativo ('product_form' / 'reception'
--      / 'other') para que la auditoría distinga alta directa de alta en
--      recepción.
--
-- 2) DOS CHECK constraints de blindaje cruzado contra abuso del namespace:
--
--    a) `package_barcode_aliases`: `package_code !~* '^POSINT-'`.
--       El alias de recepción (017) jamás debe ser un código interno:
--       los códigos internos SON productos unitarios, no empaques de otro
--       producto. Mezclarlos haría que un escaneo en recepción sumara
--       stock a sí mismo con multiplicador >1.
--
--    b) `products.alternate_codes`: `position('POSINT-' in upper(...)) = 0`.
--       Un alternate_code POSINT- confundiría al generador en los
--       reintentos (collision contra alternate_codes vive en el handler,
--       pero aquí ponemos el guardián dura por si un script legacy lo
--       intentara). El namespace es TAN distintivo que un `position()`
--       sobre el CSV completo no tiene falsos positivos operativos.
--
--    Ambas se agregan vía `DO $$ ... END $$` para ser idempotentes:
--    Postgres no soporta `ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS`,
--    y los reintentos del runner (p.ej. tras un fallo parcial) deben
--    poder volver a correr este archivo sin reventar.
--
-- 3) UN CHECK de COHERENCIA (no prohibición) sobre `label_codes`:
--
--    `label_codes` SÍ puede llevar `code` en el namespace POSINT-, pero
--    SÓLO cuando la fila está auditando/imprimiendo la etiqueta de un
--    producto interno; en ese caso `product_barcode` debe ser igual al
--    `code`. Es decir, para una fila POSINT-:
--
--        code = product_barcode = products.barcode del producto interno
--
--    Esto habilita el flujo audit-first de LabelPrintSheet para
--    productos internos:
--
--        1. UI llama `/labels/codes` con `productBarcode = POSINT-X`.
--        2. El repositorio detecta el prefijo POSINT- y persiste
--           `label_codes.code = POSINT-X`, `product_barcode = POSINT-X`
--           (reutilizando el barcode del producto, SIN generar un LC-<hex>
--           para no romper la biyección "lo impreso es el barcode").
--        3. UI llama `/labels/print-jobs` con ese code, incrementando
--           `print_count`/`last_printed_at` y dejando snapshot en
--           `label_print_jobs.payload_json`.
--        4. UI envía al bridge o cae a `window.print()`.
--
--    Al escanear la etiqueta impresa, `ResolveLabelCode` encuentra la
--    fila por `code = POSINT-X` y hace JOIN con `products` por
--    `product_barcode = barcode`, resolviendo al producto correcto. Si
--    por error alguien insertara `code = POSINT-X` sin `product_barcode`
--    o con un `product_barcode` distinto, el escaneo no resolvería y la
--    etiqueta impresa no serviría — por eso la restricción es necesaria.
--
--    IMPORTANTE: los productos comerciales (barcode NO POSINT-) siguen
--    usando el namespace `LC-<hex>` emitido por
--    `generateUniqueCodeTx` (label_repository.go). En ese caso `code` es
--    distinto de `product_barcode` y la rama `code !~ '^POSINT-'` del
--    CHECK aplica, sin restricción adicional. La coherencia la hace
--    cumplir el repositorio Go; este CHECK es defensa en profundidad a
--    nivel BD contra cualquier INSERT ad hoc.
--
--    El CHECK es puramente INTRA-FILA (no referencia otras tablas, no
--    usa subquery): Postgres no permite subqueries en CHECKs. La
--    garantía "ese POSINT-X existe también en products.barcode" vive
--    exclusivamente en el repositorio (ver nota explicativa en
--    label_repository.go cerca de EnsureCodeForProduct). Un trigger
--    cross-table sería estrictamente más fuerte pero añadiría latencia
--    y complejidad fuera del scope de esta migración; el handler ya
--    valida la existencia del producto antes de llamar a
--    EnsureCodeForProduct.
--
-- QUÉ NO HACE
-- ============================================================================
-- - NO declara FK dura de `internal_barcode_reservations.consumed_product_barcode`
--   hacia `products(barcode)`. Patrón idéntico a label_codes y cash_drawer_opens
--   (migración 016): el POS tiene productos marcador [HISTORICO]<codigo> y
--   productos con soft delete; una FK dura cascadearía o bloquearía la
--   auditoría. La validación de existencia la hace el handler Go dentro de
--   la transacción de consumo.
--
-- - NO fuerza al handler a usar esta tabla para TODOS los productos. Sólo
--   los productos cuyo barcode comience por 'POSINT-' deben tener una fila
--   RESERVED/CONSUMED aquí. Los productos con GTIN real siguen sin reserva.
--   La regla "si barcode LIKE 'POSINT-%' debe existir reserva válida" vive
--   en el handler Go: aquí no se declara FK ni trigger, porque un FK
--   parcial requeriría exclusión por predicado (no existe en Postgres) y un
--   trigger sumaría complejidad fuera del scope de esta migración.
--
-- - NO prohíbe el prefijo POSINT- en `label_codes.code`. Al contrario:
--   permitirlo (con la restricción de coherencia intra-fila descrita
--   arriba) es parte del contrato audit-first para productos internos.
--   La prohibición global que una versión anterior de esta migración
--   intentó introducir rompía el flujo: hacía imposible persistir el
--   label_code necesario para imprimir y auditar la etiqueta POSINT-X.
--
-- - NO ejecuta semillas ni backfill. Los códigos POSINT- se crean a demanda
--   desde el modal; la tabla arranca vacía.
--
-- - NO toca `products.barcode` existente. Ningún producto legacy usa el
--   namespace (es nuevo y distintivo); las CHECK constraints sobre
--   package_barcode_aliases/products.alternate_codes son compatibles con
--   todos los datos actuales. Si un ambiente de pruebas tiene un valor con
--   "POSINT-" ya hoy, la migración abortará: eso es un dato ensuciado y
--   debe limpiarse antes de aplicar. El CHECK de coherencia sobre
--   label_codes también valida filas existentes al aplicarse: si hay
--   alguna fila con `code LIKE 'POSINT-%'` y `product_barcode` nulo o
--   distinto, la migración falla con error legible — eso también es un
--   dato ensuciado y debe limpiarse antes de reaplicar.
--
-- TRANSACCIONAL: SÍ
-- ============================================================================
-- Esta migración NO usa CREATE INDEX CONCURRENTLY. Todo DDL corre dentro de
-- la transacción por defecto del runner, con rollback automático si algún
-- paso falla. Por eso NO se añade a la lista de excepciones transaccionales
-- en catalog.go (que hoy incluye 8, 9, 11, 13, 14, 15 y 18).
--
-- Agregar un CHECK a una tabla existente sí fuerza un scan completo de la
-- tabla para validar filas vigentes. En label_codes y package_barcode_aliases
-- es trivial (son tablas chicas que se poblaron desde la 016/017). En
-- products el scan es un match literal "position('POSINT-' in upper(...))":
-- O(n) sobre `alternate_codes` text, pero sin reindexación ni reescritura.
-- En una tienda real (decenas de miles de productos) corre en segundos y
-- es parte del precio documentado de aplicar la migración; por eso debe
-- ejecutarse en ventana aprobada con el API detenido como el resto.
--
-- NO MODIFICA DATOS DE NEGOCIO
-- ============================================================================
-- Puramente DDL: CREATE TABLE, CREATE INDEX, ALTER TABLE ADD CONSTRAINT y
-- COMMENT. Ni un UPDATE, ni un DELETE, ni un INSERT. Ninguna fila de
-- producto, label_code o alias de paquete se toca.
--
-- REVERSIBILIDAD (manual, con API detenido y respaldo)
-- ============================================================================
-- Si por alguna razón hay que deshacer esta migración después de aplicada,
-- la secuencia en una sola transacción (BEGIN/COMMIT) es:
--
--   1) ALTER TABLE products                DROP CONSTRAINT IF EXISTS
--        ck_products_alternate_codes_no_internal_namespace;
--   2) ALTER TABLE package_barcode_aliases DROP CONSTRAINT IF EXISTS
--        ck_pba_no_internal_namespace;
--   3) ALTER TABLE label_codes             DROP CONSTRAINT IF EXISTS
--        ck_label_codes_posint_matches_product_barcode;
--   4) DROP TABLE IF EXISTS internal_barcode_reservations;
--   5) Borrar la fila `version = 24` de `schema_migrations` para que el
--      runner no vuelva a validar su checksum. Un operador que ejecute
--      este rollback debe hacerlo manualmente con una sentencia DML
--      explícita; esta migración NO incluye el borrado para no violar la
--      regla "puramente DDL" del propio archivo.
--
-- Antes de deshacer, confirmar que ningún producto tiene barcode LIKE
-- 'POSINT-%'; si existen, perderían su rastro de reserva pero seguirían
-- siendo productos válidos. El rollback NO los borra. Las filas de
-- label_codes con code LIKE 'POSINT-%' tampoco se tocan: tras eliminar
-- el CHECK sobreviven y siguen resolviendo contra sus productos.

-- ----------------------------------------------------------------------------
-- 1) Tabla principal: reservas de códigos internos.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS internal_barcode_reservations (
    reserved_code              VARCHAR(64)   PRIMARY KEY,
    status                     VARCHAR(16)   NOT NULL DEFAULT 'RESERVED',
    source                     VARCHAR(16)   NOT NULL DEFAULT 'product_form',
    reserved_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    reserved_by_dni            VARCHAR(32)   NOT NULL,
    expires_at                 TIMESTAMPTZ,
    consumed_at                TIMESTAMPTZ,
    consumed_product_barcode   VARCHAR(64),
    consumed_by_dni            VARCHAR(32),
    note                       TEXT,
    CONSTRAINT ck_ibr_status_known
        CHECK (status IN ('RESERVED', 'CONSUMED', 'EXPIRED')),
    CONSTRAINT ck_ibr_source_known
        CHECK (source IN ('product_form', 'reception', 'other')),
    CONSTRAINT ck_ibr_namespace_shape
        CHECK (reserved_code ~ '^POSINT-[0-9A-F]{8,24}$'),
    CONSTRAINT ck_ibr_consumed_coherent
        CHECK (
            (status <> 'CONSUMED'
                AND consumed_at IS NULL
                AND consumed_product_barcode IS NULL
                AND consumed_by_dni IS NULL)
            OR
            (status = 'CONSUMED'
                AND consumed_at IS NOT NULL
                AND consumed_product_barcode IS NOT NULL
                AND consumed_by_dni IS NOT NULL)
        ),
    CONSTRAINT ck_ibr_expiry_after_reserved
        CHECK (expires_at IS NULL OR expires_at > reserved_at)
);

-- Hot path del handler al reservar: "busca reservas vivas por si expiró
-- alguna reciente del mismo DNI". El índice parcial restringe el B-tree
-- a filas RESERVED, que son las candidatas a vencer o a liberar; filas
-- CONSUMED/EXPIRED no se consultan por este camino.
CREATE INDEX IF NOT EXISTS ix_ibr_live_by_expiry
    ON internal_barcode_reservations (expires_at)
    WHERE status = 'RESERVED';

-- Auditoría "qué reservó cada operador".
CREATE INDEX IF NOT EXISTS ix_ibr_by_actor
    ON internal_barcode_reservations (reserved_by_dni, reserved_at DESC);

-- Al consumir: resolver el barcode del producto que tomó esta reserva es
-- cadena corta pero conviene índice parcial para evitar seq scan al listar
-- productos POSINT desde pantallas de auditoría.
CREATE INDEX IF NOT EXISTS ix_ibr_by_consumed_product
    ON internal_barcode_reservations (consumed_product_barcode)
    WHERE consumed_product_barcode IS NOT NULL;

COMMENT ON TABLE internal_barcode_reservations IS
    'Reservas atómicas de códigos internos POSINT-<hex> para productos sin GTIN físico. La PK sobre reserved_code garantiza que un mismo valor nunca se emita dos veces; status distingue RESERVED (pendiente de consumo), CONSUMED (ya es el barcode de un producto creado) y EXPIRED (abandonado por timeout). Ningún valor se borra: la unicidad vive para siempre vía la PK aun después de la expiración. La validación cruzada contra products.barcode, tokens de products.alternate_codes, label_codes.code y package_barcode_aliases.package_code la ejecuta el handler Go dentro de la transacción de reserva, igual que label_repository.codeExistsAnywhereTx (migración 016).';
COMMENT ON COLUMN internal_barcode_reservations.reserved_code IS
    'El código interno completo (prefijo + hex en mayúsculas). PK para garantizar unicidad absoluta aun ante reintentos simultáneos del generador. CHECK ck_ibr_namespace_shape fuerza el formato ^POSINT-[0-9A-F]{8,24}$ y empata con el strings.ToUpper que product_handler.go aplica a products.barcode.';
COMMENT ON COLUMN internal_barcode_reservations.status IS
    'RESERVED mientras el modal está abierto y el usuario aún no envió crear-producto. CONSUMED después de un INSERT exitoso en products: el handler marca atómicamente en la misma transacción (status=CONSUMED, consumed_at=NOW(), consumed_product_barcode=<barcode insertado>, consumed_by_dni=<actor>). EXPIRED lo escribe un job que recorre expires_at < NOW() y status=RESERVED; nunca borra la fila para preservar la unicidad del código.';
COMMENT ON COLUMN internal_barcode_reservations.source IS
    'Origen operativo: product_form (alta directa desde /products), reception (alta desde /inventory/receive), other (reservado para futuros flujos). Útil para medir qué pantalla usa más el namespace y para la auditoría.';
COMMENT ON COLUMN internal_barcode_reservations.reserved_by_dni IS
    'DNI del empleado que pidió la reserva. Lo escribe el handler desde la sesión; nunca lo manda el cliente libremente.';
COMMENT ON COLUMN internal_barcode_reservations.expires_at IS
    'Momento después del cual la reserva se considera abandonada. Opcional: si es NULL la reserva vive hasta ser consumida. El job que expira reservas usa el índice parcial ix_ibr_live_by_expiry; no libera el código (sigue reservado por la PK), sólo cambia el status a EXPIRED.';
COMMENT ON COLUMN internal_barcode_reservations.consumed_at IS
    'Momento del INSERT exitoso en products. CHECK ck_ibr_consumed_coherent exige que esté poblado si y sólo si status=CONSUMED.';
COMMENT ON COLUMN internal_barcode_reservations.consumed_product_barcode IS
    'products.barcode del producto que consumió esta reserva. Sin FK dura (patrón consistente con label_codes.product_barcode y cash_drawer_opens.sale_id en la migración 016): el POS tiene productos marcador [HISTORICO] y soft delete, y queremos preservar el audit aunque el producto se purgue físicamente.';
COMMENT ON COLUMN internal_barcode_reservations.consumed_by_dni IS
    'DNI del empleado que confirmó la creación del producto. Normalmente coincide con reserved_by_dni, pero puede diferir si otro operador toma el relevo en la misma pantalla.';
COMMENT ON COLUMN internal_barcode_reservations.note IS
    'Observación libre opcional del operador. Útil cuando una reserva se abandona a propósito ("probé pero el producto ya existía con otro código").';

-- ----------------------------------------------------------------------------
-- 2) Guardián cruzado: package_barcode_aliases.package_code no puede usar
--    el namespace interno.
--
--    Un alias de paquete representa un ENVOLTORIO de otro producto, con
--    units_per_pack > 1. Un código interno POSINT- siempre apunta a un
--    producto UNITARIO; mezclarlos sumaría stock a sí mismo multiplicado.
--
--    Se usa DO $$ porque Postgres no soporta `ADD CONSTRAINT IF NOT EXISTS`
--    y el runner debe poder reintentar la migración tras un fallo parcial
--    (igual patrón que la 018 para columnas; aquí para constraints).
-- ----------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_pba_no_internal_namespace'
    ) THEN
        ALTER TABLE package_barcode_aliases
            ADD CONSTRAINT ck_pba_no_internal_namespace
            CHECK (package_code !~* '^POSINT-');
    END IF;
END $$;

COMMENT ON CONSTRAINT ck_pba_no_internal_namespace ON package_barcode_aliases IS
    'Un alias de recepción (migración 017) representa el envoltorio exterior de otro producto con units_per_pack > 1. El namespace POSINT- se reserva para productos unitarios creados desde ProductFormModal (migración 024). Un paquete JAMÁS puede llevar un código POSINT-: lo haría sumar stock a sí mismo multiplicado.';

-- ----------------------------------------------------------------------------
-- 3) Guardián cruzado: products.alternate_codes (CSV) no puede contener el
--    namespace interno en ningún token.
--
--    alternate_codes es `text` con códigos separados por coma (ver
--    repositories/label_repository.go constante alternateCodesContainsSQL).
--    Permitir "POSINT-ABCD" como alias de un producto arbitrario rompería
--    la unicidad conceptual: dos productos (el "dueño" del código interno
--    y el que lo lleva como alias) serían escaneables como el mismo bien
--    en caja (buildProductLookup de sale_service.go).
--
--    El prefijo es tan distintivo (ninguna numeración comercial lo usa)
--    que un `position('POSINT-' in upper(alternate_codes)) = 0` no tiene
--    falsos positivos: no existe un alias legítimo que contenga la
--    subcadena "POSINT-" por casualidad. Más barato y más legible que un
--    regex con límites de token.
--
--    IMPACTO AL APLICAR: Postgres debe scanear products para validar la
--    nueva CHECK. Si existe cualquier fila con "POSINT-" en alternate_codes
--    (improbable: el namespace es nuevo), el ALTER TABLE aborta con error
--    legible y hay que limpiar esos datos antes de reaplicar la migración.
-- ----------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_products_alternate_codes_no_internal_namespace'
    ) THEN
        ALTER TABLE products
            ADD CONSTRAINT ck_products_alternate_codes_no_internal_namespace
            CHECK (
                alternate_codes IS NULL
                OR position('POSINT-' in upper(alternate_codes)) = 0
            );
    END IF;
END $$;

COMMENT ON CONSTRAINT ck_products_alternate_codes_no_internal_namespace ON products IS
    'El namespace POSINT- se reserva exclusivamente para products.barcode (código principal del producto) gestionado por internal_barcode_reservations (migración 024). Un alternate_code POSINT- escanearía en caja al producto equivocado vía buildProductLookup (sale_service.go). La validación "token exacto" cruzada vive en el handler Go; este CHECK blinda el camino a nivel BD.';

-- ----------------------------------------------------------------------------
-- 4) Coherencia intra-fila: label_codes POSINT- debe espejear product_barcode.
--
--    Para productos internos (barcode = POSINT-<hex>) el flujo audit-first
--    de LabelPrintSheet persiste una fila en label_codes donde
--    `code = product_barcode = POSINT-<hex>`. Al escanear la etiqueta
--    impresa, ResolveLabelCode (label_repository.go) hace JOIN
--    `products.barcode = label_codes.product_barcode` y resuelve al
--    producto correcto; eso sólo es confiable si la fila POSINT- tiene
--    los dos campos iguales y ambos poblados.
--
--    Los productos comerciales siguen usando `LC-<hex>` emitido por
--    generateUniqueCodeTx: `code` difiere de `product_barcode`, pero no
--    cae en la rama POSINT del CHECK y queda sin restricción extra.
--
--    La restricción es puramente INTRA-FILA (no referencia otras tablas,
--    no usa subquery). La garantía "ese POSINT-X también existe como
--    products.barcode" vive en el repositorio Go (EnsureCodeForProduct
--    y codeExistsAnywhereTx consultan products.barcode y validan contra
--    las cuatro fuentes). Un trigger cross-table sería estrictamente más
--    fuerte pero añadiría latencia y queda fuera del scope.
--
--    IMPACTO AL APLICAR: Postgres debe scanear label_codes para validar
--    la nueva CHECK. En una base limpia la tabla está vacía o casi; si
--    hay filas POSINT- previamente generadas sin product_barcode o con
--    product_barcode distinto (improbable, el flujo nunca lo permitió),
--    el ALTER TABLE aborta con error legible y hay que corregir esos
--    datos antes de reaplicar la migración.
-- ----------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_label_codes_posint_matches_product_barcode'
    ) THEN
        ALTER TABLE label_codes
            ADD CONSTRAINT ck_label_codes_posint_matches_product_barcode
            CHECK (
                code !~ '^POSINT-'
                OR (product_barcode IS NOT NULL AND product_barcode = code)
            );
    END IF;
END $$;

COMMENT ON CONSTRAINT ck_label_codes_posint_matches_product_barcode ON label_codes IS
    'Para filas con code en el namespace POSINT- (etiqueta de producto interno), product_barcode debe ser igual a code: la etiqueta impresa ES el barcode del producto, y ResolveLabelCode (label_repository.go) depende de esa igualdad para resolver al escanear. Los códigos comerciales LC-<hex> no caen en esta rama y quedan sin restricción adicional. La existencia del producto correspondiente (products.barcode = code) la garantiza el repositorio Go, no este CHECK: Postgres no admite subqueries en CHECK.';
