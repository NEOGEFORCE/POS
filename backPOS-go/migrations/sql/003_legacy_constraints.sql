-- Compatibilidad posterior a AutoMigrate: migra datos legacy y establece
-- restricciones canónicas una sola vez bajo control del runner.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'cashier_closures' AND column_name = 'coins500_1000'
    ) THEN
        UPDATE cashier_closures
        SET coins500 = "coins500_1000"
        WHERE COALESCE(coins500, 0) = 0;
        ALTER TABLE cashier_closures DROP COLUMN "coins500_1000";
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'created_by_dni'
    ) THEN
        UPDATE expenses
        SET "createdByDni" = created_by_dni
        WHERE COALESCE("createdByDni", '') = '' AND COALESCE(created_by_dni, '') <> '';
    END IF;
END $$;

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_schema = kcu.constraint_schema
         AND tc.constraint_name = kcu.constraint_name
        WHERE tc.constraint_schema = 'public'
          AND tc.table_name = 'sale_details'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'barcode'
    LOOP
        EXECUTE format('ALTER TABLE sale_details DROP CONSTRAINT IF EXISTS %I', r.constraint_name);
    END LOOP;
    ALTER TABLE sale_details
        ADD CONSTRAINT fk_sale_details_product
        FOREIGN KEY (barcode) REFERENCES products(barcode)
        ON UPDATE CASCADE ON DELETE RESTRICT;

    FOR r IN
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_schema = kcu.constraint_schema
         AND tc.constraint_name = kcu.constraint_name
        WHERE tc.constraint_schema = 'public'
          AND tc.table_name = 'return_details'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'barcode'
    LOOP
        EXECUTE format('ALTER TABLE return_details DROP CONSTRAINT IF EXISTS %I', r.constraint_name);
    END LOOP;
    ALTER TABLE return_details
        ADD CONSTRAINT fk_return_details_product
        FOREIGN KEY (barcode) REFERENCES products(barcode)
        ON UPDATE CASCADE ON DELETE RESTRICT;

    FOR r IN
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_schema = kcu.constraint_schema
         AND tc.constraint_name = kcu.constraint_name
        WHERE tc.constraint_schema = 'public'
          AND tc.table_name = 'purchase_order_items'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'productBarcode'
    LOOP
        EXECUTE format('ALTER TABLE purchase_order_items DROP CONSTRAINT IF EXISTS %I', r.constraint_name);
    END LOOP;
    ALTER TABLE purchase_order_items
        ADD CONSTRAINT fk_purchase_order_items_product
        FOREIGN KEY ("productBarcode") REFERENCES products(barcode)
        ON UPDATE CASCADE ON DELETE CASCADE;

    FOR r IN
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_schema = kcu.constraint_schema
         AND tc.constraint_name = kcu.constraint_name
        WHERE tc.constraint_schema = 'public'
          AND tc.table_name = 'product_suppliers'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'product_barcode'
    LOOP
        EXECUTE format('ALTER TABLE product_suppliers DROP CONSTRAINT IF EXISTS %I', r.constraint_name);
    END LOOP;
    ALTER TABLE product_suppliers
        ADD CONSTRAINT fk_product_suppliers_product
        FOREIGN KEY (product_barcode) REFERENCES products(barcode)
        ON UPDATE CASCADE ON DELETE CASCADE;

    FOR r IN
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_schema = kcu.constraint_schema
         AND tc.constraint_name = kcu.constraint_name
        WHERE tc.constraint_schema = 'public'
          AND tc.table_name = 'stock_movements'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'barcode'
    LOOP
        EXECUTE format('ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS %I', r.constraint_name);
    END LOOP;
    ALTER TABLE stock_movements
        ADD CONSTRAINT fk_stock_movements_product
        FOREIGN KEY (barcode) REFERENCES products(barcode)
        ON UPDATE CASCADE ON DELETE RESTRICT;

    FOR r IN
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_schema = kcu.constraint_schema
         AND tc.constraint_name = kcu.constraint_name
        WHERE tc.constraint_schema = 'public'
          AND tc.table_name = 'products'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'baseProductBarcode'
    LOOP
        EXECUTE format('ALTER TABLE products DROP CONSTRAINT IF EXISTS %I', r.constraint_name);
    END LOOP;
    ALTER TABLE products
        ADD CONSTRAINT fk_products_base_product
        FOREIGN KEY ("baseProductBarcode") REFERENCES products(barcode)
        ON UPDATE CASCADE ON DELETE SET NULL;

    ALTER TABLE confirmed_order_items DROP CONSTRAINT IF EXISTS fk_confirmed_order_items_product;
    ALTER TABLE active_purchase_list DROP CONSTRAINT IF EXISTS fk_active_purchase_list_product;
    ALTER TABLE price_logs DROP CONSTRAINT IF EXISTS fk_price_logs_product;
END $$;
