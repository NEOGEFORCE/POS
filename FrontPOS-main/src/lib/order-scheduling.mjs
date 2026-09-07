// Reglas puras de agrupamiento y de eleccion de fecha para la pantalla de
// Pedidos Inteligentes. Se vive fuera de React para poder probar cada regla
// con `node --test` sin montar la UI.
//
// Contrato de datos: los items son sugerencias de /restock/suggestions-v2 (v2
// del backend), documentadas en el resumen de la etapa backend-proveedor-fechas.
// Campos relevantes aqui:
//   - primarySupplierId        (uint | null) proveedor efectivo asignado a la fila
//   - supplierName             (string)
//   - supplierLeadDays         (integer) lead time efectivo
//   - nextVisitDate            (YYYY-MM-DD | null) proxima visita segun agenda
//   - nextDeliveryDate         (YYYY-MM-DD | null) proxima entrega segun agenda
//   - daysUntilNextVisit       (integer | null)
//   - leadTimeSource           ("configured_days" | "explicit_lead_time" |
//                                "visit_frequency_learned" | "default")
//
// Convencion: cuando leadTimeSource === "configured_days" la agenda es
// confiable (viene de los dias que el dueno configuro en el proveedor). En los
// otros tres casos nextVisitDate / nextDeliveryDate son null y la fecha
// propuesta baja a una estimacion (hoy + lead time efectivo).

/** Fuentes conocidas del lead time, segun el contrato del backend. */
export const LEAD_TIME_SOURCE = Object.freeze({
  CONFIGURED_DAYS: "configured_days",
  LEARNED_DAYS: "learned_days",
  EXPLICIT_LEAD_TIME: "explicit_lead_time",
  VISIT_FREQUENCY_LEARNED: "visit_frequency_learned",
  DEFAULT: "default",
});

/**
 * Fuente de la agenda efectiva (visitas / entregas) que reporta el backend.
 * "manual" ⇒ salio de los dias que el dueno configuro en la ficha.
 * "learned" ⇒ salio de la agenda aprendida por el nocturno observando pedidos
 *              reales, y el dueno no tiene nada configurado.
 * "none"   ⇒ no hay agenda ni configurada ni aprendida (fechas en null).
 */
export const AGENDA_SOURCE = Object.freeze({
  MANUAL: "manual",
  LEARNED: "learned",
  NONE: "none",
});

/**
 * Umbral minimo de pedidos observados que el backend usa para considerar la
 * agenda aprendida como "confiable". Debe coincidir con
 * `scheduling.LearnMinSamples` del back. Se guarda aca para poder etiquetar
 * en la UI cuando el respaldo es debil (< min) versus solido.
 */
export const LEARN_MIN_SAMPLES = 4;

const DEFAULT_LEAD_DAYS = 7;

/**
 * Agrupa las sugerencias por proveedor. La agrupacion cambia con el filtro:
 *
 *  - Sin filtro (selectedSupplierKey === 'global' | vacio | '0'): se agrupa
 *    por primarySupplierId, tal como venia funcionando. Sin proveedor
 *    asignado el grupo cae al bucket 'unassigned'.
 *  - Con filtro activo: la pantalla debe mostrar UN SOLO grupo con el
 *    proveedor seleccionado. El backend ya reescribe primarySupplierId al
 *    proveedor efectivo cuando hay filtro, pero agrupamos igual
 *    defensivamente por si alguna fila llegara mal etiquetada.
 *
 * @param {Array<object>} items sugerencias listas para pintar
 * @param {string} [selectedSupplierKey] '' | 'global' | '0' para sin filtro
 * @returns {Array<{key: string, supplierId: number | null, supplierName: string, items: Array<object>}>}
 */
