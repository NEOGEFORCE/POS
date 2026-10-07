-- Sprint 10: generador persistente de códigos únicos para rótulos y
-- auditoría dura del cajón de dinero.
--
-- POR QUÉ existe esta migración
-- ============================================================================
-- Esta migración existe exclusivamente para habilitar el punto 10 del sprint
-- del dueño: "sustituir Etiquetas por generador persistente de códigos únicos
-- con búsqueda, lector teclado, cámara, reimpresión, configuración de
-- impresora/tamaños y cajón que no abre sin venta salvo admin". Los otros
-- diez puntos (recepción fiscal, visuales de confirmar, aviso cross-supplier,
-- cierre con cero billetes, agenda del proveedor intocable, retiro de
-- invoice_ref, llegadas filtradas, recomendaciones por ciclo, "faltantes
-- pendientes" y reauth que vuelve a la ruta original) ya tienen el esquema
-- que necesitan o son puro trabajo de handler/servicio/UI; no fabricamos
-- tablas vacías para los que no requieren persistencia nueva.
--
-- 1) /labels era 100 % memoria.
--    Hoy (FrontPOS-main/src/app/(app)/labels/page.tsx) la pantalla toma
--    /products/paginated?pageSize=1000, acumula una `printQueue` en
--    React useState e imprime con window.print(). Al refrescar la pestaña
--    se pierde la cola, no hay histórico, no hay reimpresión, no hay
--    noción de "código interno" distinto del barcode del producto, y el
--    tamaño/impresora están hardcoded. El dueño pidió exactamente lo
--    contrario: generar un código único que persiste, buscarlo después
--    para reimprimirlo, configurar impresora y tamaño desde la UI, y
--    tener auditoría de qué se imprimió y por quién.
--
--    El `code` que vive en label_codes ES lo que se imprime: una cadena
--    propia del local, independiente de products.barcode. Esto permite
--    etiquetar granel, producción interna o lotes que no tienen barcode
--    de fábrica. La asociación con un producto queda en product_barcode
--    (opcional, sin FK dura: ver nota en la columna).
--
-- 2) El cajón de dinero no existía en el backend.
--    Toda la lógica de kickout vivía en el frontend/driver local; cualquier
--    operador podía abrir el cajón desde Postman sin dejar rastro. La
--    regla "no abrir sin venta salvo admin" era un chequeo UI,
--    bypasseable. Esta migración crea la tabla de auditoría; la
--    validación dura (403 CASH_DRAWER_REQUIRES_SALE_OR_ADMIN) la hará el
--    handler Go. El CHECK a nivel BD codifica el invariante mínimo:
--    toda apertura debe tener O una venta/devolución asociada O ser un
--    override admin.
--
-- QUÉ SE CREA
-- ============================================================================
-- Cinco tablas en snake_case, pensadas para que un model GORM nuevo las
-- cuelgue sin fricción (schemaModels() en migrations/catalog.go las
-- registrará cuando el backend añada los structs correspondientes; el
-- checksum de la versión 002 no cambia porque sólo cambia la lista de
-- modelos, no el payload SQL de las migraciones ya aplicadas):
--
--   - label_size_templates    plantillas de tamaño (ancho/alto/márgenes).
--   - label_printer_profiles  perfiles de impresora (protocolo, destino, cajón).
--   - label_codes             código interno único por rótulo, con print_count.
--   - label_print_jobs        historial de cada envío a imprimir (incluye
--                             reimpresos, con payload_json detallado).
--   - cash_drawer_opens       auditoría de cada apertura del cajón.
--
-- Más los índices de filtro frecuente: productos, fechas, autor.
--
-- QUÉ NO HACE
-- ============================================================================
-- - No elimina ni toca confirmed_orders.invoice_ref (punto 6 del sprint).
--   Esa columna todavía se usa aguas abajo (order_handler.go la expone
--   como "invoiceRef" y SendDeliverySummaryToTelegram la lee como override
--   del valor). Su retiro físico es un DROP COLUMN irreversible; primero
--   debe migrarse el handler, el servicio y el cron fuera de ese campo, y
--   después, en una migración futura (017+), eliminarla. Dropear la
--   columna ahora rompería el resumen de Telegram y perdería histórico
--   sin razón.
-- - No agrega filtros sobre confirmed_orders.expected_date para el punto 7
--   ("llegadas filtradas por fecha + retrasado/a tiempo"). Los datos ya
--   existen (expected_date TEXT YYYY-MM-DD, received_at TIMESTAMPTZ); el
--   trabajo pendiente es derivar arrivalStatus en el repositorio Go
--   (CASE WHEN received_at::date > expected_date → 'late'). Una tabla de
--   pedidos de este tamaño responde con seq scan sin problema; un índice
--   nuevo sería prematuro.
-- - No añade columna isCritical a cashier_closures (punto 4). El bloqueo
--   contra faltante sin autorización es una validación de servicio en
--   SaveClosure (if Difference < 0 && AuthorizedBy == "" → 403); la
--   columna authorized_by ya existe en el modelo CashierClosure.
-- - No introduce agenda universitaria ni FK missing_items → confirmed_order_items
--   (punto 9). El término "preguntas universitarias" no aparece en código
--   ni documentación del repo; antes de modelar algo hay que confirmar con
--   el usuario a qué se refiere.
--
-- TRANSACCIONAL: SÍ
-- ============================================================================
-- Esta migración NO usa CREATE INDEX CONCURRENTLY. Todo corre dentro de la
-- transacción por defecto del runner. Las tablas son nuevas, así que
-- ningún CREATE INDEX bloquea tablas calientes. Por eso catalog.go NO
-- añade la 016 a la lista de excepciones (que hoy incluye 8, 9, 11, 13,
-- 14 y 15).
--
-- NO MODIFICA DATOS DE NEGOCIO
-- ============================================================================
-- Puramente DDL: CREATE TABLE, CREATE INDEX y COMMENT. Ni un UPDATE, ni un
-- DELETE, ni un INSERT. Los posibles valores por defecto (plantilla "Default
-- 4x2.5 cm" y perfil "Impresora térmica POS 80") los inserta la pantalla
-- de configuración la primera vez que un admin la abre, no esta migración.
-- Hasta entonces las tablas están vacías y el frontend muestra los valores
-- predeterminados cliente sin tocar la BD.

-- ----------------------------------------------------------------------------
-- 1) label_size_templates: plantillas reutilizables de tamaño de etiqueta.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS label_size_templates (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(80)    NOT NULL,
    width_mm        NUMERIC(6,2)   NOT NULL CHECK (width_mm  > 0),
    height_mm       NUMERIC(6,2)   NOT NULL CHECK (height_mm > 0),
    margin_mm       NUMERIC(6,2)   NOT NULL DEFAULT 1.0 CHECK (margin_mm >= 0),
    columns_count   INTEGER        NOT NULL DEFAULT 1   CHECK (columns_count >= 1),
    dpi             INTEGER        NOT NULL DEFAULT 203 CHECK (dpi > 0),
    barcode_format  VARCHAR(16)    NOT NULL DEFAULT 'CODE128'
                        CHECK (barcode_format IN ('CODE128', 'EAN13', 'EAN8', 'QR')),
    show_name       BOOLEAN        NOT NULL DEFAULT TRUE,
    show_price      BOOLEAN        NOT NULL DEFAULT TRUE,
    is_default      BOOLEAN        NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_by_dni  VARCHAR(32)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_label_size_templates_name
    ON label_size_templates (name);

-- Sólo una plantilla puede ser "default" global. Índice parcial unique:
-- el B-tree sólo contiene filas con is_default=TRUE, así que la unicidad
-- fuerza como máximo una fila con esa marca sin impedir múltiples FALSE.
CREATE UNIQUE INDEX IF NOT EXISTS ux_label_size_templates_default
    ON label_size_templates (is_default)
    WHERE is_default;

COMMENT ON TABLE label_size_templates IS
    'Plantillas de tamaño de etiqueta administrables desde /labels/config. Admin only. Si no hay fila default, el frontend muestra una plantilla cliente sensata.';
COMMENT ON COLUMN label_size_templates.barcode_format IS
    'Formato gráfico que renderiza la plantilla. QR requiere área mayor que CODE128 para el mismo contenido; validarlo en el handler.';
COMMENT ON COLUMN label_size_templates.is_default IS
    'TRUE marca la plantilla usada automáticamente al generar un código sin plantilla explícita. Único (índice parcial ux_label_size_templates_default).';

-- ----------------------------------------------------------------------------
-- 2) label_printer_profiles: perfiles de impresora y bandera de cajón.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS label_printer_profiles (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(80)    NOT NULL,
    protocol            VARCHAR(16)    NOT NULL
                            CHECK (protocol IN ('escpos', 'tspl', 'zpl', 'pdf', 'system')),
    target              VARCHAR(255)   NOT NULL,
    roll_width_mm       NUMERIC(6,2),
    model               VARCHAR(80),
    drawer_connected    BOOLEAN        NOT NULL DEFAULT FALSE,
    is_default          BOOLEAN        NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_by_dni      VARCHAR(32)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_label_printer_profiles_name
    ON label_printer_profiles (name);

CREATE UNIQUE INDEX IF NOT EXISTS ux_label_printer_profiles_default
    ON label_printer_profiles (is_default)
    WHERE is_default;

COMMENT ON TABLE label_printer_profiles IS
    'Perfiles de impresora disponibles para rótulos y recibos. protocol/target los interpreta el servicio local de impresión (ESC/POS por USB, TSPL por red, PDF para pruebas).';
COMMENT ON COLUMN label_printer_profiles.target IS
    'Dirección física o lógica: nombre de impresora Windows, IP:puerto, path /dev/usb/lp0, etc. El esquema NO valida formato: cada protocolo tiene sintaxis distinta.';
COMMENT ON COLUMN label_printer_profiles.drawer_connected IS
    'Si TRUE, el cajón de dinero cuelga del puerto DK de esta impresora. El handler /cash-drawer/open envía el pulso de kickout por el mismo driver (ESC/POS: 0x1B 0x70 0x00 0x19 0xFA; TSPL: OPENCASHDRAWER).';

-- ----------------------------------------------------------------------------
-- 3) label_codes: el código único que efectivamente se imprime.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS label_codes (
    code              VARCHAR(64)   PRIMARY KEY,
    product_barcode   VARCHAR(64),
    size_template_id  INTEGER       REFERENCES label_size_templates(id) ON DELETE SET NULL,
    note              TEXT,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_by_dni    VARCHAR(32)   NOT NULL,
    last_printed_at   TIMESTAMPTZ,
    print_count       INTEGER       NOT NULL DEFAULT 0 CHECK (print_count >= 0),
    voided_at         TIMESTAMPTZ,
    voided_by_dni     VARCHAR(32),
    CONSTRAINT ck_label_codes_void_dni
        CHECK ((voided_at IS NULL) = (voided_by_dni IS NULL))
);

