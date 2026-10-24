-- Sprint OTP cajón: apertura manual segura del cajón de dinero desde la
-- tecla física Home de /sales/new, con challenge OTP para empleados y
-- override admin auditado.
--
-- POR QUÉ existe esta migración
-- ============================================================================
-- Hoy (migración 016) cash_drawer_opens audita cada apertura del cajón y la
-- regla operativa a nivel BD es "no abrir sin venta salvo admin" vía el
-- CHECK ck_cash_drawer_opens_sale_or_admin: toda apertura debe tener O una
-- venta, O una devolución, O ser un override admin. Esto es correcto para
-- aperturas que vienen de /sales (venta cerrada → kickdrawer automático),
-- de /returns (devolución confirmada → kickdrawer) o del botón admin
-- "Abrir cajón" en pantallas administrativas (override).
--
-- Lo que todavía NO cubre: la apertura MANUAL fuera de venta/devolución.
-- El caso de uso real:
--
--   - El cajero necesita abrir el cajón entre ventas para dar cambio en
--     efectivo pedido por un cliente, para intercambiar denominaciones
--     con otra caja, para corregir un billete que entró doblado, etc.
--     No hay venta reciente a la cual atar la apertura, y el cajero NO
--     es admin, por lo que el override tampoco aplica.
--
-- Hasta ahora la "solución" era que el cajero inventara una venta cero o
-- llamara al admin para que escanee su DNI, lo cual (a) rompe el cuadre
-- real porque la venta cero existe en kardex y en el cuadre, (b) desvía
-- al admin de su trabajo y (c) convierte el override admin en una tecla
-- de desbloqueo rutinaria que pierde su carácter excepcional.
--
-- El dueño pidió exactamente esto: la tecla física Home dentro de
-- /sales/new abre un modal "¿querés abrir el cajón?". Si el actor es
-- admin, el modal confirma y abre con override auditado (reason='admin_override').
-- Si es empleado, pide un OTP: el servidor genera un código numérico
-- aleatorio, lo manda por Telegram al chat de administración, el cajero
-- lo escribe en el modal, el servidor lo valida y SÓLO entonces habilita
-- el pulso físico del cajón (handler envía kick al bridge local o al
-- driver ESC/POS, independiente de impresión).
--
-- Esta migración crea el soporte de BD para el challenge OTP y amplía
-- cash_drawer_opens para admitir la apertura "otp_manual" como una
-- cuarta justificación legítima (sale/return/admin/otp).
--
-- QUÉ SE CREA
-- ============================================================================
-- 1) Tabla `cash_drawer_otp_challenges`: una fila por challenge emitido.
--
--    - `challenge_id` opaco UNIQUE: identifica el challenge desde el
--      cliente. Es un string ASCII generado por crypto/rand en el handler
--      (p. ej. 32 nibbles hex); NUNCA lleva el DNI ni el OTP. Lo que el
--      cliente ve y manda de vuelta al validar.
--
--    - `requested_by_dni`: DNI del actor que pidió el OTP, sacado de la
--      sesión por el handler. El cliente NO lo manda libremente.
--
--    - `code_hash BYTEA`: hash bcrypt del OTP numérico. El OTP en claro
--      JAMÁS se persiste; viaja únicamente por Telegram y vuelve al
--      servidor en el POST de validación. El CHECK de tamaño asegura que
--      sea un hash bcrypt plausible (bcrypt emite ~60 bytes ASCII; el
--      rango 59..72 cubre $2a$/$2b$/$2y$ con cost 10..14 sin dejar entrar
--      strings vacíos ni blobs enormes). JSON no aplica a nivel SQL
--      porque bcrypt produce bytes y una columna BYTEA es la forma
--      directa; el handler Go hace bcrypt.GenerateFromPassword / CompareHashAndPassword.
--
--    - `expires_at`: el handler le da típicamente 2 minutos. Pasado ese
--      instante el challenge no puede consumirse aunque el status siga
--      en PENDING; un job de limpieza (o el propio validador en línea)
--      lo marca EXPIRED. CHECK ck_cdoc_expires_after_created obliga a
--      que la ventana sea positiva.
--
--    - `attempts_used` / `attempts_max`: máximo 3 intentos por challenge.
--      El handler incrementa attempts_used en cada intento fallido; al
--      llegar a attempts_max el challenge pasa a FAILED. attempts_max
--      queda como columna (no constante) por si una política futura
--      necesita ampliarlo para un chat o cambiarlo transitoriamente;
--      hoy el default es 3 y el CHECK impide un valor < 1.
--
--    - `status` CHECK IN ('PENDING','CONSUMED','FAILED','EXPIRED','CANCELLED'):
--        * PENDING: emitido, aún se puede validar.
--        * CONSUMED: validado correctamente, el cajón se abrió.
--        * FAILED:   agotó attempts_max sin acertar.
--        * EXPIRED:  pasó expires_at sin validar.
--        * CANCELLED: el actor pidió otro (p. ej. cerró el modal y lo
--                     volvió a abrir) o un admin lo invalidó manualmente.
--
--    - `consumed_at` y `consumed_drawer_open_id`: se poblan en la misma
--      transacción que inserta la fila en cash_drawer_opens con
--      reason='otp_manual'. CHECK ck_cdoc_consumed_coherent fuerza la
--      biyección: si status='CONSUMED' entonces los dos campos deben
--      estar poblados; si status es cualquier otro ambos deben ser NULL.
--      consumed_drawer_open_id lleva FK dura a cash_drawer_opens(id)
--      con ON DELETE RESTRICT: cash_drawer_opens es una tabla de
--      auditoría append-only y nunca se borra; RESTRICT es un seguro
--      contra DELETE accidental.
--
-- 2) Índices:
--    - UNIQUE sobre challenge_id (unicidad global).
--    - UNIQUE PARCIAL sobre requested_by_dni WHERE status='PENDING':
--      permite UN challenge vivo por actor a la vez. Si el cajero pide
--      un segundo OTP sin consumir el primero, el handler primero debe
--      CANCELLED-ear el PENDING vigente (lo que elimina la fila del
--      índice parcial y libera el slot). Evita que un operador acumule
--      challenges PENDING paralelos y que un atacante dispare N OTPs en
--      serie para hacer DoS al chat de Telegram.
--    - Índice parcial sobre expires_at WHERE status='PENDING' para el
--      job de expiración (recorre los que vencieron).
--    - Índice por actor+created_at DESC para la auditoría "qué OTPs
--      pidió este empleado".
--
-- 3) `cash_drawer_opens` recibe cuatro cambios coordinados:
--
--    a) Columna `otp_challenge_id BIGINT NULL` con FK dura a
--       `cash_drawer_otp_challenges(id)` ON DELETE RESTRICT. Nullable
--       porque las aperturas sale/return/admin_override no tienen
--       challenge asociado. UNIQUE PARCIAL en el índice para que un
--       challenge nunca pueda consumirse en dos aperturas distintas.
--
--    b) El CHECK anónimo original `reason IN ('sale','return','admin_override','other')`
--       se reemplaza por un CHECK con nombre estable
--       `ck_cash_drawer_opens_reason_known` que amplía el repertorio
--       con 'otp_manual'. Se busca por contenido para no depender del
--       nombre autogenerado (<table>_<col>_check); si el constraint
--       anterior ya fue reemplazado por una ejecución previa, el
--       lookup no devuelve filas y el bloque es idempotente.
--
--    c) El CHECK `ck_cash_drawer_opens_sale_or_admin` se reemplaza por
--       `ck_cash_drawer_opens_sale_admin_return_otp`, que admite CUATRO
--       justificaciones: venta, devolución, override admin o challenge
--       OTP. El nuevo CHECK es ESTRICTAMENTE más permisivo que el
--       anterior (toda fila que satisfacía el viejo satisface el nuevo),
--       así que no hay violación posible en datos existentes.
--
--    d) Se añade `ck_cash_drawer_opens_otp_reason_coherent`, biyección
--       exacta entre reason='otp_manual' y otp_challenge_id IS NOT NULL:
--       un otp_challenge_id sólo tiene sentido con reason='otp_manual',
--       y una apertura marcada 'otp_manual' DEBE llevar su challenge.
--
-- QUÉ NO HACE
-- ============================================================================
-- - NO transporta el OTP en claro por ningún campo. El cliente nunca
--   recibe el hash; el servidor nunca persiste el OTP. Lo único que
--   fluye del servidor hacia el cliente es `challenge_id` y la ventana
--   `expires_at`.
--
-- - NO toca el canal Telegram. El handler Go reutiliza el bot ya
--   existente (jobs_orchestrator / alertas). Esta migración NO crea
--   tabla de mensajes de Telegram ni message_id de referencia; si una
--   migración futura necesita borrar el mensaje del chat tras consumo,
--   es una 026 posterior.
--
-- - NO cambia la semántica de override_admin. Admin sigue abriendo con
--   reason='admin_override' y override_admin=TRUE, authorized_by_dni
--   poblado. El nuevo flujo OTP es un camino PARALELO para empleados,
--   NO un sustituto del override admin.
--
-- - NO ejecuta semillas, backfill ni UPDATE. La tabla arranca vacía;
--   los challenges nacen a demanda cuando un cajero presiona Home.
--
-- - NO modifica la 024 ni ninguna migración ya aplicada. Preserva el
--   catálogo POSINT y las coherencias cruzadas de la 024 intactas.
--
-- TRANSACCIONAL: SÍ
-- ============================================================================
-- Esta migración NO usa CREATE INDEX CONCURRENTLY. Todo DDL corre dentro
-- de la transacción por defecto del runner, con rollback automático si
-- algún paso falla. Por eso NO se añade a la lista de excepciones
-- transaccionales en catalog.go (que hoy incluye 8, 9, 11, 13, 14, 15 y
-- 18). Las tablas afectadas son chicas:
--   - cash_drawer_otp_challenges arranca vacía.
--   - cash_drawer_opens es append-only y hoy tiene poblado reciente;
--     el ALTER TABLE ADD COLUMN con DEFAULT NULL es instantáneo (no
--     reescribe filas); los ALTER TABLE ADD CONSTRAINT ... CHECK fuerzan
--     un scan rápido para validar las filas vigentes, pero el nuevo
--     repertorio de `reason` incluye el viejo y el nuevo CHECK de
--     sale/admin/return/otp es estrictamente más permisivo, así que el
--     scan jamás encuentra violaciones.
--
-- NO MODIFICA DATOS DE NEGOCIO
-- ============================================================================
-- Puramente DDL: CREATE TABLE, CREATE INDEX, ALTER TABLE ADD COLUMN,
-- ALTER TABLE ADD/DROP CONSTRAINT, COMMENT. Ni un UPDATE, ni un DELETE,
-- ni un INSERT.
--
-- REVERSIBILIDAD (manual, con API detenido y respaldo)
-- ============================================================================
-- Si hubiera que deshacer la 025 después de aplicada, la secuencia en
-- una sola transacción (BEGIN/COMMIT) es:
--
--   1) ALTER TABLE cash_drawer_opens DROP CONSTRAINT IF EXISTS
--        ck_cash_drawer_opens_otp_reason_coherent;
--   2) ALTER TABLE cash_drawer_opens DROP CONSTRAINT IF EXISTS
--        ck_cash_drawer_opens_sale_admin_return_otp;
--      -- Reinstala el guardián original estrictamente más estricto:
--      ALTER TABLE cash_drawer_opens ADD CONSTRAINT
--        ck_cash_drawer_opens_sale_or_admin
--        CHECK (override_admin OR sale_id IS NOT NULL OR return_id IS NOT NULL);
--      -- Antes de aplicar, confirmar que no quedan filas con otp_manual
--      -- sin override/sale/return: `SELECT COUNT(*) FROM cash_drawer_opens
--      -- WHERE reason='otp_manual' AND sale_id IS NULL AND return_id IS NULL
--      -- AND NOT override_admin;` debe ser 0. Si no, decidir cómo
--      -- reclasificarlas antes de bajar el CHECK.
--   3) ALTER TABLE cash_drawer_opens DROP CONSTRAINT IF EXISTS
--        ck_cash_drawer_opens_reason_known;
--      -- Reinstala el CHECK inline anónimo original:
--      ALTER TABLE cash_drawer_opens ADD CONSTRAINT
--        cash_drawer_opens_reason_check
--        CHECK (reason IN ('sale','return','admin_override','other'));
--      -- Antes de aplicar, confirmar que no quedan filas con reason='otp_manual'.
--   4) DROP INDEX IF EXISTS ux_cash_drawer_opens_otp_challenge;
--   5) ALTER TABLE cash_drawer_opens DROP CONSTRAINT IF EXISTS
--        fk_cash_drawer_opens_otp_challenge;
--   6) ALTER TABLE cash_drawer_opens DROP COLUMN IF EXISTS otp_challenge_id;
--   7) DROP TABLE IF EXISTS cash_drawer_otp_challenges;
--   8) Borrar la fila `version = 25` de `schema_migrations` para que el
--      runner no vuelva a validar su checksum. Un operador que ejecute
--      este rollback debe hacerlo manualmente con una sentencia DML
--      explícita; esta migración NO incluye el borrado para no violar
--      la regla "puramente DDL" del propio archivo.

