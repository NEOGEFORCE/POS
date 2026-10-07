// ============================================================================
// COBERTURA DE REPOSICIÓN SEGÚN AGENDA DEL PROVEEDOR
// ============================================================================
//
// Espejo de `scheduling.ReplenishmentCoverageDays` del backend (vive en Go).
// Al pedir mercancía la pregunta no es "¿cada cuánto me pasa el proveedor?",
// sino "¿cuántos días de venta tengo que cubrir con este pedido?". La
// respuesta sale del CALENDARIO REAL del proveedor:
//
//   1. Si visita UNA sola vez por semana (p. ej. miércoles), hay que cubrir
//      hasta la próxima visita + el lead time hasta la entrega. Con lead=1
//      día ⇒ 7 + 1 = 8 días. Es el caso dominante en el POS.
//
//   2. Si visita DOS veces por semana (p. ej. martes y viernes), el peor
//      hueco entre visitas manda: el pedido debe cubrir el tramo largo
//      (martes→viernes es 3 días, viernes→martes es 4 días → se usa 4).
//      Más lead time hasta la entrega.
//
//   3. Si no hay agenda configurada ni aprendida, se cae a un fallback
//      conservador: 14 días como TOPE para no inflar el pedido con
//      números arbitrarios. Antes el legacy usaba 30 (demasiado) o
//      `avgDaily * 14` sin fundamento operativo.
//
// Este helper es PURO (sin red, sin React) para poder probarse con
// `node --test`. El consumidor principal es la sugerencia v2 que ya usa
// `coverageDays` que llega del backend; esta función también sirve como:
//
//   - Guardián de contrato en tests: documenta la fórmula esperada.
//   - Fallback defensivo si el back viejo no envía `coverageDays`.

// ---------------------------------------------------------------------------
// Constantes compartidas con el backend. Si cambian allá, hay que
// sincronizarlas aquí a mano. Los tests las fijan explícitamente.
// ---------------------------------------------------------------------------

/** Tope duro cuando no hay agenda. Antes el legacy usaba 30 o 14*avgDaily. */
export const FALLBACK_COVERAGE_DAYS = 14;

/** Lead time asumido entre visita y entrega cuando no viene explícito. */
export const DEFAULT_LEAD_DAYS = 1;

const CANONICAL_ORDER = Object.freeze([
  "lunes",
  "martes",
  "miercoles",
  "jueves",
  "viernes",
  "sabado",
  "domingo",
]);

const CANONICAL_INDEX = new Map(CANONICAL_ORDER.map((day, index) => [day, index]));

/** Normaliza a canónico sin acentos, minúsculas y sin espacios. */
function normalizeDay(raw) {
  if (typeof raw !== "string") return "";
  const clean = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  return CANONICAL_INDEX.has(clean) ? clean : "";
}

/** Reduce una lista a días únicos canónicos ordenados Lun→Dom. */
function sanitizeDays(days) {
  if (!Array.isArray(days)) return [];
  const seen = new Set();
  const collected = [];
  for (const raw of days) {
    const canonical = normalizeDay(raw);
    if (!canonical) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    collected.push(canonical);
  }
  return collected.sort((a, b) => CANONICAL_INDEX.get(a) - CANONICAL_INDEX.get(b));
}

/**
 * Peor gap entre visitas, en días. Devuelve 0 si hay menos de dos visitas.
 * Para una visita única el "gap" es 7 (ciclo semanal completo); eso NO lo
 * resuelve este helper interno sino replenishmentCoverageDays que distingue
 * los casos.
 */
function worstGap(days) {
  if (!Array.isArray(days) || days.length < 2) return 0;
  const indexes = days.map((d) => CANONICAL_INDEX.get(d));
  let max = 0;
  for (let i = 0; i < indexes.length; i++) {
    const current = indexes[i];
    const next = indexes[(i + 1) % indexes.length];
    const diff = (next - current + 7) % 7;
    // El "gap" relevante es (días hasta la próxima visita). Un gap de 0
    // (día duplicado) se ignora porque sanitizeDays ya quita duplicados.
    if (diff > max) max = diff;
  }
  return max;
}

/**
 * Calcula los días que debe cubrir un pedido según la agenda del proveedor.
 *
 * @param {object} schedule
 * @param {string[]} [schedule.visitDays] días del preventa
 * @param {string[]} [schedule.deliveryDays] días en los que llega la mercancía
 * @param {number} [schedule.leadDays] lead time explícito (sobreescribe cálculo)
 * @returns {{
 *   days: number,
 *   source: "configured" | "fallback",
 *   cycle: number,
 *   leadDays: number,
 *   visitDays: string[],
 *   deliveryDays: string[],
 * }}
 */
