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
        // Removemos cualquier cosa que no sea numero o el punto decimal resultante
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
    
    // Eliminamos todo excepto digitos, puntos y comas
    let clean = val.toString().replace(/[^\d.,]/g, '');
    
    // En es-CO: "." es miles, "," es decimal.
    // Si hay ambos, el punto es miles. Si solo hay uno, detectamos contexto.
    const hasComma = clean.includes(',');
    const hasDot = clean.includes('.');

    if (hasComma && hasDot) {
        // Formato estandar es-CO: 1.000,00 -> 1000.00
        clean = clean.replace(/\./g, '').replace(/,/g, '.');
    } else if (hasComma) {
        // Solo coma: 1000,50 -> 1000.50
        clean = clean.replace(/,/g, '.');
    } else if (hasDot) {
        // Solo punto: ¿Es miles o decimal? 
        // Si hay multiples puntos o el punto esta lejos del final, es miles.
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

export const applySurtifamiliarRounding = (val: number): number => {
    const value = Math.round(val);
    const remainder = value % 100;
    const baseCien = value - remainder;
    return remainder >= 20 ? baseCien + 100 : baseCien;
};

// Alias para mantener compatibilidad con otras partes del sistema
export const applyRounding = applySurtifamiliarRounding;

// Formato para Costo (Hasta 2 decimales): 1540.81 -> "1.540,81"
export const formatCost = (val: number): string => {
    if (!val || isNaN(val)) return '0';
    return val.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};


// Formato COP sin decimales: 10000 -> "10.000"
export const formatCOP = (val: number): string => {
    if (!val || isNaN(val)) return '0';
    return Math.round(val).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};

// Formatear input con puntos mientras escribe: "10000" -> "10.000"
export const formatInputCOP = (val: string): string => {
    // Remover todo excepto digitos
    const digits = val.replace(/\D/g, '');
    if (!digits) return '';
    // Convertir a numero y formatear
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
 * Logica de Semaforo Proporcional POS Pro v3.0 (Global)
 * Calcula la salud del stock basada en el porcentaje vs la meta (minStock).
 */
export const calculateStockHealth = (stock: number, minStock: number): 'CRITICAL' | 'WARNING' | 'OPTIMAL' => {
    const s = Number(stock) || 0;
    const m = Number(minStock) || 1; // Asumir 1 si es 0 para evitar division por cero

    const percentage = (s / m) * 100;

    if (percentage <= 20) return 'CRITICAL';
    if (percentage <= 50) return 'WARNING';
    return 'OPTIMAL';
};

/**
 * @deprecated Use calculateStockHealth for new proportional logic
 */
export const getStockStatus = (stock: number, minStock: number): 'STABLE' | 'REORDER' | 'CRITICAL' => {
    const health = calculateStockHealth(stock, minStock);
    if (health === 'CRITICAL') return 'CRITICAL';
    if (health === 'WARNING') return 'REORDER';
    return 'STABLE';
};

/**
 * Sanitiza un valor numerico para envio a API
 * Elimina: $, espacios, puntos de miles, simbolos de moneda
 * Maneja formato es-CO: "1.234,56" -> 1234.56
 * Ej: "$ 1.300" -> 1300, "2.500,50" -> 2500.5
 */
export const sanitizeNumber = (val: string | number | undefined): number => {
    if (val === undefined || val === null || val === '') return 0;
    if (typeof val === 'number') return val;
    
    // Eliminar todo excepto digitos, comas y puntos
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
 * Limpia campos numericos que pueden venir formateados con moneda
 */
export const sanitizeProductPayload = (product: any): any => {
    return {
        ...product,
        // Costo: Entero exacto (Math.round)
        purchasePrice: Math.round(sanitizeNumber(product.purchasePrice)),
        // PVP: Regla Surtifamiliar
        salePrice: applySurtifamiliarRounding(Math.round(sanitizeNumber(product.salePrice))),
        quantity: sanitizeNumber(product.quantity),
        minStock: sanitizeNumber(product.minStock),
        marginPercentage: sanitizeNumber(product.marginPercentage),
        packMultiplier: product.packMultiplier ? sanitizeNumber(product.packMultiplier) : undefined,
    };
};

/**
 * Formatea la cantidad de stock para visualizacion
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
    
    // 1. Evaluacion directa del booleano
    if (typeof product.isWeighted === 'boolean') return product.isWeighted;
    
    // 2. Evaluacion de strings (Tolerancia a DB inconsistente)
    if (typeof product.isWeighted === 'string') {
        const val = product.isWeighted.toLowerCase().trim();
        return val === 'true' || val === '1' || val === 'si' || val === 'on';
    }
    
    // 3. Evaluacion de numeros (1 = true, 0 = false)
    if (typeof product.isWeighted === 'number') return product.isWeighted > 0;

    // 4. Fallback por Unidad de Medida (Sugerido por el usuario)
    const unit = (product.unit || product.unidad || '').toString().toLowerCase().trim();
    if (['kg', 'kilogramo', 'lb', 'libra', 'gramos', 'gr', 'kgs'].includes(unit)) return true;

    // 5. Ultima instancia: Verdad absoluta del campo
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
 * Formatea una fecha sin hora
 * "08/05/2026"
 */
export const formatDate = (date: string | Date): string => {
    if (!date) return '---';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '---';
    return format(d, 'dd/MM/yyyy', { locale: es });
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
 * Formatea fecha + hora compacta para displays pequenos
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
/**
 * Estandariza un texto para el sistema POS:
 * 1. Quita tildes y caracteres especiales (NFD)
 * 2. Convierte a MAYUSCULAS
 */
export const normalizeText = (text: string | null | undefined): string => {
    if (!text) return "";
    return text
        .toString()
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, (match) => (match === '\u0303' ? match : ''))
        .normalize("NFC");
};

/**
 * Sanitiza automaticamente los campos de texto de un objeto (util para formularios)
 */
export const sanitizeTextFields = (obj: any, fields: string[]): any => {
    const newObj = { ...obj };
    fields.forEach(field => {
        if (newObj[field] !== undefined) {
            newObj[field] = normalizeText(newObj[field]);
        }
    });
    return newObj;
};

export const formatLocalDate = (dateStr: string): string => {
    if (!dateStr) return '---';
    const [year, month, day] = dateStr.split('-').map(Number);
    if (!year || !month || !day) return dateStr;
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString('es-CO', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    }).toUpperCase();
};