-- ----------------------------------------------------------------------------
-- 1) Tabla principal: challenges OTP para apertura manual del cajón.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cash_drawer_otp_challenges (
    id                        BIGSERIAL     PRIMARY KEY,
    challenge_id              VARCHAR(64)   NOT NULL,
    requested_by_dni          VARCHAR(32)   NOT NULL,
    code_hash                 BYTEA         NOT NULL,
    created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    expires_at                TIMESTAMPTZ   NOT NULL,
    attempts_used             INTEGER       NOT NULL DEFAULT 0,
    attempts_max              INTEGER       NOT NULL DEFAULT 3,
    status                    VARCHAR(16)   NOT NULL DEFAULT 'PENDING',
    consumed_at               TIMESTAMPTZ,
    consumed_drawer_open_id   BIGINT,
    CONSTRAINT ck_cdoc_status_known
        CHECK (status IN ('PENDING', 'CONSUMED', 'FAILED', 'EXPIRED', 'CANCELLED')),
    CONSTRAINT ck_cdoc_attempts_bounds
        CHECK (
            attempts_max  >= 1
            AND attempts_used >= 0
            AND attempts_used <= attempts_max
        ),
    CONSTRAINT ck_cdoc_expires_after_created
        CHECK (expires_at > created_at),
    CONSTRAINT ck_cdoc_code_hash_bcrypt_size
        CHECK (octet_length(code_hash) BETWEEN 59 AND 72),
    CONSTRAINT ck_cdoc_consumed_coherent
        CHECK (
            (status <> 'CONSUMED'
                AND consumed_at IS NULL
                AND consumed_drawer_open_id IS NULL)
            OR
            (status = 'CONSUMED'
                AND consumed_at IS NOT NULL
                AND consumed_drawer_open_id IS NOT NULL)
        )
);

