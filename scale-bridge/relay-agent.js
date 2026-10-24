// =============================================================================
// scale-bridge/relay-agent.js
//
// Modo AGENTE del scale-bridge.
//
// Problema: el PC de caja ya no es el servidor; el backend corre en Docker en
// otra máquina. El navegador no puede llegar directo al WS local del PC de
// caja desde el celular. Solución: el bridge inicia una conexión WebSocket
// *saliente* al backend, autenticada con `X-Bridge-Token`, y el backend hace
// de relay transparente entre navegadores autorizados y este agente.
//
// Protocolo de encapsulado (ver spec en el contrato del sprint):
//
//   servidor → agente:
//     { "relayId": "<id del cliente>", "payload": <mensaje del cliente> }
//
//   agente  → servidor:
//     respuesta dirigida: { "relayId": "<id>", "payload": <resp> }
//     broadcast:          { "payload": <msg> }   (sin relayId → server reparte)
//
//   `payload` es, literalmente, un mensaje del protocolo local del bridge
//   (`{type:'ping'}`, `{type:'command',value:'read'|'refresh'}`,
//   `{type:'printer.request',...}` y sus respuestas `{type:'pong'}`,
//   `{type:'weight',...}`, `{type:'status',...}`, `{type:'printer.response',
//   ok:false, errorCode:'...'}`). Esto es lo que hace el relay transparente:
//   el frontend reutiliza su cliente actual cambiándole sólo la URL.
//
// Políticas:
//   * Si falta cualquiera de POS_SERVER_URL / POS_AGENT_TOKEN / POS_CAJA_ID,
//     este módulo NO abre conexiones y el bridge se comporta exactamente
//     como antes (sin cambios). `readConfigFromEnv()` devuelve `null` y el
//     caller omite la creación del agente.
//   * Reconexión exponencial 1s → 30s con jitter aleatorio (0..1s), para
//     que N bridges detrás de la misma caída no se re-conecten en falange.
//   * Ping nativo WS periódico (`ws.ping()`) como keepalive. El ping del
//     protocolo del bridge (`{type:'ping'}` → `{type:'pong'}`) va envuelto
//     en `{relayId, payload}` como cualquier otro mensaje: no se trata aparte.
//   * El token NUNCA se loguea. Los logs sólo incluyen `caja_id` y host.
// =============================================================================

"use strict";

const WebSocket = require("ws");

const DEFAULT_PING_INTERVAL_MS = 25_000;
const DEFAULT_MIN_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_JITTER_MAX_MS = 1_000;

/**
 * Convierte `http(s)://host[:puerto]` en la URL de WebSocket del endpoint
 * del agente (`ws(s)://host[:puerto]/api/bridge/agent?caja_id=<CAJA>`).
 * Mantiene puerto no estándar si venía en la URL original.
 *
 * @param {string} serverUrl
 * @param {string} cajaId
 * @returns {string}
 */
function toWsAgentUrl(serverUrl, cajaId) {
    const u = new URL(serverUrl);
    const proto = u.protocol === "https:" ? "wss:" : "ws:";
    // `u.host` incluye puerto si el input lo traía (p.ej. "pos.local:8080").
    return `${proto}//${u.host}/api/bridge/agent?caja_id=${encodeURIComponent(cajaId)}`;
}

/**
 * Lee la configuración de modo agente desde variables de entorno.
 * Devuelve `null` cuando falta cualquiera de las tres variables requeridas
 * (comportamiento previo: el bridge no abre conexión saliente).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{serverUrl:string, token:string, cajaId:string} | null}
 */
function readConfigFromEnv(env) {
    const e = env || process.env;
    const serverUrl = e.POS_SERVER_URL;
    const token = e.POS_AGENT_TOKEN;
    const cajaId = e.POS_CAJA_ID;
    if (!serverUrl || !token || !cajaId) return null;
    return {
        serverUrl: String(serverUrl),
        token: String(token),
        cajaId: String(cajaId),
    };
}

