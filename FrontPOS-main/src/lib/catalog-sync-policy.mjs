// Política de sincronización del catálogo offline.
//
// El catálogo local en IndexedDB sólo existe para poder seguir vendiendo si el
// servidor se cae. Las vistas normales del POS ya se refrescan por SWR/SSE, así
// que este mirror NO tiene que estar al segundo. Los helpers de este módulo
// deciden cuándo corresponde bajar de nuevo el catálogo completo y aíslan esa
// decisión de React para poder testearla con node --test.

export const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000; // 10 min
export const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000; // 30 min
export const RECONNECT_MIN_INTERVAL_MS = 60 * 1000; // 1 min

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Decide si toca sincronizar el catálogo completo AHORA.
 *
 * Regla:
 *  - Sin marca previa de sincronización -> sí.
 *  - Con marca previa: sólo si transcurrió al menos `minIntervalMs`.
 * Esto evita que 32 pestañas abiertas disparen 32 descargas en cadena y
 * también que un intervalo se solape con la sincronización al montar.
 *
 * @param {object} args
 * @param {number|null|undefined} args.lastSyncAt Timestamp de la última corrida (ms).
 * @param {number} args.now Timestamp actual (ms).
 * @param {number} [args.minIntervalMs] Piso mínimo entre sincronizaciones.
 * @returns {boolean}
 */
export function shouldSyncCatalog({ lastSyncAt, now, minIntervalMs = DEFAULT_MIN_INTERVAL_MS } = {}) {
  const currentTs = toFiniteNumber(now);
  if (currentTs === null) return false;
  const lastTs = toFiniteNumber(lastSyncAt);
  if (lastTs === null || lastTs <= 0) return true;
  const gap = currentTs - lastTs;
  if (gap < 0) {
    // Reloj para atrás (cambio de zona, DST, etc.): permitimos y reajustamos.
    return true;
  }
  const floor = toFiniteNumber(minIntervalMs);
  const minGap = floor !== null && floor > 0 ? floor : DEFAULT_MIN_INTERVAL_MS;
  return gap >= minGap;
}

/**
 * Indica si el snapshot local ya se puede considerar viejo para modo offline.
 * Sirve para decidir sincronizaciones bajo demanda (por ejemplo al detectar
 * pérdida de conexión) sin depender del intervalo periódico.
 *
 * @param {object} args
 * @param {number|null|undefined} args.lastSyncAt
 * @param {number} args.now
 * @param {number} [args.staleAfterMs]
 * @returns {boolean}
 */
export function isCatalogStale({ lastSyncAt, now, staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  const currentTs = toFiniteNumber(now);
  if (currentTs === null) return false;
  const lastTs = toFiniteNumber(lastSyncAt);
  if (lastTs === null || lastTs <= 0) return true;
  const gap = currentTs - lastTs;
  if (gap < 0) return true;
  const threshold = toFiniteNumber(staleAfterMs);
  const staleGap = threshold !== null && threshold > 0 ? threshold : DEFAULT_STALE_AFTER_MS;
  return gap >= staleGap;
}

/**
 * Piso mínimo entre sincronizaciones según lo que la disparó.
 *
 * El caso 'reconnect' merece un piso mucho más corto: mientras no había red se
 * estuvo vendiendo contra el snapshot local, así que en cuanto vuelve la
 * conexión ese snapshot es justo el dato que conviene refrescar (precios y
 * altas nuevas). Esperar los 10 minutos del piso normal dejaría al cajero
 * vendiendo con precios viejos justo después de una caída.
 *
 * Se conserva un piso de 1 minuto porque una red intermitente emite ráfagas de
 * eventos `online`/`offline`, y sin piso cada parpadeo bajaría el catálogo
 * completo.
 *
 * @param {'mount'|'interval'|'reconnect'} reason
 * @returns {number}
 */
export function syncFloorForReason(reason) {
  return reason === 'reconnect' ? RECONNECT_MIN_INTERVAL_MS : DEFAULT_MIN_INTERVAL_MS;
}