export function replenishmentCoverageDays(schedule = {}) {
  const safe = schedule && typeof schedule === "object" ? schedule : {};
  const visitDays = sanitizeDays(safe.visitDays);
  const deliveryDays = sanitizeDays(safe.deliveryDays);

  // Lead time efectivo. Si viene explícito se respeta (pero no se deja
  // bajar de 1: el modelo asume al menos un día entre visita y entrega para
  // no fingir cobertura total inmediata).
  const explicitLead = Number(safe.leadDays);
  const leadDays = Number.isFinite(explicitLead) && explicitLead > 0
    ? Math.ceil(explicitLead)
    : computeLeadFromDays(visitDays, deliveryDays);

  // Sin agenda: fallback acotado a 14 días.
  if (visitDays.length === 0 && deliveryDays.length === 0) {
    return {
      days: FALLBACK_COVERAGE_DAYS,
      source: "fallback",
      cycle: 0,
      leadDays: leadDays || DEFAULT_LEAD_DAYS,
      visitDays,
      deliveryDays,
    };
  }

  // Hay agenda: calculamos el ciclo máximo que debe cubrir el pedido.
  let cycle = 0;
  if (visitDays.length === 1) {
    // Visita única por semana ⇒ ciclo completo (7 días).
    cycle = 7;
  } else if (visitDays.length >= 2) {
    cycle = worstGap(visitDays);
  } else if (deliveryDays.length === 1) {
    // Sin visitas pero sí entregas únicas (p. ej. app con ruta fija): el
    // ciclo lo marca la entrega.
    cycle = 7;
  } else if (deliveryDays.length >= 2) {
    cycle = worstGap(deliveryDays);
  }

  // Cuando sanitizeDays devuelve un único día válido, worstGap retorna 0;
  // ya lo capturamos arriba con length===1. Esta rama defensiva se queda
  // por si el ciclo acaba siendo 0 con listas inconsistentes (p. ej. dos
  // elementos pero el mismo día duplicado antes del dedup).
  if (cycle === 0) cycle = 7;

  const total = cycle + leadDays;
  // Capamos al tope del fallback: pedir para 60 días con una visita rara
  // destruye capital inmovilizado. Si el proveedor realmente tiene un
  // ciclo de 30 días (p. ej. mayorista mensual), el back ya recibe un
  // leadDays explícito y gana.
  const capped = Math.min(total, Math.max(cycle + leadDays, FALLBACK_COVERAGE_DAYS));

  return {
    days: capped,
    source: "configured",
    cycle,
    leadDays,
    visitDays,
    deliveryDays,
  };
}

/** Deriva el lead time entre visita y entrega cuando no viene explícito. */
function computeLeadFromDays(visitDays, deliveryDays) {
  if (visitDays.length === 0 || deliveryDays.length === 0) {
    return DEFAULT_LEAD_DAYS;
  }
  const visit = visitDays[0];
  // Buscamos la primera entrega POSTERIOR a la visita (mod 7). Si no hay
  // entrega posterior, caemos a +7 (próxima semana).
  const visitIdx = CANONICAL_INDEX.get(visit);
  let best = Number.POSITIVE_INFINITY;
  for (const delivery of deliveryDays) {
    const deliveryIdx = CANONICAL_INDEX.get(delivery);
    const diff = (deliveryIdx - visitIdx + 7) % 7;
    const value = diff === 0 ? 7 : diff;
    if (value < best) best = value;
  }
  return Number.isFinite(best) && best > 0 ? best : DEFAULT_LEAD_DAYS;
}

/**
 * Mensaje de UI alineado con los datos reales. NO inventa fechas: si no hay
 * agenda devuelve texto genérico. Para pintar una fecha concreta usa el
 * helper `resolveExpectedDeliveryDate` que ya existe y respeta el contrato.
 */
export function describeCoverage(result) {
  if (!result || typeof result !== "object") return "";
  if (result.source === "fallback") {
    return `Sin agenda: cubrimos ${result.days} días como máximo (fallback).`;
  }
  if (result.cycle === 7 && (result.visitDays?.length ?? 0) === 1) {
    const day = result.visitDays[0];
    return `Visita semanal (${day}) + ${result.leadDays} día${result.leadDays === 1 ? "" : "s"} de entrega: cubrir ${result.days} días.`;
  }
  if ((result.visitDays?.length ?? 0) >= 2) {
    return `Dos visitas: el peor hueco es ${result.cycle} días + ${result.leadDays} día${result.leadDays === 1 ? "" : "s"} de entrega: cubrir ${result.days} días.`;
  }
  return `Cubrir ${result.days} días de venta.`;
}
