-- Sprint 9+: cerrar dos huecos de rendimiento y persistir los porcentajes
-- reales de recepción como columnas dedicadas de stock_movements.
--
-- POR QUÉ existe esta migración
-- ============================================================================
-- 1) Porcentajes de recepción atrapados en JSON.
--    Cada recepción de mercancía guarda DTO %, IVA %, ICUI % e IBUA % de la
--    línea únicamente dentro de stock_movements.metadata (TEXT con un JSON
--    serializado por BulkReceive en internal/adapters/repositories/
--    postgres_product_inventory.go). El vigente vive en products.iva/icui/ibua,
--    pero se sobrescribe con CADA recepción, borrando el histórico. Hoy el
--    frontend (inventory/receive y inventory/history) hace JSON.parse en cada
--    fila para pintar el detalle y, si algún día alguien quiere agregar por
--    proveedor "IVA promedio pagado en el mes", no hay forma de hacerlo en
--    SQL sin desarmar el JSON.
--    La solución es agregar cuatro columnas físicas NUMERIC en
--    stock_movements. El futuro cambio en BulkReceive las poblará junto con
--    la fila; el JSON se mantiene por compatibilidad, sin datos duplicados
--    nuevos que se contradigan (para eso están los tests del backend).
--
-- 2) Índices puntuales para consultas frecuentes que hoy hacen seq scan.
--    Cada uno de los seis índices que se agregan aquí está justificado por
--    una consulta concreta del código; se enumeran abajo. Los índices ya
--    existentes de 008/011/013/014 se dejan como están; esta migración NO
--    los duplica.
--
-- QUÉ CONSULTA ACELERA CADA ÍNDICE
-- ============================================================================
-- idx_clients_credit_debtors
--     internal/adapters/repositories/postgres_client_repository.go:133
--         Where(`COALESCE("currentCredit", 0) > 0`)
--     internal/adapters/handlers/dashboard_export_handler.go:372-374
--         Where(`COALESCE("currentCredit", 0) > 0`).Order(`current_credit DESC`)
--     internal/core/services/working_capital.go:340
--         Where(`"currentCredit" > 0`)
--     internal/core/services/export_service.go:386
--         Where(`deleted_at IS NULL AND "currentCredit" > 0`)
--     Miles de clientes, la mayoría con saldo cero. Un índice parcial con
--     predicado WHERE COALESCE("currentCredit", 0) > 0 AND deleted_at IS NULL
--     cabe en pocas páginas y responde tanto los SUM globales como los
--     rankings ORDER BY "currentCredit" DESC.
--
-- idx_sales_debt_pending_date
--     internal/adapters/repositories/postgres_sale_repository.go:351
--         Where(`"debtPending" > 0`).Order(`"saleDate" DESC`).Limit(100)
--     Hoy sólo existe idx_sales_pending_debts ("clientDni", status,
--     "debtPending", "saleDate") de 008: al no filtrar por clientDni el
--     planificador tiene que hacer index scan por cada prefijo distinto.
--     Un parcial sobre ("saleDate" DESC) WHERE "debtPending" > 0 responde
--     el top-100 en una sola lectura ordenada.
--
-- idx_expenses_pending_debts_date
--     internal/adapters/repositories/postgres_expense_repository.go:265-273
--         GetPendingDebtsSummary()
--             (UPPER(status) = 'PENDING' OR UPPER("paymentSource")
--                 IN ('PRESTAMO', 'PREST.'))
--             AND UPPER(status) NOT IN ('PAID', 'SETTLED')
--     Misma condición en GetExpensesByStatus("PENDING") (línea 279), llamado
--     desde el flujo de settle/pago. idx_expenses_dashboard(date DESC,
--     status, deleted_at) de 008 no sirve porque el WHERE usa UPPER(status)
--     y UPPER("paymentSource"): un B-tree sobre las columnas planas no puede
--     matchear el predicado funcional. Un parcial sobre (date DESC) con
--     exactamente ese predicado (más deleted_at IS NULL, que GORM añade por
--     el soft delete de Expense) sí lo hace.
--
-- idx_missing_items_pendiente_created
--     internal/adapters/repositories/postgres_admin_repository.go:177-183
--         GetRecentPendingMissingItems(limit int)
--             Where("UPPER(status) = ?", "PENDIENTE").
--             Order("created_at desc").Limit(limit)
--     Se ejecuta en cada apertura del dashboard (dashboard_service.go:497).
--     La tabla no tiene índice sobre status ni sobre created_at por sí sola;
--     un parcial (created_at DESC) WHERE UPPER(status) = 'PENDIENTE' AND
--     deleted_at IS NULL responde directo.
--
-- idx_shrinkages_date
--     internal/core/services/export_service.go:521-533
--         Table("shrinkages AS sh").
--         Where(`sh.date BETWEEN ? AND ?`, from, to).
--         Where(`sh.deleted_at IS NULL`).Order(`sh.date DESC`)
--     Shrinkage.Date no lleva tag `gorm:"index"`, así que ni AutoMigrate ni
--     ninguna migración anterior lo cubren. Un B-tree parcial (date DESC)
--     WHERE deleted_at IS NULL resuelve el rango + orden sin scan.
--
-- idx_price_logs_created_at
--     internal/adapters/repositories/postgres_product_repository.go:398-403
--         GetPriceChangesToday():
--             Where("created_at >= ?", startOfDayUnix).Order("created_at DESC")
--     La tabla no tiene índice sobre created_at (es BIGINT Unix epoch en el
--     modelo). El dashboard llama esto en cada refresh; un índice simple
--     (created_at DESC) evita seq scan.
--
-- ÍNDICES DELIBERADAMENTE DESCARTADOS
-- ============================================================================
-- - confirmed_orders(status) y purchase_orders(status) para
--   restock_metrics_repository.go:117,123,425,432. Ambas tablas crecen
--   despacio (una fila por pedido confirmado); el join va por PK; el
--   beneficio es marginal. Reevaluar si un día pasan de decenas de miles
--   de filas.
-- - stock_movements(reference_id, type) para la reversión de recepción.
--   idx_stock_movements_reference_reason (011) ya cubre el filtro principal;
--   la variante por type es una bitmap-scan combinada, aceptable.
-- - expenses.reference_id ya lo cubre el tag gorm:"index" en el modelo, o
--   sea que AutoMigrate (versión 002) generó idx_expenses_reference_id.
-- - products.baseProductBarcode también lo cubre AutoMigrate por tag GORM.
--
-- TRANSACCIONAL: NO
-- ============================================================================
-- Todos los índices se crean con CREATE INDEX CONCURRENTLY porque
-- stock_movements, sales, expenses y clients son tablas calientes (las
-- escriben ventas, recepciones, mermas, devoluciones y pagos de crédito).
-- Un CREATE INDEX plano tomaría un ShareLock que bloquearía esas escrituras
-- durante la construcción del índice. CONCURRENTLY exige autocommit, así
-- que esta migración se marca como NO transaccional en catalog.go (la lista
-- de excepciones ya incluye 8, 9, 11, 13 y 14; ahora se agrega la 15).
--
-- Los ALTER TABLE ADD COLUMN IF NOT EXISTS corren en autocommit dentro del
-- mismo archivo. En PostgreSQL 11+ agregar una columna NUMERIC nullable (o
-- con DEFAULT constante) es una operación metadata-only, casi instantánea,
-- así que no necesita transacción envolvente. Los COMMENT ON COLUMN también
-- son metadata-only.
--
-- NO MODIFICA DATOS
-- ============================================================================
-- Esta migración sólo agrega estructura: cuatro columnas nuevas y seis
-- índices. NO ejecuta ni un UPDATE, ni un DELETE, ni un INSERT sobre datos
-- de negocio. Las filas históricas de stock_movements quedarán con
-- discount_pct/iva_pct/icui_pct/ibua_pct en NULL, que es intencional: no
-- tenemos el porcentaje real de esas recepciones fuera del blob JSON y se
-- prefiere "sin dato" a un cero engañoso. El backfill desde metadata queda
-- para un job separado si se decide extraerlo; no forma parte de esta
-- migración.