-- Unicidad global del challenge_id opaco emitido al cliente. Un segundo
-- INSERT con el mismo valor viola la UNIQUE y fuerza al generador a
-- reintentar con otro candidato (crypto/rand en el handler).
CREATE UNIQUE INDEX IF NOT EXISTS ux_cdoc_challenge_id
    ON cash_drawer_otp_challenges (challenge_id);

-- Un PENDING vivo por actor: evita que un empleado acumule challenges
-- paralelos y mitiga DoS contra el chat Telegram. Antes de pedir un
-- nuevo OTP, el handler debe CANCELLED-ear el PENDING previo (lo que
-- saca la fila del índice parcial y libera el slot).
CREATE UNIQUE INDEX IF NOT EXISTS ux_cdoc_live_by_actor
    ON cash_drawer_otp_challenges (requested_by_dni)
    WHERE status = 'PENDING';

-- Hot path del job de expiración: recorrer challenges vencidos sin
-- scanear filas CONSUMED/FAILED/EXPIRED/CANCELLED.
CREATE INDEX IF NOT EXISTS ix_cdoc_expiry_pending
    ON cash_drawer_otp_challenges (expires_at)
    WHERE status = 'PENDING';

-- Auditoría "qué OTPs pidió este empleado en la última semana".
CREATE INDEX IF NOT EXISTS ix_cdoc_actor_created
    ON cash_drawer_otp_challenges (requested_by_dni, created_at DESC);

