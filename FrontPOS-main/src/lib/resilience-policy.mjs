export const FATAL_SYNC_STATUSES = Object.freeze([400, 409, 410, 422]);

export function isFatalSyncStatus(status) {
  return FATAL_SYNC_STATUSES.includes(Number(status));
}


export function classifySyncStatus(status) {
  const numericStatus = Number(status);
  if (numericStatus >= 200 && numericStatus < 300) return "success";
  if (numericStatus === 401) return "session-recovery";
  if (isFatalSyncStatus(numericStatus)) return "dead-letter";
  return "retry";
}

export function exponentialBackoff(attempt, options = {}) {
  const baseMs = Number.isFinite(options.baseMs) ? options.baseMs : 2000;
  const maxMs = Number.isFinite(options.maxMs) ? options.maxMs : 300000;
  const jitterMs = Number.isFinite(options.jitterMs) ? options.jitterMs : 1000;
  const random = typeof options.random === "function" ? options.random : Math.random;
  const safeAttempt = Math.max(0, Math.trunc(Number(attempt) || 0));
  const exponential = Math.min(maxMs, baseMs * (2 ** safeAttempt));
  return Math.min(maxMs, exponential + Math.floor(Math.max(0, random()) * jitterMs));
}

export function computeSyncRetryDelay(attempt, random = Math.random) {
  return exponentialBackoff(attempt, {
    baseMs: 2000,
    maxMs: 5 * 60 * 1000,
    jitterMs: 1000,
    random,
  });
}

export function computeSSERetryDelay(attempt, random = Math.random) {
  return exponentialBackoff(attempt, {
    baseMs: 1000,
    maxMs: 30000,
    jitterMs: 500,
    random,
  });
}

export function normalizeUserDni(userDni) {
  const normalized = String(userDni ?? "").trim();
  if (!normalized) throw new Error("Se requiere DNI para aislar los datos locales");
  return normalized;
}

export function cartRecordKey(userDni) {
  return `active::${encodeURIComponent(normalizeUserDni(userDni))}`;
}

export function cartStorageKey(baseKey, userDni) {
  return `${baseKey}::${encodeURIComponent(normalizeUserDni(userDni))}`;
}

export function parseSSEBlock(block) {
  const normalized = String(block ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized || normalized.startsWith(":")) return null;

  let event = "message";
  const data = [];
  for (const line of normalized.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    let value = separator >= 0 ? line.slice(separator + 1) : "";
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event" && value) event = value;
    if (field === "data") data.push(value);
  }

  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}