export function groupSuggestionsBySupplier(items, selectedSupplierKey = "global") {
  const list = Array.isArray(items) ? items : [];
  const filterActive = isSupplierFilterActive(selectedSupplierKey);

  if (filterActive) {
    if (list.length === 0) return [];
    // Elegimos identidad y nombre del grupo a partir del primer item que traiga
    // primarySupplierId numerico. Cae al key del filtro si ninguno lo trae.
    let supplierId = null;
    let supplierName = "";
    for (const item of list) {
      if (item && typeof item.primarySupplierId === "number" && Number.isFinite(item.primarySupplierId)) {
        supplierId = item.primarySupplierId;
        supplierName = typeof item.supplierName === "string" && item.supplierName.trim()
          ? item.supplierName
          : supplierName;
        break;
      }
    }
    if (!supplierName) {
      // Ultimo recurso: usar el nombre de cualquier item que lo traiga.
      const withName = list.find((item) => item && typeof item.supplierName === "string" && item.supplierName.trim());
      supplierName = withName?.supplierName ?? "Proveedor seleccionado";
    }
    const numericFilter = Number(selectedSupplierKey);
    const key = supplierId !== null
      ? String(supplierId)
      : (Number.isFinite(numericFilter) && numericFilter > 0 ? String(numericFilter) : `filter-${selectedSupplierKey}`);
    return [
      {
        key,
        supplierId,
        supplierName,
        items: list.slice(),
      },
    ];
  }

  const groups = new Map();
  for (const item of list) {
    if (!item) continue;
    const supplierId = typeof item.primarySupplierId === "number" && Number.isFinite(item.primarySupplierId)
      ? item.primarySupplierId
      : null;
    const key = supplierId !== null ? String(supplierId) : "unassigned";
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    groups.set(key, {
      key,
      supplierId,
      supplierName: typeof item.supplierName === "string" && item.supplierName.trim()
        ? item.supplierName
        : "Sin proveedor asignado",
      items: [item],
    });
  }
  return Array.from(groups.values()).sort((left, right) =>
    (left.supplierName || "").localeCompare(right.supplierName || "", "es")
  );
}

/**
 * Devuelve true cuando el usuario tiene un proveedor puntual seleccionado.
 * Reconoce las variantes que usa la URL (`global`, vacio, `'0'`).
 * @param {string | number | null | undefined} selectedSupplierKey
 */
export function isSupplierFilterActive(selectedSupplierKey) {
  if (selectedSupplierKey === null || selectedSupplierKey === undefined) return false;
  const raw = String(selectedSupplierKey).trim().toLowerCase();
  if (!raw) return false;
  if (raw === "global") return false;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed <= 0) return false;
  return true;
}

/**
 * Elige la fecha propuesta de entrega para un grupo de sugerencias.
 *
 * Reglas:
 *   1. Si algun item tiene leadTimeSource === 'configured_days' y trae
 *      nextDeliveryDate valida, se usa la MAS CERCANA. Todo lo demas ignorado.
 *      La UI la puede pintar como "segun agenda del proveedor".
 *   2. Si no hay agenda manual pero el backend paso a la agenda aprendida
 *      (leadTimeSource === 'learned_days'), se usa esa fecha, marcada como
 *      "aprendida". La UI debe dejar claro que sale del aprendizaje, no de
 *      lo que el dueno configuro.
 *   3. Si tampoco hay agenda aprendida, se estima con "hoy + lead time"
 *      usando el maximo supplierLeadDays del grupo (o 7 dias por defecto).
 *      La UI la debe pintar como "estimada" y avisar que faltan dias en la
 *      ficha del proveedor.
 *
 * Todas las fechas se emiten en formato YYYY-MM-DD y zona America/Bogota.
 *
 * @param {Array<object>} items sugerencias del grupo
 * @param {object} [opts]
 * @param {Date} [opts.today] reloj inyectado para tests deterministicos
 * @param {number} [opts.fallbackLeadDays] fallback si el grupo no informa lead time
 * @returns {{
 *   isoDate: string,
 *   source: string,
 *   hasConfiguredDays: boolean,
 *   hasLearnedDays: boolean,
 *   leadDaysUsed: number,
 *   nextVisitDate: string | null,
 *   nextDeliveryDate: string | null,
 * }}
 */