COMMENT ON TABLE cash_drawer_otp_challenges IS
    'Challenges OTP para apertura manual del cajón de dinero disparada por la tecla Home de /sales/new cuando el actor no es admin. El OTP en claro NUNCA se persiste: viaja por Telegram y vuelve al servidor en el POST de validación; aquí guardamos sólo bcrypt(code_hash). La biyección exacta entre reason=otp_manual y otp_challenge_id en cash_drawer_opens vive en ck_cash_drawer_opens_otp_reason_coherent (misma migración).';
COMMENT ON COLUMN cash_drawer_otp_challenges.challenge_id IS
    'Identificador opaco emitido al cliente para que lo mande de vuelta al validar. ASCII hex de crypto/rand (típicamente 32 nibbles). NUNCA contiene el DNI ni el OTP: su único propósito es correlacionar la petición de emisión con la de validación.';
COMMENT ON COLUMN cash_drawer_otp_challenges.requested_by_dni IS
    'DNI del empleado que pidió el OTP, tomado por el handler desde la sesión. Nunca lo manda el cliente libremente; eso permitiría a un empleado emitir challenges a nombre de otro.';
COMMENT ON COLUMN cash_drawer_otp_challenges.code_hash IS
    'bcrypt(OTP). BYTEA porque el handler Go usa bcrypt.GenerateFromPassword / bcrypt.CompareHashAndPassword, que trabajan sobre bytes. No es JSON ni texto en claro. El CHECK ck_cdoc_code_hash_bcrypt_size restringe el tamaño al rango que emite bcrypt (~60 bytes) para que no entre un string vacío ni un blob accidental.';
