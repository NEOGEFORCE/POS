// =============================================================================
// src/lib/bridge-connection.mjs
//
// Lógica pura y testeable para la nueva arquitectura "bridge local → relay
// por servidor" del scale-bridge e impresoras del POS.
//
// La UI hoy abre un WS directo al bridge local del PC de caja
// (ws://localhost:9876). Eso no funciona cuando el POS corre en un celular
// o en otro PC: el bridge no es alcanzable desde fuera de la LAN. La
// solución es:
//
//   1. El bridge local se conecta como AGENTE SALIENTE al backend Go
//      (`GET /api/bridge/agent`), autenticándose con un token por caja.
//   2. El servidor mantiene un pool por caja y hace de RELAY TRANSPARENTE
//      para los clientes del navegador.
//   3. El cliente navegador obtiene un ticket de un sólo uso
//      (`POST /api/bridge/ticket`) y abre un WS firmado por URL contra
//      `/api/bridge/relay?ticket=<...>`.
//
// Este módulo centraliza la lógica puramente deterministica — resolución
// de URLs, selección de caja, mapas de errores — para que:
//   - `src/lib/scaleBridge.ts` (socket de peso)
//   - `src/lib/pos-bridge-ws.ts` (socket de impresión / cajón)
// la compartan sin duplicarla. Los guardianes estáticos en
// `tests/bridge-connection-wiring.test.mjs` verifican que ambos la
// importen y no reimplementen el resolver por su cuenta.
//
// NO contiene efectos secundarios: no abre sockets, no consulta DOM, no
// toca `localStorage` por sí mismo (el storage se inyecta). Testeable
// bajo `node --test` sin mocks de WebSocket real.
// =============================================================================

/**
 * Clave canónica donde se persiste la preferencia de caja relay elegida
 * por el usuario (en `window.localStorage`). Centralizada aquí para que
 * el chip de UI y los clientes WS compartan la misma fuente.
 *
 * @type {"pos_bridge_caja_id"}
 */
export const POS_BRIDGE_CAJA_STORAGE_KEY = "pos_bridge_caja_id";

/**
 * Timeout corto para la sonda del bridge local. Si el WS no logra abrir
 * en este margen, caemos al relay. Se mantiene breve a propósito: el
 * usuario no debe esperar más que lo que tarda un apretón de manos TCP
 * en la misma LAN.
 */
export const LOCAL_BRIDGE_PROBE_TIMEOUT_MS = 1500;

/**
 * Códigos de error normalizados que el relay devuelve en el payload
 * `pos.response.error`. El consumidor de UI los mapea a toasts con texto
 * claro vía `describeRelayError`.
 */
export const RELAY_ERROR_CODES = Object.freeze({
    AGENT_OFFLINE: "RELAY_AGENT_OFFLINE",
    FORBIDDEN: "RELAY_FORBIDDEN",
    TIMEOUT: "RELAY_TIMEOUT",
});

// -----------------------------------------------------------------------------
// Resolución de URL local
// -----------------------------------------------------------------------------

/**
 * URL del bridge local a partir del entorno Next (public env vars) y del
 * `window.location`. Replica el comportamiento histórico: si el admin
 * configuró `NEXT_PUBLIC_POS_BRIDGE_WS_URL` o `NEXT_PUBLIC_SCALE_WS_URL`,
 * eso manda; si no, se arma `ws://<hostname>:9876` con el host del
 * documento (o `localhost` en SSR).
 *
 * No toca `process.env` global: el objeto `env` se pasa explícitamente
 * para que los tests puedan ejercitar variaciones sin ensuciar el
 * entorno Node.
 *
 * @param {{ env?: Record<string, string | undefined>, location?: { hostname?: string } }} [opts]
 * @returns {string}
 */
export function resolveLocalBridgeUrl(opts = {}) {
    const env = opts.env || {};
    const location = opts.location || null;
    const explicit = String(
        env.NEXT_PUBLIC_POS_BRIDGE_WS_URL
        || env.NEXT_PUBLIC_SCALE_WS_URL
        || "",
    ).trim();
    if (explicit) return explicit;
    const host = location && typeof location.hostname === "string" && location.hostname
        ? location.hostname
        : "localhost";
    return `ws://${host}:9876`;
}

// -----------------------------------------------------------------------------
// Resolución de URL del relay
// -----------------------------------------------------------------------------

