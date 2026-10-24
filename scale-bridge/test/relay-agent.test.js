// =============================================================================
// test/relay-agent.test.js
//
// Suite `node --test` para el modo AGENTE (relay-agent.js). Levantamos un
// servidor WS fake en localhost con puerto efímero y verificamos el contrato:
//
//   1. Handshake: URL `/api/bridge/agent?caja_id=<CAJA>` y header
//      `X-Bridge-Token: <token>`.
//   2. Broadcast local → `{"payload": ...}` sin relayId al servidor.
//   3. Request del servidor `{relayId, payload}` → el agente responde con
//      `{relayId, payload: <resp>}` conservando el mismo relayId.
//   4. Ping del protocolo (`{type:'ping'}` envuelto en relayId) → pong
//      dirigido con el mismo relayId.
//   5. Reconexión tras cierre del server.
//   6. Sin variables de entorno `readConfigFromEnv()` devuelve `null`
//      (y el bridge no inicia el agente).
//
// No tocamos red externa, no abrimos puertos COM, no spawneamos nada. Todo
// contra `WebSocket.Server({port: 0})`.
// =============================================================================

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const WebSocket = require("ws");

const {
    createRelayAgent,
    readConfigFromEnv,
    toWsAgentUrl,
} = require("../relay-agent");

// -----------------------------------------------------------------------------
// Helpers de test
// -----------------------------------------------------------------------------

/**
 * Levanta un servidor WS que:
 *   - captura el req.url y los headers del handshake
 *   - acepta/rechaza según `expectedToken`
 *   - acumula los mensajes recibidos en `buffer` y expone
 *     `nextFrame()`/`waitForFrames(n)` para consumirlos sin perderlos.
 *
 * Diseño clave: los frames NO se consumen desde un EventEmitter one-shot
 * porque múltiples broadcasts del cliente pueden emitirse en el mismo tick
 * y un listener que se auto-desregistra tras el primero perdería el resto.
 * Por eso el buffer: un listener persistente acumula, y los helpers del test
 * consumen del buffer en orden.
 */
