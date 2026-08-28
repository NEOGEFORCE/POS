CREATE TABLE IF NOT EXISTS daily_stock_snapshots (
    id BIGSERIAL PRIMARY KEY,
    product_id VARCHAR(50) NOT NULL,
    snapshot_date DATE NOT NULL,
    closing_stock NUMERIC(12,3) NOT NULL DEFAULT 0,
    was_zero BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_dss_product_date UNIQUE (product_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_dss_product_date
    ON daily_stock_snapshots (product_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_dss_date_zero
    ON daily_stock_snapshots (snapshot_date, was_zero);

CREATE TABLE IF NOT EXISTS product_restock_metrics (
    id BIGSERIAL PRIMARY KEY,
    product_id VARCHAR(50) NOT NULL,
    product_name VARCHAR(255) NOT NULL DEFAULT '',
    total_sold_30d NUMERIC(12,3) NOT NULL DEFAULT 0,
    days_with_stock INTEGER NOT NULL DEFAULT 30,
    days_zero_stock INTEGER NOT NULL DEFAULT 0,
    avg_daily_sales NUMERIC(12,4) NOT NULL DEFAULT 0,
    abc_category CHAR(1) NOT NULL DEFAULT 'C',
    current_stock NUMERIC(12,3) NOT NULL DEFAULT 0,
    in_transit_qty NUMERIC(12,3) NOT NULL DEFAULT 0,
    ideal_stock NUMERIC(12,3) NOT NULL DEFAULT 0,
    suggested_order_qty NUMERIC(12,3) NOT NULL DEFAULT 0,
    primary_supplier_id BIGINT,
    supplier_name VARCHAR(255) NOT NULL DEFAULT '',
    supplier_lead_days INTEGER NOT NULL DEFAULT 7,
    unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_prm_product UNIQUE (product_id),
    CONSTRAINT chk_prm_abc CHECK (abc_category IN ('A', 'B', 'C'))
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_prm_abc'
          AND conrelid = 'product_restock_metrics'::regclass
    ) THEN
        ALTER TABLE product_restock_metrics
            ADD CONSTRAINT chk_prm_abc CHECK (abc_category IN ('A', 'B', 'C'));
    END IF;
END $$;


ALTER TABLE product_restock_metrics
    ADD COLUMN IF NOT EXISTS in_transit_qty NUMERIC(12,3) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_prm_abc ON product_restock_metrics (abc_category);
CREATE INDEX IF NOT EXISTS idx_prm_supplier ON product_restock_metrics (primary_supplier_id);
CREATE INDEX IF NOT EXISTS idx_prm_suggested
    ON product_restock_metrics (suggested_order_qty)
    WHERE suggested_order_qty > 0;

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lead_time_days INTEGER;
ALTER TABLE suppliers ALTER COLUMN lead_time_days DROP DEFAULT;
