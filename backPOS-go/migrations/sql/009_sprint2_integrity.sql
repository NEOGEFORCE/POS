-- Sprint 2: idempotencia de ventas e integridad histórica.
-- Se ejecuta fuera de transacción porque CREATE INDEX CONCURRENTLY lo exige.

DO $$
DECLARE
    duplicate_groups integer;
BEGIN
    SELECT COUNT(*) INTO duplicate_groups
    FROM (
        SELECT "clientTxId"
        FROM sales
        WHERE "clientTxId" IS NOT NULL AND "clientTxId" <> ''
        GROUP BY "clientTxId"
        HAVING COUNT(*) > 1
    ) duplicates;

    IF duplicate_groups > 0 THEN
        RAISE EXCEPTION
            'Hay % grupos de ClientTxId duplicados. Resolverlos antes de crear el índice único.',
            duplicate_groups;
    END IF;
END $$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_sales_client_tx_id_unique
    ON sales ("clientTxId")
    WHERE "clientTxId" IS NOT NULL AND "clientTxId" <> '';

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS return_ref bigint NULL;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS parent_return_ref bigint NULL;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS financial_trace_ready boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_expenses_return_ref
    ON expenses(return_ref) WHERE return_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_parent_return_ref
    ON sales(parent_return_ref) WHERE parent_return_ref IS NOT NULL;

DO $$
DECLARE
    constraint_delete_action "char";
BEGIN
    SELECT confdeltype INTO constraint_delete_action
    FROM pg_constraint
    WHERE conname = 'fk_stock_movements_product'
      AND conrelid = 'stock_movements'::regclass;

    IF constraint_delete_action IS DISTINCT FROM 'r' THEN
        ALTER TABLE stock_movements
            DROP CONSTRAINT IF EXISTS fk_stock_movements_product;
        ALTER TABLE stock_movements
            ADD CONSTRAINT fk_stock_movements_product
            FOREIGN KEY (barcode) REFERENCES products(barcode)
            ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
        ALTER TABLE stock_movements
            VALIDATE CONSTRAINT fk_stock_movements_product;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_return_details_return') THEN
        ALTER TABLE return_details
            ADD CONSTRAINT fk_return_details_return
            FOREIGN KEY ("returnId") REFERENCES returns(id)
            ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
        ALTER TABLE return_details VALIDATE CONSTRAINT fk_return_details_return;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_expenses_return') THEN
        ALTER TABLE expenses
            ADD CONSTRAINT fk_expenses_return
            FOREIGN KEY (return_ref) REFERENCES returns(id)
            ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
        ALTER TABLE expenses VALIDATE CONSTRAINT fk_expenses_return;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sales_parent_return') THEN
        ALTER TABLE sales
            ADD CONSTRAINT fk_sales_parent_return
            FOREIGN KEY (parent_return_ref) REFERENCES returns(id)
            ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
        ALTER TABLE sales VALIDATE CONSTRAINT fk_sales_parent_return;
    END IF;
END $$;