COMMENT ON COLUMN cash_drawer_otp_challenges.expires_at IS
    'Momento después del cual el challenge no puede consumirse aunque status siga PENDING. El handler lo setea típicamente a NOW()+2min; el validador en línea y el job de limpieza (ix_cdoc_expiry_pending) lo mueven a EXPIRED.';
COMMENT ON COLUMN cash_drawer_otp_challenges.attempts_used IS
    'Intentos fallidos acumulados en este challenge. El handler incrementa en cada POST de validación con código erróneo; al llegar a attempts_max el challenge pasa a FAILED y el actor debe pedir uno nuevo (lo que primero CANCELLED-ea el FAILED es innecesario porque FAILED ya no cae en ux_cdoc_live_by_actor).';
COMMENT ON COLUMN cash_drawer_otp_challenges.attempts_max IS
    'Techo de intentos (default 3). Es columna, no constante, para permitir una política futura por chat/rol sin requerir migración.';
COMMENT ON COLUMN cash_drawer_otp_challenges.status IS
    'PENDING: emitido, aún validable. CONSUMED: validado y cajón abierto (consumed_at y consumed_drawer_open_id poblados). FAILED: agotó attempts_max. EXPIRED: pasó expires_at sin validar. CANCELLED: el actor pidió otro o un admin lo invalidó. Nunca se borra: la auditoría preserva el histórico de intentos.';
COMMENT ON COLUMN cash_drawer_otp_challenges.consumed_drawer_open_id IS
    'FK dura a cash_drawer_opens(id) ON DELETE RESTRICT. La biyección con reason=otp_manual vive en ck_cash_drawer_opens_otp_reason_coherent. RESTRICT porque cash_drawer_opens es append-only; si alguien intenta borrar la fila referenciada, el error legible es preferible a perder la trazabilidad del consumo.';