export function resolveExpectedDeliveryDate(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const today = opts.today instanceof Date ? opts.today : new Date();
  const fallbackLeadDays = Number.isFinite(opts.fallbackLeadDays) && opts.fallbackLeadDays > 0
    ? Math.floor(opts.fallbackLeadDays)
    : DEFAULT_LEAD_DAYS;

  // Preferencia 1: agenda manual. Si al menos una fila trae dias configurados
  // con fecha valida, se toma la mas cercana. El dueno manda siempre.
  let bestDelivery = null;
  let bestVisit = null;
  for (const item of list) {
    if (!item) continue;
    if (item.leadTimeSource !== LEAD_TIME_SOURCE.CONFIGURED_DAYS) continue;
    const delivery = normalizeIsoDate(item.nextDeliveryDate);
    if (!delivery) continue;
    if (!bestDelivery || delivery < bestDelivery) {
      bestDelivery = delivery;
      bestVisit = normalizeIsoDate(item.nextVisitDate);
    }
  }
  if (bestDelivery) {
    return {
      isoDate: bestDelivery,
      source: LEAD_TIME_SOURCE.CONFIGURED_DAYS,
      hasConfiguredDays: true,
      hasLearnedDays: false,
      leadDaysUsed: 0,
      nextVisitDate: bestVisit,
      nextDeliveryDate: bestDelivery,
    };
  }

  // Preferencia 2: agenda aprendida. Cuando el dueno no configuro nada pero
  // el sistema ya observo un patron consistente, el backend pone la fecha en
  // nextDeliveryDate con leadTimeSource='learned_days'.
  let bestLearnedDelivery = null;
  let bestLearnedVisit = null;
  for (const item of list) {
    if (!item) continue;
    if (item.leadTimeSource !== LEAD_TIME_SOURCE.LEARNED_DAYS) continue;
    const delivery = normalizeIsoDate(item.nextDeliveryDate);
    if (!delivery) continue;
    if (!bestLearnedDelivery || delivery < bestLearnedDelivery) {
      bestLearnedDelivery = delivery;
      bestLearnedVisit = normalizeIsoDate(item.nextVisitDate);
    }
  }
  if (bestLearnedDelivery) {
    return {
      isoDate: bestLearnedDelivery,
      source: LEAD_TIME_SOURCE.LEARNED_DAYS,
      hasConfiguredDays: false,
      hasLearnedDays: true,
      leadDaysUsed: 0,
      nextVisitDate: bestLearnedVisit,
      nextDeliveryDate: bestLearnedDelivery,
    };
  }

  const leadDaysUsed = list.reduce(
    (max, item) => {
      const value = Number(item?.supplierLeadDays);
      return Number.isFinite(value) && value > 0 ? Math.max(max, value) : max;
    },
    0,
  ) || fallbackLeadDays;

  const sourcesInGroup = list
    .map((item) => (item && typeof item.leadTimeSource === "string" ? item.leadTimeSource : null))
    .filter((source) => source
      && source !== LEAD_TIME_SOURCE.CONFIGURED_DAYS
      && source !== LEAD_TIME_SOURCE.LEARNED_DAYS);
  const preferredSource = sourcesInGroup.find(Boolean) ?? LEAD_TIME_SOURCE.DEFAULT;

  return {
    isoDate: addDaysBogotaIso(today, leadDaysUsed),
    source: preferredSource,
    hasConfiguredDays: false,
    hasLearnedDays: false,
    leadDaysUsed,
    nextVisitDate: null,
    nextDeliveryDate: null,
  };
}

/**
 * Suma dias a la referencia y devuelve la fecha resultante en YYYY-MM-DD,
 * formateada en zona America/Bogota. Reproduce el comportamiento del
 * `dateAfter` legacy para conservar compatibilidad visual.
 *
 * @param {Date} reference
 * @param {number} days
 * @returns {string}
 */
export function addDaysBogotaIso(reference, days) {
  const base = reference instanceof Date ? new Date(reference.getTime()) : new Date();
  const safe = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 0;
  base.setDate(base.getDate() + safe);
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(base);
}

/**
 * Etiqueta corta para pintar el origen del calculo debajo del "ideal".
 * @param {string | null | undefined} source
 * @returns {{ label: string, trusted: boolean }}
 */
export function describeLeadTimeSource(source) {
  switch (source) {
    case LEAD_TIME_SOURCE.CONFIGURED_DAYS:
      return { label: "segun dias configurados", trusted: true };
    case LEAD_TIME_SOURCE.LEARNED_DAYS:
      // La agenda aprendida es confiable (>= 4 pedidos observados) pero
      // vino del sistema, no del dueno. Se marca como confiable para no
      // caer en la estimacion generica, pero la UI la muestra como
      // "aprendida" para dejar claro que no es lo que el dueno escribio.
      return { label: "segun agenda aprendida", trusted: true };
    case LEAD_TIME_SOURCE.EXPLICIT_LEAD_TIME:
      return { label: "estimado por lead time del proveedor", trusted: false };
    case LEAD_TIME_SOURCE.VISIT_FREQUENCY_LEARNED:
      return { label: "estimado por frecuencia aprendida", trusted: false };
    case LEAD_TIME_SOURCE.DEFAULT:
      return { label: "estimado por defecto", trusted: false };
    default:
      return { label: "estimado", trusted: false };
  }
}

