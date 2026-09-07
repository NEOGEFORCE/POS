// Helpers puros para el conflicto HISTORICAL_MARKER_RESERVED.
//
// Cuando el operador cambia el código de barras de un producto y ese código
// está ocupado por un producto-marcador '[HISTORICO] ...', el backend responde
// con un 409 estructurado:
//
//   {
//     "success": false,
//     "message": "...",
//     "error": {
//       "code": "HISTORICAL_MARKER_RESERVED",
//       "message": "...",
//       "metadata": { "realBarcode", "markerBarcode", "markerName" }
//     }
//   }
//
// El frontend expone ese payload en `ApiError.data`. Estos helpers son puros
// (sin dependencias de UI, apiFetch ni React) para poder probarlos en Node y
// tolerar variaciones menores del contrato (por ejemplo, si algún day el
// backend expone `code`/`metadata` planos en la raíz de `data`).

export const HISTORICAL_MARKER_CODE = 'HISTORICAL_MARKER_RESERVED';

function readCode(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.code === 'string') return data.code;
  if (data.error && typeof data.error === 'object' && typeof data.error.code === 'string') {
    return data.error.code;
  }
  return null;
}

function readMetadata(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.metadata && typeof data.metadata === 'object') return data.metadata;
  if (data.error && typeof data.error === 'object' && data.error.metadata && typeof data.error.metadata === 'object') {
    return data.error.metadata;
  }
  return null;
}

function normalizeBarcode(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeName(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * Detecta si un error atrapado corresponde al conflicto HISTORICAL_MARKER_RESERVED.
 * Acepta objetos con forma `{ status, data }` (ApiError) y valida:
 *  - status === 409
 *  - data.code === 'HISTORICAL_MARKER_RESERVED'
 *    (o data.error.code === 'HISTORICAL_MARKER_RESERVED', por compatibilidad).
 */
export function isHistoricalMarkerError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.status !== 409) return false;
  return readCode(err.data) === HISTORICAL_MARKER_CODE;
}

/**
 * Extrae `{ realBarcode, markerBarcode, markerName }` del error.
 * Retorna `null` cuando falta alguno de los códigos, para que el consumidor
 * pueda hacer fallback a un toast genérico en lugar de abrir el diálogo con
 * datos vacíos.
 */
export function extractHistoricalMarkerMetadata(err) {
  if (!err || typeof err !== 'object') return null;
  const meta = readMetadata(err.data);
  if (!meta) return null;
  const realBarcode = normalizeBarcode(meta.realBarcode);
  const markerBarcode = normalizeBarcode(meta.markerBarcode);
  const markerName = normalizeName(meta.markerName);
  if (!realBarcode || !markerBarcode) return null;
  return { realBarcode, markerBarcode, markerName };
}

/**
 * Construye el body para `POST /admin/products/merge-historical`.
 * Retorna `null` cuando el par no es utilizable (códigos vacíos o iguales),
 * evitando disparar una llamada con datos inválidos.
 */
export function buildMergeRequest(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const realBarcode = normalizeBarcode(metadata.realBarcode);
  const markerBarcode = normalizeBarcode(metadata.markerBarcode);
  if (!realBarcode || !markerBarcode) return null;
  if (realBarcode === markerBarcode) return null;
  return { realBarcode, markerBarcode };
}

/**
 * Elimina campos del payload que quedarían obsoletos tras un merge exitoso.
 *
 * `updatedAt` es el candidato principal: el backend usa optimistic locking
 * comparando la marca de tiempo del payload contra la de la BD. Como el merge
 * refresca ese timestamp, reintentar el PUT con el `updatedAt` viejo dispara
 * "el producto cambió mientras estaba abierto". Al removerlo, el segundo
 * guardado se salta la validación (el backend interpreta zero-value como
 * "no verificar") y aplica los demás cambios.
 */
export function stripStaleTimestamp(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const clone = { ...payload };
  delete clone.updatedAt;
  delete clone.updated_at;
  return clone;
}

/**
 * Verdadero cuando el rol puede ejecutar el merge admin. El endpoint
 * `POST /admin/products/merge-historical` vive detrás de middleware de admin,
 * así que un no-admin verá 403 aunque el frontend lo permita. La UI usa este
 * chequeo para ocultar el botón y pedir explícitamente que un administrador
 * apruebe la fusión.
 */
export function isAdminRole(role) {
  if (!role) return false;
  const normalized = String(role).trim().toLowerCase();
  return normalized === 'admin' || normalized === 'administrador' || normalized === 'superadmin';
}
