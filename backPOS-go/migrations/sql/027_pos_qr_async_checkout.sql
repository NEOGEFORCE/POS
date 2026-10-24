-- Checkout asíncrono de QR Bold/Bre-B para Supermercado Surtifamiliar.
-- La 026 instaló la intención durable + el log de webhooks con dedupe
-- doble. La 027 agrega al mismo `pos_qr_payment_intents` lo que falta
-- para que el flujo pueda operar 100 % en segundo plano, sin que el
-- cajero tenga que mirar el modal para que la venta se cierre.
--
-- Dependencias explícitas: la migración 026 debe estar aplicada antes
-- que la 027 (la 027 extiende aditivamente la tabla creada por la 026).
-- También depende del contrato de la migración 009 (idempotencia de
-- sales."clientTxId") y del patrón de FK soft (sin REFERENCES duras)
-- usado por 016/019/023/026 cuando una tabla append-only de auditoría
-- apunta a tablas con soft delete.
--
-- POR QUÉ existe esta migración
-- ============================================================================
-- Con la 026 ya se podía emitir una intención PENDIENTE, matchear por
-- monto exacto cuando llegaba la notificación de MacroDroid (co.bold) o
-- el webhook oficial Bold, y marcar la intención como APROBADA. Pero el
-- cierre de la venta todavía dependía de que el ModalPagoBoldQR
-- siguiera abierto en el navegador: el frontend recibía el SSE
-- APROBADO, llamaba a POST /api/sales desde el cajero, imprimía y la
-- intención quedaba "aprobada" pero sin venta vinculada hasta ese
-- último paso manual. Dos problemas en campo:
--
--   1) EL CAJERO NO QUIERE ESPERAR EL QR.
--      Mientras el cliente paga por Bre-B pueden pasar entre 10 s y
--      3 min hasta que la notificación llegue. En ese tiempo el cajero
--      quiere atender al siguiente cliente, no quedarse mirando el QR.
--      Hoy, si cierra el modal, la ingestión del webhook sigue
--      funcionando pero NO hay quien dispare la venta: la intención
--      queda APROBADA huérfana, el pago entró a la cuenta pero el
--      kárdex y el ticket no existen. Al día siguiente el dueño
--      intenta cuadrar caja y faltan ventas.
--
--   2) REINTENTOS Y RECONEXIONES DUPLICAN.
--      El flujo anterior era "web manda POST /api/sales cuando ve el
--      SSE APROBADO". Si el cajero refresca el browser, otro operador
--      abre la bandeja o se reconecta la red, el frontend ha intentado
--      cerrar la venta dos veces. El clientTxId que usaba el flujo
--      sincrónico lo generaba el frontend al momento del POST, así que
--      dos clientes de red con el mismo SSE generaban dos clientTxId
--      distintos y dos ventas en sales. La idempotencia de
--      CreateSale (sales."clientTxId" UNIQUE partial) no servía porque
--      cada reconexión generaba una clave nueva.
--
-- Esta migración instala el esquema MÍNIMO para que el servidor se
-- vuelva la autoridad del cierre:
--
--   (a) Snapshot durable del carrito, cliente y totales. Al emitir la
--       intención (POST /api/pos/pagos-qr/iniciar), el frontend ya tenía
--       la info del carrito activo. Hoy se tira esa info al cerrar el
--       modal. Ahora se persiste como JSONB inmutable y el servidor
--       puede materializar la venta sin volver a preguntar al
--       frontend. Si el navegador se cae, otro PC entra, o el servicio
--       se reinicia, el snapshot sigue ahí.
--
--   (b) clientTxId reservado al emitir. Se genera UNA vez junto con la
--       intención y se guarda en `sale_client_tx_id`. Si el matcher
--       aprueba la intención y la finalización falla a mitad de la
--       transacción, el reintento usa el MISMO clientTxId: la UNIQUE
--       parcial sobre sales."clientTxId" (migración 009) rechaza el
--       segundo INSERT y la idempotencia opera sin generar ventas
--       duplicadas. Más: UNIQUE parcial sobre `sale_client_tx_id` en
--       esta misma tabla evita que dos intenciones distintas peleen
--       por el mismo clientTxId.
--
--   (c) Máquina de finalización separada del status de la intención.
--       `status` de la 026 era la máquina del PAGO (PENDIENTE →
--       APROBADA/...). `finalization_status` nuevo describe el ciclo
--       de la VENTA en sales a partir del momento en que el pago fue
--       aprobado: NOT_STARTED → IN_PROGRESS → SUCCEEDED | FAILED. Las
--       dos máquinas conviven; una no reemplaza a la otra. Esto se
--       nota en los CHECK: SUCCEEDED requiere que el pago ya esté
--       APROBADA/CONFIRMADA_MANUAL, pero una intención puede estar
--       APROBADA sin que la venta se haya materializado (ventana entre
--       el webhook y el commit del Sale).
--
--   (d) Reintentos con backoff. `finalization_attempts`,
--       `finalization_last_error` (acotado a 255 chars, nunca stack
--       trace ni payload), `finalization_next_retry_at`. Un barredor
--       del servicio levanta las FAILED cuyo next_retry_at ya pasó y
--       las reintenta, usando el mismo `sale_client_tx_id`.
--
--   (e) Encolado (bandeja). `queued_at TIMESTAMPTZ NULL`. NULL
--       significa "el modal todavía está abierto, el cajero mira el
--       QR"; NOT NULL significa "el cajero pulsó Dejar en espera y
--       sigue atendiendo". La bandeja global de /sales/new filtra por
--       `queued_at IS NOT NULL AND status = 'PENDIENTE'`. Es una señal
--       de operación, no un estado del pago: una intención en cola
--       sigue en PENDIENTE y la aprobación por webhook funciona
--       igual. La diferencia es sólo visual (dónde la ve el cajero).
--
--   (f) Marca de notificación al cajero. `cashier_notified_at`
--       registra cuándo se emitió por SSE el evento post-commit que
--       dispara la alerta grande + sonido + impresión. Idempotente:
--       si el cajero cierra y reabre la bandeja, el servidor puede
--       re-emitir sin duplicar la venta (eso ya lo bloquea
--       `sale_client_tx_id`) pero el frontend decide si repite el
--       sonido mirando esta columna + un token local.
--
-- QUÉ NO HACE
-- ============================================================================
-- - NO modifica `pos_qr_webhook_events`. La ingestión de webhook sigue
--   igual: dedupe doble (external_id canónico Bold + fingerprint
--   anti-replay) y transición de la intención a APROBADA. El cambio
--   es QUÉ pasa después de que la intención queda APROBADA: ahora el
--   servicio dispara la materialización de la venta en segundo plano.
--
-- - NO modifica `sales`, `sale_details` ni `stock_movements`. El flujo
--   canónico de `SaleService.CreateSale` sigue siendo la única fuente
--   de verdad para registrar ventas y descontar stock. Esta migración
--   sólo le entrega la foto del carrito en JSONB y recibe de vuelta
--   el `saleId` resultante.
--
-- - NO almacena secretos. BOLD_SECRET_KEY, BOLD_BRIDGE_TOKEN,
--   x-bold-signature y el payload crudo de la notificación siguen
--   fuera del esquema (igual que en la 026). `finalization_last_error`
--   acepta 255 chars y el handler debe recortar sin incluir el token
--   ni la firma; un test estático en el servicio ya audita este
--   contrato.
--
-- - NO rompe la retrocompatibilidad con el flujo sincrónico heredado.
--   Las columnas nuevas son NULL por defecto; una intención antigua
--   (si existiera) permanece con `finalization_status='NOT_STARTED'`,
--   `cart_snapshot NULL`, etc. Los CHECK sólo exigen coherencia dentro
--   de cada rama: una fila legacy con `related_sale_id` ya poblado
--   desde el flujo sincrónico ANTERIOR no viola nada porque
--   `finalization_status='NOT_STARTED'` no exige que related_sale_id
--   sea NULL (sólo exige que, si SUCCEEDED, lo sea NOT NULL).
--
-- - NO reintroduce AMBIGUA como status de la intención. Si llegaran
--   dos pendientes al mismo monto, el evento sigue siendo AMBIGUOUS y
--   NINGUNA de las dos intenciones transita a APROBADA
--   automáticamente. Esto significa que la finalización asíncrona ni
--   siquiera arranca: cero facturación automática en caso ambiguo. El
--   cajero resuelve con la bandeja (reabrir el QR específico) y el
--   webhook posterior ya tendrá un único candidato. La regla "falso
--   negativo antes que doble aprobación" se mantiene bit a bit. Es
--   mejor un falso negativo (el cajero resuelve a mano una vez) que
--   una doble aprobación (dos ventas por el mismo cobro).
--
-- - NO elimina las columnas de confirmación manual
--   (`manual_confirmed_by_dni`, `manual_confirmed_note`,
--   `approved_source='MANUAL'`). La ruta POST
--   /api/pos/pagos-qr/confirmar-manual queda deprecada en el handler
--   (sólo admin, log de advertencia o 410) pero sus columnas se
--   conservan por auditoría histórica: una venta cerrada con
--   confirmar-manual antes del rollout de la 027 debe seguir siendo
--   consultable con pg_dump sin que falte la autoría.
--
-- TRANSACCIONAL: SÍ
-- ============================================================================
-- Esta migración NO usa CREATE INDEX CONCURRENTLY. Añade columnas,
-- CHECKs y cinco índices sobre `pos_qr_payment_intents`. En
-- instalaciones típicas la tabla está vacía (el módulo QR se activa
-- recién con la 026 y la 027 va en la misma ventana). PostgreSQL
-- prohíbe CONCURRENTLY dentro de una transacción, y mantener la 027
-- transaccional nos da rollback automático si cualquier ADD CONSTRAINT
-- falla al validar datos preexistentes. Por eso catalog.go NO añade
-- la 027 a la lista de excepciones no transaccionales (hoy 8, 9, 11,
-- 13, 14, 15 y 18).
--
-- NO MODIFICA DATOS DE NEGOCIO
-- ============================================================================
-- Puramente DDL: ALTER TABLE ADD COLUMN con defaults seguros, ADD
-- CONSTRAINT CHECK, CREATE INDEX y COMMENT. Ni un UPDATE, ni un
-- DELETE, ni un INSERT. No se backfillea `sale_client_tx_id` en filas
-- históricas: las intenciones APROBADAS pre-027 se cerraron por el
-- flujo sincrónico y ya tienen (o no tienen) `related_sale_id` según
-- lo haya seteado el servicio en su momento. Mezclar un backfill con
-- la DDL abriría la puerta a dobles de UPDATE que no es lo que
-- queremos.
--
-- REVERSIBILIDAD (manual, con API detenido y respaldo)
-- ============================================================================
-- Si hubiera que deshacer la 027 después de aplicada, en una sola
-- transacción (BEGIN/COMMIT):
--
--   1) DROP INDEX IF EXISTS ix_pqpi_finalization_in_progress;
--   2) DROP INDEX IF EXISTS ix_pqpi_finalization_retry;
--   3) DROP INDEX IF EXISTS ix_pqpi_queued_bandeja;
--   4) DROP INDEX IF EXISTS ux_pqpi_related_sale_id;
--   5) DROP INDEX IF EXISTS ux_pqpi_sale_client_tx_id;
--   6) ALTER TABLE pos_qr_payment_intents
--        DROP CONSTRAINT IF EXISTS ck_pqpi_finalization_coherent,
--        DROP CONSTRAINT IF EXISTS ck_pqpi_finalization_requires_approval,
--        DROP CONSTRAINT IF EXISTS ck_pqpi_finalization_last_error_shape,
--        DROP CONSTRAINT IF EXISTS ck_pqpi_finalization_attempts_bounds,
--        DROP CONSTRAINT IF EXISTS ck_pqpi_finalization_status_known,
--        DROP CONSTRAINT IF EXISTS ck_pqpi_sale_client_tx_id_shape;
--   7) ALTER TABLE pos_qr_payment_intents
--        DROP COLUMN IF EXISTS cashier_notified_at,
--        DROP COLUMN IF EXISTS finalization_next_retry_at,
--        DROP COLUMN IF EXISTS finalization_last_error,
--        DROP COLUMN IF EXISTS finalization_attempts,
--        DROP COLUMN IF EXISTS finalization_completed_at,
--        DROP COLUMN IF EXISTS finalization_started_at,
--        DROP COLUMN IF EXISTS finalization_status,
--        DROP COLUMN IF EXISTS queued_at,
--        DROP COLUMN IF EXISTS sale_client_tx_id,
--        DROP COLUMN IF EXISTS totals_snapshot,
--        DROP COLUMN IF EXISTS client_snapshot,
--        DROP COLUMN IF EXISTS cart_snapshot;
--   8) Borrar la fila `version = 27` de `schema_migrations`.
--
-- Si la tabla ya tiene ventas finalizadas (related_sale_id poblado
-- vía esta migración), el DROP las deja huérfanas de las columnas de
-- lifecycle pero NO borra las ventas (están en sales): la auditoría
-- cruzada quedaría degradada hasta que se reaplique la 027. Hacerlo
-- con respaldo reciente.

