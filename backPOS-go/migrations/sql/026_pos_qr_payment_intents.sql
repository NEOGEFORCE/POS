-- Sprint pagos QR Bold / Bre-B: módulo de cobro con QR estático "0 %"
-- para Supermercado Surtifamiliar (titular Sebastian Sarmiento, código
-- de comercio Bre-B 0093097755). Intención PENDIENTE con TTL de 5 min,
-- aprobación por webhook oficial Bold (SALE_APPROVED firmado
-- HMAC-SHA256 por x-bold-signature cuando BOLD_SECRET_KEY está
-- configurado) o por puente MacroDroid con token BOLD_BRIDGE_TOKEN que
-- extrae COP de notificaciones push ("Recibiste $45.800"), y
-- confirmación manual auditada por DNI cuando el match por monto exacto
-- es 0 o ambiguo.
--
-- POR QUÉ existe esta migración
-- ============================================================================
-- Hoy el POS registra cobros con transferSource ∈ {nequi, daviplata,
-- otra} marcando la venta pagada sobre la fe del cajero, que recibe el
-- comprobante Bre-B/Nequi/DaviPlata en su celular. Problemas repetidos
-- en campo:
--
--   1) FALSAS APROBACIONES.
--      El cliente dice "ya te mandé", el cajero cierra la venta sin
--      verificar y 30 minutos después se descubre que no entró plata.
--      No hay registro de la intención de cobro ni correlación con el
--      movimiento recibido, así que la auditoría llega demasiado tarde.
--
--   2) PUENTE MACRODROID SIN AUDIT.
--      El dueño ya tiene un MacroDroid que lee notificaciones push de
--      Nequi/DaviPlata/Bancolombia y las puede POSTear a un endpoint
--      HTTP local. Hoy esas señales no existen contra el POS: la
--      "aprobación" vive en el WhatsApp del dueño y nadie puede
--      responder "¿se cobró la venta 123 de las 14:35?".
--
--   3) BOLD "0 %" OFICIAL.
--      Bold Colombia ofrece QR estático Bre-B al 0 % de comisión con
--      webhook SALE_APPROVED firmado (HMAC-SHA256 por x-bold-signature).
--      El payload trae data.bold_code (identificador único canónico),
--      data.amount.total, moneda y timestamp. Sin persistencia en el
--      POS ese webhook llega, el handler ACKea 200 y se olvida.
--
-- Esta migración instala el esquema MÍNIMO para dos cosas:
--
--   (a) Intención de cobro durable: el cajero inicia la intención
--       (POST /api/pos/pagos-qr/iniciar), el POS la guarda PENDIENTE y
--       el frontend muestra el modal ModalPagoBoldQR con el QR
--       estático. La BD es la autoridad del estado; la memoria del
--       handler (sync.RWMutex + canales SSE para GET
--       /api/pos/pagos-qr/stream) es sólo caché/notificación. Al
--       arrancar, el servicio recupera las intenciones PENDIENTES
--       vigentes desde esta tabla y repopula el mapa en memoria; la
--       DB no se puede re-sincronizar desde la memoria pero la
--       memoria sí se puede reconstruir desde la DB.
--
--   (b) Eventos de webhook idempotentes: ambos endpoints públicos
--       (/api/webhooks/bold y /api/webhooks/bold-notificacion)
--       escriben UNA FILA por evento con dedupe doble (external_id
--       canónico Bold + fingerprint para el bridge MacroDroid con
--       ventana de replay). Si el match por monto exacto en los
--       próximos 5 min devuelve 0 o >1 pendientes, la fila queda
--       registrada como UNMATCHED/AMBIGUOUS y NO aprueba
--       automáticamente ninguna intención (regla "prefiere falso
--       negativo/manual antes que doble aprobación"). El cajero
--       entonces usa POST /api/pos/pagos-qr/confirmar-manual con
--       autoría DNI explícita, que queda auditada en esta misma
--       tabla y en audit_logs vía el handler Go.
--
-- QUÉ CREA
-- ============================================================================
-- 1) `pos_qr_payment_intents`  intención durable con máquina de 5
--                              estados (PENDIENTE, APROBADA,
--                              CONFIRMADA_MANUAL, EXPIRADA, CANCELADA),
--                              amount_cop BIGINT, expires_at TTL,
--                              approved_source y approved_reference
--                              para dejar persistida la "referencia y
--                              hora" que pide la UX.
--
-- 2) `pos_qr_webhook_events`   evento recibido (BOLD_OFFICIAL o
--                              BRIDGE_NOTIFICATION) con dedupe por
--                              external_id (bold_code) y fingerprint
--                              (replay MacroDroid), estado procesado
--                              (PENDING/APPROVED/UNMATCHED/AMBIGUOUS/
--                              DUPLICATE/INVALID) y matched_intent_id
--                              cuando el match es exacto.
--
-- Más los índices parciales que el hot path necesita:
--   - UNIQUE parcial venta_temp_id vigente (una intención viva por
--     venta temporal del front, evita duplicados cuando el modal se
--     reabre antes de cancelar);
--   - lookup por monto exacto en PENDIENTES vigentes (hot path del
--     webhook);
--   - barrido de expiración por intención;
--   - histórico/auditoría por caja/cajero/fecha;
--   - dedupe canónico oficial (source, external_id);
--   - dedupe por replay fingerprint (source, fingerprint).
--
-- QUÉ NO HACE
-- ============================================================================
-- - NO almacena el token BOLD_BRIDGE_TOKEN ni la firma x-bold-signature:
--   el handler los valida en memoria contra la variable de entorno y
--   los descarta. Persistirlos no ayuda a nada y abre riesgo de fuga
--   si el dump se comparte. El fingerprint se persiste pero NO incluye
--   el token: es un hash del origen + monto + bucket temporal.
--
-- - NO guarda el payload crudo (titulo, mensaje, data.amount.total raw,
--   data.bold_code completo, data.* restante). El esquema persiste SÓLO
--   los campos normalizados que el POS necesita para auditar y
--   correlacionar: amount_cop (BIGINT COP enteros, nunca float),
--   external_id (bold_code recortado a 128 chars), source, event_type
--   normalizado y fingerprint. Si una investigación futura requiere el
--   payload crudo, debe venir del log del servidor rotado, no de esta
--   tabla; esta tabla NO es un sumidero de ingesta ni un log aplicativo.
--
-- - NO vincula FK dura a sales.saleId. Primero porque la venta aún no
--   existe cuando se emite la intención (la venta nace del cierre del
--   modal, exactamente una vez, tras la aprobación); segundo porque
--   sales usa soft delete y una FK dura rompería la auditoría de
--   intenciones huérfanas por anulaciones legítimas. La correlación
--   opcional queda como columna `related_sale_id BIGINT NULL` sin
--   REFERENCES, igual que cash_drawer_opens.sale_id en la 016.
--
-- - NO modela el QR gráfico ni la cuenta Bold. El QR estático que el
--   cliente escanea vive como recurso estático
--   (FrontPOS-main/public/qr-bold-breb.png) y el titular/código del
--   comercio están hard-coded en el frontend porque son estables del
--   local (Sebastian Sarmiento / 0093097755). Esta migración NO guarda
--   credenciales, llaves ni metadatos de la cuenta Bre-B.
--
-- - NO modifica tablas existentes. No agrega columnas a sales,
--   employees, audit_logs ni a ninguna otra. La auditoría de la
--   confirmación manual se registra en audit_logs vía el handler Go
--   (como el resto de acciones críticas); esta migración expone los
--   campos de autoría dentro de las dos tablas nuevas para que la
--   trazabilidad quede evidente en pg_dump --schema-only sin tener
--   que hacer joins contra audit_logs.
--
-- - NO introduce AMBIGUA en el repertorio de la intención. Si llega un
--   webhook y hay >1 PENDIENTES al mismo monto, la intención sigue
--   PENDIENTE (ningún estado terminal), y el EVENTO queda como
--   AMBIGUOUS. La ambigüedad vive en el evento, no en la intención;
--   así, cuando el cajero resuelve la ambigüedad por confirmar-manual,
--   sólo transita una intención a CONFIRMADA_MANUAL y las otras siguen
--   PENDIENTES hasta expirar o ser canceladas.
--
-- TRANSACCIONAL: SÍ
-- ============================================================================
-- Esta migración NO usa CREATE INDEX CONCURRENTLY. Las dos tablas nacen
-- vacías; los índices se construyen instantáneamente dentro de la
-- transacción del runner. Por eso catalog.go NO añade la 026 a la lista
-- de excepciones no transaccionales (hoy 8, 9, 11, 13, 14, 15 y 18).
-- PostgreSQL prohíbe CONCURRENTLY dentro de una transacción; mantener
-- la 026 transaccional nos da rollback automático si algún paso falla.
--
-- NO MODIFICA DATOS DE NEGOCIO
-- ============================================================================
-- Puramente DDL: CREATE TABLE, CREATE INDEX, ALTER TABLE ADD CONSTRAINT
-- (vía DO $$ para la FK retro de intents→events), y COMMENT. Ni un
-- UPDATE, ni un DELETE, ni un INSERT. No hay backfill: antes de la 026
-- el POS no registraba intenciones ni eventos QR, así que no hay dato
-- legado que recuperar.
--
-- REVERSIBILIDAD (manual, con API detenido y respaldo)
-- ============================================================================
-- Si hubiera que deshacer la 026 después de aplicada, en una sola
-- transacción (BEGIN/COMMIT):
--
--   1) ALTER TABLE pos_qr_payment_intents
--        DROP CONSTRAINT IF EXISTS fk_pqpi_approved_event;
--   2) DROP TABLE IF EXISTS pos_qr_webhook_events;
--   3) DROP TABLE IF EXISTS pos_qr_payment_intents;
--   4) Borrar la fila `version = 26` de `schema_migrations` para que el
--      runner no vuelva a validar su checksum. Un operador que ejecute
--      este rollback debe hacerlo manualmente con una sentencia DML
--      explícita; esta migración NO incluye el borrado para no violar
--      la regla "puramente DDL" del propio archivo.
--
-- Si la tabla ya tiene filas de producción vigentes, el DROP las
-- pierde definitivamente: no hay rollback automático porque borrar
-- este módulo también borra la autoridad de "cuál intención aprobó
-- cuál evento", y esa decisión no es DDL sino operativa.