async function startFakeServer(expectedToken) {
    const handshakes = [];
    const sockets = new Set();
    const events = new (require("node:events").EventEmitter)();
    const frameBuffer = [];
    const connectBuffer = [];
    const pendingFrameWaiters = []; // {resolve, needed}
    const pendingConnectWaiters = []; // {resolve}

    function pumpFrameWaiters() {
        for (let i = pendingFrameWaiters.length - 1; i >= 0; i--) {
            const w = pendingFrameWaiters[i];
            if (frameBuffer.length >= w.needed) {
                pendingFrameWaiters.splice(i, 1);
                w.resolve(frameBuffer.slice(0, w.needed));
            }
        }
    }
    function pumpConnectWaiters() {
        while (pendingConnectWaiters.length > 0 && connectBuffer.length > 0) {
            const w = pendingConnectWaiters.shift();
            w.resolve(connectBuffer.shift());
        }
    }

    const wss = new WebSocket.Server({
        host: "127.0.0.1",
        port: 0,
        verifyClient(info, cb) {
            const token = info.req.headers["x-bridge-token"];
            handshakes.push({
                url: info.req.url,
                token,
                headers: info.req.headers,
            });
            if (expectedToken && token !== expectedToken) {
                cb(false, 401, "Unauthorized");
                return;
            }
            cb(true);
        },
    });

    wss.on("connection", (ws, req) => {
        sockets.add(ws);
        const connEvent = { ws, url: req.url };
        connectBuffer.push(connEvent);
        events.emit("connect", connEvent);
        pumpConnectWaiters();
        ws.on("message", (buf) => {
            let frame;
            try { frame = JSON.parse(buf.toString("utf8")); } catch { frame = null; }
            frameBuffer.push(frame);
            events.emit("frame", frame, ws);
            pumpFrameWaiters();
        });
        ws.on("close", () => { sockets.delete(ws); });
    });

    await once(wss, "listening");
    const port = wss.address().port;

    /** Espera a que haya al menos `n` frames en total; devuelve los primeros `n`. */
    function waitForFrames(n = 1, { timeoutMs = 2000 } = {}) {
        return new Promise((resolve, reject) => {
            if (frameBuffer.length >= n) {
                resolve(frameBuffer.slice(0, n));
                return;
            }
            const w = { needed: n };
            const timer = setTimeout(() => {
                const idx = pendingFrameWaiters.indexOf(w);
                if (idx >= 0) pendingFrameWaiters.splice(idx, 1);
                reject(new Error(
                    `timeout esperando ${n} frames (recibidos ${frameBuffer.length})`,
                ));
            }, timeoutMs);
            w.resolve = (val) => { clearTimeout(timer); resolve(val); };
            pendingFrameWaiters.push(w);
        });
    }

    /** Consume y devuelve el próximo frame nuevo (o espera que llegue). */
    async function nextFrame({ timeoutMs = 2000 } = {}) {
        const [frame] = await waitForFrames(frameBuffer.length + 1, { timeoutMs });
        // El buffer no se "consume", devolvemos siempre por índice secuencial.
        return frame;
    }

    /** Espera a la próxima conexión (nunca pierde las que ya ocurrieron). */
    function waitForConnection({ timeoutMs = 2000 } = {}) {
        return new Promise((resolve, reject) => {
            if (connectBuffer.length > 0) {
                resolve(connectBuffer.shift());
                return;
            }
            const w = {};
            const timer = setTimeout(() => {
                const idx = pendingConnectWaiters.indexOf(w);
                if (idx >= 0) pendingConnectWaiters.splice(idx, 1);
                reject(new Error("timeout esperando conexión"));
            }, timeoutMs);
            w.resolve = (val) => { clearTimeout(timer); resolve(val); };
            pendingConnectWaiters.push(w);
        });
    }

    return {
        wss,
        port,
        url: `http://127.0.0.1:${port}`,
        handshakes,
        events,
        sockets,
        get frames() { return frameBuffer; },
        waitForFrames,
        nextFrame,
        waitForConnection,
        async close() {
            for (const s of sockets) { try { s.terminate(); } catch (_) {} }
            await new Promise((res) => wss.close(() => res()));
        },
    };
}

/** Mantiene compat: espera UNA ocurrencia de un evento genérico (no "frame"). */
async function waitFor(emitter, event, { timeoutMs = 2000, filter } = {}) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            emitter.off(event, onEvent);
            reject(new Error(`timeout esperando "${event}" en ${timeoutMs}ms`));
        }, timeoutMs);
        const onEvent = (...args) => {
            if (filter && !filter(...args)) return;
            clearTimeout(timer);
            emitter.off(event, onEvent);
            resolve(args);
        };
        emitter.on(event, onEvent);
    });
}

/** Mini-logger silencioso para que los tests no spameen stdout. */
function silentLogger() {
    const noop = () => {};
    return { log: noop, warn: noop, error: noop };
}

/**
 * Espera activamente a que `agent.isConnected()` sea true. Evita la race
 * entre que el server emite `connection` y que el cliente dispara `open`:
 * sin esto, `broadcast()` podría intentarse mientras `readyState` todavía
 * es CONNECTING y se perdería (sendRaw devuelve false silencioso).
 */
async function waitUntilConnected(agent, { timeoutMs = 2000, stepMs = 10 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (agent.isConnected()) return;
        await new Promise((r) => setTimeout(r, stepMs));
    }
    throw new Error("timeout esperando agent.isConnected()");
}

// -----------------------------------------------------------------------------
// 0. Helpers puros
// -----------------------------------------------------------------------------

test("toWsAgentUrl: http → ws y preserva puerto no estándar", () => {
    assert.equal(
        toWsAgentUrl("http://pos.local:8080", "CAJA-01"),
        "ws://pos.local:8080/api/bridge/agent?caja_id=CAJA-01",
    );
    assert.equal(
        toWsAgentUrl("https://api.pos.local", "CAJA-02"),
        "wss://api.pos.local/api/bridge/agent?caja_id=CAJA-02",
    );
    // caja_id con caracteres especiales se URL-encodea
    assert.equal(
        toWsAgentUrl("http://x:9000", "CAJA 1/2"),
        "ws://x:9000/api/bridge/agent?caja_id=CAJA%201%2F2",
    );
});