-- ============================================================================
-- 1) Columnas nuevas sobre pos_qr_payment_intents.
-- ============================================================================
--
-- Idempotentes con ADD COLUMN IF NOT EXISTS para que la migración
-- pueda reintentar tras un fallo parcial sin reventar.
--
-- cart_snapshot / client_snapshot / totals_snapshot viven como JSONB.
-- La forma exacta la posee el servicio Go (no la BD) para evitar que
-- un rename de campo en el frontend obligue a una migración 028. El
-- contrato declarado en el COMMENT: el snapshot es INMUTABLE desde el
-- momento de la emisión; el servicio no reescribe estas columnas.
--
-- sale_client_tx_id es la clave de idempotencia reservada al emitir
-- la intención; cuando el matcher aprueba la intención, el servicio
-- llama a SaleService.CreateSale con este valor. La UNIQUE partial
-- bloquea reusos entre intenciones distintas; CreateSale ya tiene su
-- propia UNIQUE partial sobre sales."clientTxId" (migración 009), que
-- rechaza la segunda inserción si una materialización paralela se
-- adelantó. Esos dos UNIQUE son las dos líneas de defensa que
-- cierran la ventana de "una intención aprobada ↔ exactamente una
-- venta".
--
-- queued_at es la señal de "cajero pulsó Dejar en espera". NULL por
-- default (modal activo). La bandeja global se filtra con
-- `WHERE queued_at IS NOT NULL AND status = 'PENDIENTE'`.
--
-- finalization_status describe el lifecycle de la MATERIALIZACIÓN de
-- la venta, separado del lifecycle del PAGO (status). Default
-- 'NOT_STARTED' para que todas las filas históricas de 026 queden en
-- un estado trivialmente coherente sin backfill.
--
-- finalization_attempts/last_error/next_retry_at sostienen el backoff
-- del reintentador. finalization_last_error se acota a 255 chars y en
-- Go el servicio recorta a mensaje operativo (nada de stack trace,
-- nada que incluya el token BOLD_BRIDGE_TOKEN ni la firma HMAC).
--
-- cashier_notified_at es la última vez que el servidor emitió por
-- SSE el evento post-commit que dispara la alerta grande + sonido +
-- impresión en el frontend. Idempotente desde el punto de vista de
-- la venta (que ya está materializada): el frontend decide si
-- repetir el sonido con un token local separado.