-- ============================================================================
-- 1) pos_qr_payment_intents: intención durable con máquina de estados.
-- ============================================================================
--
-- amount_cop vive en BIGINT porque el handler lo recibe como int64 por
-- contrato explícito del dueño (POST /api/pos/pagos-qr/iniciar con
-- {caja_id, monto:int64, venta_temp_id}). BIGINT evita las
-- imprecisiones acumuladas que tendría NUMERIC(14,2) sobre pesos
-- colombianos (que no usan centavos en el flujo QR) y rechaza
-- silenciosamente a un cliente que mande 45800.0: el bind Go a int64
-- fallaría antes de llegar a Postgres. CHECK amount_cop > 0 impide
-- montos cero o negativos aun si el handler se olvidara de validar.
--
-- status pasa por 5 valores legales:
--   - PENDIENTE: emitida, aún matchable por webhook o confirmable
--     manualmente. Es el único estado "vivo" para el matcher.
--   - APROBADA: webhook (BOLD_OFFICIAL o BRIDGE_NOTIFICATION) confirmó
--     un match EXACTO por monto en los 5 min; approved_source,
--     approved_reference y approved_event_id poblados. Terminal.
--   - CONFIRMADA_MANUAL: el cajero/admin confirmó a mano con DNI
--     auditor cuando el match automático era 0 o ambiguo;
--     approved_source='MANUAL' y manual_confirmed_by_dni poblado.
--     Terminal.
--   - EXPIRADA: pasó expires_at sin match y sin confirmar. Terminal.
--   - CANCELADA: el cajero cambió de método; cancelled_at y
--     cancelled_by_dni poblados. Terminal.
--
-- Las transiciones legales (sólo PENDIENTE → cualquiera de las 4
-- terminales, nunca al revés, nunca entre terminales) vive en el
-- service con transacciones SELECT ... FOR UPDATE sobre la fila del
-- intent para evitar race conditions entre el webhook, el barredor de
-- expiración y la cancelación manual. La BD codifica el invariante
-- de coherencia por CHECK; esto no reemplaza la lógica de servicio,
-- es defensa en profundidad.

