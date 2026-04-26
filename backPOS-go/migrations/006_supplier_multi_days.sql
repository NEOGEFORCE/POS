-- ============================================
-- MIGRACIÓN: Soporte Multi-Días para Proveedores
-- Fecha: 2026-04-22
-- Descripción: Agrega columnas para múltiples días de visita/entrega
-- ============================================

-- Agregar nuevas columnas JSONB para múltiples días
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS visit_days JSONB DEFAULT '[]';
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS delivery_days JSONB DEFAULT '[]';
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS restock_method VARCHAR(50) DEFAULT '';

-- Crear índices GIN para búsquedas eficientes en arrays JSONB
CREATE INDEX IF NOT EXISTS idx_suppliers_visit_days ON suppliers USING GIN (visit_days);
CREATE INDEX IF NOT EXISTS idx_suppliers_delivery_days ON suppliers USING GIN (delivery_days);

-- Migrar datos existentes: convertir visitDay/deliveryDay (string) a arrays
-- Esto migra los datos del formato antiguo al nuevo formato JSONB

-- Primero, actualizar visit_days con datos de visitDay (si existe)
UPDATE suppliers 
SET visit_days = CASE 
    WHEN visitDay IS NOT NULL AND visitDay != '' 
    THEN jsonb_build_array(visitDay)
    ELSE '[]'::jsonb
END
WHERE visitDay IS NOT NULL;

-- Luego, actualizar delivery_days con datos de deliveryDay (si existe)
UPDATE suppliers 
SET delivery_days = CASE 
    WHEN deliveryDay IS NOT NULL AND deliveryDay != '' 
    THEN jsonb_build_array(deliveryDay)
    ELSE '[]'::jsonb
END
WHERE deliveryDay IS NOT NULL;

-- Nota: Los campos visitDay y deliveryDay se mantienen temporalmente
-- para compatibilidad con versiones anteriores. Se pueden eliminar
-- en una migración futura cuando todo el sistema esté actualizado.

-- Comentarios para documentación
COMMENT ON COLUMN suppliers.visit_days IS 'Array JSONB de días de visita (ej: ["Lunes", "Jueves"])';
COMMENT ON COLUMN suppliers.delivery_days IS 'Array JSONB de días de entrega (ej: ["Martes", "Viernes"])';
COMMENT ON COLUMN suppliers.restock_method IS 'Método de abastecimiento principal (ej: RUTA, APP, MIXTO)';

-- Verificar la migración
SELECT 
    id, 
    name, 
    visitDay as legacy_visit,
    visit_days as new_visit_days,
    deliveryDay as legacy_delivery,
    delivery_days as new_delivery_days,
    restock_method
FROM suppliers 
LIMIT 5;
