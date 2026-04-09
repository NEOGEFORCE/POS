import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const formatCurrency = (val: number | string): string => {
    if (val === undefined || val === null || val === '') return '';
    const num = typeof val === 'string' ? parseFloat(val.replace(/[^\d.]/g, '')) : val;
    if (isNaN(num)) return '';
    return num.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};

export const parseCurrency = (val: string): number => {
    // Eliminamos todo excepto números y el punto decimal
    const cleanValue = val.replace(/[^\d.]/g, '');
    return parseFloat(cleanValue) || 0;
};

export const applyRounding = (val: number): number => {
    const base = Math.floor(val / 100) * 100;
    const remainder = val % 100;
    if (remainder >= 25) {
        return base + 100;
    }
    return base;
};