/**
 * Normaliza una base HTTP (apiUrl o relativo `/api`) al equivalente WS. Si
 * `apiUrl` entra como ruta relativa, se usa `location` para resolver el
 * origen. Siempre devuelve una URL base SIN el sufijo `/bridge/relay`.
 *
 * Casos:
 *   - `http://host:3000/api`      → `ws://host:3000/api`
 *   - `https://pos.sf.co/api`     → `wss://pos.sf.co/api`
 *   - `/api` + location https/x.y → `wss://x.y/api`
 *   - `""`/undefined + location   → `ws(s)://host/api`
 *
 * @param {{ apiUrl?: string, location?: { protocol?: string, host?: string } }} [opts]
 * @returns {string}
 */
export function httpBaseToWsBase(opts = {}) {
    const apiUrl = typeof opts.apiUrl === "string" ? opts.apiUrl.trim() : "";
    const location = opts.location || null;
    const relativePrefix = (() => {
        if (apiUrl.startsWith("/")) return apiUrl.replace(/\/+$/, "") || "/api";
        return "/api";
    })();
    if (!apiUrl || apiUrl.startsWith("/")) {
        if (location && typeof location.protocol === "string" && location.host) {
            const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
            return `${wsProto}//${location.host}${relativePrefix}`;
        }
        return `ws://localhost${relativePrefix}`;
    }
    try {
        const url = new URL(apiUrl);
        const wsProto = url.protocol === "https:" ? "wss:" : "ws:";
        const path = url.pathname.replace(/\/+$/, "");
        return `${wsProto}//${url.host}${path || "/api"}`;
    } catch {
        // apiUrl era un string arbitrario que no parseó; mejor caer al
        // origen del documento que inventar un host.
        if (location && typeof location.protocol === "string" && location.host) {
            const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
            return `${wsProto}//${location.host}/api`;
        }
        return "ws://localhost/api";
    }
}

/**
 * URL del WS del relay para un ticket concreto. El ticket se codifica
 * siempre con `encodeURIComponent` por si el servidor cambia la familia
 * de caracteres del token.
 *
 * @param {{ apiUrl?: string, location?: { protocol?: string, host?: string }, ticket: string }} opts
 * @returns {string}
 */
export function buildRelayWsUrl(opts) {
    const base = httpBaseToWsBase({ apiUrl: opts && opts.apiUrl, location: opts && opts.location });
    const ticket = encodeURIComponent(String(opts && opts.ticket ? opts.ticket : ""));
    return `${base}/bridge/relay?ticket=${ticket}`;
}

/**
 * Endpoints REST del relay para apertura de ticket y listado de agentes.
 * Siguen la convención de `apiFetch`: la base viene de `NEXT_PUBLIC_API_URL`
 * (ya con `/api` incluido) o `/api` relativo como fallback para producción
 * detrás de nginx.
 *
 * @param {{ apiUrl?: string }} [opts]
 * @returns {{ agentsPath: string, ticketPath: string }}
 */
export function getRelayEndpoints(_opts = {}) {
    // apiFetch recibe el `path` relativo a la base API; de ahí que estos
    // valores sean rutas sin host — ellos los concatena con `API_URL`.
    return {
        agentsPath: "/bridge/agents",
        ticketPath: "/bridge/ticket",
    };
}

// -----------------------------------------------------------------------------
// Agentes y selección de caja
// -----------------------------------------------------------------------------

/**
 * Normaliza la respuesta de `GET /api/bridge/agents`. Es defensiva: tolera
 * agentes malformados y filtra entradas sin `cajaId`. Nunca lanza.
 *
 * @param {unknown} input
 * @returns {Array<{cajaId:string, connected:boolean, connectedAt:string|null, lastSeenAt:string|null}>}
 */
export function normalizeAgents(input) {
    if (!input || typeof input !== "object") return [];
    const list = Array.isArray(/** @type {{agents?:unknown}} */(input).agents)
        ? /** @type {{agents:unknown[]}} */(input).agents
        : [];
    const out = [];
    for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const agent = /** @type {Record<string, unknown>} */ (raw);
        const cajaId = typeof agent.cajaId === "string" ? agent.cajaId.trim() : "";
        if (!cajaId) continue;
        out.push({
            cajaId,
            connected: !!agent.connected,
            connectedAt: typeof agent.connectedAt === "string" ? agent.connectedAt : null,
            lastSeenAt: typeof agent.lastSeenAt === "string" ? agent.lastSeenAt : null,
        });
    }
    return out;
}

/**
 * Selecciona la caja a usar para abrir un ticket relay:
 *   1. Si el usuario tiene una preferencia guardada y esa caja está
 *      conectada, se usa.
 *   2. Si hay EXACTAMENTE una caja conectada, se usa esa (sin preguntar).
 *   3. Si hay varias y ninguna preferencia válida, se devuelve la primera
 *      por orden alfabético — determinista para no sorprender al usuario.
 *   4. Si ninguna está conectada, devuelve `null`.
 *
 * @param {{ agents: Array<{cajaId:string, connected:boolean}>, savedCajaId?: string | null }} opts
 * @returns {string | null}
 */
