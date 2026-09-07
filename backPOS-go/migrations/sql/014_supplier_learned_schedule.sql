-- Sprint 9: aprendizaje pasivo de la agenda real de cada proveedor.
--
-- POR QUÉ existe esta migración
-- ============================================================================
-- El dueño configura a mano en la ficha del proveedor los días en que viene el
-- preventista (visit_days) y los días en que llega el pedido (delivery_days).
-- Ese dato manual es sagrado y cambiarlo automáticamente ya nos quemó una vez:
-- visit_frequency_days lo sobreescribe un batch nocturno y el dueño perdió su
-- configuración sin saber por qué. NO vamos a repetir ese error.
--
-- A la vez, sí queremos que el sistema aprenda observando los pedidos ya
-- confirmados y recibidos, para poder sugerir "parece que este proveedor
-- llega los miércoles" cuando el dueño no ha configurado nada, o para
-- avisarle "tú dijiste martes pero en los últimos 6 pedidos vino miércoles".
--
-- La solución es escribir el conocimiento aprendido en COLUMNAS SEPARADAS.
-- El proceso de aprendizaje sólo toca las columnas learned_*. El dueño sigue
-- controlando visit_days y delivery_days sin que ningún job automático las
-- pise. La UI decidirá qué mostrar (manual, aprendido, o comparación).
--
-- REGLA DE ORO PARA QUIEN AGREGUE CÓDIGO DESPUÉS
-- ============================================================================
-- Las columnas learned_* NO son un reemplazo de visit_days ni delivery_days.
-- Ningún proceso automático puede escribir en visit_days ni en delivery_days;
-- esas dos son propiedad exclusiva del dueño. Si necesitas sugerir un cambio
-- basado en lo aprendido, se lo propones en la UI, no lo escribes tú.
--
-- QUÉ APRENDE Y DE DÓNDE
-- ============================================================================
-- El batch de aprendizaje agrupa por proveedor los pedidos ya recibidos:
--
--     SELECT supplier_id, confirmed_at, received_at
--       FROM confirmed_orders
--      WHERE received_at IS NOT NULL;
--
-- De ahí saca:
--   - learned_visit_days:    día(s) de la semana de confirmed_at
--   - learned_delivery_days: día(s) de la semana de received_at
--   - learned_lead_time_days: mediana(received_at - confirmed_at)
--   - learned_sample_count:  cuántos pedidos respaldan los cálculos
--   - learned_at:            timestamp del último recálculo
--
-- ÍNDICE
-- ============================================================================
-- La consulta filtra received_at IS NOT NULL y agrupa por supplier_id. Un
-- índice B-tree sobre (supplier_id, received_at) con predicado parcial
-- WHERE received_at IS NOT NULL:
--   1) Descarta desde el índice los pedidos aún pendientes o en tránsito
--      (que son mayoría al principio de cada ciclo).
--   2) Permite index-only scans para el batch de aprendizaje.
--   3) Es más pequeño que un índice total y no compite en cache con las
--      escrituras del flujo de recepción.
-- Justifica su costo aunque la tabla sea moderada, porque el batch va a
-- correrse periódicamente (probablemente diario) y confirmed_orders crece
-- monotónicamente con el tiempo.
--
-- TRANSACCIONAL: NO
-- ============================================================================
-- confirmed_orders es una tabla caliente: el flujo de recepción hace UPDATE
-- para setear received_at justo cuando el dueño confirma que llegó el pedido.
-- Un CREATE INDEX plano tomaría un ShareLock que bloquearía esas escrituras
-- durante la construcción del índice. Usamos CREATE INDEX CONCURRENTLY para
-- no congelar el flujo operativo. CONCURRENTLY exige autocommit, así que
-- esta migración se marca como NO transaccional en catalog.go (la lista de
-- excepciones ya incluye 8, 9, 11 y 13; ahora se agrega la 14).
--
-- Los ALTER TABLE ADD COLUMN IF NOT EXISTS corren en autocommit dentro del
-- mismo archivo. En PostgreSQL 11+ agregar una columna JSONB/INTEGER/TIMESTAMPTZ
-- con default constante (o sin default) es una operación metadata-only, casi
-- instantánea, así que no necesita transacción envolvente.
--
-- NO MODIFICA DATOS
-- ============================================================================
-- Esta migración sólo agrega estructura (columnas nuevas + un índice). NO
-- ejecuta ni un UPDATE, ni un DELETE, ni un INSERT sobre datos de negocio.
-- El backfill inicial lo hará el job de aprendizaje la primera vez que corra,
-- escribiendo únicamente en las columnas learned_* recién creadas.

-- ----------------------------------------------------------------------------
-- 1) Columnas nuevas en suppliers (agenda aprendida, paralela a la manual).
-- ----------------------------------------------------------------------------

ALTER TABLE suppliers
    ADD COLUMN IF NOT EXISTS learned_visit_days JSONB NULL;

ALTER TABLE suppliers
    ADD COLUMN IF NOT EXISTS learned_delivery_days JSONB NULL;

ALTER TABLE suppliers
    ADD COLUMN IF NOT EXISTS learned_lead_time_days INTEGER NULL;

ALTER TABLE suppliers
    ADD COLUMN IF NOT EXISTS learned_sample_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE suppliers
    ADD COLUMN IF NOT EXISTS learned_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN suppliers.learned_visit_days IS
    'Días de semana en que históricamente vino el preventista, aprendidos de confirmed_orders.confirmed_at. NO reemplaza visit_days: esa la escribe el dueño y ningún proceso automático la toca.';
COMMENT ON COLUMN suppliers.learned_delivery_days IS
    'Días de semana en que históricamente llegó el pedido, aprendidos de confirmed_orders.received_at. NO reemplaza delivery_days: esa la escribe el dueño y ningún proceso automático la toca.';
COMMENT ON COLUMN suppliers.learned_lead_time_days IS
    'Días observados entre confirmed_at y received_at (mediana). Sólo lo escribe el job de aprendizaje.';
COMMENT ON COLUMN suppliers.learned_sample_count IS
    'Cuántos pedidos recibidos respaldan las columnas learned_*. 0 = todavía no hay evidencia suficiente.';
COMMENT ON COLUMN suppliers.learned_at IS
    'Timestamp del último recálculo del bloque learned_*. NULL = nunca se ha calculado.';

-- ----------------------------------------------------------------------------
-- 2) Índice parcial para el batch de aprendizaje.
--    Consulta objetivo:
--      SELECT supplier_id, confirmed_at, received_at
--        FROM confirmed_orders
--       WHERE received_at IS NOT NULL;
-- ----------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_confirmed_orders_supplier_received
    ON confirmed_orders (supplier_id, received_at)
    WHERE received_at IS NOT NULL;