/**
 * Construye un agente de relay. No se conecta solo: llama `start()`.
 *
 * @param {object} opts
 * @param {string} opts.serverUrl        http(s)://host[:puerto] del servidor POS.
 * @param {string} opts.token            Valor para el header `X-Bridge-Token`.
 * @param {string} opts.cajaId           Identificador de caja (`CAJA-01`, ...).
 * @param {(data:object, responder:{send:(obj:object)=>void})=>void} opts.handleMessage
 *      Handler que procesa UN mensaje del protocolo local del bridge. Es el
 *      mismo que usa el WS local; el `responder` que entregamos aquí envuelve
 *      la respuesta con `{relayId, payload}` para que el server pueda
 *      enrutarla al cliente correcto.
 * @param {()=>object[]} [opts.snapshot]
 *      Devuelve mensajes a emitir como broadcasts al (re)conectar. Pensado
 *      para empujar el `status` actual y el último `weight` al servidor,
 *      para que los clientes relay reciban estado inmediato.
 * @param {object}  [opts.logger]            console-like (log/warn/error).
 * @param {typeof WebSocket} [opts.WebSocketImpl]  Inyectable para tests.
 * @param {number}  [opts.minBackoffMs]
 * @param {number}  [opts.maxBackoffMs]
 * @param {number}  [opts.pingIntervalMs]
 * @param {number}  [opts.handshakeTimeoutMs]
 * @param {number}  [opts.jitterMaxMs]
 * @param {()=>number} [opts.random]        Inyectable para tests (0..1).
 */
