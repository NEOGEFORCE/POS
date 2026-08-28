-- El POS es single-tenant y no ejecuta SET ROLE por solicitud. RLS se deja
-- habilitado como defensa adicional, pero NO forzado para que el propietario
-- de las tablas mantenga acceso operativo. La política PUBLIC no concede
-- privilegios SQL: sólo permite filas a roles que ya tengan GRANT sobre ellas.
DO $$
DECLARE
    target_table text;
    policy_name constant text := 'allow_pos_application_access';
BEGIN
    FOREACH target_table IN ARRAY ARRAY[
        'sales', 'sale_details', 'products', 'expenses', 'clients',
        'returns', 'return_details', 'stock_movements', 'missing_items',
        'expected_orders', 'purchase_orders'
    ]
    LOOP
        IF to_regclass(format('public.%I', target_table)) IS NULL THEN
            RAISE EXCEPTION 'No existe la tabla requerida para RLS: %', target_table;
        END IF;

        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target_table);
        EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', target_table);

        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = target_table
              AND policyname = policy_name
        ) THEN
            EXECUTE format(
                'CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (true) WITH CHECK (true)',
                policy_name,
                target_table
            );
        END IF;
    END LOOP;
END $$;
