// Helpers puros del lector de facturas (OCR). Viven en .mjs para poder
// probarse con `node --test` sin DOM ni Next.js.
//
// Contrato con el backend Go:
//   - `normalizeExtractedItem` del backend ya resuelve la precedencia
//     porcentaje/monto del descuento y deja `discount_percentage` como única
//     fuente de verdad en [0, 100]. `discount_value` queda en 0 por invariante.
//   - `splitBonusItems` del backend ya separa las promociones "pague X lleve Y"
//     en una línea REGULAR + una BONUS con precio 0.
//   - Los porcentajes IVA/IBUA/ICUI vienen con la jerarquía: lo que extrajo
//     Claude de la factura prevalece sobre el producto base cuando > 0.
//
// Este módulo se limita a aplicar un clamp defensivo y añadir una identidad
// local estable para que el carrito y el reviewer puedan deduplicar y navegar
// sin colisionar en facturas con nombres repetidos.

const PCT_MIN = 0;
const PCT_MAX = 100;

/**
 * Clamp a [0, 100] con tolerancia a NaN, undefined y strings. Devuelve 0
 * cuando el valor no es un número finito positivo o cuando < 0.
 */
export function clampPercentage(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= PCT_MIN) return 0;
  if (n > PCT_MAX) return PCT_MAX;
  return n;
}

/**
 * Normaliza un `line_type` arbitrario a UPPERCASE si es string. Mantiene el
 * valor original (null/undefined) cuando no es string para no inventar
 * metadata que el backend no produjo.
 */
export function normalizeLineType(lineType) {
  if (typeof lineType !== 'string') return lineType;
  const upper = lineType.toUpperCase().trim();
  if (upper === 'REGULAR' || upper === 'BONUS' || upper === 'RETURN') return upper;
  return upper;
}

/**
 * `bonus_quantity` sólo tiene sentido como entero positivo. Cualquier otro
 * valor (negativo, NaN, string vacío) colapsa a 0 para que las ramas de
 * BONUS no se activen por accidente.
 */
export function sanitizeBonusQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * Genera un identificador local estable para cada item devuelto por el OCR.
 *
 * Importante porque:
 *   - El reviewer utiliza este id para "Volver" sin colisionar cuando dos
 *     items distintos comparten el mismo invoiceName (típico en facturas con
 *     saltos de página o líneas BONUS que se repiten).
 *   - El carrito de recepción puede deduplicar updates sucesivos de la misma
 *     línea sin tener que depender del `barcode` (que falta en los items no
 *     emparejados).
 *
 * La identidad es ÚNICA por sesión de OCR: no se persiste.
 */
export function makeOcrLocalId(prefix = 'ocr') {
  const rnd = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${prefix}-${ts}-${rnd}`;
}

/**
 * Normaliza un item OCR del backend al shape que consume el frontend.
 * Aplica:
 *   - clamp defensivo de todos los porcentajes (IVA, IBUA, ICUI, descuento)
 *   - UPPERCASE del `line_type`
 *   - entero positivo o 0 en `bonus_quantity`
 *   - identidad local estable (__ocrLocalId) si no venía.
 *
 * NUNCA inventa valores monetarios ni defaults de impuestos: la jerarquía
 * fiscal ya la aplicó el backend. Lo que entra con 0 explícito, sale con 0.
 */
export function fillInvoiceItemDefaults(item) {
  if (!item || typeof item !== 'object') {
    return { __ocrLocalId: makeOcrLocalId() };
  }
  const normalized = { ...item };
  normalized.iva_percentage = clampPercentage(item.iva_percentage);
  normalized.ibua_percentage = clampPercentage(item.ibua_percentage);
  normalized.icui_percentage = clampPercentage(item.icui_percentage);
  normalized.discount_percentage = clampPercentage(item.discount_percentage);
  normalized.line_type = normalizeLineType(item.line_type);
  normalized.bonus_quantity = sanitizeBonusQuantity(item.bonus_quantity);
  if (!normalized.__ocrLocalId || typeof normalized.__ocrLocalId !== 'string') {
    normalized.__ocrLocalId = makeOcrLocalId();
  }
  return normalized;
}

/**
 * Tamaño máximo en bytes que aceptamos subir al endpoint OCR. 10 MB es el
 * techo pragmático: por encima el canvas comprime demasiado y el payload JSON
 * puede bloquear la pestaña del navegador. El backend también rechaza > 15 MB.
 */
export const INVOICE_FILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Decide si un archivo seleccionado puede subirse al OCR. Retorna un objeto
 * con `ok: boolean` y, cuando no, un `reason` humano para mostrar en toast.
 *
 * Lo exportamos para que los tests contractuales validen límites sin tener que
 * cargar el componente React.
 */
export function validateInvoiceFile(file, { maxBytes = INVOICE_FILE_MAX_BYTES } = {}) {
  if (!file || typeof file !== 'object') {
    return { ok: false, reason: 'empty', message: 'No se recibio ningun archivo.' };
  }
  const type = typeof file.type === 'string' ? file.type : '';
  if (!type.startsWith('image/')) {
    return { ok: false, reason: 'bad-type', message: 'Por favor, selecciona una imagen (JPG o PNG).' };
  }
  const size = Number(file.size) || 0;
  if (size > maxBytes) {
    const mb = (size / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      reason: 'too-large',
      message: `La foto pesa ${mb} MB. El limite es ${Math.round(maxBytes / (1024 * 1024))} MB.`,
    };
  }
  return { ok: true };
}

/**
 * Resuelve el `entryType` del carrito a partir del `line_type` del OCR.
 * Expuesto como helper puro para que page.tsx y los tests coincidan en la
 * misma tabla de verdad:
 *   BONUS  → gift
 *   RETURN → return
 *   resto  → purchase
 */
export function entryTypeFromLineType(lineType) {
  const normalized = typeof lineType === 'string' ? lineType.toUpperCase() : '';
  if (normalized === 'BONUS') return 'gift';
  if (normalized === 'RETURN') return 'return';
  return 'purchase';
}

/**
 * Dadas las flags del cajero (BONUS/RETURN) y el porcentaje de descuento que
 * extrajo el OCR, devuelve el descuento que debe viajar al carrito.
 *
 *   - BONUS siempre fuerza 0 (un regalo con "descuento" no tiene semántica).
 *   - RETURN preserva el DTO: la devolución refleja los términos de la factura
 *     original; auditoría debe ver "la devolución tenía 12% pactado".
 *   - El resto propaga el porcentaje tal cual (ya normalizado por el backend).
 *
 * Nunca interpreta un campo monetario (`discount` suelto en el OCR) para
 * evitar doble aplicación: el contrato con el backend es que la única fuente
 * de verdad es `discount_percentage`.
 */
export function resolveCartDiscountFromOcr({ lineType, discount_percentage }) {
  const entryType = entryTypeFromLineType(lineType);
  if (entryType === 'gift') return 0;
  return clampPercentage(discount_percentage);
}