-- ----------------------------------------------------------------------------
-- 1) Columnas nuevas en stock_movements para persistir porcentajes reales
--    de la línea de recepción. Se poblan sólo en filas nuevas emitidas por
--    BulkReceive (RECEPTION, RECEPTION_BONUS, PRICE_UPDATE_NO_STOCK) tras
--    el cambio de código correspondiente. Los demás reason (SALE, RETURN,
--    ADJUSTMENT_UP/DOWN, PACK_RECEPTION_BULK, VOID_SALE, etc.) las dejan
--    en NULL porque no tienen porcentajes tributarios asociados.
-- ----------------------------------------------------------------------------

ALTER TABLE stock_movements
    ADD COLUMN IF NOT EXISTS discount_pct NUMERIC(6,3) NULL;

ALTER TABLE stock_movements
    ADD COLUMN IF NOT EXISTS iva_pct NUMERIC(6,3) NULL;

ALTER TABLE stock_movements
    ADD COLUMN IF NOT EXISTS icui_pct NUMERIC(6,3) NULL;

ALTER TABLE stock_movements
    ADD COLUMN IF NOT EXISTS ibua_pct NUMERIC(6,3) NULL;

COMMENT ON COLUMN stock_movements.discount_pct IS
    'Porcentaje de descuento del proveedor aplicado a la línea de recepción (entry.DiscountPct en BulkReceive). NO baja el costo: se traslada al PVP subiendo el margen (pvpSugerido = costoNeto * (1 + (ganPct + dtoPct)/100)). NULL en movimientos que no son recepciones y en recepciones históricas anteriores a la migración 015.';
