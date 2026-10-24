// =============================================================================
// src/lib/pos-bridge-printers.mjs
//
// Logica pura de parseo para la accion `listPrinters` del bridge local. Vive
// como .mjs para que se pueda importar tanto desde pos-bridge.ts (frontend)
// como desde tests `node --test` sin pasar por tsc.
//
// El bridge responde con uno de dos shapes:
//
//   A. shape raiz:  { kind, platform, defaultName, printers:[...] }
//   B. shape anidado: { result: { kind, platform, defaultName, printers:[...] } }
//
// Este helper normaliza ambos a `{kind:"printer-list", platform, defaultName,
// printers:[DetectedPrinter]}` y descarta entradas sin nombre. Nunca lanza:
// devuelve `null` cuando el payload no es interpretable para que el consumidor
// decida mostrar un error accionable al admin.
// =============================================================================

/**
 * Enum normalizado para el campo `status` por cola de impresion. Un valor
 * desconocido debe caer a "unknown"; nunca propagamos basura al render.
 *
 * @type {ReadonlyArray<string>}
 */
export const DETECTED_PRINTER_STATUSES = Object.freeze([
  "online",
  "offline",
  "paper-out",
  "error",
  "paused",
  "unknown",
]);

/**
 * @typedef {object} DetectedPrinter
 * @property {string} name
 * @property {string} [driver]
 * @property {string} [port]
 * @property {string} [status]
 * @property {boolean} [online]
 * @property {boolean} [isDefault]
 * @property {boolean} [shared]
 * @property {number} [jobs]
 * @property {ReadonlyArray<string>} [attributes]
 */

/**
 * @typedef {object} DetectedPrintersResult
 * @property {"printer-list"} kind
 * @property {"win32"|"posix"} [platform]
 * @property {string} [defaultName]
 * @property {ReadonlyArray<DetectedPrinter>} printers
 */

/**
 * Normaliza un payload crudo del bridge a un `DetectedPrintersResult`
 * tipado. Es defensivo: devuelve `null` cuando el payload no es
 * interpretable (incluye el caso del bridge nativo que responde con un
 * shape distinto). Nunca lanza; el consumidor decide si mostrar un error.
 *
 * @param {unknown} input
 * @returns {DetectedPrintersResult|null}
 */
export function parseDetectedPrintersResult(input) {
  if (!input || typeof input !== "object") return null;
  const obj = input;
  // Shape anidado: `{ result: {...} }`.
  const nested = obj && typeof obj.result === "object" && obj.result ? obj.result : null;
  const rawList = Array.isArray(obj.printers)
    ? obj.printers
    : (nested && Array.isArray(nested.printers) ? nested.printers : null);
  if (!rawList) return null;

  const platformRaw = typeof obj.platform === "string"
    ? obj.platform
    : (nested && typeof nested.platform === "string" ? nested.platform : "");
  const platform = platformRaw === "win32" || platformRaw === "posix" ? platformRaw : undefined;

  const defaultNameRaw = typeof obj.defaultName === "string"
    ? obj.defaultName
    : (nested && typeof nested.defaultName === "string" ? nested.defaultName : "");
  const defaultName = defaultNameRaw.trim() || undefined;

  const printers = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    const statusRaw = typeof entry.status === "string" ? entry.status.trim().toLowerCase() : "";
    const status = DETECTED_PRINTER_STATUSES.includes(statusRaw) ? statusRaw : "unknown";
    const attributes = Array.isArray(entry.attributes)
      ? entry.attributes
          .filter((a) => typeof a === "string")
          .map((a) => a.trim())
          .filter(Boolean)
      : undefined;
    printers.push({
      name,
      driver: typeof entry.driver === "string" ? entry.driver.trim() : undefined,
      port: typeof entry.port === "string" ? entry.port.trim() : undefined,
      status,
      online: typeof entry.online === "boolean"
        ? entry.online
        : status === "online",
      isDefault: typeof entry.isDefault === "boolean"
        ? entry.isDefault
        : (defaultName ? name === defaultName : false),
      shared: typeof entry.shared === "boolean" ? entry.shared : undefined,
      jobs: typeof entry.jobs === "number" && Number.isFinite(entry.jobs)
        ? Math.max(0, Math.round(entry.jobs))
        : undefined,
      attributes,
    });
  }

  return {
    kind: "printer-list",
    platform,
    defaultName,
    printers,
  };
}