ALTER TABLE pos_qr_payment_intents
    ADD COLUMN IF NOT EXISTS cart_snapshot                JSONB,
    ADD COLUMN IF NOT EXISTS client_snapshot              JSONB,
    ADD COLUMN IF NOT EXISTS totals_snapshot              JSONB,
    ADD COLUMN IF NOT EXISTS sale_client_tx_id            VARCHAR(64),
    ADD COLUMN IF NOT EXISTS queued_at                    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS finalization_status          VARCHAR(24)  NOT NULL DEFAULT 'NOT_STARTED',
    ADD COLUMN IF NOT EXISTS finalization_started_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS finalization_completed_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS finalization_attempts        INTEGER      NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS finalization_last_error      VARCHAR(255),
    ADD COLUMN IF NOT EXISTS finalization_next_retry_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cashier_notified_at          TIMESTAMPTZ;

-- ============================================================================
-- 2) CHECKs idempotentes sobre pos_qr_payment_intents (vía DO $$).
-- ============================================================================
--
-- Postgres no soporta `ADD CONSTRAINT IF NOT EXISTS`. Cada CHECK se
-- envuelve en un DO $$ que consulta pg_constraint para permitir
-- reintentos tras un fallo parcial. Si alguien colapsa dos ADD
-- CONSTRAINT en el mismo DO $$, la idempotencia se rompe (parcial =
-- algunos sí, otros no, siguiente intento revienta).

