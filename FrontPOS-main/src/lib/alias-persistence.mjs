// Helpers puros para persistir alias de proveedor contra el endpoint
// POST /inventory/save-alias. Viven en .mjs para probarse con `node --test`
// sin DOM ni Next.js.
//
// Contrato:
//   - Cada vez que el usuario enlaza explícitamente un invoiceName del OCR
//     con un `productBarcode` (sugerencia, búsqueda manual, escáner o
//     producto recién creado) persistimos el alias para que el próximo OCR
//     reconozca el nombre.
//   - El backend ignora supplierId=0 o inválido, así que el frontend NUNCA
//     debe mandar un supplier fantasma. Preferimos NO llamar al endpoint
//     que mandar un payload inválido.
//   - Si la red falla o el backend responde >=400, el aprendizaje NO se
//     puede perder silenciosamente: el llamador debe recibir
//     `{ ok: false, reason, message }` y surfacer un toast.
//
// No importa este módulo nada de Next ni fetch global; recibe `fetchImpl`
// opcional para que las pruebas inyecten su mock.

/**
 * Valida y normaliza los tres campos del payload de save-alias.
 *
 * Reglas duras:
 *   - supplierId numérico y > 0 (nunca 0 ni null ni localStorage ambiguo).
 *   - invoiceName string no vacío tras trim(). Preservamos el casing
 *     original porque el backend lo guarda como clave idéntica a la factura.
 *   - productBarcode string no vacío tras trim(); lo pasamos en upper-case
 *     porque los códigos del POS viven en mayúsculas (ver product_handler).
 *
 * @param {{ supplierId: unknown, invoiceName: unknown, productBarcode: unknown }} params
 * @returns {{ ok: true, payload: { supplierId: number, invoiceName: string, productBarcode: string } }
 *          | { ok: false, reason: 'missing-supplier'|'missing-invoice-name'|'missing-barcode' } }
 */
export function buildAliasPayload({ supplierId, invoiceName, productBarcode } = {}) {
  const supplierNum = Number(supplierId);
  if (!Number.isFinite(supplierNum) || supplierNum <= 0) {
    return { ok: false, reason: 'missing-supplier' };
  }
  const name = typeof invoiceName === 'string' ? invoiceName.trim() : '';
  if (!name) {
    return { ok: false, reason: 'missing-invoice-name' };
  }
  const barcodeRaw = typeof productBarcode === 'string' ? productBarcode.trim() : '';
  if (!barcodeRaw) {
    return { ok: false, reason: 'missing-barcode' };
  }
  return {
    ok: true,
    payload: {
      supplierId: supplierNum,
      invoiceName: name,
      productBarcode: barcodeRaw.toUpperCase(),
    },
  };
}

/**
 * Mensajes humanos para mostrar en toast cuando la persistencia falla.
 * Centralizados aquí para que la UI y los tests coincidan en el texto.
 */
export const ALIAS_FAILURE_MESSAGES = Object.freeze({
  'missing-supplier':
    'Selecciona un proveedor antes de revisar la factura para que el alias se recuerde.',
  'missing-invoice-name':
    'El nombre del producto en la factura está vacío; no se puede recordar el alias.',
  'missing-barcode':
    'El producto no tiene código de barras asignado; no se puede recordar el alias.',
  'http-error':
    'El servidor rechazó el alias; se guardó el producto en el carrito pero el OCR no lo recordará todavía.',
  'network-error':
    'Sin conexión al guardar el alias; el producto quedó en el carrito pero el OCR volverá a pedirlo.',
  'unauthorized':
    'Tu sesión caducó al guardar el alias; vuelve a iniciar sesión para que el OCR aprenda el nombre.',
});

/**
 * Clasifica una respuesta HTTP del endpoint save-alias en un veredicto
 * accionable por la UI. Separado de persistAlias para poder probarlo con
 * un `Response` sintético sin montar fetch.
 *
 * Convención: cualquier `status >= 200 && < 300` cuenta como éxito. 401 y 403
 * reciben un reason propio para que la UI pueda invitar a re-login.
 *
 * @param {{ ok: boolean, status: number } | null | undefined} res
 * @returns {{ ok: true, status: number } | { ok: false, status: number, reason: 'unauthorized'|'http-error', message: string }}
 */
export function classifyAliasResponse(res) {
  if (!res || typeof res.ok !== 'boolean' || typeof res.status !== 'number') {
    return {
      ok: false,
      status: 0,
      reason: 'http-error',
      message: ALIAS_FAILURE_MESSAGES['http-error'],
    };
  }
  if (res.ok) {
    return { ok: true, status: res.status };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      status: res.status,
      reason: 'unauthorized',
      message: ALIAS_FAILURE_MESSAGES['unauthorized'],
    };
  }
  return {
    ok: false,
    status: res.status,
    reason: 'http-error',
    message: ALIAS_FAILURE_MESSAGES['http-error'],
  };
}

/**
 * Persiste un alias de proveedor contra `POST /inventory/save-alias`.
 *
 * Diseño:
 *   - Nunca lanza: devuelve un veredicto. La UI decide si muestra toast.
 *   - Nunca llama al backend si el payload es inválido (evita mandar
 *     supplierId=0 o invoiceName vacío que el backend acepta pero no sirve).
 *   - El llamador inyecta `token`, `apiBase` y opcionalmente `fetchImpl`
 *     (para tests). Si `apiBase` no termina en `/` ni empieza con `/`, lo
 *     normalizamos.
 *   - Timeout opcional (ms) con `AbortController`; si expira retornamos
 *     `reason: 'network-error'`.
 *
 * @param {{
 *   supplierId: unknown,
 *   invoiceName: unknown,
 *   productBarcode: unknown,
 *   token?: string | null,
 *   apiBase?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} params
 */
export async function persistAlias({
  supplierId,
  invoiceName,
  productBarcode,
  token,
  apiBase = '/api',
  fetchImpl,
  timeoutMs,
} = {}) {
  const built = buildAliasPayload({ supplierId, invoiceName, productBarcode });
  if (!built.ok) {
    return {
      ok: false,
      status: 0,
      reason: built.reason,
      message: ALIAS_FAILURE_MESSAGES[built.reason] || 'No se pudo guardar el alias.',
    };
  }

  const trimmedBase = typeof apiBase === 'string' && apiBase.length > 0
    ? apiBase.replace(/\/+$/, '')
    : '/api';
  const url = `${trimmedBase}/inventory/save-alias`;

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const doFetch = typeof fetchImpl === 'function'
    ? fetchImpl
    : (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) {
    return {
      ok: false,
      status: 0,
      reason: 'network-error',
      message: ALIAS_FAILURE_MESSAGES['network-error'],
    };
  }

  let controller = null;
  let timeoutId = null;
  if (typeof timeoutMs === 'number' && timeoutMs > 0 && typeof AbortController === 'function') {
    controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(built.payload),
      signal: controller ? controller.signal : undefined,
    });
    const verdict = classifyAliasResponse(res);
    if (verdict.ok) {
      return { ...verdict, payload: built.payload };
    }
    return { ...verdict, payload: built.payload };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: 'network-error',
      message: ALIAS_FAILURE_MESSAGES['network-error'],
      payload: built.payload,
      error: err,
    };
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}