COMMENT ON COLUMN stock_movements.iva_pct IS
    'Alícuota de IVA aplicada a la línea de recepción (entry.IvaPct en BulkReceive). Snapshot del porcentaje vigente al momento de la recepción; products.iva se sobrescribe con cada recepción y no conserva este histórico. Sólo la escribe BulkReceive; NULL para el resto.';
COMMENT ON COLUMN stock_movements.icui_pct IS
    'Alícuota de ICUI aplicada a la línea de recepción (entry.IcuiPct en BulkReceive). Sólo la escribe BulkReceive; NULL para el resto.';
COMMENT ON COLUMN stock_movements.ibua_pct IS
    'Alícuota de IBUA aplicada a la línea de recepción (entry.IbuaPct en BulkReceive). Sólo la escribe BulkReceive; NULL para el resto.';

-- ----------------------------------------------------------------------------
-- 2) Índices parciales para las consultas frecuentes enumeradas arriba.
--    Nomenclatura recordatoria: las columnas en camelCase van entre comillas
--    dobles (clients."currentCredit", sales."saleDate"); las de tablas
--    totalmente snake_case (stock_movements, missing_items, shrinkages,
--    price_logs) no llevan comillas.
-- ----------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_clients_credit_debtors
    ON clients ("currentCredit" DESC)
    WHERE COALESCE("currentCredit", 0) > 0 AND deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_debt_pending_date
    ON sales ("saleDate" DESC)
    WHERE "debtPending" > 0 AND deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expenses_pending_debts_date
    ON expenses (date DESC)
    WHERE (UPPER(status) = 'PENDING' OR UPPER("paymentSource") IN ('PRESTAMO', 'PREST.'))
      AND UPPER(status) NOT IN ('PAID', 'SETTLED')
      AND deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_missing_items_pendiente_created
    ON missing_items (created_at DESC)
    WHERE UPPER(status) = 'PENDIENTE' AND deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shrinkages_date
    ON shrinkages (date DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_price_logs_created_at
    ON price_logs (created_at DESC);
