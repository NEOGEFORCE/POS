import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { format } from "date-fns";
import { es } from "date-fns/locale";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const formatCurrency = (val: number | string): string => {
    if (val === undefined || val === null || val === '') return '';
    
    let num: number;
    if (typeof val === 'string') {
        // En es-CO el punto es separador de miles. Removemos todos los puntos primero.
        let clean = val.replace(/\./g, '');
        // Reemplazamos coma decimal por punto para que parseFloat trabaje correctamente
        clean = clean.replace(/,/g, '.');
        // Removemos cualquier cosa que no sea número o el punto decimal resultante
        clean = clean.replace(/[^\d.]/g, '');
        num = parseFloat(clean);
    } else {
        num = val;
    }

    if (isNaN(num)) return '';
    return num.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};

export const parseCurrency = (val: string | number): number => {
    if (val === undefined || val === null) return 0;
    if (typeof val === 'number') return val;
    
    // Eliminamos todo excepto dígitos, puntos y comas
    let clean = val.toString().replace(/[^\d.,]/g, '');
    
    // En es-CO: "." es miles, "," es decimal.
    // Si hay ambos, el punto es miles. Si solo hay uno, detectamos contexto.
    const hasComma = clean.includes(',');
    const hasDot = clean.includes('.');

    if (hasComma && hasDot) {
        // Formato estándar es-CO: 1.000,00 -> 1000.00
        clean = clean.replace(/\./g, '').replace(/,/g, '.');
    } else if (hasComma) {
        // Solo coma: 1000,50 -> 1000.50
        clean = clean.replace(/,/g, '.');
    } else if (hasDot) {
        // Solo punto: ¿Es miles o decimal? 
        // Si hay múltiples puntos o el punto está lejos del final, es miles.
        const dots = (clean.match(/\./g) || []).length;
        const lastDotIndex = clean.lastIndexOf('.');
        const distanceFromEnd = clean.length - lastDotIndex - 1;

        if (dots > 1 || distanceFromEnd !== 2) {
            // Probablemente miles: 1.000 -> 1000
            clean = clean.replace(/\./g, '');
        } else {
            // Probablemente decimal: 100.5 -> 100.5 (mantenemos el punto)
        }
    }

    const result = parseFloat(clean);
    return isNaN(result) ? 0 : result;
};

export const applyRounding = (val: number): number => {
    const base = Math.floor(val / 100) * 100;
    const remainder = val % 100;
    if (remainder >= 25) {
        return base + 100;
    }
    return base;
};

// Formato COP sin decimales: 10000 -> "10.000"
export const formatCOP = (val: number): string => {
    if (!val || isNaN(val)) return '0';
    return Math.round(val).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};

// Formatear input con puntos mientras escribe: "10000" -> "10.000"
export const formatInputCOP = (val: string): string => {
    // Remover todo excepto dígitos
    const digits = val.replace(/\D/g, '');
    if (!digits) return '';
    // Convertir a número y formatear
    const num = parseInt(digits, 10);
    if (isNaN(num)) return '';
    return num.toLocaleString('es-CO');
};

// Parsear input COP: "10.000" -> 10000
export const parseCOP = (val: string): number => {
    const digits = val.replace(/\./g, '').replace(/,/g, '');
    return parseInt(digits, 10) || 0;
};

/**
 * Lógica de Stock Inteligente Cerberus v2.0
 * Define el estado visual basado en la meta (minStock) y el inventario actual.
 */
export const getStockStatus = (stock: number, minStock: number): 'STABLE' | 'REORDER' | 'CRITICAL' => {
    const s = Number(stock) || 0;
    const m = Number(minStock) || 0;

    // Si no hay meta, todo es estable a menos que sea cero
    if (m <= 0) return s > 0 ? 'STABLE' : 'CRITICAL';

    // 1. ZONA ROJA (CRÍTICO): Menos del 20% de la meta
    // Para metas pequeñas, aseguramos que al menos el 0 siempre sea rojo
    // y que para una meta de 3, el 1 (33%) caiga en rojo si es necesario, 
    // pero según tu regla de "1 o 0 rojo para meta 3", el umbral es < 2 unidades.
    const redThreshold = m <= 3 ? 1 : Math.floor(m * 0.2);
    if (s <= redThreshold) return 'CRITICAL';

    // 2. ZONA AMARILLA (REORDER): Entre el 20% y el 50%
    // Para una meta de 3, el 2 (66%) técnicamente es > 50%, pero pediste que sea amarillo.
    // Ajustamos: si m=3, amarillo es 2. Si m > 3, seguimos el 50%.
    const yellowThreshold = m <= 3 ? 2 : Math.floor(m * 0.5);
    if (s <= yellowThreshold) return 'REORDER';

    // 3. ZONA VERDE (ESTABLE): Más del 50%
    return 'STABLE';
};

/**
 * Sanitiza un valor numérico para envío a API
 * Elimina: $, espacios, puntos de miles, símbolos de moneda
 * Maneja formato es-CO: "1.234,56" -> 1234.56
 * Ej: "$ 1.300" -> 1300, "2.500,50" -> 2500.5
 */