-- 2.a) ck_pqpi_finalization_status_known: enum cerrado en BD. Si una
--      pieza de código futura intenta setear un estado desconocido,
--      Postgres lo rechaza antes de que la biyección se contamine.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_pqpi_finalization_status_known'
    ) THEN
        ALTER TABLE pos_qr_payment_intents
            ADD CONSTRAINT ck_pqpi_finalization_status_known
            CHECK (finalization_status IN ('NOT_STARTED', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED'));
    END IF;
END $$;

-- 2.b) ck_pqpi_finalization_attempts_bounds: 0 ≤ attempts ≤ 100. Cien
--      intentos cubre varios días de backoff exponencial con sobra;
--      si una intención llega a esa cota es que algo está mal (bug
--      sostenido o producto borrado) y debe pararse manualmente.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_pqpi_finalization_attempts_bounds'
    ) THEN
        ALTER TABLE pos_qr_payment_intents
            ADD CONSTRAINT ck_pqpi_finalization_attempts_bounds
            CHECK (finalization_attempts >= 0 AND finalization_attempts <= 100);
    END IF;
END $$;

-- 2.c) ck_pqpi_finalization_last_error_shape: NULL o entre 1 y 255
--      chars. El handler recorta mensajes largos antes de persistir;
--      el CHECK es defensa en profundidad para que una línea vacía
--      ("") no quede guardada como "hubo error pero sin motivo".
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_pqpi_finalization_last_error_shape'
    ) THEN
        ALTER TABLE pos_qr_payment_intents
            ADD CONSTRAINT ck_pqpi_finalization_last_error_shape
            CHECK (finalization_last_error IS NULL
                   OR (char_length(finalization_last_error) >= 1
                       AND char_length(finalization_last_error) <= 255));
    END IF;