CREATE TABLE IF NOT EXISTS pos_qr_payment_intents (
    id                        BIGSERIAL     PRIMARY KEY,
    venta_temp_id             VARCHAR(80)   NOT NULL,
    caja_id                   VARCHAR(64)   NOT NULL,
    created_by_dni            VARCHAR(32)   NOT NULL,
    amount_cop                BIGINT        NOT NULL,
    status                    VARCHAR(24)   NOT NULL DEFAULT 'PENDIENTE',
    created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    expires_at                TIMESTAMPTZ   NOT NULL,
    approved_at               TIMESTAMPTZ,
    approved_source           VARCHAR(24),
    approved_reference        VARCHAR(128),
    approved_event_id         BIGINT,
    cancelled_at              TIMESTAMPTZ,
    cancelled_by_dni          VARCHAR(32),
    cancel_reason             VARCHAR(64),
    manual_confirmed_by_dni   VARCHAR(32),
    manual_confirmed_note     TEXT,
    related_sale_id           BIGINT,
    CONSTRAINT ck_pqpi_amount_positive
        CHECK (amount_cop > 0),
    CONSTRAINT ck_pqpi_status_known
        CHECK (status IN ('PENDIENTE', 'APROBADA', 'CONFIRMADA_MANUAL', 'EXPIRADA', 'CANCELADA')),
    CONSTRAINT ck_pqpi_approved_source_known
        CHECK (
            approved_source IS NULL
            OR approved_source IN ('BOLD_OFFICIAL', 'BRIDGE_NOTIFICATION', 'MANUAL')
        ),
    CONSTRAINT ck_pqpi_expires_after_created
        CHECK (expires_at > created_at),
    CONSTRAINT ck_pqpi_approval_coherent
        CHECK (
            (status = 'APROBADA'
                AND approved_at IS NOT NULL
                AND approved_reference IS NOT NULL
                AND approved_event_id IS NOT NULL
                AND approved_source IN ('BOLD_OFFICIAL', 'BRIDGE_NOTIFICATION')
                AND manual_confirmed_by_dni IS NULL
                AND manual_confirmed_note IS NULL)
            OR
            (status = 'CONFIRMADA_MANUAL'
                AND approved_at IS NOT NULL
                AND approved_reference IS NOT NULL
                AND approved_source = 'MANUAL'
                AND approved_event_id IS NULL
                AND manual_confirmed_by_dni IS NOT NULL)
            OR
            (status IN ('PENDIENTE', 'EXPIRADA', 'CANCELADA')
                AND approved_at IS NULL
                AND approved_source IS NULL
                AND approved_reference IS NULL
                AND approved_event_id IS NULL
                AND manual_confirmed_by_dni IS NULL
                AND manual_confirmed_note IS NULL)
        ),
    CONSTRAINT ck_pqpi_cancelled_coherent
        CHECK (
            (status = 'CANCELADA'
                AND cancelled_at IS NOT NULL
                AND cancelled_by_dni IS NOT NULL)
            OR
            (status <> 'CANCELADA'
                AND cancelled_at IS NULL
                AND cancelled_by_dni IS NULL
                AND cancel_reason IS NULL)
        )
);