export const sanitizeNumber = (val: string | number | undefined): number => {
    if (val === undefined || val === null || val === '') return 0;
    if (typeof val === 'number') return val;
    
    // Eliminar todo excepto dígitos, comas y puntos
    let clean = val.toString().replace(/[^\d.,]/g, '');
    
    // Detectar formato
    const hasComma = clean.includes(',');
    const hasDot = clean.includes('.');
    
    if (hasComma && hasDot) {
        // Formato es-CO: 1.000,50 -> 1000.50
        clean = clean.replace(/\./g, '').replace(/,/g, '.');
    } else if (hasComma) {
        // Solo coma: 1000,50 -> 1000.50 (decimal)
        clean = clean.replace(/,/g, '.');
    } else if (hasDot) {
        // Solo punto: verificar si es miles o decimal
        const dots = (clean.match(/\./g) || []).length;
        const lastDotIndex = clean.lastIndexOf('.');
        const distanceFromEnd = clean.length - lastDotIndex - 1;
        
        if (dots > 1 || (distanceFromEnd !== 2 && distanceFromEnd !== 1)) {
            // Es separador de miles: 1.000 -> 1000
            clean = clean.replace(/\./g, '');
        }
        // Si distanceFromEnd es 1 o 2, es decimal, lo dejamos
    }
    
    const result = parseFloat(clean);
    return isNaN(result) ? 0 : result;
};

/**
 * Sanitiza todo el payload de un producto antes de enviar a API
 * Limpia campos numéricos que pueden venir formateados con moneda
 */
export const sanitizeProductPayload = (product: any): any => {
    return {
        ...product,
        purchasePrice: sanitizeNumber(product.purchasePrice),
        salePrice: sanitizeNumber(product.salePrice),
        quantity: sanitizeNumber(product.quantity),
        minStock: sanitizeNumber(product.minStock),
        marginPercentage: sanitizeNumber(product.marginPercentage),
        packMultiplier: product.packMultiplier ? sanitizeNumber(product.packMultiplier) : undefined,
    };
};

/**
 * Formatea la cantidad de stock para visualización
 * - Productos pack (isPack): Siempre entero con Math.floor
 * - Productos no pesados (isWeighted === false): Entero sin decimales
 * - Productos pesados: Se muestra el valor completo
 */
export const formatStock = (quantity: number, isPack?: boolean, isWeighted?: boolean): string => {
    if (quantity === undefined || quantity === null) return '0';
    
    // Para packs o productos no pesados: usar Math.floor para evitar decimales
    if (isPack || (!isWeighted && !isPack)) {
        return Math.floor(quantity).toString();
    }
    
    // Para productos pesados: mostrar el valor tal cual
    return quantity.toString();
};

export const isProductWeighted = (product: any): boolean => {
    if (!product) return false;
    
    // 1. Evaluación directa del booleano
    if (typeof product.isWeighted === 'boolean') return product.isWeighted;
    
    // 2. Evaluación de strings (Tolerancia a DB inconsistente)
    if (typeof product.isWeighted === 'string') {
        const val = product.isWeighted.toLowerCase().trim();
        return val === 'true' || val === '1' || val === 'si' || val === 'on';
    }
    
    // 3. Evaluación de números (1 = true, 0 = false)
    if (typeof product.isWeighted === 'number') return product.isWeighted > 0;

    // 4. Fallback por Unidad de Medida (Sugerido por el usuario)
    const unit = (product.unit || product.unidad || '').toString().toLowerCase().trim();
    if (['kg', 'kilogramo', 'lb', 'libra', 'gramos', 'gr', 'kgs'].includes(unit)) return true;

    // 5. Última instancia: Verdad absoluta del campo
    return !!product.isWeighted;
};

/**
 * Formatea una fecha/hora en formato de 12 horas (AM/PM)
 * Solo hora y minutos: "2:30 PM"
 */
export const formatTime = (date: string | Date): string => {
    if (!date) return '---';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '---';
    return format(d, 'hh:mm:ss aa', { locale: es });
};

/**
 * Formatea fecha + hora completa en 12 horas
 * "8/05/2026, 2:30 PM"
 */
export const formatDateTime = (date: string | Date): string => {
    if (!date) return '---';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '---';
    return format(d, 'dd/MM/yyyy, hh:mm:ss aa', { locale: es });
};

/**
 * Formatea fecha + hora compacta para displays pequeños
 * "08/05 2:30 PM"
 */
export const formatShortDateTime = (date: string | Date): string => {
    if (!date) return '---';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '---';
    return format(d, 'dd/MM hh:mm aa', { locale: es });
};

/**
 * Formatea hora con segundos en 12 horas
 * "2:30:45 PM"
 */
export const formatTimeWithSeconds = (date: string | Date): string => {
    if (!date) return '---';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '---';
    return format(d, 'hh:mm:ss aa', { locale: es });
};

/**
 * Formatea una fecha local (YYYY-MM-DD) sin desfases de zona horaria.
 * Evita que el navegador reste horas al interpretar la fecha como UTC.
 */
export const formatLocalDate = (dateStr: string): string => {
    if (!dateStr) return '---';
    // Dividir la cadena para evitar que el constructor de Date la trate como UTC
    const [year, month, day] = dateStr.split('-').map(Number);
    if (!year || !month || !day) return dateStr;
    
    // Crear objeto Date usando componentes locales
    const date = new Date(year, month - 1, day);
    
    return date.toLocaleDateString('es-CO', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    }).toUpperCase();
};