END $$;

-- 2.d) ck_pqpi_sale_client_tx_id_shape: NULL o entre 8 y 64 chars.
--      Empata con el shape de sales."clientTxId" (migración 009):
--      cualquier UUID/ULID/short-id que el servicio genere entra en
--      ese rango. Un valor "" o "x" quedaría rechazado antes de que
--      la UNIQUE partial sobre sales lo descubra.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_pqpi_sale_client_tx_id_shape'
    ) THEN
        ALTER TABLE pos_qr_payment_intents
            ADD CONSTRAINT ck_pqpi_sale_client_tx_id_shape
            CHECK (sale_client_tx_id IS NULL
                   OR (char_length(sale_client_tx_id) >= 8
                       AND char_length(sale_client_tx_id) <= 64));
    END IF;
END $$;

-- 2.e) ck_pqpi_finalization_coherent: máquina de 4 estados de la
--      materialización, biyección exacta con los timestamps y el
--      related_sale_id.
--
--      NOT_STARTED: nadie ha intentado materializar aún. Ningún
--      timestamp. Ningún error. related_sale_id debe ser NULL
--      (si una fila legacy del flujo sincrónico tenía related_sale_id
--      sin pasar por el matcher, debe pasar primero por un ADD
--      MIGRATION manual que la lleve a SUCCEEDED; mientras tanto el
--      service la trata como "ya cerrada por fuera" y no la reintenta).
--
--      IN_PROGRESS: alguien arrancó el materializador (started_at
--      poblado) y aún no terminó (completed_at NULL). Un reintento
--      tras un FAILED sobreescribe started_at y limpia completed_at.
--
--      SUCCEEDED: terminal. started_at y completed_at poblados,
--      related_sale_id obligatorio, finalization_last_error NULL
--      (los errores quedaron en el intento anterior; cuando se logra
--      el commit se limpia). sale_client_tx_id debe estar presente.
--
--      FAILED: estado intermedio terminal de un intento. started_at
--      y completed_at poblados, finalization_last_error obligatorio,
--      related_sale_id NULL. El reintentador puede volver a
--      IN_PROGRESS más tarde si next_retry_at ya pasó.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_pqpi_finalization_coherent'
    ) THEN
        ALTER TABLE pos_qr_payment_intents
            ADD CONSTRAINT ck_pqpi_finalization_coherent
            CHECK (
                (finalization_status = 'NOT_STARTED'
                    AND finalization_started_at IS NULL
                    AND finalization_completed_at IS NULL
                    AND finalization_last_error IS NULL
                    AND related_sale_id IS NULL)
                OR
                (finalization_status = 'IN_PROGRESS'
                    AND finalization_started_at IS NOT NULL
                    AND finalization_completed_at IS NULL
                    AND finalization_last_error IS NULL
                    AND related_sale_id IS NULL)
                OR
                (finalization_status = 'SUCCEEDED'
                    AND finalization_started_at IS NOT NULL
                    AND finalization_completed_at IS NOT NULL
                    AND finalization_last_error IS NULL
                    AND related_sale_id IS NOT NULL
                    AND sale_client_tx_id IS NOT NULL)
                OR
                (finalization_status = 'FAILED'
                    AND finalization_started_at IS NOT NULL
                    AND finalization_completed_at IS NOT NULL
                    AND finalization_last_error IS NOT NULL
                    AND related_sale_id IS NULL)
            );
    END IF;
