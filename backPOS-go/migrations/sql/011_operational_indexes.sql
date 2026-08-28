-- Sprint 7: índices operativos para consultas de kárdex, egresos y auditoría.
-- Esta migración corre en autocommit porque PostgreSQL no permite
-- CREATE INDEX CONCURRENTLY dentro de una transacción.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_movements_reference_reason
    ON stock_movements(reference_id, reason);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_movements_barcode_reason_date
    ON stock_movements(barcode, reason, date DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expenses_category_supplier_date
    ON expenses(category, supplier_id, date DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_module_employee_date
    ON audit_logs(module, employee_dni, created_at DESC);
