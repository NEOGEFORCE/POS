-- ============================================
-- MIGRACIÓN: Row Level Security (RLS) Policy
-- Fecha: 2026-04-22
-- Descripción: Habilita RLS en tablas transaccionales
-- ============================================

-- ============================================
-- 1. HABILITAR RLS EN TABLAS CLAVE
-- ============================================

-- Tabla de ventas
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales FORCE ROW LEVEL SECURITY;

-- Tabla de detalles de venta
ALTER TABLE sale_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_details FORCE ROW LEVEL SECURITY;

-- Tabla de productos
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;

-- Tabla de gastos
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;

-- Tabla de clientes
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;

-- Tabla de órdenes de compra
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;

-- Tabla de faltantes
ALTER TABLE missing_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE missing_items FORCE ROW LEVEL SECURITY;

-- Tabla de devoluciones
ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE returns FORCE ROW LEVEL SECURITY;

-- Tabla de movimientos de inventario
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;

-- ============================================
-- 2. CREAR POLÍTICAS DE ACCESO
-- ============================================

-- Política: Los usuarios solo pueden ver ventas de su organización
-- Nota: Esto asume que existe una columna organization_id o similar
-- Si no existe, se debe agregar primero

-- Ejemplo de política para tablas con organization_id:
-- CREATE POLICY org_sales_isolation ON sales
--     USING (organization_id = current_setting('app.current_org_id', true)::uuid);

-- Política más simple para aplicaciones single-tenant:
-- Permitir acceso completo a usuarios autenticados
CREATE POLICY allow_all_authenticated ON sales
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY allow_all_authenticated ON sale_details
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY allow_all_authenticated ON products
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY allow_all_authenticated ON expenses
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY allow_all_authenticated ON clients
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY allow_all_authenticated ON purchase_orders
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY allow_all_authenticated ON missing_items
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY allow_all_authenticated ON returns
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY allow_all_authenticated ON stock_movements
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- ============================================
-- 3. POLÍTICAS ESPECÍFICAS POR ROL (Opcional)
-- ============================================

-- Empleados: Solo pueden ver y crear, no eliminar
-- Admin: Acceso completo

-- Verificar si existe la columna created_by antes de crear estas políticas
DO $$
BEGIN
    -- Política para empleados: solo pueden modificar sus propios registros
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'sales' AND column_name = 'created_by_dni') THEN
        
        CREATE POLICY employee_own_sales ON sales
            FOR UPDATE
            TO employee
            USING (created_by_dni = current_setting('app.current_user_dni', true));
            
        CREATE POLICY employee_own_sales_delete ON sales
            FOR DELETE
            TO employee
            USING (created_by_dni = current_setting('app.current_user_dni', true));
    END IF;
END $$;

-- ============================================
-- 4. INDICES ADICIONALES PARA RLS PERFORMANCE
-- ============================================

-- Índices para acelerar las políticas de RLS
CREATE INDEX IF NOT EXISTS idx_sales_created_by_dni ON sales(created_by_dni);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
CREATE INDEX IF NOT EXISTS idx_products_supplier_id ON products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_missing_items_status ON missing_items(status);

-- ============================================
-- 5. FUNCIÓN AUXILIAR PARA SETEAR CONTEXTO
-- ============================================

CREATE OR REPLACE FUNCTION set_app_context(org_id uuid, user_dni text, user_role text)
RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_org_id', org_id::text, false);
    PERFORM set_config('app.current_user_dni', user_dni, false);
    PERFORM set_config('app.current_user_role', user_role, false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- NOTAS DE IMPLEMENTACIÓN
-- ============================================
--
-- 1. Para aplicar esta migración:
--    psql -U postgres -d backpos -f migrations/005_enable_rls.sql
--
-- 2. El backend Go debe llamar a set_app_context() al inicio de cada request:
--    db.Exec("SELECT set_app_context($1, $2, $3)", orgID, userDNI, userRole)
--
-- 3. Para deshabilitar RLS en desarrollo:
--    ALTER TABLE sales DISABLE ROW LEVEL SECURITY;
--
-- 4. Verificar políticas activas:
--    SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
--    FROM pg_policies WHERE tablename = 'sales';
--