function createRelayAgent(opts) {
    const {
        serverUrl,
        token,
        cajaId,
        handleMessage,
        snapshot,
        logger,
        WebSocketImpl,
        minBackoffMs,
        maxBackoffMs,
        pingIntervalMs,
        handshakeTimeoutMs,
        jitterMaxMs,
        random,
    } = opts || {};

    if (!serverUrl || typeof serverUrl !== "string") {
        throw new Error("relay-agent: serverUrl requerido");
    }
    if (!token || typeof token !== "string") {
        throw new Error("relay-agent: token requerido");
    }
    if (!cajaId || typeof cajaId !== "string") {
        throw new Error("relay-agent: cajaId requerido");
    }
    if (typeof handleMessage !== "function") {
        throw new Error("relay-agent: handleMessage requerido");
    }

    const log = logger || console;
    const WsImpl = WebSocketImpl || WebSocket;
    const minBo = Number.isFinite(minBackoffMs) ? minBackoffMs : DEFAULT_MIN_BACKOFF_MS;
    const maxBo = Number.isFinite(maxBackoffMs) ? maxBackoffMs : DEFAULT_MAX_BACKOFF_MS;
    const pingMs = Number.isFinite(pingIntervalMs) ? pingIntervalMs : DEFAULT_PING_INTERVAL_MS;
    const hsMs = Number.isFinite(handshakeTimeoutMs) ? handshakeTimeoutMs : DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const jMax = Number.isFinite(jitterMaxMs) ? jitterMaxMs : DEFAULT_JITTER_MAX_MS;
    const rand = typeof random === "function" ? random : Math.random;

    const wsUrl = toWsAgentUrl(serverUrl, cajaId);
    // Enmascaramiento: nunca logueamos el token.
    const hostLabel = new URL(serverUrl).host;

    let ws = null;
    let currentBackoff = minBo;
    let reconnectTimer = null;
    let pingTimer = null;
    let stopped = false;

    function logLine(level, msg) {
        const fn = log && typeof log[level] === "function" ? log[level] : console.log;
        try {
            fn.call(log, `[relay-agent caja=${cajaId} host=${hostLabel}] ${msg}`);
        } catch (_) {
            // Logger roto: no es razón para tirar el agente.
        }
    }

    function clearReconnectTimer() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
    }
    function clearPingTimer() {
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
    }

    function scheduleReconnect() {
        if (stopped) return;
        clearReconnectTimer();
        const jitter = Math.floor(rand() * jMax);
        const delay = currentBackoff + jitter;
        logLine("log", `reintentando en ${delay}ms`);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
        // Backoff multiplicativo con tope. Se resetea en `open`.
        currentBackoff = Math.min(currentBackoff * 2, maxBo);
    }

    function sendRaw(obj) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        try {
            ws.send(JSON.stringify(obj));
            return true;
        } catch (err) {
            logLine("warn", `send falló: ${err && err.message ? err.message : String(err)}`);
            return false;
        }
    }

    /** Envía un mensaje como broadcast (sin relayId). El server lo reparte. */
    function broadcast(payload) {
        if (payload == null) return false;
        return sendRaw({ payload });
    }

    function emitSnapshot() {
        if (typeof snapshot !== "function") return;
        let msgs;
        try {
            msgs = snapshot();
        } catch (err) {
            logLine("warn", `snapshot error: ${err && err.message ? err.message : String(err)}`);
            return;
        }
        if (!Array.isArray(msgs)) return;
        for (const m of msgs) {
            if (m) broadcast(m);
        }
    }

    function handleFrame(buf) {
        let text;
        try {
            text = typeof buf === "string" ? buf : Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
        } catch (_) {
            return;
        }
        let frame;
        try {
            frame = JSON.parse(text);
        } catch (_) {
            logLine("warn", "mensaje inválido del servidor (JSON parse)");
            return;
        }
        if (!frame || typeof frame !== "object") return;
        const relayId =
            typeof frame.relayId === "string" || typeof frame.relayId === "number"
                ? String(frame.relayId).slice(0, 128)
                : "";
        const payload = frame.payload;
        if (!relayId) {
            // Mensajes sin relayId podrían ser notificaciones del server
            // (reserve futuro). No los procesamos como requests.
            return;
        }
        if (!payload || typeof payload !== "object") {
            // Request mal formado: no podemos responder sin un payload
            // interpretable. Devolvemos un error accionable al cliente
            // reusando el shape de printer.response para que el frontend
            // pueda procesarlo con su manejador existente.
            sendRaw({
                relayId,
                payload: {
                    type: "printer.response",
                    requestId: "",
                    ok: false,
                    error: "payload ausente o inválido",
                    errorCode: "INVALID_REQUEST",
                },
            });
            return;
        }
        const responder = {
            send: (obj) => sendRaw({ relayId, payload: obj }),
        };
        try {
            handleMessage(payload, responder);
        } catch (err) {
            logLine("error", `handleMessage error: ${err && err.message ? err.message : String(err)}`);
        }
    }

    function connect() {
        if (stopped) return;
        clearReconnectTimer();
        logLine("log", "conectando (modo agente)");
        try {
            ws = new WsImpl(wsUrl, {
                headers: { "X-Bridge-Token": token },
                handshakeTimeout: hsMs,
            });
        } catch (err) {
            logLine("error", `error creando WS: ${err && err.message ? err.message : String(err)}`);
            ws = null;
            scheduleReconnect();
            return;
        }

        ws.on("open", () => {
            logLine("log", "conectado");
            currentBackoff = minBo;
            clearPingTimer();
            pingTimer = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    try { ws.ping(); } catch (_) { /* ignore */ }
                }
            }, pingMs);
            emitSnapshot();
        });

        ws.on("message", (data) => {
            handleFrame(data);
        });

        ws.on("unexpected-response", (_req, res) => {
            const status = res && res.statusCode;
            logLine("warn", `handshake rechazado (status=${status})`);
            try { ws && ws.terminate && ws.terminate(); } catch (_) {}
            ws = null;
            // No reagendamos aquí: `close` siempre llega y agenda. Si por
            // alguna razón `close` no viene (handshake abortado antes de
            // crear el socket subyacente), el programa queda inerte hasta
            // el próximo `start()` — comportamiento preferible a reconectar
            // en bucle apretado contra un servidor que nos rechaza.
        });

        ws.on("error", (err) => {
            logLine("warn", `ws error: ${err && err.message ? err.message : String(err)}`);
        });

        ws.on("close", (code) => {
            clearPingTimer();
            logLine("log", `desconectado (code=${code})`);
            ws = null;
            scheduleReconnect();
        });
    }

    function start() {
        stopped = false;
        currentBackoff = minBo;
        connect();
    }

    function stop() {
        stopped = true;
        clearReconnectTimer();
        clearPingTimer();
        if (ws) {
            try { ws.close(); } catch (_) {}
            try { ws.terminate && ws.terminate(); } catch (_) {}
            ws = null;
        }
    }

    function isConnected() {
        return !!(ws && ws.readyState === WebSocket.OPEN);
    }

    return {
        start,
        stop,
        broadcast,
        isConnected,
        // Sólo para tests / introspección: NO usar fuera de este archivo.
        _internals: {
            getWs: () => ws,
            getBackoffMs: () => currentBackoff,
            getUrl: () => wsUrl,
        },
    };
}

module.exports = {
    createRelayAgent,
    readConfigFromEnv,
    toWsAgentUrl,
    DEFAULTS: Object.freeze({
        pingIntervalMs: DEFAULT_PING_INTERVAL_MS,
        minBackoffMs: DEFAULT_MIN_BACKOFF_MS,
        maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
        handshakeTimeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS,
        jitterMaxMs: DEFAULT_JITTER_MAX_MS,
    }),
};
