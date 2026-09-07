-- Sprint 8+: acelerar el camino caliente de "Pedidos Inteligentes" y desbloquear
-- el botón + cuando el stock quedó negativo.
--
-- POR QUÉ existe esta migración
-- ============================================================================
-- 1) La pantalla de Pedidos Inteligentes calcula, por cada producto activo, la
--    fecha de la última recepción usando:
--
--        SELECT barcode, MAX(date)
--          FROM stock_movements
--         WHERE reason = 'RECEPTION'
--         GROUP BY barcode;
--
--    Hoy el único índice útil es idx_stock_movements_barcode_reason_date
--    (barcode, reason, date DESC), creado en 011. Ese índice cubre TODOS los
--    reason (SALE, RECEPTION, ADJUSTMENT, RETURN, SHRINKAGE, …); en tiendas
--    reales el 90%+ de las filas de stock_movements son ventas, así que el
--    planificador termina escaneando páginas llenas de ruido para responder
--    una consulta que sólo mira recepciones. Un índice PARCIAL con
--    WHERE reason = 'RECEPTION' sobre (barcode, date DESC) es al menos un
--    orden de magnitud más pequeño, cabe en memoria, y permite responder el
--    MAX(date) por barcode con un index-only scan. Eso es lo que hace bajar
--    de segundos a milisegundos la carga de la pantalla de pedidos y también
--    la de inventario, que consume la misma métrica.
--
-- 2) product_restock_metrics es la tabla que llena el batch nocturno con la
--    foto agregada de cada producto. Hoy last_reception_at y
--    sold_since_reception se recalculan en caliente en cada request de
--    /restock/suggestions (dos subconsultas contra stock_movements y
--    sale_details). Guardarlos precalculados en la tabla permite que la
--    pantalla lea una sola fila por producto, sin ventanas ni GROUP BY.
--    El batch nocturno los rellena; el hot path los expone.
--
-- TRANSACCIONAL: NO
-- ============================================================================
-- Esta migración usa CREATE INDEX CONCURRENTLY para no bloquear stock_movements
-- (tabla caliente, la escriben ventas, recepciones, mermas, devoluciones).
-- CONCURRENTLY exige que la sentencia corra fuera de una transacción, así que
-- el catálogo marca la 013 como no transaccional (ver catalog.go: la lista de
-- excepciones incluye la 8, 9, 11 y ahora la 13).
--
-- Los ALTER TABLE ADD COLUMN IF NOT EXISTS se ejecutan en autocommit dentro
-- del mismo archivo. En PostgreSQL 11+ agregar una columna con DEFAULT
-- constante es una operación metadata-only, así que es rápida aunque no vaya
-- envuelta en transacción.

-- Índice parcial para MAX(date) por barcode entre las recepciones.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_movements_reception_barcode_date
    ON stock_movements (barcode, date DESC)
    WHERE reason = 'RECEPTION';

-- Columnas nuevas en product_restock_metrics para el precálculo nocturno.
ALTER TABLE product_restock_metrics
    ADD COLUMN IF NOT EXISTS last_reception_at TIMESTAMPTZ NULL;

ALTER TABLE product_restock_metrics
    ADD COLUMN IF NOT EXISTS sold_since_reception NUMERIC(14,3) NOT NULL DEFAULT 0;