/**
 * Detecta si un grupo tiene informacion suficiente para pintar fechas
 * ajustadas o si toca avisar al usuario que configure los dias del proveedor.
 * @param {Array<object>} items
 * @returns {{
 *   allConfigured: boolean,
 *   anyConfigured: boolean,
 *   missingSchedule: boolean,
 *   source: string,
 * }}
 */
export function summarizeGroupSchedule(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return {
      allConfigured: false,
      anyConfigured: false,
      missingSchedule: false,
      source: LEAD_TIME_SOURCE.DEFAULT,
    };
  }
  let configured = 0;
  let sourceObserved = null;
  for (const item of list) {
    const source = item && typeof item.leadTimeSource === "string" ? item.leadTimeSource : null;
    if (source === LEAD_TIME_SOURCE.CONFIGURED_DAYS) {
      configured += 1;
      sourceObserved = LEAD_TIME_SOURCE.CONFIGURED_DAYS;
    } else if (source && !sourceObserved) {
      sourceObserved = source;
    }
  }
  const allConfigured = configured === list.length;
  const anyConfigured = configured > 0;
  return {
    allConfigured,
    anyConfigured,
    missingSchedule: !anyConfigured,
    source: sourceObserved ?? LEAD_TIME_SOURCE.DEFAULT,
  };
}

function normalizeIsoDate(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
  return trimmed.slice(0, 10);
}

/**
 * Normaliza el nombre de un dia para comparaciones sin acentos ni
 * mayusculas. "MIÉRCOLES" y "miercoles" son iguales.
 */