-- FK dura hacia cash_drawer_opens: se agrega vía DO $$ porque Postgres
-- no admite ADD CONSTRAINT IF NOT EXISTS y el runner debe poder
-- reintentar la migración tras un fallo parcial.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'fk_cdoc_consumed_drawer_open'
    ) THEN
        ALTER TABLE cash_drawer_otp_challenges
            ADD CONSTRAINT fk_cdoc_consumed_drawer_open
            FOREIGN KEY (consumed_drawer_open_id)
            REFERENCES cash_drawer_opens(id)
            ON DELETE RESTRICT;
    END IF;
END $$;

COMMENT ON CONSTRAINT fk_cdoc_consumed_drawer_open ON cash_drawer_otp_challenges IS
    'ON DELETE RESTRICT porque cash_drawer_opens es append-only. Si alguien intenta borrar una fila referenciada, el error legible es preferible a perder la trazabilidad del consumo.';

-- ----------------------------------------------------------------------------
-- 2) cash_drawer_opens: nueva columna otp_challenge_id y su FK.
-- ----------------------------------------------------------------------------

ALTER TABLE cash_drawer_opens
    ADD COLUMN IF NOT EXISTS otp_challenge_id BIGINT NULL;

COMMENT ON COLUMN cash_drawer_opens.otp_challenge_id IS
    'FK dura a cash_drawer_otp_challenges(id) ON DELETE RESTRICT. Nullable porque las aperturas sale/return/admin_override no llevan challenge. UNIQUE PARCIAL (ux_cash_drawer_opens_otp_challenge) para que un challenge nunca se consuma dos veces. La biyección exacta con reason=otp_manual vive en ck_cash_drawer_opens_otp_reason_coherent.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'fk_cash_drawer_opens_otp_challenge'
    ) THEN
        ALTER TABLE cash_drawer_opens
            ADD CONSTRAINT fk_cash_drawer_opens_otp_challenge
            FOREIGN KEY (otp_challenge_id)
            REFERENCES cash_drawer_otp_challenges(id)
            ON DELETE RESTRICT;
    END IF;
END $$;

COMMENT ON CONSTRAINT fk_cash_drawer_opens_otp_challenge ON cash_drawer_opens IS
    'ON DELETE RESTRICT: un challenge consumido nunca debe desaparecer mientras exista la apertura que lo consumió. cash_drawer_otp_challenges tampoco se borra en operación normal (status cambia, filas quedan).';

-- UNIQUE PARCIAL: un challenge se consume en una sola apertura. El
-- índice es parcial para no bloquear aperturas pre-025 que llevan
-- otp_challenge_id = NULL (todas las existentes al aplicar).
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_drawer_opens_otp_challenge
    ON cash_drawer_opens (otp_challenge_id)
    WHERE otp_challenge_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3) cash_drawer_opens.reason: reemplazar CHECK inline anónimo heredado
--    de la 016 por un CHECK con nombre estable que incluye 'otp_manual'.
-- ----------------------------------------------------------------------------
--
-- La 016 declaró `reason VARCHAR(16) NOT NULL CHECK (reason IN (...))`
-- inline, por lo que Postgres le dio nombre autogenerado (típicamente
-- `cash_drawer_opens_reason_check`). En vez de depender del nombre,
-- buscamos el CHECK vigente por contenido: cualquier CHECK sobre
-- cash_drawer_opens que referencie `reason` y NO contenga 'otp_manual'
-- es el inline heredado de la 016. Si ya fue reemplazado (ejecución
-- previa), el lookup no devuelve filas y el bloque es idempotente.

DO $$
DECLARE
    legacy_check_name TEXT;
BEGIN
    SELECT c.conname INTO legacy_check_name
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'cash_drawer_opens'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ~* '\mreason\M'
       AND pg_get_constraintdef(c.oid) NOT ILIKE '%otp_manual%'
       AND c.conname <> 'ck_cash_drawer_opens_otp_reason_coherent'
     LIMIT 1;

    IF legacy_check_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE cash_drawer_opens DROP CONSTRAINT %I', legacy_check_name);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_cash_drawer_opens_reason_known'
    ) THEN
        ALTER TABLE cash_drawer_opens
            ADD CONSTRAINT ck_cash_drawer_opens_reason_known
            CHECK (reason IN ('sale', 'return', 'admin_override', 'other', 'otp_manual'));
    END IF;