export function selectCajaId(opts) {
    const agents = Array.isArray(opts && opts.agents) ? opts.agents : [];
    const connected = agents.filter((a) => a && a.connected && typeof a.cajaId === "string" && a.cajaId);
    if (connected.length === 0) return null;
    const saved = typeof (opts && opts.savedCajaId) === "string" ? String(opts.savedCajaId).trim() : "";
    if (saved) {
        const match = connected.find((a) => a.cajaId === saved);
        if (match) return match.cajaId;
    }
    if (connected.length === 1) return connected[0].cajaId;
    const sorted = [...connected].sort((a, b) => a.cajaId.localeCompare(b.cajaId));
    return sorted[0].cajaId;
}

/**
 * Lee la preferencia persistida de caja en el storage inyectado. Nunca
 * lanza; devuelve `null` si el storage no está, no tiene la clave o la
 * clave está vacía.
 *
 * @param {{ getItem(k:string): string | null } | null | undefined} storage
 * @returns {string | null}
 */
export function readSavedCajaId(storage) {
    try {
        if (!storage || typeof storage.getItem !== "function") return null;
        const raw = storage.getItem(POS_BRIDGE_CAJA_STORAGE_KEY);
        if (typeof raw !== "string") return null;
        const trimmed = raw.trim();
        return trimmed || null;
    } catch {
        return null;
    }
}

/**
 * Persiste la preferencia de caja. Si `cajaId` es vacío/nulo se borra la
 * clave para no congelar una preferencia inválida.
 *
 * @param {{ setItem(k:string,v:string): void, removeItem(k:string): void } | null | undefined} storage
 * @param {string | null | undefined} cajaId
 */
export function writeSavedCajaId(storage, cajaId) {
    try {
        if (!storage || typeof storage.setItem !== "function") return;
        const trimmed = typeof cajaId === "string" ? cajaId.trim() : "";
        if (!trimmed) {
            if (typeof storage.removeItem === "function") {
                try { storage.removeItem(POS_BRIDGE_CAJA_STORAGE_KEY); } catch { /* storage lleno */ }
            }
            return;
        }
        storage.setItem(POS_BRIDGE_CAJA_STORAGE_KEY, trimmed);
    } catch {
        /* storage lleno o bloqueado — no es fatal */
    }
}

// -----------------------------------------------------------------------------
// Mapas de error legibles
// -----------------------------------------------------------------------------

/**
 * Texto humano para los códigos conocidos del relay. Se usa en toasts
 * y en el chip de UI cuando el relay reporta fallos. Códigos desconocidos
 * caen a un fallback genérico en español.
 *
 * @param {string | null | undefined} code
 * @returns {string}
 */
export function describeRelayError(code) {
    switch (code) {
        case RELAY_ERROR_CODES.AGENT_OFFLINE:
            return "La caja seleccionada está desconectada del servidor.";
        case RELAY_ERROR_CODES.FORBIDDEN:
            return "Tu rol no permite esta acción remota (ej. abrir cajón).";
        case RELAY_ERROR_CODES.TIMEOUT:
            return "La caja no respondió a tiempo (15 s).";
        default:
            return "No se pudo completar la operación remota.";
    }
}

/**
 * Extrae un código de error relay de un string de error del bridge. Si
 * el servidor envía `RELAY_FORBIDDEN: ...`, devolvemos el token inicial.
 *
 * @param {unknown} message
 * @returns {string | null}
 */
export function extractRelayErrorCode(message) {
    if (typeof message !== "string") return null;
    const m = message.match(/^(RELAY_[A-Z_]+)/);
    if (!m) return null;
    const code = m[1];
    const known = Object.values(RELAY_ERROR_CODES);
    return known.includes(code) ? code : null;
}

// -----------------------------------------------------------------------------
// Orquestador: local → relay
// -----------------------------------------------------------------------------

/**
 * @typedef {object} AgentsResponseLike
 * @property {Array<{cajaId?:string, connected?:boolean}>} [agents]
 */

/**
 * @typedef {object} NegotiateOptions
 * @property {Record<string, string | undefined>} [env]
 * @property {{ hostname?: string, protocol?: string, host?: string }} [location]
 * @property {{ getItem(k:string): string | null, setItem(k:string,v:string): void, removeItem(k:string): void } | null} [storage]
 * @property {string | null} [cajaIdOverride]
 * @property {number} [localProbeTimeoutMs]
 * @property {(url:string, timeoutMs:number) => Promise<unknown | null>} probeLocal
 * @property {() => Promise<AgentsResponseLike>} fetchAgents
 * @property {(cajaId:string) => Promise<{ ticket?:string, expiresInSeconds?: number }>} requestTicket
 */