-- UNIQUE parcial sobre venta_temp_id en PENDIENTES vivas: una sola
-- intención viva por venta temporal del front. Si el cliente reabre
-- el modal sin cancelar la intención anterior, el handler debe
-- CANCELADA-earla primero (lo que saca la fila del índice parcial y
-- libera el slot). Evita duplicados por doble clic/double submit del
-- cajero.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pqpi_live_by_venta_temp
    ON pos_qr_payment_intents (venta_temp_id)
    WHERE status = 'PENDIENTE';

-- Hot path del webhook: busca PENDIENTES por monto exacto vigente. El
-- orden expires_at ASC permite al handler decidir determinísticamente
-- cuántas candidatas hay (0, 1 o >1) y aplicar la regla "sólo aprobar
-- cuando hay exactamente 1". La condición "vigente" (expires_at >
-- NOW()) la añade la query, no el índice, para no reindexar a cada
-- segundo que pasa.
CREATE INDEX IF NOT EXISTS ix_pqpi_match_by_amount_live
    ON pos_qr_payment_intents (amount_cop, expires_at)
    WHERE status = 'PENDIENTE';

-- Barredor de expiración: recorre PENDIENTES cuyo expires_at ya pasó
-- para pasarlas a EXPIRADA. Parcial para que el B-tree no crezca con
-- filas terminales.
CREATE INDEX IF NOT EXISTS ix_pqpi_expiry_pending
    ON pos_qr_payment_intents (expires_at)
    WHERE status = 'PENDIENTE';

