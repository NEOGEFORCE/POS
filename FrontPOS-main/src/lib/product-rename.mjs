// Pure helpers for the "rename-and-link" flow of UnmatchedItemsReviewer.
//
// Al enlazar un producto EXISTENTE desde el reviewer del OCR (sugerencia,
// búsqueda manual o escáner), el flujo abre un diálogo que ofrece tres
// acciones:
//
//   1. "Solo enlazar": guarda el alias y avanza al siguiente item SIN tocar
//      el nombre del producto.
//   2. "Actualizar nombre y enlazar": pide al padre que haga el PUT a
//      `/products/update-products/:barcode` con sanitizeProductPayload. Si
//      el PUT es exitoso, se actualiza el estado local, se emite el
//      broadcast PRODUCT_UPDATE, se guarda el alias y se avanza. Si falla,
//      el diálogo se mantiene abierto mostrando el error.
//   3. "Volver": cierra el diálogo sin enlazar ni cambiar nada.
//
// Para que los tests no dependan ni del DOM ni de Next, aislamos la lógica
// pura (normalización del nombre, validación, clasificación de outcome,
// construcción de URL) en este módulo .mjs y la exponemos por tipos en
// `product-rename.d.mts`.
//
// Importante: nunca renombramos de forma automática. Un rename sólo ocurre
// cuando el operario pulsa deliberadamente "Actualizar nombre y enlazar".

/**
 * Mensajes humanos para toasts/errores del flujo de rename. Centralizados
 * para que la UI y los tests coincidan en el texto.
 */
export const RENAME_FAILURE_MESSAGES = Object.freeze({
  'empty-name':
    'El nombre no puede estar vacío.',
  'identical-name':
    'El nombre propuesto es idéntico al actual; no hace falta actualizarlo.',
  'missing-barcode':
    'No se puede renombrar sin un código de barras válido.',
  'http-error':
    'El servidor rechazó la actualización del nombre; vuelve a intentarlo.',
  'network-error':
    'Sin conexión al actualizar el nombre; intenta de nuevo cuando haya red.',
  'unauthorized':
    'Tu sesión caducó al actualizar el nombre; vuelve a iniciar sesión.',
});

/**
 * Normaliza un nombre propuesto siguiendo las reglas del POS:
 *   - trim de bordes
 *   - colapso de espacios internos múltiples a uno solo
 *   - MAYÚSCULAS
 *   - quita tildes/diacríticos pero conserva la ñ (igual que `normalizeText`
 *     en `src/lib/utils.ts`).
 *
 * Para valores no string retorna cadena vacía — permite que la validación
 * detecte el caso con `empty-name` sin lanzar.
 */
export function normalizeProposedName(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  // Igual algoritmo que normalizeText de utils.ts: quita diacríticos excepto
  // la ñ (U+0303) y vuelve a NFC para que el string sea estable.
  return trimmed
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, (match) => (match === '\u0303' ? match : ''))
    .normalize('NFC');
}

/**
 * Devuelve true cuando el diálogo de rename DEBE abrirse: el invoiceName
 * tiene sustancia y, una vez normalizado, difiere del nombre actual del
 * producto. Si son iguales o invoiceName está vacío, prompearíamos sin
 * motivo y confundiríamos al cajero.
 */
export function shouldPromptRename({ currentName, invoiceName } = {}) {
  const invoice = normalizeProposedName(invoiceName);
  if (!invoice) return false;
  const current = normalizeProposedName(currentName);
  // Si no conocemos el nombre actual (p.ej. una sugerencia sin match
  // completo) igual preguntamos — es la decisión segura para no renombrar a
  // ciegas y, aun así, dejar al operario decidir "Solo enlazar".
  if (!current) return true;
  return current !== invoice;
}

