ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS visit_days JSONB DEFAULT '[]'::jsonb;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS delivery_days JSONB DEFAULT '[]'::jsonb;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS restock_method VARCHAR(50) DEFAULT '';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'suppliers' AND column_name = 'visitDay'
    ) THEN
        UPDATE suppliers
        SET visit_days = jsonb_build_array("visitDay")
        WHERE COALESCE("visitDay", '') <> ''
          AND (visit_days IS NULL OR visit_days = '[]'::jsonb);
    ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'suppliers' AND column_name = 'visit_day'
    ) THEN
        UPDATE suppliers
        SET visit_days = jsonb_build_array(visit_day)
        WHERE COALESCE(visit_day, '') <> ''
          AND (visit_days IS NULL OR visit_days = '[]'::jsonb);
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'suppliers' AND column_name = 'deliveryDay'
    ) THEN
        UPDATE suppliers
        SET delivery_days = jsonb_build_array("deliveryDay")
        WHERE COALESCE("deliveryDay", '') <> ''
          AND (delivery_days IS NULL OR delivery_days = '[]'::jsonb);
    ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'suppliers' AND column_name = 'delivery_day'
    ) THEN
        UPDATE suppliers
        SET delivery_days = jsonb_build_array(delivery_day)
        WHERE COALESCE(delivery_day, '') <> ''
          AND (delivery_days IS NULL OR delivery_days = '[]'::jsonb);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_suppliers_visit_days ON suppliers USING GIN (visit_days);
CREATE INDEX IF NOT EXISTS idx_suppliers_delivery_days ON suppliers USING GIN (delivery_days);