test("readConfigFromEnv: devuelve null si falta cualquiera de las tres variables", () => {
    assert.equal(readConfigFromEnv({}), null);
    assert.equal(readConfigFromEnv({ POS_SERVER_URL: "http://x" }), null);
    assert.equal(readConfigFromEnv({ POS_SERVER_URL: "http://x", POS_AGENT_TOKEN: "t" }), null);
    assert.equal(readConfigFromEnv({ POS_AGENT_TOKEN: "t", POS_CAJA_ID: "CAJA-01" }), null);
    assert.equal(readConfigFromEnv({ POS_SERVER_URL: "http://x", POS_CAJA_ID: "CAJA-01" }), null);
    // Con las tres presentes, devuelve el objeto normalizado.
    assert.deepEqual(
        readConfigFromEnv({
            POS_SERVER_URL: "http://pos.local:8080",
            POS_AGENT_TOKEN: "secreto",
            POS_CAJA_ID: "CAJA-01",
        }),
        { serverUrl: "http://pos.local:8080", token: "secreto", cajaId: "CAJA-01" },
    );
});

// -----------------------------------------------------------------------------
// 1. Handshake: header + caja_id
// -----------------------------------------------------------------------------

test("handshake: envía X-Bridge-Token y caja_id en query", async () => {
    const server = await startFakeServer("tok-123");
    const agent = createRelayAgent({
        serverUrl: server.url,
        token: "tok-123",
        cajaId: "CAJA-07",
        handleMessage: () => {},
        snapshot: () => [],
        logger: silentLogger(),
        pingIntervalMs: 60_000,
        handshakeTimeoutMs: 1500,
    });
    try {
        agent.start();
        await server.waitForConnection();
        assert.equal(server.handshakes.length, 1);
        const hs = server.handshakes[0];
        assert.ok(hs.url.startsWith("/api/bridge/agent"), `url inesperada: ${hs.url}`);
        assert.match(hs.url, /caja_id=CAJA-07/);
        assert.equal(hs.token, "tok-123");
    } finally {
        agent.stop();
        await server.close();
    }
});

test("handshake: token inválido → close/retry, el agente no queda OPEN", async () => {
    const server = await startFakeServer("correcto");
    const agent = createRelayAgent({
        serverUrl: server.url,
        token: "equivocado",
        cajaId: "CAJA-01",
        handleMessage: () => {},
        logger: silentLogger(),
        pingIntervalMs: 60_000,
        minBackoffMs: 50,
        maxBackoffMs: 100,
        jitterMaxMs: 1,
        handshakeTimeoutMs: 1500,
    });
    try {
        agent.start();
        // El server registra el intento de handshake aunque haya rechazado.
        await new Promise((r) => setTimeout(r, 300));
        assert.ok(server.handshakes.length >= 1);
        assert.equal(server.handshakes[0].token, "equivocado");
        assert.equal(agent.isConnected(), false);
    } finally {
        agent.stop();
        await server.close();
    }
});

// -----------------------------------------------------------------------------
// 2. Broadcast local → payload sin relayId
// -----------------------------------------------------------------------------

test("broadcast: envía {payload} sin relayId al servidor", async () => {
    const server = await startFakeServer("t");
    const agent = createRelayAgent({
        serverUrl: server.url,
        token: "t",
        cajaId: "CAJA-01",
        handleMessage: () => {},
        snapshot: () => [],
        logger: silentLogger(),
        pingIntervalMs: 60_000,
    });
    try {
        agent.start();
        await server.waitForConnection();
        await waitUntilConnected(agent);
        agent.broadcast({ type: "status", connected: true, port: "COM1" });
        agent.broadcast({ type: "weight", value: 1.234, display: "1.234" });
        const [frame1, frame2] = await server.waitForFrames(2);
        assert.equal(frame1.relayId, undefined, "broadcast no debe llevar relayId");
        assert.deepEqual(frame1.payload, { type: "status", connected: true, port: "COM1" });
        assert.equal(frame2.relayId, undefined);
        assert.deepEqual(frame2.payload, { type: "weight", value: 1.234, display: "1.234" });
    } finally {
        agent.stop();
        await server.close();
    }
});