function normalizeDayName(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Convierte un input en una lista de dias en minusculas sin acentos,
 * conservando el orden original y descartando duplicados y vacios.
 * @param {unknown} raw
 * @returns {string[]}
 */
function cleanDayList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const value of raw) {
    const normalized = normalizeDayName(String(value ?? ""));
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * Compara dos listas de dias como conjuntos (orden irrelevante).
 */
function sameDayList(left, right) {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  for (const value of right) if (!set.has(value)) return false;
  return true;
}

/**
 * Toma el primer item con un valor definido para la clave dada. Los items del
 * mismo grupo comparten los campos de agenda del proveedor, pero un fallback
 * defensivo evita pintar undefined si la primera fila viene sin proveedor.
 * @template T
 * @param {Array<object>} list
 * @param {(item: object) => T | undefined} accessor
 * @returns {T | undefined}
 */
function pickFirst(list, accessor) {
  for (const item of list) {
    if (!item) continue;
    const value = accessor(item);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Resume las DOS agendas del proveedor (la manual y la aprendida) para pintar
 * la comparacion en la UI. La logica no combina las listas: cada una queda
 * separada para que el dueno vea que fue lo que el escribio y que fue lo que
 * el sistema observo, y pueda decidir.
 *
 * @param {Array<object>} items sugerencias del grupo
 * @returns {{
 *   configured: {
 *     visitDays: string[],
 *     deliveryDays: string[],
 *     hasConfigured: boolean,
 *   },
 *   learned: {
 *     visitDays: string[],
 *     deliveryDays: string[],
 *     leadTimeDays: number | null,
 *     sampleCount: number,
 *     learnedAt: string | null,
 *     hasLearned: boolean,
 *     isReliable: boolean,
 *   },
 *   contradiction: {
 *     visit: boolean,
 *     delivery: boolean,
 *     hasAny: boolean,
 *   },
 *   agendaSource: string,
 * }}
 */
export function summarizeSupplierAgenda(items) {
  const list = Array.isArray(items) ? items : [];

  const configuredVisit = cleanDayList(pickFirst(list, (item) => item.visitDays));
  const configuredDelivery = cleanDayList(pickFirst(list, (item) => item.deliveryDays));
  const scheduleFlag = pickFirst(list, (item) =>
    typeof item.scheduleHasConfigured === "boolean" ? item.scheduleHasConfigured : undefined,
  );
  const hasConfigured = typeof scheduleFlag === "boolean"
    ? scheduleFlag
    : (configuredVisit.length > 0 || configuredDelivery.length > 0);

  const learnedVisit = cleanDayList(pickFirst(list, (item) => item.learnedVisitDays));
  const learnedDelivery = cleanDayList(pickFirst(list, (item) => item.learnedDeliveryDays));
  const learnedLeadRaw = pickFirst(list, (item) =>
    Number.isFinite(item.learnedLeadTimeDays) ? item.learnedLeadTimeDays : undefined,
  );
  const learnedLead = typeof learnedLeadRaw === "number" && learnedLeadRaw > 0
    ? Math.floor(learnedLeadRaw)
    : null;
  const sampleCountRaw = pickFirst(list, (item) =>
    Number.isFinite(item.learnedSampleCount) ? item.learnedSampleCount : undefined,
  );
  const sampleCount = typeof sampleCountRaw === "number" && sampleCountRaw > 0
    ? Math.floor(sampleCountRaw)
    : 0;
  const learnedAt = pickFirst(list, (item) => (typeof item.learnedAt === "string" ? item.learnedAt : undefined))
    ?? null;

  // "hasLearned" es debil: hay evidencia (sample_count > 0) pero puede que
  // esten pocos dias listados. "isReliable" alinea con el umbral del back:
  // sample_count >= 4 y al menos un dia listado.
  const hasLearned = sampleCount > 0
    && (learnedVisit.length > 0 || learnedDelivery.length > 0 || learnedLead !== null);
  const isReliable = hasLearned && sampleCount >= LEARN_MIN_SAMPLES
    && (learnedVisit.length > 0 || learnedDelivery.length > 0);

  // Contradicciones: solo tienen sentido cuando ambas agendas existen.
  const visitContradiction = hasConfigured
    && isReliable
    && learnedVisit.length > 0
    && configuredVisit.length > 0
    && !sameDayList(configuredVisit, learnedVisit);
  const deliveryContradiction = hasConfigured
    && isReliable
    && learnedDelivery.length > 0
    && configuredDelivery.length > 0
    && !sameDayList(configuredDelivery, learnedDelivery);

  // Origen de la agenda efectiva. El backend ya lo reporta por fila; la UI
  // usa esta cifra para etiquetar. Si algun item lo trae, se usa; si no, se
  // infiere de lo que el grupo trae.
  const agendaSourceFromItem = pickFirst(list, (item) =>
    typeof item.agendaSource === "string" && item.agendaSource ? item.agendaSource : undefined,
  );
  let agendaSource;
  if (agendaSourceFromItem === AGENDA_SOURCE.MANUAL
    || agendaSourceFromItem === AGENDA_SOURCE.LEARNED
    || agendaSourceFromItem === AGENDA_SOURCE.NONE) {
    agendaSource = agendaSourceFromItem;
  } else if (hasConfigured) {
    agendaSource = AGENDA_SOURCE.MANUAL;
  } else if (isReliable) {
    agendaSource = AGENDA_SOURCE.LEARNED;
  } else {
    agendaSource = AGENDA_SOURCE.NONE;
  }

  return {
    configured: {
      visitDays: configuredVisit,
      deliveryDays: configuredDelivery,
      hasConfigured,
    },
    learned: {
      visitDays: learnedVisit,
      deliveryDays: learnedDelivery,
      leadTimeDays: learnedLead,
      sampleCount,
      learnedAt,
      hasLearned,
      isReliable,
    },
    contradiction: {
      visit: visitContradiction,
      delivery: deliveryContradiction,
      hasAny: visitContradiction || deliveryContradiction,
    },
    agendaSource,
  };
}

/**
 * Etiqueta corta para pintar de donde sale la fecha propuesta.
 * @param {string | null | undefined} source
 * @returns {{ label: string, trusted: boolean, tone: 'manual' | 'learned' | 'none' }}
 */
export function describeAgendaSource(source) {
  switch (source) {
    case AGENDA_SOURCE.MANUAL:
      return { label: "agenda configurada", trusted: true, tone: "manual" };
    case AGENDA_SOURCE.LEARNED:
      return { label: "agenda aprendida", trusted: true, tone: "learned" };
    case AGENDA_SOURCE.NONE:
    default:
      return { label: "sin agenda", trusted: false, tone: "none" };
  }
}