-- Auditoría / listado por cajero y por caja.
CREATE INDEX IF NOT EXISTS ix_pqpi_actor_created
    ON pos_qr_payment_intents (created_by_dni, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_pqpi_caja_created
    ON pos_qr_payment_intents (caja_id, created_at DESC);

-- Listado administrativo general del dashboard de pagos QR.
CREATE INDEX IF NOT EXISTS ix_pqpi_created_desc
    ON pos_qr_payment_intents (created_at DESC);

-- Soporte para la FK retro approved_event_id → pos_qr_webhook_events.id.
-- Postgres NO crea índice automático sobre la columna que referencia;
-- este índice evita escaneos secuenciales cuando se evalúa ON DELETE
-- RESTRICT sobre pos_qr_webhook_events.
CREATE INDEX IF NOT EXISTS ix_pqpi_approved_event
    ON pos_qr_payment_intents (approved_event_id)
    WHERE approved_event_id IS NOT NULL;

COMMENT ON TABLE pos_qr_payment_intents IS
    'Intenciones de cobro QR Bold/Bre-B para Supermercado Surtifamiliar. Autoridad durable del estado del cobro: PENDIENTE → {APROBADA | CONFIRMADA_MANUAL | EXPIRADA | CANCELADA}. El webhook oficial Bold (BOLD_OFFICIAL, data.bold_code firmado HMAC-SHA256) y el puente MacroDroid (BRIDGE_NOTIFICATION, token BOLD_BRIDGE_TOKEN) sólo aprueban automáticamente si hay EXACTAMENTE 1 PENDIENTE al mismo monto en los próximos 5 min; si hay 0 o >1, la intención queda PENDIENTE y el evento queda UNMATCHED/AMBIGUOUS, forzando confirmación manual auditada con DNI vía POST /api/pos/pagos-qr/confirmar-manual.';
COMMENT ON COLUMN pos_qr_payment_intents.venta_temp_id IS
    'Identificador de venta temporal provisto por el frontend al llamar POST /api/pos/pagos-qr/iniciar. Se mantiene durante toda la sesión del modal ModalPagoBoldQR; el UNIQUE parcial ux_pqpi_live_by_venta_temp garantiza una sola intención viva por venta_temp_id, evitando duplicados por doble clic.';
COMMENT ON COLUMN pos_qr_payment_intents.caja_id IS
    'Identificador de la caja/terminal del POS. Permite segmentar auditoría cuando hay varias cajas abiertas simultáneamente.';
COMMENT ON COLUMN pos_qr_payment_intents.amount_cop IS
    'Monto exacto en pesos colombianos (COP), BIGINT. El dueño pidió int64 explícitamente para evitar imprecisiones de float en montos tipo "Recibiste $45.800". El match contra el webhook es por igualdad exacta (amount_cop = evento.amount_cop); sin tolerancia, porque el cliente digita el monto exacto en su app.';
COMMENT ON COLUMN pos_qr_payment_intents.status IS
    'Máquina de 5 estados. PENDIENTE es el único estado "vivo" para el matcher. CONFIRMADA_MANUAL implica approved_source=MANUAL y manual_confirmed_by_dni poblado (auditoría manual con DNI del admin/cajero autorizado).';
COMMENT ON COLUMN pos_qr_payment_intents.expires_at IS
    'Momento después del cual la intención deja de ser matchable. El handler lo setea típicamente a NOW()+5min (TTL de 5 minutos pedido por el dueño); el barredor de expiración (ix_pqpi_expiry_pending) y el matcher en línea mueven la fila a EXPIRADA.';
COMMENT ON COLUMN pos_qr_payment_intents.approved_source IS
    'Fuente de la aprobación: BOLD_OFFICIAL (webhook oficial Bold firmado por x-bold-signature con BOLD_SECRET_KEY), BRIDGE_NOTIFICATION (puente MacroDroid con token BOLD_BRIDGE_TOKEN que leyó notificación push) o MANUAL (POST /api/pos/pagos-qr/confirmar-manual con DNI auditor). NULL mientras status esté en PENDIENTE/EXPIRADA/CANCELADA.';
COMMENT ON COLUMN pos_qr_payment_intents.approved_reference IS
    'Referencia textual que acompaña la aprobación: bold_code para BOLD_OFFICIAL, fingerprint corto o resumen de la notificación para BRIDGE_NOTIFICATION, nota opcional para MANUAL. Lo que la UX muestra como "comprobante #".';
COMMENT ON COLUMN pos_qr_payment_intents.approved_event_id IS
    'FK soft (RESTRICT) al evento del webhook que aprobó esta intención. NULL para CONFIRMADA_MANUAL (no hay evento) y para PENDIENTE/EXPIRADA/CANCELADA. La biyección exacta la impone ck_pqpi_approval_coherent.';
COMMENT ON COLUMN pos_qr_payment_intents.manual_confirmed_by_dni IS
    'DNI del empleado que confirmó manualmente cuando el match automático era 0 o ambiguo. Obligatorio cuando status=CONFIRMADA_MANUAL; NULL en cualquier otro estado. La auditoría cruzada vive también en audit_logs vía el handler Go.';
COMMENT ON COLUMN pos_qr_payment_intents.related_sale_id IS
    'Referencia blanda a sales.saleId cuando el service la rellena post-cierre. NO lleva FK dura: sales usa soft delete y una restricción dura rompería la auditoría de intenciones huérfanas por anulaciones legítimas. Mismo patrón que cash_drawer_opens.sale_id en la migración 016.';

-- ============================================================================
-- 2) pos_qr_webhook_events: eventos recibidos con dedupe doble.
-- ============================================================================
--
-- source distingue el origen del evento:
--   - BOLD_OFFICIAL: POST /api/webhooks/bold firmado HMAC-SHA256 por
--     x-bold-signature cuando BOLD_SECRET_KEY está configurado; el
--     payload trae data.bold_code (único, canónico), data.amount.total
--     y event_type (SALE_APPROVED, SALE_REJECTED, etc.). external_id
--     se puebla con data.bold_code.
--   - BRIDGE_NOTIFICATION: POST /api/webhooks/bold-notificacion con
--     body {titulo, mensaje, token}; token se valida contra
--     BOLD_BRIDGE_TOKEN en memoria, el handler extrae el monto COP
--     del mensaje tipo "Recibiste $45.800" por regex. external_id
--     queda NULL (MacroDroid no entrega id canónico); el dedupe se
--     apoya sólo en fingerprint.
--
-- external_id es el identificador canónico cuando lo hay (bold_code
-- oficial). UNIQUE parcial (source, external_id) WHERE external_id
-- IS NOT NULL evita doble procesamiento de un replay del webhook
-- oficial: si Bold reintenta porque nuestro ACK se perdió, el segundo
-- INSERT viola la UNIQUE y el handler responde 200 OK como
-- idempotente.
--
-- fingerprint es un hash determinístico calculado por el handler como
--   sha256(source + "|" + amount_cop + "|" + bucket_de_tiempo)
-- donde bucket_de_tiempo es received_at redondeado a una ventana de
-- replay corta (p. ej. 60 s). Dos notificaciones literalmente
-- idénticas que llegan en el mismo bucket colisionan y la UNIQUE
-- (source, fingerprint) rechaza la segunda. Para el oficial, el
-- fingerprint se construye desde bold_code y es trivialmente único.
--
-- Semántica deliberada: si dos pagos LEGÍTIMOS por el mismo monto
-- caen en el mismo bucket desde el bridge, el segundo es rechazado
-- (falso negativo) y el cajero debe usar confirmar-manual. Esto
-- cumple el requisito explícito del dueño: "prefiera falso negativo
-- /manual antes que doble aprobación". La UX degradada aquí es
-- preferible a cobrar dos veces por error.