// -----------------------------------------------------------------------------
// 3. Snapshot al conectar
// -----------------------------------------------------------------------------

test("snapshot: emite mensajes como broadcasts al conectar", async () => {
    const server = await startFakeServer("t");
    const snap = [
        { type: "status", connected: false, port: "" },
        { type: "weight", value: 0, display: "0.000" },
    ];
    const agent = createRelayAgent({
        serverUrl: server.url,
        token: "t",
        cajaId: "CAJA-01",
        handleMessage: () => {},
        snapshot: () => snap,
        logger: silentLogger(),
        pingIntervalMs: 60_000,
    });
    try {
        agent.start();
        const [status, weight] = await server.waitForFrames(2);
        assert.deepEqual(status, { payload: snap[0] });
        assert.deepEqual(weight, { payload: snap[1] });
    } finally {
        agent.stop();
        await server.close();
    }
});

// -----------------------------------------------------------------------------
// 4. Request relayed → respuesta dirigida con el mismo relayId
// -----------------------------------------------------------------------------

test("request: {relayId, payload} → responder.send() devuelve {relayId, payload: resp}", async () => {
    const server = await startFakeServer("t");

    // handleMessage simula el bridge: ante printer.request responde ok.
    const handleMessage = (payload, responder) => {
        if (payload && payload.type === "printer.request") {
            responder.send({
                type: "printer.response",
                requestId: payload.requestId,
                ok: true,
                result: { echoed: payload.action },
            });
        }
    };

    const agent = createRelayAgent({
        serverUrl: server.url,
        token: "t",
        cajaId: "CAJA-01",
        handleMessage,
        snapshot: () => [],
        logger: silentLogger(),
        pingIntervalMs: 60_000,
    });
    try {
        agent.start();
        const { ws: srvWs } = await server.waitForConnection();
        await waitUntilConnected(agent);
        // El server simula enrutar un request de un cliente navegador.
        srvWs.send(JSON.stringify({
            relayId: "r-42",
            payload: {
                type: "printer.request",
                requestId: "req-1",
                action: "listPrinters",
                payload: {},
            },
        }));
        const [resp] = await server.waitForFrames(1);
        assert.equal(resp.relayId, "r-42", "relayId del request debe preservarse");
        assert.equal(resp.payload.type, "printer.response");
        assert.equal(resp.payload.requestId, "req-1");
        assert.equal(resp.payload.ok, true);
        assert.deepEqual(resp.payload.result, { echoed: "listPrinters" });
    } finally {
        agent.stop();
        await server.close();
    }
});

// -----------------------------------------------------------------------------
// 5. Ping del protocolo → pong dirigido
// -----------------------------------------------------------------------------

test("ping relayed: {relayId, payload:{type:'ping'}} → pong dirigido", async () => {
    const server = await startFakeServer("t");

    // Reutilizamos el mismo handler que usa el index.js (ping→pong).
    const handleMessage = (payload, responder) => {
        if (payload && payload.type === "ping") {
            responder.send({ type: "pong" });
        }
    };

    const agent = createRelayAgent({
        serverUrl: server.url,
        token: "t",
        cajaId: "CAJA-01",
        handleMessage,
        snapshot: () => [],
        logger: silentLogger(),
        pingIntervalMs: 60_000,
    });
    try {
        agent.start();
        const { ws: srvWs } = await server.waitForConnection();
        await waitUntilConnected(agent);
        srvWs.send(JSON.stringify({ relayId: "p-1", payload: { type: "ping" } }));
        const [resp] = await server.waitForFrames(1);
        assert.equal(resp.relayId, "p-1");
        assert.deepEqual(resp.payload, { type: "pong" });
    } finally {
        agent.stop();
        await server.close();
    }
});

