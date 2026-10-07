-- Sprint 12: idempotencia anti-doble-cierre de caja.
--
-- POR QUÉ existe esta migración
-- ============================================================================
-- El endpoint POST /dashboard/cashier-closure/close hoy no tiene defensa
-- contra un segundo intento idéntico. El cajero puede:
--
--   1) Hacer doble clic en "CERRAR" cuando la red va lenta.
--   2) Reintentar porque apiFetch respondió "sin conexión" sin saber si el
--      servidor procesó la primera petición.
--   3) Perder la pestaña (unload) con el POST en vuelo y abrirla de nuevo.
--
-- En los tres casos vive hoy un bug reproducido en campo: dos filas en
-- cashier_closures con los mismos totales, dos reportes de Telegram, dos
-- PDFs. El latch del botón (isSubmitting) y el UPDATE WHERE status='OPEN'
-- de active_shifts no sirven: el latch está en el navegador que ya se
-- cayó, y la segunda petición llega después del CLOSE del turno pero el
-- servicio no se da cuenta porque CloseActiveWithTx es idempotente (no
-- devuelve error cuando rowsAffected = 0).
--
-- La solución canónica es un identificador generado por el cliente ANTES
-- del POST (UUID v4 persistido en localStorage con la key
-- `pos_closure_tx_id`), que viaja en el payload como `clientTxId` /
-- columna `client_tx_id`. El backend aplica la regla:
--
--     SELECT id FROM cashier_closures WHERE client_tx_id = ? LIMIT 1;
--     - si existe → responder 200 con el id previo (idempotente);
--     - si no    → INSERT; el UNIQUE parcial garantiza que una carrera
--                   pierde en el COMMIT, no después.
--
-- Es exactamente el mismo patrón que la migración 009 aplicó a sales
-- (`idx_sales_client_tx_id_unique`), probado en producción y respaldado
-- por el guardián sprint2_transaction_rules_test.go.
--
-- POR QUÉ ÍNDICE PARCIAL Y NO UNIQUE DURO
-- ============================================================================
-- Hay cientos de cashier_closures históricos sin este dato. Un UNIQUE NOT
-- NULL exigiría backfillear cada uno con un UUID distinto, lo que es una
-- mutación masiva de datos de negocio que esta migración, por política,
-- NO hace. Las filas antiguas quedan con client_tx_id NULL y el índice
-- parcial WHERE client_tx_id IS NOT NULL las ignora. Idéntica estrategia
-- que la 009 usa para sales (WHERE "clientTxId" IS NOT NULL AND <> '').
--
-- Se incluye también la condición `<> ''` para no colisionar en caso de
-- que un cliente mal escrito mande cadena vacía en vez de omitir el campo.
-- Si llega '', el servidor debe tratarla como "sin idempotencia" (misma
-- semántica que NULL): sin el `<> ''` cada envío con cadena vacía
-- chocaría contra el índice. La misma defensa vive en la 009.
--
-- TOLERANCIA A LA MIGRACIÓN NO APLICADA (backend)
-- ============================================================================
-- Esta migración puede estar escrita y NO aplicada en una instalación
-- vieja. El backend que consume la columna debe comprobar con
-- `to_regclass('public.cashier_closures')` + information_schema.columns
-- (cacheado al arranque) si la columna existe antes de usarla, y volver
-- al comportamiento anterior (sin idempotencia a nivel BD) cuando no está
-- aplicada. La política del repo ya exige esta tolerancia para 016/017,
-- que están pendientes al día de esta migración. La 018 sigue el mismo
-- contrato: aplicarla es un paso operativo separado del despliegue.
--
-- POR QUÉ EL BACKEND NO LA DECLARA EN schemaModels()
-- ============================================================================
-- Agregar un campo `ClientTxID *string gorm:"column:client_tx_id"` al
-- struct `models.CashierClosure` NO cambia la fuente de la migración 002
-- (model_schema), porque el checksum se calcula sobre el string
-- "gorm-model-schema-v1:employees,clients,...,cashier_closures,..." que
-- lista TABLAS, no columnas. Sin embargo, mantenemos la convención del
-- repo: la BD la mutan sólo migraciones numeradas explícitas. El struct
-- del modelo se actualiza aparte, en el PR del backend que consume la
-- columna, no en esta migración.
--
-- TRANSACCIONAL: NO
-- ============================================================================
-- `CREATE UNIQUE INDEX CONCURRENTLY` evita bloquear cashier_closures
-- mientras se construye el índice. PostgreSQL prohíbe CONCURRENTLY dentro
-- de una transacción, así que esta migración se marca como NO
-- transaccional en catalog.go junto con 8, 9, 11, 13, 14 y 15.
--
-- El `ALTER TABLE ADD COLUMN IF NOT EXISTS` nullable es metadata-only en
-- PostgreSQL 11+ (no reescribe filas), así que puede correr en autocommit
-- sin bloquear escrituras concurrentes. El `COMMENT ON COLUMN` también
-- es metadata-only. Ambos son idempotentes.
--
-- Si el `CREATE INDEX CONCURRENTLY` quedó inválido por una interrupción
-- previa, el runner (dropInvalidConcurrentIndex en runner.go) detecta el
-- índice como `pg_index.indisvalid = false` y lo elimina antes de
-- reintentar. Así los reruns no se atascan.
--
-- NO MODIFICA DATOS DE NEGOCIO
-- ============================================================================
-- Puramente DDL: ALTER TABLE ADD COLUMN, CREATE INDEX, COMMENT. Ni un
-- UPDATE, ni un DELETE, ni un INSERT. Las filas históricas quedan con
-- client_tx_id = NULL (ignoradas por el índice parcial), que es
-- intencional: no inventamos UUIDs para cierres cerrados hace meses.