CREATE TABLE IF NOT EXISTS pos_qr_webhook_events (
    id                 BIGSERIAL     PRIMARY KEY,
    received_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    source             VARCHAR(24)   NOT NULL,
    event_type         VARCHAR(32),
    external_id        VARCHAR(128),
    fingerprint        VARCHAR(128)  NOT NULL,
    amount_cop         BIGINT        NOT NULL,
    processed_at       TIMESTAMPTZ,
    processed_status   VARCHAR(24)   NOT NULL DEFAULT 'PENDING',
    matched_intent_id  BIGINT,
    note               VARCHAR(255),
    CONSTRAINT ck_pqwe_source_known
        CHECK (source IN ('BOLD_OFFICIAL', 'BRIDGE_NOTIFICATION')),
    CONSTRAINT ck_pqwe_processed_status_known
        CHECK (processed_status IN ('PENDING', 'APPROVED', 'UNMATCHED', 'AMBIGUOUS', 'DUPLICATE', 'INVALID')),
    CONSTRAINT ck_pqwe_amount_positive
        CHECK (amount_cop > 0),
    CONSTRAINT ck_pqwe_fingerprint_nonempty
        CHECK (char_length(fingerprint) >= 8 AND char_length(fingerprint) <= 128),
    CONSTRAINT ck_pqwe_external_id_shape
        CHECK (external_id IS NULL OR (char_length(external_id) >= 1 AND char_length(external_id) <= 128)),
    CONSTRAINT ck_pqwe_matched_only_if_approved
        CHECK (
            (processed_status = 'APPROVED'
                AND matched_intent_id IS NOT NULL
                AND processed_at IS NOT NULL)
            OR
            (processed_status <> 'APPROVED'
                AND matched_intent_id IS NULL)
        ),
    CONSTRAINT fk_pqwe_matched_intent
        FOREIGN KEY (matched_intent_id)
        REFERENCES pos_qr_payment_intents(id)
        ON DELETE RESTRICT
);