/**
 * Valida el nombre que el operario escribió en el input del diálogo.
 *   - vacío/whitespace → reason 'empty-name'
 *   - idéntico al actual tras normalizar → reason 'identical-name'
 *   - válido → `{ ok: true, name: NORMALIZADO }`
 *
 * Nunca lanza. El llamador decide si muestra toast inline o deja el botón
 * de acción deshabilitado.
 */
export function validateProposedName(value, currentName) {
  const normalized = normalizeProposedName(value);
  if (!normalized) {
    return {
      ok: false,
      reason: 'empty-name',
      message: RENAME_FAILURE_MESSAGES['empty-name'],
    };
  }
  const current = normalizeProposedName(currentName);
  if (current && current === normalized) {
    return {
      ok: false,
      reason: 'identical-name',
      message: RENAME_FAILURE_MESSAGES['identical-name'],
    };
  }
  return { ok: true, name: normalized };
}

/**
 * Normaliza el `apiBase` (quita slash final) y construye la URL del PUT
 * `/products/update-products/:barcode`. Centralizado para que los tests
 * eviten regresiones al cambiar el path (ya pasó una vez en otros flujos).
 *
 * Rechaza con `{ ok: false, reason: 'missing-barcode' }` si el barcode es
 * vacío o no string.
 */
export function buildRenameUrl(apiBase, barcode) {
  const raw = typeof barcode === 'string' ? barcode.trim() : '';
  if (!raw) {
    return {
      ok: false,
      reason: 'missing-barcode',
      message: RENAME_FAILURE_MESSAGES['missing-barcode'],
    };
  }
  const base = typeof apiBase === 'string' && apiBase.length > 0
    ? apiBase.replace(/\/+$/, '')
    : '/api';
  const encoded = encodeURIComponent(raw.toUpperCase());
  return {
    ok: true,
    url: `${base}/products/update-products/${encoded}`,
    barcode: raw.toUpperCase(),
  };
}

/**
 * Clasifica el outcome HTTP de un rename. Mantiene paralelismo con
 * `classifyAliasResponse` de alias-persistence para que la UI mapee errores
 * con la misma gramática (unauthorized / http-error / network-error).
 */
export function classifyRenameResponse(res) {
  if (!res || typeof res.ok !== 'boolean' || typeof res.status !== 'number') {
    return {
      ok: false,
      status: 0,
      reason: 'http-error',
      message: RENAME_FAILURE_MESSAGES['http-error'],
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
      message: RENAME_FAILURE_MESSAGES['unauthorized'],
    };
  }
  return {
    ok: false,
    status: res.status,
    reason: 'http-error',
    message: RENAME_FAILURE_MESSAGES['http-error'],
  };
}

/**
 * Dada una ApiError u objeto thrown por la capa de red, devuelve un
 * veredicto consistente para mostrar en el diálogo de rename. Preserva el
 * `message` del error cuando viene — el backend puede detallar la razón
 * (p.ej. 400 con mensajes de validación) y queremos surfaceárselo al
 * operario sin inventar texto.
 */
export function extractRenameErrorMessage(err) {
  if (!err) {
    return RENAME_FAILURE_MESSAGES['http-error'];
  }
  // ApiError viene con `.message` y opcionalmente `.status`.
  if (typeof err === 'object') {
    const status = Number(err.status);
    if (status === 401 || status === 403) {
      return RENAME_FAILURE_MESSAGES['unauthorized'];
    }
    // TypeError 'Failed to fetch' (y familia) llega como instance of Error
    // con name 'TypeError'. Lo tratamos como network-error ANTES de leer
    // el message, para que la UI vea un texto humano en vez del del
    // navegador.
    if (err.name === 'TypeError') return RENAME_FAILURE_MESSAGES['network-error'];
    const msg = typeof err.message === 'string' ? err.message.trim() : '';
    if (msg) return msg;
  }
  if (typeof err === 'string' && err.trim()) return err.trim();
  return RENAME_FAILURE_MESSAGES['http-error'];
}
