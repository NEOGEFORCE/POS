/**
 * Utilidad centralizada de validación de formularios POS.
 * Principio Fail-Fast: rechazar datos inválidos en el borde (frontend)
 * antes de que lleguen al backend.
 * 
 * Reglas:
 *  - CERO valores negativos en campos numéricos (stock, precio, margen, monto, crédito)
 *  - Campos obligatorios no vacíos
 *  - Longitud mínima donde aplique
 */

export interface FieldError {
  field: string;
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: FieldError[];
}

// ─── Helpers ────────────────────────────────────────────────────

function nonNegative(value: number | string | undefined | null, fieldName: string): FieldError | null {
  const num = Number(value);
  if (isNaN(num)) return { field: fieldName, message: `${fieldName}: VALOR NO NUMÉRICO` };
  if (num < 0) return { field: fieldName, message: `${fieldName}: NO SE PERMITEN VALORES NEGATIVOS (${num})` };
  return null;
}

function required(value: string | undefined | null, fieldName: string): FieldError | null {
  if (!value || !value.trim()) return { field: fieldName, message: `${fieldName}: CAMPO OBLIGATORIO` };
  return null;
}

function minLength(value: string | undefined | null, min: number, fieldName: string): FieldError | null {
  if (!value || value.trim().length < min) return { field: fieldName, message: `${fieldName}: MÍNIMO ${min} CARACTERES` };
  return null;
}

function positiveNumber(value: number | string | undefined | null, fieldName: string): FieldError | null {
  const num = Number(value);
  if (isNaN(num)) return { field: fieldName, message: `${fieldName}: VALOR NO NUMÉRICO` };
  if (num <= 0) return { field: fieldName, message: `${fieldName}: DEBE SER MAYOR A 0` };
  return null;
}

function collect(...checks: (FieldError | null)[]): FieldError[] {
  return checks.filter((e): e is FieldError => e !== null);
}

// ─── Validadores por Módulo ──────────────────────────────────────

export function validateProduct(data: {
  barcode?: string;
  productName?: string;
  purchasePrice?: number | string;
  salePrice?: number | string;
  quantity?: number | string;
  minStock?: number | string;
  marginPercentage?: number | string;
  isWeighted?: boolean;
  isPack?: boolean;
  packMultiplier?: number | string;
  baseProductBarcode?: string;
  categoryId?: number | string;
}): ValidationResult {
  const errors = collect(
    required(data.barcode, 'CÓDIGO'),
    minLength(data.barcode, 2, 'CÓDIGO'),
    required(data.productName, 'NOMBRE'),
    minLength(data.productName, 2, 'NOMBRE'),
    nonNegative(data.purchasePrice, 'COSTO'),
    nonNegative(data.salePrice, 'PVP'),
    nonNegative(data.marginPercentage, 'MARGEN'),
    ...(data.isWeighted ? [] : [nonNegative(data.quantity, 'STOCK')]),
    nonNegative(data.minStock, 'STOCK MÍNIMO'),
    ...(data.isPack ? [
      required(data.baseProductBarcode, 'PRODUCTO BASE (PACK)'),
      positiveNumber(data.packMultiplier, 'FACTOR PACK'),
    ] : []),
  );
  return { isValid: errors.length === 0, errors };
}

export function validateCustomer(data: {
  dni?: string;
  name?: string;
  creditLimit?: number | string;
}): ValidationResult {
  const errors = collect(
    required(data.dni, 'IDENTIFICACIÓN'),
    minLength(data.dni, 5, 'IDENTIFICACIÓN'),
    required(data.name, 'RAZÓN SOCIAL'),
    minLength(data.name, 2, 'RAZÓN SOCIAL'),
    nonNegative(data.creditLimit, 'CUPO DE CRÉDITO'),
  );
  return { isValid: errors.length === 0, errors };
}

export function validateExpense(data: {
  description?: string;
  amount?: number | string;
  category?: string;
  paymentSource?: string;
  lenderName?: string;
}): ValidationResult {
  const errors = collect(
    required(data.category, 'CATEGORÍA'),
    required(data.description, 'DESCRIPCIÓN'),
    minLength(data.description, 3, 'DESCRIPCIÓN'),
    nonNegative(data.amount, 'MONTO'),
    ...(Number(data.amount) <= 0 ? [{ field: 'MONTO', message: 'MONTO: DEBE SER MAYOR A $0' }] : []),
    ...(data.paymentSource === 'PRESTADO' && !data.lenderName?.trim()
      ? [{ field: 'PRESTAMISTA', message: 'PRESTAMISTA: NOMBRE REQUERIDO PARA PAGOS PRESTADOS' }]
      : []),
  );
  return { isValid: errors.length === 0, errors };
}

export function validateSupplier(data: {
  name?: string;
  phone?: string;
}): ValidationResult {
  const errors = collect(
    required(data.name, 'EMPRESA / RAZÓN SOCIAL'),
    minLength(data.name, 2, 'EMPRESA / RAZÓN SOCIAL'),
  );
  return { isValid: errors.length === 0, errors };
}

export function validateCategory(data: {
  name?: string;
}): ValidationResult {
  const errors = collect(
    required(data.name, 'NOMBRE DE CATEGORÍA'),
    minLength(data.name, 2, 'NOMBRE DE CATEGORÍA'),
  );
  return { isValid: errors.length === 0, errors };
}

export function validateUser(data: {
  dni?: string;
  name?: string;
  email?: string;
  password?: string;
  role?: string;
  isEdit?: boolean;
}): ValidationResult {
  const isAdminRole = ['admin', 'administrador', 'superadmin'].includes((data.role || '').toLowerCase());
  const errors = collect(
    required(data.dni, 'DNI'),
    minLength(data.dni, 5, 'DNI'),
    required(data.name, 'NOMBRE COMPLETO'),
    minLength(data.name, 2, 'NOMBRE COMPLETO'),
    ...(isAdminRole && !data.email?.trim()
      ? [{ field: 'EMAIL', message: 'EMAIL: OBLIGATORIO PARA ROLES ADMINISTRATIVOS' }]
      : []),
    ...(!data.isEdit && !data.password?.trim()
      ? [{ field: 'CLAVE DE ACCESO', message: 'CLAVE DE ACCESO: OBLIGATORIA PARA NUEVOS USUARIOS' }]
      : []),
  );
  return { isValid: errors.length === 0, errors };
}

export function validateManualWeight(value: string | number | undefined): ValidationResult {
  const num = Number(value);
  const errors = collect(
    ...(isNaN(num) ? [{ field: 'PESO', message: 'PESO: VALOR NO NUMÉRICO' }] : []),
    ...(num <= 0 ? [{ field: 'PESO', message: 'PESO: DEBE SER MAYOR A 0 KG' }] : []),
  );
  return { isValid: errors.length === 0, errors };
}