-- Dedupe canónico Bold: el bold_code viaja en external_id y es único
-- por origen. Un replay del mismo webhook con el mismo bold_code es
-- rechazado por la UNIQUE y el handler responde 200 OK (idempotente).
-- Parcial porque el bridge MacroDroid no entrega bold_code.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pqwe_source_external_id
    ON pos_qr_webhook_events (source, external_id)
    WHERE external_id IS NOT NULL;

-- Dedupe por replay fingerprint: cada evento tiene fingerprint
-- obligatorio. UNIQUE (source, fingerprint) evita doble aprobación
-- aun si el bridge reintenta antes del ACK. Para el oficial, el
-- fingerprint se construye desde bold_code; para el bridge, incluye
-- bucket temporal corto. Un pago legítimo distinto en el mismo
-- bucket colisiona (falso negativo) y requiere confirmar-manual.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pqwe_source_fingerprint
    ON pos_qr_webhook_events (source, fingerprint);

-- Hot path operativo: últimos eventos recibidos.
CREATE INDEX IF NOT EXISTS ix_pqwe_received_desc
    ON pos_qr_webhook_events (received_at DESC);

-- Pantalla "eventos sin resolver": PENDING/UNMATCHED/AMBIGUOUS.
CREATE INDEX IF NOT EXISTS ix_pqwe_needs_review
    ON pos_qr_webhook_events (received_at DESC)
    WHERE processed_status IN ('PENDING', 'UNMATCHED', 'AMBIGUOUS');

-- Correlación por intención matched (debugging e histórico).
CREATE INDEX IF NOT EXISTS ix_pqwe_matched_intent
    ON pos_qr_webhook_events (matched_intent_id)
    WHERE matched_intent_id IS NOT NULL;

-- Match secundario por monto: útil para "qué eventos recientes a este
-- monto se recibieron" al investigar un cobro perdido.
CREATE INDEX IF NOT EXISTS ix_pqwe_amount_received
    ON pos_qr_webhook_events (amount_cop, received_at DESC);

COMMENT ON TABLE pos_qr_webhook_events IS
    'Eventos recibidos por los webhooks públicos del módulo QR Bold/Bre-B. Fuente BOLD_OFFICIAL (POST /api/webhooks/bold, SALE_APPROVED firmado HMAC-SHA256 por x-bold-signature cuando BOLD_SECRET_KEY está configurado) o BRIDGE_NOTIFICATION (POST /api/webhooks/bold-notificacion con token BOLD_BRIDGE_TOKEN que extrae COP de notificaciones push tipo "Recibiste $45.800"). Dedupe doble: UNIQUE (source, external_id) para el bold_code oficial y UNIQUE (source, fingerprint) para la ventana de replay del bridge MacroDroid. Si el match por monto exacto es 0 o >1 PENDIENTES vigentes, el evento queda UNMATCHED/AMBIGUOUS; nunca aprueba automáticamente ninguna intención en esos casos (regla "falso negativo antes que doble aprobación").';
COMMENT ON COLUMN pos_qr_webhook_events.source IS
    'BOLD_OFFICIAL (webhook oficial Bold, data.bold_code presente) o BRIDGE_NOTIFICATION (bridge MacroDroid, token BOLD_BRIDGE_TOKEN). Scope de los UNIQUE de dedupe.';
COMMENT ON COLUMN pos_qr_webhook_events.event_type IS
    'Tipo de evento normalizado. Para BOLD_OFFICIAL se puebla con payload.type (típicamente SALE_APPROVED). Para BRIDGE_NOTIFICATION queda NULL o con un marcador tipo PUSH_NOTIFICATION.';