END $$;

-- 2.f) ck_pqpi_finalization_requires_approval: una venta sólo se
--      materializa cuando el pago fue aprobado. Si finalization_status
--      es SUCCEEDED, el status del pago debe ser APROBADA o
--      CONFIRMADA_MANUAL (la 026 ya definió ambos como "terminal con
--      cobro recibido"). Esto bloquea un bug donde el materializador
--      intentara cerrar una PENDIENTE o EXPIRADA; si pasara, la BD
--      aborta la transacción.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_pqpi_finalization_requires_approval'
    ) THEN
        ALTER TABLE pos_qr_payment_intents
            ADD CONSTRAINT ck_pqpi_finalization_requires_approval
            CHECK (
                finalization_status <> 'SUCCEEDED'
                OR status IN ('APROBADA', 'CONFIRMADA_MANUAL')
            );
    END IF;
END $$;

-- ============================================================================
-- 3) Índices sobre pos_qr_payment_intents.
-- ============================================================================
--
-- Todos los índices son transaccionales (no CONCURRENTLY) porque la
-- 027 corre dentro de una transacción. Postgres puede construir
-- índices sobre tablas con pocas filas instantáneamente; si la 026
-- recién se aplicó esta ventana debería ser trivial. Si por algún
-- motivo el ambiente ya tiene miles de filas, documento aquí la
-- expectativa: los índices parciales son estrechos (filtran por
-- status/queued_at/finalization_status), así que su tamaño en disco
-- es acotado y su construcción es rápida.

-- 3.a) UNIQUE partial sobre sale_client_tx_id: evita que dos
--      intenciones distintas se reserven el mismo clientTxId. Si
--      colisionan (muy improbable con UUID v4), el repo detecta el
--      error antes de llamar a CreateSale y genera uno nuevo. Partial
--      porque las filas con sale_client_tx_id NULL (intenciones sin
--      snapshot aún, o legacy pre-027) no deben pelear por el slot.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pqpi_sale_client_tx_id
    ON pos_qr_payment_intents (sale_client_tx_id)
    WHERE sale_client_tx_id IS NOT NULL;

-- 3.b) UNIQUE partial sobre related_sale_id: la biyección "una
--      intención ↔ una venta" se cierra aquí. Si por algún bug dos
--      intenciones apuntaran al mismo saleId, la segunda escritura
--      falla. Partial porque la mayoría de intenciones no tiene
--      related_sale_id (PENDIENTE, EXPIRADA, CANCELADA sin cobro).
--      La FK sigue siendo blanda (sin REFERENCES duras) porque sales
--      usa soft delete via gorm.DeletedAt: una venta anulada debe
--      poder desaparecer lógicamente sin invalidar la auditoría de la
--      intención, que es append-only. Mismo patrón que
--      cash_drawer_opens.sale_id (migración 016) y
--      pos_qr_payment_intents.related_sale_id original (migración 026).
CREATE UNIQUE INDEX IF NOT EXISTS ux_pqpi_related_sale_id
    ON pos_qr_payment_intents (related_sale_id)
    WHERE related_sale_id IS NOT NULL;

-- 3.c) Bandeja de pendientes encolados por caja. La UI de /sales/new
--      consulta "qué pagos quedé esperando en esta caja" filtrando
--      por queued_at IS NOT NULL AND status = 'PENDIENTE'. Partial
--      para que el B-tree no cargue con intenciones terminales ni con
--      intenciones que todavía viven detrás de un modal abierto.
CREATE INDEX IF NOT EXISTS ix_pqpi_queued_bandeja
    ON pos_qr_payment_intents (caja_id, queued_at DESC)
    WHERE queued_at IS NOT NULL AND status = 'PENDIENTE';

-- 3.d) Barredor de reintentos: la cola del reintentador quiere las
--      FAILED cuyo next_retry_at ya pasó, ordenadas por reloj.
--      Partial: filas sin next_retry_at (NOT_STARTED, IN_PROGRESS,
--      SUCCEEDED, o FAILED que ya agotó reintentos) no deben entrar.
CREATE INDEX IF NOT EXISTS ix_pqpi_finalization_retry
    ON pos_qr_payment_intents (finalization_next_retry_at)
    WHERE finalization_status = 'FAILED' AND finalization_next_retry_at IS NOT NULL;