/**
 * @typedef {object} NegotiateResult
 * @property {string} url
 * @property {"local"|"relay"} mode
 * @property {string | null} cajaId
 * @property {unknown | null} socket
 *   La sonda local puede devolver el WebSocket ya abierto para que el
 *   consumidor lo reutilice y no reabra una segunda conexión. En el camino
 *   relay siempre es `null` — el consumidor abre el WS a `url`.
 */

/**
 * Negocia la URL del bridge siguiendo la regla "primero local, si no,
 * relay". Todas las dependencias no-puras se inyectan: probe, fetch y
 * ticket. Un fallo en la sonda local NO interrumpe el flujo: siempre que
 * el relay esté disponible, se devuelve una URL válida.
 *
 * Si no hay cajas conectadas en el relay y la sonda local falló, se
 * lanza un error con `code = RELAY_AGENT_OFFLINE` para que el consumidor
 * pueda mostrar un toast informativo.
 *
 * @param {NegotiateOptions} opts
 * @returns {Promise<NegotiateResult>}
 */
export async function negotiateBridgeConnection(opts) {
    if (!opts || typeof opts !== "object") {
        throw new Error("negotiateBridgeConnection: faltan opciones");
    }
    if (typeof opts.probeLocal !== "function") {
        throw new Error("negotiateBridgeConnection: probeLocal es obligatorio");
    }
    if (typeof opts.fetchAgents !== "function") {
        throw new Error("negotiateBridgeConnection: fetchAgents es obligatorio");
    }
    if (typeof opts.requestTicket !== "function") {
        throw new Error("negotiateBridgeConnection: requestTicket es obligatorio");
    }

    const env = opts.env || {};
    const location = opts.location || null;
    const storage = opts.storage || null;
    const timeoutMs = typeof opts.localProbeTimeoutMs === "number" && opts.localProbeTimeoutMs > 0
        ? opts.localProbeTimeoutMs
        : LOCAL_BRIDGE_PROBE_TIMEOUT_MS;

    // 1. Sonda del bridge local. Puede devolver un socket vivo (que el
    //    consumidor reutiliza) o null (indica que caímos al relay).
    const localUrl = resolveLocalBridgeUrl({ env, location });
    let localSocket = null;
    try {
        localSocket = await opts.probeLocal(localUrl, timeoutMs);
    } catch {
        localSocket = null;
    }
    if (localSocket) {
        return { url: localUrl, mode: "local", cajaId: null, socket: localSocket };
    }

    // 2. Fallback al relay por servidor.
    let agentsResp;
    try {
        agentsResp = await opts.fetchAgents();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err || "");
        throw _bridgeError(
            `No se pudo consultar las cajas conectadas (${message || "fallo HTTP"}).`,
            RELAY_ERROR_CODES.AGENT_OFFLINE,
        );
    }
    const agents = normalizeAgents(agentsResp);
    const savedCajaId = typeof opts.cajaIdOverride === "string" && opts.cajaIdOverride.trim()
        ? opts.cajaIdOverride.trim()
        : readSavedCajaId(storage);
    const cajaId = selectCajaId({ agents, savedCajaId });
    if (!cajaId) {
        throw _bridgeError(
            "No hay cajas conectadas al servidor para operar en remoto.",
            RELAY_ERROR_CODES.AGENT_OFFLINE,
        );
    }

    let ticketResp;
    try {
        ticketResp = await opts.requestTicket(cajaId);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err || "");
        throw _bridgeError(
            `No se pudo abrir ticket relay para ${cajaId}: ${message || "fallo HTTP"}.`,
            null,
        );
    }
    const ticket = ticketResp && typeof ticketResp.ticket === "string" ? ticketResp.ticket.trim() : "";
    if (!ticket) {
        throw _bridgeError(
            `El servidor no devolvió un ticket relay válido para ${cajaId}.`,
            null,
        );
    }

    const url = buildRelayWsUrl({
        apiUrl: typeof env.NEXT_PUBLIC_API_URL === "string" ? env.NEXT_PUBLIC_API_URL : undefined,
        location,
        ticket,
    });
    return { url, mode: "relay", cajaId, socket: null };
}

/**
 * Error enriquecido con `code` para que el consumidor pueda clasificar sin
 * parsear strings. No uso Error.cause (compat con lint estricto antiguo).
 *
 * @param {string} message
 * @param {string | null} code
 */
function _bridgeError(message, code) {
    const err = new Error(message);
    if (code) /** @type {any} */(err).code = code;
    return err;
}