COMMENT ON COLUMN pos_qr_webhook_events.external_id IS
    'Identificador canónico del evento cuando el origen lo provee: data.bold_code para BOLD_OFFICIAL. NULL para BRIDGE_NOTIFICATION (MacroDroid no entrega id canónico). UNIQUE parcial (source, external_id) hace el replay oficial idempotente.';
COMMENT ON COLUMN pos_qr_webhook_events.fingerprint IS
    'Hash determinístico calculado por el handler: sha256(source + "|" + amount_cop + "|" + bucket_de_tiempo). Para BOLD_OFFICIAL se construye desde bold_code y es trivialmente único. Para BRIDGE_NOTIFICATION incluye un bucket temporal corto que detecta replays literales. UNIQUE (source, fingerprint) cierra la segunda línea de defensa; dos pagos legítimos al mismo monto en el mismo bucket colisionan (falso negativo) y requieren confirmar-manual. NUNCA contiene el token BOLD_BRIDGE_TOKEN ni la firma x-bold-signature.';
COMMENT ON COLUMN pos_qr_webhook_events.amount_cop IS
    'Monto exacto en pesos colombianos (COP), BIGINT. Para BOLD_OFFICIAL se extrae de data.amount.total y se convierte a entero. Para BRIDGE_NOTIFICATION el handler lo parsea del mensaje push ("Recibiste $45.800" → 45800). El match contra pos_qr_payment_intents.amount_cop es por igualdad exacta.';
COMMENT ON COLUMN pos_qr_webhook_events.processed_status IS
    'PENDING: aún no procesado por el matcher. APPROVED: match exacto con una única PENDIENTE y matched_intent_id poblado. UNMATCHED: no había ninguna PENDIENTE vigente al mismo monto (fingerprint queda registrada para investigación). AMBIGUOUS: había >1 PENDIENTE vigente al mismo monto; se registra pero NO se aprueba automáticamente. DUPLICATE: evento ya visto por external_id/fingerprint, ACK idempotente. INVALID: payload no pasó validación (firma HMAC-SHA256 inválida, token BOLD_BRIDGE_TOKEN incorrecto, monto no parseable, etc.).';
COMMENT ON COLUMN pos_qr_webhook_events.matched_intent_id IS
    'FK dura (RESTRICT) a pos_qr_payment_intents.id cuando processed_status=APPROVED. NULL en cualquier otro estado procesado. La biyección exacta vive en ck_pqwe_matched_only_if_approved.';
COMMENT ON CONSTRAINT fk_pqwe_matched_intent ON pos_qr_webhook_events IS
    'ON DELETE RESTRICT: una intención aprobada no debe desaparecer mientras exista el evento que la aprobó. La auditoría cruzada se preserva en los dos sentidos (evento ↔ intento) con RESTRICT en ambas FKs.';

-- ============================================================================
-- 3) FK retro intents → events para "¿qué evento aprobó esta intención?".
-- ============================================================================
--
-- pos_qr_payment_intents.approved_event_id referencia pos_qr_webhook_events(id).
-- Como pos_qr_webhook_events se crea DESPUÉS de pos_qr_payment_intents en esta
-- misma migración (y Postgres no admite FK a una tabla aún inexistente al
-- declarar la primera CREATE TABLE), la FK se añade en un bloque DO $$
-- aparte. El bloque consulta pg_constraint para que el runner pueda
-- reintentar la migración tras un fallo parcial (Postgres no soporta
-- ADD CONSTRAINT IF NOT EXISTS).

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'fk_pqpi_approved_event'
    ) THEN
        ALTER TABLE pos_qr_payment_intents
            ADD CONSTRAINT fk_pqpi_approved_event
            FOREIGN KEY (approved_event_id)
            REFERENCES pos_qr_webhook_events(id)
            ON DELETE RESTRICT;
    END IF;
END $$;

COMMENT ON CONSTRAINT fk_pqpi_approved_event ON pos_qr_payment_intents IS
    'ON DELETE RESTRICT: un evento que aprobó una intención no debe desaparecer mientras exista la intención aprobada por él. Simétrico con fk_pqwe_matched_intent (RESTRICT en ambas direcciones); los eventos y las intenciones son append-only en operación normal (status cambia, filas quedan).';