// -----------------------------------------------------------------------------
// 6. Reconexión tras cierre del server
// -----------------------------------------------------------------------------

test("reconexión: tras cierre del lado del server, el agente se reconecta", async () => {
    const server = await startFakeServer("t");
    const agent = createRelayAgent({
        serverUrl: server.url,
        token: "t",
        cajaId: "CAJA-01",
        handleMessage: () => {},
        snapshot: () => [],
        logger: silentLogger(),
        pingIntervalMs: 60_000,
        minBackoffMs: 20,
        maxBackoffMs: 50,
        jitterMaxMs: 1,
        handshakeTimeoutMs: 1500,
    });
    try {
        agent.start();
        const { ws: first } = await server.waitForConnection();
        // Forzamos el cierre del lado del server. El agente debe reagendar
        // una reconexión y abrir una nueva conexión en < backoff + jitter.
        first.close();
        const { ws: second } = await server.waitForConnection({ timeoutMs: 2000 });
        assert.notEqual(first, second, "la segunda conexión debe ser una nueva instancia");
        assert.ok(server.handshakes.length >= 2, "server debe ver 2 handshakes");
    } finally {
        agent.stop();
        await server.close();
    }
});

// -----------------------------------------------------------------------------
// 7. Request con payload inválido → responde error accionable al relayId
// -----------------------------------------------------------------------------

test("relay request sin payload → responde INVALID_REQUEST con el mismo relayId", async () => {
    const server = await startFakeServer("t");
    const agent = createRelayAgent({
        serverUrl: server.url,
        token: "t",
        cajaId: "CAJA-01",
        // handleMessage NO debería invocarse para payload ausente.
        handleMessage: () => { throw new Error("handleMessage no debía invocarse"); },
        snapshot: () => [],
        logger: silentLogger(),
        pingIntervalMs: 60_000,
    });
    try {
        agent.start();
        const { ws: srvWs } = await server.waitForConnection();
        await waitUntilConnected(agent);
        srvWs.send(JSON.stringify({ relayId: "x-1" })); // sin payload
        const [resp] = await server.waitForFrames(1);
        assert.equal(resp.relayId, "x-1");
        assert.equal(resp.payload.ok, false);
        assert.equal(resp.payload.errorCode, "INVALID_REQUEST");
        assert.equal(resp.payload.type, "printer.response");
    } finally {
        agent.stop();
        await server.close();
    }
});

// -----------------------------------------------------------------------------
// 8. Sin variables de entorno: ni se construye el agente desde index.js
// -----------------------------------------------------------------------------

test("sin env vars: index.js no instancia el agente (gating por readConfigFromEnv)", () => {
    // Verificamos estáticamente que index.js use readConfigFromEnv y
    // omita la creación si devuelve null. Esto es el contrato operacional:
    // sin las 3 variables, el bridge se comporta exactamente como antes.
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    assert.match(src, /readConfigFromEnv/);
    assert.match(src, /if \(!cfg\)/);
    assert.match(src, /createRelayAgent/);
    // Y el helper puro devuelve null para env vacío.
    assert.equal(readConfigFromEnv({}), null);
});

// -----------------------------------------------------------------------------
// 9. stop() cancela timers y no reconecta
// -----------------------------------------------------------------------------

test("stop(): detiene la reconexión y no abre nuevas conexiones", async () => {
    const server = await startFakeServer("t");
    const agent = createRelayAgent({
        serverUrl: server.url,
        token: "t",
        cajaId: "CAJA-01",
        handleMessage: () => {},
        snapshot: () => [],
        logger: silentLogger(),
        pingIntervalMs: 60_000,
        minBackoffMs: 20,
        maxBackoffMs: 50,
        jitterMaxMs: 1,
    });
    try {
        agent.start();
        await server.waitForConnection();
        const before = server.handshakes.length;
        agent.stop();
        // Dar tiempo a que, si hubiera un timer pendiente, reconectase.
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(server.handshakes.length, before, "stop() no debe reabrir");
        assert.equal(agent.isConnected(), false);
    } finally {
        agent.stop();
        await server.close();
    }
});