CREATE INDEX IF NOT EXISTS ix_label_codes_product
    ON label_codes (product_barcode)
    WHERE product_barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_label_codes_created_at
    ON label_codes (created_at DESC);

-- Búsqueda del historial reciente de impresión (reimprimir últimos N).
CREATE INDEX IF NOT EXISTS ix_label_codes_last_printed
    ON label_codes (last_printed_at DESC)
    WHERE last_printed_at IS NOT NULL;

COMMENT ON TABLE label_codes IS
    'Códigos internos únicos generados por /labels. El valor `code` ES lo que se imprime en la etiqueta; es distinto de products.barcode y persiste aun si el producto se renombra o se da de baja.';
COMMENT ON COLUMN label_codes.product_barcode IS
    'Barcode del producto asociado al generar el código, si lo hay. NO lleva FK dura: el POS tiene productos marcador [HISTORICO]<codigo> (ver OPERATIONS.md) y productos con soft delete; una restricción dura rompería la generación en bordes conocidos. El handler valida colisión contra products.barcode al crear el código.';
COMMENT ON COLUMN label_codes.voided_at IS
    'Marcar un código como anulado NO lo destruye: lo deshabilita para reimpresión. Preservamos el histórico porque la etiqueta ya puede estar físicamente pegada en mercancía y necesitamos poder explicar cuándo apareció.';