END $$;

COMMENT ON CONSTRAINT ck_cash_drawer_opens_reason_known ON cash_drawer_opens IS
    'Repertorio cerrado de razones admitidas para auditar la apertura del cajón. Reemplaza al CHECK inline anónimo de la 016 e incorpora otp_manual (apertura con challenge OTP validado, migración 025). El nombre explícito evita depender del nombre autogenerado por Postgres y permite drops idempotentes en migraciones futuras.';

-- ----------------------------------------------------------------------------
-- 4) cash_drawer_opens: ampliar el guardián sale_or_admin a cuatro
--    justificaciones (sale/admin/return/otp).
-- ----------------------------------------------------------------------------
--
-- El CHECK de la 016 (ck_cash_drawer_opens_sale_or_admin) exigía
-- "override_admin OR sale_id OR return_id". El nuevo CHECK añade
-- "OR otp_challenge_id IS NOT NULL". Es estrictamente más permisivo:
-- toda fila que satisfacía el viejo satisface el nuevo. No hay
-- violaciones posibles en datos existentes.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_cash_drawer_opens_sale_or_admin'
    ) THEN
        ALTER TABLE cash_drawer_opens
            DROP CONSTRAINT ck_cash_drawer_opens_sale_or_admin;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_cash_drawer_opens_sale_admin_return_otp'
    ) THEN
        ALTER TABLE cash_drawer_opens
            ADD CONSTRAINT ck_cash_drawer_opens_sale_admin_return_otp
            CHECK (
                sale_id IS NOT NULL
                OR return_id IS NOT NULL
                OR override_admin
                OR otp_challenge_id IS NOT NULL
            );
    END IF;
END $$;

COMMENT ON CONSTRAINT ck_cash_drawer_opens_sale_admin_return_otp ON cash_drawer_opens IS
    'Toda apertura del cajón debe declarar O una venta (sale_id), O una devolución (return_id), O un override admin (override_admin=TRUE con authorized_by_dni), O un challenge OTP validado (otp_challenge_id). Reemplaza al ck_cash_drawer_opens_sale_or_admin de la 016 y es estrictamente más permisivo: toda fila legada satisface el nuevo CHECK.';

-- ----------------------------------------------------------------------------
-- 5) cash_drawer_opens: biyección exacta reason='otp_manual' ↔ otp_challenge_id.
-- ----------------------------------------------------------------------------
--
-- No basta con que "si hay otp_challenge_id la fila sea legal". Queremos
-- la biyección exacta: un otp_challenge_id SIN reason=otp_manual no
-- tiene sentido semántico, y una fila con reason=otp_manual SIN
-- otp_challenge_id no auditó qué challenge la autorizó. Esta
-- restricción vive en la BD como defensa en profundidad; el handler
-- puebla ambos campos atómicamente dentro de la misma transacción que
-- marca el challenge como CONSUMED.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ck_cash_drawer_opens_otp_reason_coherent'
    ) THEN
        ALTER TABLE cash_drawer_opens
            ADD CONSTRAINT ck_cash_drawer_opens_otp_reason_coherent
            CHECK (
                (reason = 'otp_manual' AND otp_challenge_id IS NOT NULL)
                OR
                (reason <> 'otp_manual' AND otp_challenge_id IS NULL)
            );
    END IF;
END $$;

COMMENT ON CONSTRAINT ck_cash_drawer_opens_otp_reason_coherent ON cash_drawer_opens IS
    'Biyección exacta entre reason=otp_manual y otp_challenge_id IS NOT NULL. Un otp_challenge_id huérfano (sin reason=otp_manual) sería basura; una apertura marcada otp_manual sin su challenge perdería la trazabilidad. El handler puebla ambos campos en la misma transacción que marca el challenge CONSUMED.';
