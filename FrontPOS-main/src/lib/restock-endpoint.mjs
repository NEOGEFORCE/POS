// ============================================================================
// CONSTRUCCION DEL ENDPOINT /restock/suggestions-v2
// ============================================================================
//
// Regla del dueno (Fase 1): la busqueda es SERVER-SIDE. La caja de texto no
// filtra sobre el catalogo completo cargado en memoria, sino que le pide al
// backend un subconjunto acotado. Esto acelera drasticamente el celular,
// donde antes se montaban miles de tarjetas en el DOM.
//
// Contrato:
//   GET /restock/suggestions-v2
//       ?supplier_id=<id>       (opcional; se omite en modo global)
//       &search=<texto>          (opcional; se omite si esta vacio)
//       &include_all=<bool>      (default false = solo prioridades)
//
// Este helper vive en .mjs para poder testear la construccion de la URL con
// `node --test` (ver tests/restock-endpoint.test.mjs). Escupe la ruta
// relativa sin origen; el fetcher del hook la concatena al API base.

const BASE_PATH = "/restock/suggestions-v2";

function shouldSendSupplier(rawKey) {
  if (rawKey === null || rawKey === undefined) return false;
  const trimmed = String(rawKey).trim();
  if (!trimmed) return false;
  if (["global", "unassigned"].includes(trimmed.toLowerCase())) return false;
  if (trimmed === "0") return false;
  return true;
}

function normalizeSearch(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  return trimmed.length === 0 ? "" : trimmed;
}

/**
 * Construye el endpoint relativo con los parametros correctos.
 *
 * @param {object} [params]
 * @param {string | number | null | undefined} [params.supplierId] clave del
 *        proveedor tal como viene del selector ("global", "0", "20", 20, ...).
 * @param {string} [params.search] texto ya deshoyado (el debounce vive fuera).
 * @param {boolean} [params.includeAll] cuando es true, pide TODO el catalogo
 *        del proveedor. Cuando es false (default), el backend restringe la
 *        respuesta a las prioridades (rojo/amarillo o con sugerencia > 0).
 * @param {boolean} [params.unassignedOnly] pide exclusivamente productos sin
 *        proveedor y fuerza include_all=true sin serializar supplier_id.
 * @returns {string}
 */
export function buildRestockSuggestionsEndpoint(params = {}) {
  const query = new URLSearchParams();
  const unassignedOnly = params.unassignedOnly === true
    || String(params.supplierId ?? "").trim().toLowerCase() === "unassigned";

  if (!unassignedOnly && shouldSendSupplier(params.supplierId)) {
    query.append("supplier_id", String(params.supplierId).trim());
  }
  if (unassignedOnly) {
    query.append("unassigned_only", "true");
  }

  const search = normalizeSearch(params.search);
  if (search) {
    query.append("search", search);
  }

  // include_all va siempre explicito: hace de flag legible en logs del back
  // y evita que un default distinto en cliente vs servidor descuadre el
  // comportamiento. Sin embargo, para conservar compatibilidad con backend
  // viejo que no espera el parametro, cuando el default (false) se
  // combina con un search vacio omitimos el flag: en ese caso la URL queda
  // exactamente como la version pre-Fase 1 (`/restock/suggestions-v2` a
  // secas) y no rompemos deploys parciales.
  if (unassignedOnly || params.includeAll === true) {
    query.append("include_all", "true");
  } else if (search) {
    query.append("include_all", "false");
  }

  const qs = query.toString();
  return qs ? `${BASE_PATH}?${qs}` : BASE_PATH;
}