-- 3.e) Detección de atascos: materializadores IN_PROGRESS que llevan
--      demasiado tiempo (p. ej. caída del proceso durante la tx).
--      Partial para que el barrido administrativo encuentre rápido.
CREATE INDEX IF NOT EXISTS ix_pqpi_finalization_in_progress
    ON pos_qr_payment_intents (finalization_started_at)
    WHERE finalization_status = 'IN_PROGRESS';

-- ============================================================================
-- 4) COMMENTs sobre tabla, columnas y constraints.
-- ============================================================================
--
-- pg_dump --schema-only conserva estos comentarios junto con la BD.
-- Son la fuente de verdad "operativa" del contrato para quien lea el
-- esquema sin tener acceso al código.

COMMENT ON COLUMN pos_qr_payment_intents.cart_snapshot IS
    'Snapshot inmutable del carrito al momento de emitir la intención. JSONB opaco a la BD; la forma la posee el servicio Go (típicamente [{barcode, quantity, unitPrice, subtotal, name}]). Permite que el servidor materialice la venta sin volver a consultar al frontend cuando el webhook aprueba. El servicio NO reescribe esta columna después de la emisión; si falta algún dato (producto borrado, precio cambiado) el materializador falla con FAILED y el cajero resuelve por bandeja.';
COMMENT ON COLUMN pos_qr_payment_intents.client_snapshot IS
    'Snapshot inmutable del cliente al momento de emitir la intención. JSONB opaco a la BD (típicamente {dni, name, currentCredit}). Permite imprimir el ticket con el nombre correcto incluso si el cliente modifica sus datos entre la emisión y la aprobación.';
COMMENT ON COLUMN pos_qr_payment_intents.totals_snapshot IS
    'Snapshot inmutable de los totales de la venta al momento de emitir la intención. JSONB opaco a la BD (típicamente {totalAmount, amountPaid, change, discount, paymentMethod}). El amount_cop de la 026 es el monto exacto a cobrar por Bre-B; totals_snapshot carga el resto del detalle contable para que CreateSale no tenga que recomputar.';
COMMENT ON COLUMN pos_qr_payment_intents.sale_client_tx_id IS
    'Clave de idempotencia reservada al emitir la intención. Al materializar la venta, se usa como sales."clientTxId"; la UNIQUE partial sobre sales (migración 009) bloquea la segunda inserción si un reintento se adelanta. UNIQUE parcial local evita que dos intenciones distintas peleen por el mismo clientTxId. Shape 8..64 chars (UUID/ULID razonables).';
COMMENT ON COLUMN pos_qr_payment_intents.queued_at IS
    'Momento en que el cajero pulsó "Dejar en espera y seguir atendiendo". NULL mientras el modal ModalPagoBoldQR permanece activo; NOT NULL cuando la intención pasa a la bandeja global de /sales/new. No es un estado del pago (status sigue en PENDIENTE); es una marca de encolado operativo.';
COMMENT ON COLUMN pos_qr_payment_intents.finalization_status IS
    'Lifecycle de la MATERIALIZACIÓN de la venta en sales, separado del status del pago. NOT_STARTED (aún no se intentó) → IN_PROGRESS (materializador corriendo) → SUCCEEDED (venta creada, related_sale_id poblado) o FAILED (último intento falló, puede reintentar). El materializador arranca cuando el matcher transita status a APROBADA; mientras tanto queda NOT_STARTED. SUCCEEDED es terminal; FAILED puede volver a IN_PROGRESS por el barredor de reintentos.';
COMMENT ON COLUMN pos_qr_payment_intents.finalization_started_at IS
    'Timestamp del arranque del intento vigente de materialización. Se setea cuando finalization_status pasa a IN_PROGRESS y se preserva en SUCCEEDED/FAILED. Un reintento sobreescribe este valor con el nuevo arranque.';
COMMENT ON COLUMN pos_qr_payment_intents.finalization_completed_at IS
    'Timestamp del cierre del intento vigente de materialización, poblado en SUCCEEDED y FAILED. NULL durante IN_PROGRESS. Combinado con started_at da la duración del intento.';
COMMENT ON COLUMN pos_qr_payment_intents.finalization_attempts IS
    'Cuántos intentos se han hecho de materializar la venta. Se incrementa al transitar FAILED. Cota superior 100: si una intención llega a esa cuenta es un bug sostenido y el barredor debe parar y escalar.';
