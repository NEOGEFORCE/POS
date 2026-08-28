-- Preflight de compatibilidad para instalaciones creadas por el arranque legacy.
-- Esta migración no inventa datos: elimina bloqueadores conocidos y normaliza
-- columnas antiguas únicamente cuando existen.

CREATE EXTENSION IF NOT EXISTS unaccent;

DO $$
BEGIN
    IF to_regclass('public.employees') IS NOT NULL THEN
        -- Estas restricciones son redundantes con la llave primaria. En bases
        -- heredadas puede haber llaves foraneas apuntando a ellas; en ese caso
        -- se conservan, porque eliminarlas exigiria destruir esas llaves.
        BEGIN
            ALTER TABLE employees DROP CONSTRAINT IF EXISTS uni_employees_dni;
        EXCEPTION WHEN dependent_objects_still_exist THEN
            RAISE NOTICE 'Se conserva uni_employees_dni: existen objetos dependientes';
        END;

        BEGIN
            ALTER TABLE employees DROP CONSTRAINT IF EXISTS uni_employees_email;
        EXCEPTION WHEN dependent_objects_still_exist THEN
            RAISE NOTICE 'Se conserva uni_employees_email: existen objetos dependientes';
        END;

        BEGIN
            DROP INDEX IF EXISTS uni_employees_dni;
        EXCEPTION WHEN dependent_objects_still_exist OR object_not_in_prerequisite_state THEN
            RAISE NOTICE 'Se conserva el indice uni_employees_dni';
        END;

        BEGIN
            DROP INDEX IF EXISTS uni_employees_email;
        EXCEPTION WHEN dependent_objects_still_exist OR object_not_in_prerequisite_state THEN
            RAISE NOTICE 'Se conserva el indice uni_employees_email';
        END;
    END IF;

    IF to_regclass('public.sale_details') IS NOT NULL AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sale_details' AND column_name = 'costPrice'
    ) THEN
        UPDATE sale_details SET "costPrice" = 0 WHERE "costPrice" IS NULL;
    END IF;

    IF to_regclass('public.expenses') IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'created_by_dni'
        ) AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'createdByDni'
        ) THEN
            ALTER TABLE expenses RENAME COLUMN created_by_dni TO "createdByDni";
        ELSIF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'created_by_dni'
        ) AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'createdByDni'
        ) THEN
            UPDATE expenses
            SET "createdByDni" = created_by_dni
            WHERE COALESCE("createdByDni", '') = '' AND COALESCE(created_by_dni, '') <> '';
        END IF;
    END IF;
END $$;