COMMENT ON COLUMN label_codes.print_count IS
    'Veces que el código se imprimió (incluye reimpresos). El handler lo incrementa en el mismo update que setea last_printed_at.';

-- ----------------------------------------------------------------------------
-- 4) label_print_jobs: historial de envíos a impresora (incluye reimpresos).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS label_print_jobs (
    id                  BIGSERIAL PRIMARY KEY,
    created_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    created_by_dni      VARCHAR(32)    NOT NULL,
    printer_profile_id  INTEGER        REFERENCES label_printer_profiles(id) ON DELETE SET NULL,
    size_template_id    INTEGER        REFERENCES label_size_templates(id)   ON DELETE SET NULL,
    trigger_source      VARCHAR(16)    NOT NULL DEFAULT 'new'
                            CHECK (trigger_source IN ('new', 'reprint', 'bulk')),
    label_count         INTEGER        NOT NULL DEFAULT 0 CHECK (label_count >= 0),
    status              VARCHAR(16)    NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued', 'printed', 'failed', 'cancelled')),
    error               TEXT,
    payload_json        JSONB          NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_label_print_jobs_created_at
    ON label_print_jobs (created_at DESC);

CREATE INDEX IF NOT EXISTS ix_label_print_jobs_author_date
    ON label_print_jobs (created_by_dni, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_label_print_jobs_status
    ON label_print_jobs (status)
    WHERE status IN ('queued', 'failed');

COMMENT ON TABLE label_print_jobs IS
    'Un registro por envío a impresora. Un reimpreso genera una fila nueva con trigger_source=reprint; el payload_json contiene la lista [{code, quantity}] enviada, para poder reproducir exactamente el lote si hace falta.';
COMMENT ON COLUMN label_print_jobs.payload_json IS
    'Snapshot del lote enviado: `{"items":[{"code":"...","quantity":N},...],"meta":{...}}`. Es la fuente para la reimpresión fiel: un reprint lee este JSON, no reconstruye desde label_codes.';
COMMENT ON COLUMN label_print_jobs.status IS
    'queued = enviado al servicio local, aún sin confirmación; printed = ACK OK; failed = error reportado (ver columna error); cancelled = el operador abortó antes de imprimirse.';

-- ----------------------------------------------------------------------------
-- 5) cash_drawer_opens: auditoría del cajón de dinero.
--
-- La regla operativa es "no abrir sin venta salvo admin". A nivel BD
-- codificamos el mínimo: toda apertura declara O una venta, O una
-- devolución, O que fue un override admin autorizado. La validación de
-- rol, token admin y vigencia de la venta (últimos 60 s, mismo cajero)
-- es responsabilidad del handler Go.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cash_drawer_opens (
    id                  BIGSERIAL PRIMARY KEY,
    opened_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    actor_dni           VARCHAR(32)   NOT NULL,
    reason              VARCHAR(16)   NOT NULL
                            CHECK (reason IN ('sale', 'return', 'admin_override', 'other')),
    sale_id             INTEGER,
    return_id           INTEGER,
    override_admin      BOOLEAN       NOT NULL DEFAULT FALSE,
    authorized_by_dni   VARCHAR(32),
    note                TEXT,
    printer_profile_id  INTEGER       REFERENCES label_printer_profiles(id) ON DELETE SET NULL,
    CONSTRAINT ck_cash_drawer_opens_sale_or_admin
        CHECK (
            override_admin
            OR sale_id   IS NOT NULL
            OR return_id IS NOT NULL
        ),
    CONSTRAINT ck_cash_drawer_opens_override_requires_authorizer
        CHECK (NOT override_admin OR authorized_by_dni IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_cash_drawer_opens_opened_at
    ON cash_drawer_opens (opened_at DESC);

CREATE INDEX IF NOT EXISTS ix_cash_drawer_opens_actor_date
    ON cash_drawer_opens (actor_dni, opened_at DESC);

CREATE INDEX IF NOT EXISTS ix_cash_drawer_opens_sale
    ON cash_drawer_opens (sale_id)
    WHERE sale_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_cash_drawer_opens_override
    ON cash_drawer_opens (opened_at DESC)
    WHERE override_admin;

COMMENT ON TABLE cash_drawer_opens IS
    'Auditoría de cada apertura del cajón de dinero. La regla "no abrir sin venta salvo admin" se expresa en el CHECK ck_cash_drawer_opens_sale_or_admin.';
COMMENT ON COLUMN cash_drawer_opens.sale_id IS
    'Venta POS que gatilló la apertura. NO lleva FK dura porque sales.id usa soft delete; queremos conservar el audit aun si la venta se da de baja.';
COMMENT ON COLUMN cash_drawer_opens.override_admin IS
    'TRUE sólo si un admin autorizó la apertura sin venta/devolución asociada. Requiere llenar authorized_by_dni (CHECK ck_cash_drawer_opens_override_requires_authorizer) y es recomendable llenar `note` con el motivo.';
COMMENT ON COLUMN cash_drawer_opens.printer_profile_id IS
    'Perfil de impresora por el que viajó el pulso de kickout (si el cajón cuelga de una térmica). NULL si la apertura fue manual o por un driver externo.';
