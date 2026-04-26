import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

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
 * Calcula el umbral crítico de stock basado en el minStock configurado
 * Tramos: minStock >= 12 → 3, minStock >= 4 → 2, minStock <= 3 → 1
 */
export const getCriticalThreshold = (minStock: number): number => {
    if (minStock >= 12) return 3;
    if (minStock >= 4) return 2;
    return 1; // Para minStock <= 3, el crítico es 1
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