-- ----------------------------------------------------------------------------
-- 1) Columna nullable que recibe el UUID generado por el frontend.
--    No lleva CHECK de formato porque la validación de UUID v4 vive en el
--    handler Go (patrón idéntico al de sales."clientTxId"): la BD sólo
--    exige unicidad, no estructura.
-- ----------------------------------------------------------------------------

ALTER TABLE cashier_closures
    ADD COLUMN IF NOT EXISTS client_tx_id VARCHAR(64) NULL;

COMMENT ON COLUMN cashier_closures.client_tx_id IS
    'UUID v4 generado por el frontend antes del POST /dashboard/cashier-closure/close y persistido en localStorage (pos_closure_tx_id). Permite al backend rechazar un segundo intento idéntico (doble clic, red lenta, replay post-timeout) devolviendo la fila existente en vez de duplicar el cierre. NULL en todas las filas creadas antes de la migración 018; el índice parcial ux_cashier_closures_client_tx_id las ignora.';

-- ----------------------------------------------------------------------------
-- 2) Índice único parcial. CONCURRENTLY para no bloquear la tabla.
--    `WHERE client_tx_id IS NOT NULL AND client_tx_id <> ''` reproduce el
--    predicado de idx_sales_client_tx_id_unique (migración 009): un cliente
--    que mande cadena vacía queda fuera del índice, con la misma semántica
--    que NULL (sin idempotencia a nivel BD).
-- ----------------------------------------------------------------------------

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_cashier_closures_client_tx_id
    ON cashier_closures (client_tx_id)
    WHERE client_tx_id IS NOT NULL AND client_tx_id <> '';

COMMENT ON INDEX ux_cashier_closures_client_tx_id IS
    'Idempotencia anti-doble-cierre. Parcial para no exigir backfill del histórico. El backend consulta `SELECT id FROM cashier_closures WHERE client_tx_id = ? LIMIT 1` dentro de la misma transacción del INSERT; si la fila existe, responde 200 con el id previo. Mismo patrón que idx_sales_client_tx_id_unique (migración 009).';
