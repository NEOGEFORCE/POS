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