COMMENT ON COLUMN pos_qr_payment_intents.finalization_last_error IS
    'Mensaje operativo del último fallo (máx 255 chars). El handler recorta antes de persistir y nunca incluye stack trace, BOLD_BRIDGE_TOKEN, BOLD_SECRET_KEY ni la firma HMAC. Si está presente, la UI de /admin/qr-eventos lo muestra para investigación.';
COMMENT ON COLUMN pos_qr_payment_intents.finalization_next_retry_at IS
    'Cuándo vuelve a correr el reintentador para esta intención FAILED. NULL si no hay reintento previsto (aún no ha fallado, o agotó la política de backoff). El barredor filtra por este índice parcial.';
COMMENT ON COLUMN pos_qr_payment_intents.cashier_notified_at IS
    'Última vez que el servidor emitió por SSE el evento post-commit que dispara la alerta grande + sonido + impresión. Idempotente: la venta ya está materializada (related_sale_id poblado), así que re-emitir no duplica stock ni ticket. El frontend decide si repite el sonido con un token local.';

COMMENT ON CONSTRAINT ck_pqpi_finalization_status_known ON pos_qr_payment_intents IS
    'Enum cerrado del lifecycle de materialización. Si un valor desconocido llega a entrar, la BD aborta la transacción. Las transiciones legales (NOT_STARTED→IN_PROGRESS, IN_PROGRESS→SUCCEEDED|FAILED, FAILED→IN_PROGRESS) viven en el service con SELECT ... FOR UPDATE sobre la fila del intent.';
COMMENT ON CONSTRAINT ck_pqpi_finalization_coherent ON pos_qr_payment_intents IS
    'Biyección exacta entre finalization_status y los campos de timestamp/error/related_sale_id/sale_client_tx_id. Garantiza que no se pueda tener SUCCEEDED sin saleId, ni FAILED sin mensaje, ni IN_PROGRESS con completed_at.';
COMMENT ON CONSTRAINT ck_pqpi_finalization_requires_approval ON pos_qr_payment_intents IS
    'Una venta sólo se materializa cuando el pago fue aprobado. Si finalization_status llega a SUCCEEDED con status=PENDIENTE/EXPIRADA/CANCELADA, la BD aborta la transacción (defensa en profundidad contra un bug del service que materializara sin cobro recibido).';
COMMENT ON CONSTRAINT ck_pqpi_sale_client_tx_id_shape ON pos_qr_payment_intents IS
    'Shape 8..64 chars para sale_client_tx_id cuando NO es NULL. Empata con el shape de sales."clientTxId" (migración 009) para que la idempotencia cruzada no se rompa por longitud.';
COMMENT ON CONSTRAINT ck_pqpi_finalization_attempts_bounds ON pos_qr_payment_intents IS
    'finalization_attempts en [0, 100]. Si una intención llega a 100 reintentos es que algo está mal (producto borrado, bug sostenido) y el barredor debe parar y escalar.';
COMMENT ON CONSTRAINT ck_pqpi_finalization_last_error_shape ON pos_qr_payment_intents IS
    'finalization_last_error NULL o 1..255 chars. "" vacío queda prohibido para que no haya "error sin motivo" guardado.';

COMMENT ON INDEX ux_pqpi_sale_client_tx_id IS
    'UNIQUE partial sobre sale_client_tx_id: dos intenciones distintas no pueden reservar el mismo clientTxId. Combina con la UNIQUE partial sobre sales."clientTxId" (migración 009) para cerrar la ventana de doble materialización.';
COMMENT ON INDEX ux_pqpi_related_sale_id IS
    'UNIQUE partial sobre related_sale_id: una venta materializada ↔ exactamente una intención. Si por bug dos intenciones apuntaran al mismo saleId, la segunda escritura falla.';
COMMENT ON INDEX ix_pqpi_queued_bandeja IS
    'Hot path de la bandeja global en /sales/new: pendientes encolados por caja_id, ordenados por queued_at DESC. Partial para que el B-tree ignore intenciones terminales y las que aún viven detrás de un modal abierto.';
COMMENT ON INDEX ix_pqpi_finalization_retry IS
    'Hot path del barredor de reintentos: FAILED cuyo next_retry_at ya pasó. Partial para no cargar con intenciones NOT_STARTED, IN_PROGRESS o SUCCEEDED.';
COMMENT ON INDEX ix_pqpi_finalization_in_progress IS
    'Detección de atascos: materializadores IN_PROGRESS que llevan demasiado tiempo (caída del proceso durante la tx). Partial para que el barrido administrativo sea O(1) en el 99 % de los casos.';
