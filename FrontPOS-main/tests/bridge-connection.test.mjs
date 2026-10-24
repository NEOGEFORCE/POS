// =============================================================================
// tests/bridge-connection.test.mjs
//
// Lógica pura del módulo compartido entre `scaleBridge.ts` y `pos-bridge-ws.ts`
// para la arquitectura "bridge local → relay por servidor". Cubre resolución
// de URLs, selección de caja, mensajes de error y la orquestación completa
// `negotiateBridgeConnection` (con dependencias inyectadas).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";

import {
    LOCAL_BRIDGE_PROBE_TIMEOUT_MS,
    POS_BRIDGE_CAJA_STORAGE_KEY,
    RELAY_ERROR_CODES,
    buildRelayWsUrl,
    describeRelayError,
    extractRelayErrorCode,
    getRelayEndpoints,
    httpBaseToWsBase,
    negotiateBridgeConnection,
    normalizeAgents,
    readSavedCajaId,
    resolveLocalBridgeUrl,
    selectCajaId,
    writeSavedCajaId,
} from "../src/lib/bridge-connection.mjs";

// -----------------------------------------------------------------------------
// Mocks de storage para los tests
// -----------------------------------------------------------------------------

function makeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        get _map() { return map; },
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { map.set(k, String(v)); },
        removeItem(k) { map.delete(k); },
    };
}

// -----------------------------------------------------------------------------
// Constantes públicas
// -----------------------------------------------------------------------------

test("constantes: timeout de sonda local es 1.5s y storage key canónica", () => {
    assert.equal(LOCAL_BRIDGE_PROBE_TIMEOUT_MS, 1500);
    assert.equal(POS_BRIDGE_CAJA_STORAGE_KEY, "pos_bridge_caja_id");
    assert.equal(RELAY_ERROR_CODES.AGENT_OFFLINE, "RELAY_AGENT_OFFLINE");
    assert.equal(RELAY_ERROR_CODES.FORBIDDEN, "RELAY_FORBIDDEN");
    assert.equal(RELAY_ERROR_CODES.TIMEOUT, "RELAY_TIMEOUT");
});

// -----------------------------------------------------------------------------
// resolveLocalBridgeUrl
// -----------------------------------------------------------------------------

test("resolveLocalBridgeUrl: honra NEXT_PUBLIC_POS_BRIDGE_WS_URL cuando viene", () => {
    const url = resolveLocalBridgeUrl({
        env: { NEXT_PUBLIC_POS_BRIDGE_WS_URL: "ws://custom:1234" },
        location: { hostname: "ignored" },
    });
    assert.equal(url, "ws://custom:1234");
});

test("resolveLocalBridgeUrl: cae a NEXT_PUBLIC_SCALE_WS_URL si POS_BRIDGE no está", () => {
    const url = resolveLocalBridgeUrl({
        env: { NEXT_PUBLIC_SCALE_WS_URL: "ws://old:9876" },
        location: { hostname: "whatever" },
    });
    assert.equal(url, "ws://old:9876");
});

test("resolveLocalBridgeUrl: usa location.hostname cuando no hay env", () => {
    const url = resolveLocalBridgeUrl({ env: {}, location: { hostname: "192.168.1.21" } });
    assert.equal(url, "ws://192.168.1.21:9876");
});

test("resolveLocalBridgeUrl: cae a localhost en SSR (sin env ni location)", () => {
    assert.equal(resolveLocalBridgeUrl(), "ws://localhost:9876");
    assert.equal(resolveLocalBridgeUrl({ env: {}, location: null }), "ws://localhost:9876");
});

// -----------------------------------------------------------------------------
// httpBaseToWsBase y buildRelayWsUrl
// -----------------------------------------------------------------------------

test("httpBaseToWsBase: http→ws conservando ruta /api", () => {
    const base = httpBaseToWsBase({ apiUrl: "http://192.168.1.6:3000/api" });
    assert.equal(base, "ws://192.168.1.6:3000/api");
});

test("httpBaseToWsBase: https→wss", () => {
    const base = httpBaseToWsBase({ apiUrl: "https://pos.surtifamiliar.co/api" });
    assert.equal(base, "wss://pos.surtifamiliar.co/api");
});

test("httpBaseToWsBase: path relativo usa location.origin", () => {
    const base = httpBaseToWsBase({
        apiUrl: "/api",
        location: { protocol: "https:", host: "pos.surtifamiliar.co" },
    });
    assert.equal(base, "wss://pos.surtifamiliar.co/api");
});

test("httpBaseToWsBase: path relativo diferente a /api se preserva", () => {
    const base = httpBaseToWsBase({
        apiUrl: "/custom-api/",
        location: { protocol: "http:", host: "localhost:9002" },
    });
    assert.equal(base, "ws://localhost:9002/custom-api");
});

test("httpBaseToWsBase: fallback cuando no hay nada", () => {
    assert.equal(httpBaseToWsBase({}), "ws://localhost/api");
});

test("buildRelayWsUrl: construye URL completa con ticket y respeta NEXT_PUBLIC_API_URL", () => {
    const url = buildRelayWsUrl({
        apiUrl: "http://192.168.1.6:3000/api",
        ticket: "abc123",
    });
    assert.equal(url, "ws://192.168.1.6:3000/api/bridge/relay?ticket=abc123");
});

test("buildRelayWsUrl: con location https devuelve wss", () => {
    const url = buildRelayWsUrl({
        apiUrl: "/api",
        location: { protocol: "https:", host: "pos.sf.co" },
        ticket: "t+ok/with=special",
    });
    // encodeURIComponent de "t+ok/with=special" → "t%2Bok%2Fwith%3Dspecial"
    assert.equal(url, "wss://pos.sf.co/api/bridge/relay?ticket=t%2Bok%2Fwith%3Dspecial");
});

test("buildRelayWsUrl: ticket vacío queda como query vacío (no rompe)", () => {
    const url = buildRelayWsUrl({ apiUrl: "http://host/api", ticket: "" });
    assert.equal(url, "ws://host/api/bridge/relay?ticket=");
});

// -----------------------------------------------------------------------------
// getRelayEndpoints
// -----------------------------------------------------------------------------

test("getRelayEndpoints: devuelve paths relativos a la base API", () => {
    const { agentsPath, ticketPath } = getRelayEndpoints();
    assert.equal(agentsPath, "/bridge/agents");
    assert.equal(ticketPath, "/bridge/ticket");
});

// -----------------------------------------------------------------------------
// normalizeAgents / selectCajaId
// -----------------------------------------------------------------------------

test("normalizeAgents: filtra entradas sin cajaId y agentes malformados", () => {
    const result = normalizeAgents({
        agents: [
            { cajaId: "CAJA-01", connected: true, connectedAt: "2026-10-24T12:00:00Z", lastSeenAt: "2026-10-24T12:04:00Z" },
            { connected: true },             // sin cajaId → descartado
            null,                            // null → descartado
            { cajaId: "  ", connected: true }, // vacío → descartado
            { cajaId: "CAJA-02", connected: false, connectedAt: null, lastSeenAt: null },
        ],
    });
    assert.equal(result.length, 2);
    assert.equal(result[0].cajaId, "CAJA-01");
    assert.equal(result[0].connected, true);
    assert.equal(result[1].cajaId, "CAJA-02");
    assert.equal(result[1].connected, false);
});

test("normalizeAgents: tolera input vacío o malformado", () => {
    assert.deepEqual(normalizeAgents(null), []);
    assert.deepEqual(normalizeAgents({}), []);
    assert.deepEqual(normalizeAgents({ agents: "nope" }), []);
    assert.deepEqual(normalizeAgents({ agents: [] }), []);
});

test("selectCajaId: una sola caja conectada → auto-seleccionada", () => {
    const picked = selectCajaId({
        agents: [{ cajaId: "CAJA-01", connected: true }],
    });
    assert.equal(picked, "CAJA-01");
});

test("selectCajaId: preferencia guardada ganas si está conectada", () => {
    const picked = selectCajaId({
        agents: [
            { cajaId: "CAJA-01", connected: true },
            { cajaId: "CAJA-02", connected: true },
        ],
        savedCajaId: "CAJA-02",
    });
    assert.equal(picked, "CAJA-02");
});

test("selectCajaId: preferencia desconectada se ignora, cae a orden alfabético", () => {
    const picked = selectCajaId({
        agents: [
            { cajaId: "CAJA-02", connected: true },
            { cajaId: "CAJA-01", connected: true },
        ],
        savedCajaId: "CAJA-99", // no conectada
    });
    assert.equal(picked, "CAJA-01");
});

test("selectCajaId: ninguna conectada → null", () => {
    assert.equal(selectCajaId({
        agents: [
            { cajaId: "CAJA-01", connected: false },
            { cajaId: "CAJA-02", connected: false },
        ],
    }), null);
    assert.equal(selectCajaId({ agents: [] }), null);
});

// -----------------------------------------------------------------------------
// readSavedCajaId / writeSavedCajaId
// -----------------------------------------------------------------------------

test("readSavedCajaId / writeSavedCajaId: round-trip en storage mock", () => {
    const storage = makeStorage();
    assert.equal(readSavedCajaId(storage), null);
    writeSavedCajaId(storage, "CAJA-01");
    assert.equal(readSavedCajaId(storage), "CAJA-01");
    assert.equal(storage.getItem(POS_BRIDGE_CAJA_STORAGE_KEY), "CAJA-01");
});

test("writeSavedCajaId: con null borra la preferencia", () => {
    const storage = makeStorage({ [POS_BRIDGE_CAJA_STORAGE_KEY]: "CAJA-01" });
    writeSavedCajaId(storage, null);
    assert.equal(storage._map.has(POS_BRIDGE_CAJA_STORAGE_KEY), false);
});

test("readSavedCajaId: null-safe con storage inválido", () => {
    assert.equal(readSavedCajaId(null), null);
    assert.equal(readSavedCajaId(undefined), null);
    // Storage que lanza
    assert.equal(readSavedCajaId({ getItem() { throw new Error("blocked"); } }), null);
});

test("writeSavedCajaId: no lanza si storage se cae (quota, bloqueado)", () => {
    const broken = {
        setItem() { throw new Error("quota exceeded"); },
        removeItem() { throw new Error("blocked"); },
    };
    writeSavedCajaId(broken, "CAJA-01");
    writeSavedCajaId(broken, null);
    // Si llegamos acá sin excepción, pasa.
    assert.ok(true);
});

// -----------------------------------------------------------------------------
// Mapas de error
// -----------------------------------------------------------------------------

test("describeRelayError: devuelve texto en español para cada código conocido", () => {
    assert.match(describeRelayError(RELAY_ERROR_CODES.AGENT_OFFLINE), /desconectada/i);
    assert.match(describeRelayError(RELAY_ERROR_CODES.FORBIDDEN), /rol/i);
    assert.match(describeRelayError(RELAY_ERROR_CODES.TIMEOUT), /15/);
    assert.match(describeRelayError("DESCONOCIDO"), /remota/i);
});

test("extractRelayErrorCode: extrae prefijos RELAY_* del mensaje", () => {
    assert.equal(extractRelayErrorCode("RELAY_AGENT_OFFLINE: caja desconectada"), "RELAY_AGENT_OFFLINE");
    assert.equal(extractRelayErrorCode("RELAY_FORBIDDEN: rol insuficiente"), "RELAY_FORBIDDEN");
    assert.equal(extractRelayErrorCode("RELAY_TIMEOUT: agente no respondió"), "RELAY_TIMEOUT");
    assert.equal(extractRelayErrorCode("OTHER_CODE: nope"), null);
    assert.equal(extractRelayErrorCode(null), null);
    assert.equal(extractRelayErrorCode(123), null);
});

// -----------------------------------------------------------------------------
// negotiateBridgeConnection
// -----------------------------------------------------------------------------

test("negotiateBridgeConnection: sonda local OK → modo local, socket reutilizado, sin fetch", async () => {
    let fetchAgentsCalls = 0;
    let ticketCalls = 0;
    const fakeSocket = { marker: "local-socket" };
    const result = await negotiateBridgeConnection({
        env: { NEXT_PUBLIC_SCALE_WS_URL: "ws://localhost:9876" },
        probeLocal: async (url, timeout) => {
            assert.equal(url, "ws://localhost:9876");
            assert.equal(timeout, LOCAL_BRIDGE_PROBE_TIMEOUT_MS);
            return fakeSocket;
        },
        fetchAgents: async () => { fetchAgentsCalls++; return { agents: [] }; },
        requestTicket: async () => { ticketCalls++; return { ticket: "nope" }; },
    });
    assert.equal(result.mode, "local");
    assert.equal(result.url, "ws://localhost:9876");
    assert.equal(result.cajaId, null);
    assert.strictEqual(result.socket, fakeSocket);
    assert.equal(fetchAgentsCalls, 0, "no debe consultar agentes si local responde");
    assert.equal(ticketCalls, 0, "no debe pedir ticket si local responde");
});

test("negotiateBridgeConnection: sonda local falla + caja única → modo relay, URL con ticket", async () => {
    const result = await negotiateBridgeConnection({
        env: {
            NEXT_PUBLIC_API_URL: "http://192.168.1.6:3000/api",
            NEXT_PUBLIC_SCALE_WS_URL: "ws://localhost:9876",
        },
        probeLocal: async () => null,
        fetchAgents: async () => ({
            agents: [{ cajaId: "CAJA-01", connected: true }],
        }),
        requestTicket: async (cajaId) => {
            assert.equal(cajaId, "CAJA-01");
            return { ticket: "SHORT_TICKET_123" };
        },
    });
    assert.equal(result.mode, "relay");
    assert.equal(result.cajaId, "CAJA-01");
    assert.equal(result.url, "ws://192.168.1.6:3000/api/bridge/relay?ticket=SHORT_TICKET_123");
    assert.equal(result.socket, null);
});

test("negotiateBridgeConnection: ninguna caja conectada → error con code AGENT_OFFLINE", async () => {
    await assert.rejects(
        () => negotiateBridgeConnection({
            env: { NEXT_PUBLIC_API_URL: "/api" },
            location: { protocol: "https:", host: "pos.sf.co" },
            probeLocal: async () => null,
            fetchAgents: async () => ({
                agents: [{ cajaId: "CAJA-01", connected: false }],
            }),
            requestTicket: async () => ({ ticket: "nope" }),
        }),
        (err) => {
            assert.equal(err.code, RELAY_ERROR_CODES.AGENT_OFFLINE);
            assert.match(err.message, /No hay cajas conectadas/);
            return true;
        },
    );
});

test("negotiateBridgeConnection: fetch de agentes falla → error AGENT_OFFLINE propagado", async () => {
    await assert.rejects(
        () => negotiateBridgeConnection({
            env: {},
            probeLocal: async () => null,
            fetchAgents: async () => { throw new Error("HTTP 500"); },
            requestTicket: async () => ({ ticket: "x" }),
        }),
        (err) => {
            assert.equal(err.code, RELAY_ERROR_CODES.AGENT_OFFLINE);
            assert.match(err.message, /HTTP 500/);
            return true;
        },
    );
});

test("negotiateBridgeConnection: múltiples cajas + override gana sobre guardada", async () => {
    const storage = makeStorage({ [POS_BRIDGE_CAJA_STORAGE_KEY]: "CAJA-02" });
    const result = await negotiateBridgeConnection({
        env: { NEXT_PUBLIC_API_URL: "https://pos.sf.co/api" },
        storage,
        cajaIdOverride: "CAJA-03",
        probeLocal: async () => null,
        fetchAgents: async () => ({
            agents: [
                { cajaId: "CAJA-01", connected: true },
                { cajaId: "CAJA-02", connected: true },
                { cajaId: "CAJA-03", connected: true },
            ],
        }),
        requestTicket: async (cajaId) => {
            assert.equal(cajaId, "CAJA-03", "el override debe prevalecer sobre la preferencia guardada");
            return { ticket: "TICKET_FOR_3" };
        },
    });
    assert.equal(result.mode, "relay");
    assert.equal(result.cajaId, "CAJA-03");
    assert.equal(result.url, "wss://pos.sf.co/api/bridge/relay?ticket=TICKET_FOR_3");
});

test("negotiateBridgeConnection: pide ticket NUEVO en cada reconexión", async () => {
    const tickets = ["T1", "T2", "T3"];
    const used = [];
    const makeOpts = () => ({
        env: { NEXT_PUBLIC_API_URL: "http://host:3000/api" },
        probeLocal: async () => null,
        fetchAgents: async () => ({ agents: [{ cajaId: "CAJA-01", connected: true }] }),
        requestTicket: async () => {
            const t = tickets.shift();
            used.push(t);
            return { ticket: t };
        },
    });
    for (let i = 0; i < 3; i++) {
        const result = await negotiateBridgeConnection(makeOpts());
        assert.equal(result.mode, "relay");
        assert.match(result.url, /\/bridge\/relay\?ticket=T\d/);
    }
    assert.deepEqual(used, ["T1", "T2", "T3"]);
});

test("negotiateBridgeConnection: respuesta de ticket sin campo ticket → error", async () => {
    await assert.rejects(
        () => negotiateBridgeConnection({
            env: { NEXT_PUBLIC_API_URL: "http://host/api" },
            probeLocal: async () => null,
            fetchAgents: async () => ({ agents: [{ cajaId: "CAJA-01", connected: true }] }),
            requestTicket: async () => ({ /* vacío */ }),
        }),
        /ticket relay válido/i,
    );
});

test("negotiateBridgeConnection: sonda local lanza → sigue a relay sin romper", async () => {
    const result = await negotiateBridgeConnection({
        env: { NEXT_PUBLIC_API_URL: "http://host/api" },
        probeLocal: async () => { throw new Error("boom"); },
        fetchAgents: async () => ({ agents: [{ cajaId: "CAJA-01", connected: true }] }),
        requestTicket: async () => ({ ticket: "X" }),
    });
    assert.equal(result.mode, "relay");
    assert.equal(result.url, "http://host/api/bridge/relay?ticket=X".replace("http:", "ws:"));
});

test("negotiateBridgeConnection: timeout personalizado se propaga a probeLocal", async () => {
    let seenTimeout = null;
    await negotiateBridgeConnection({
        env: {},
        localProbeTimeoutMs: 42,
        probeLocal: async (_url, timeout) => { seenTimeout = timeout; return { ok: true }; },
        fetchAgents: async () => ({ agents: [] }),
        requestTicket: async () => ({ ticket: "x" }),
    });
    assert.equal(seenTimeout, 42);
});

test("negotiateBridgeConnection: valida que las dependencias sean funciones", async () => {
    await assert.rejects(
        () => negotiateBridgeConnection({}),
        /probeLocal es obligatorio/,
    );
    await assert.rejects(
        () => negotiateBridgeConnection({ probeLocal: async () => null }),
        /fetchAgents es obligatorio/,
    );
    await assert.rejects(
        () => negotiateBridgeConnection({
            probeLocal: async () => null,
            fetchAgents: async () => ({ agents: [{ cajaId: "x", connected: true }] }),
        }),
        /requestTicket es obligatorio/,
    );
});

// -----------------------------------------------------------------------------
// Escenario móvil: el navegador vive en el servidor (192.168.1.6:3000),
// el firewall bloquea el puerto 9876 del bridge local → la URL del relay
// se arma con `window.location.host`, no con `localhost`.
// -----------------------------------------------------------------------------

test("negotiateBridgeConnection (móvil): probe local falla + API_URL vacío → relay via window.location.host", async () => {
    const result = await negotiateBridgeConnection({
        env: {}, // Sin NEXT_PUBLIC_API_URL explícito.
        location: {
            hostname: "192.168.1.6",
            host: "192.168.1.6:3000",
            protocol: "http:",
        },
        // Simula el firewall que silencia el puerto 9876: la sonda
        // local devuelve null tras timeout.
        probeLocal: async () => null,
        fetchAgents: async () => ({
            agents: [{ cajaId: "CAJA-01", connected: true }],
        }),
        requestTicket: async (cajaId) => {
            assert.equal(cajaId, "CAJA-01");
            return { ticket: "MOBILE_TICKET" };
        },
    });
    assert.equal(result.mode, "relay");
    assert.equal(result.cajaId, "CAJA-01");
    // La URL del relay se arma con el host del documento (NO localhost),
    // porque desde el celular `localhost` apuntaría al propio celular.
    assert.equal(result.url, "ws://192.168.1.6:3000/api/bridge/relay?ticket=MOBILE_TICKET");
});

test("resolveLocalBridgeUrl (móvil): usa location.hostname, nunca localhost cuando el navegador no está en el PC de caja", () => {
    // El celular accede a http://192.168.1.6:3000 y nuestra heurística
    // de bridge local prueba `ws://192.168.1.6:9876` (no `ws://localhost:9876`).
    // Si localhost se usara aquí, el celular intentaría abrir un socket
    // contra sí mismo y nunca llegaría al bridge real.
    const url = resolveLocalBridgeUrl({
        env: {},
        location: { hostname: "192.168.1.6" },
    });
    assert.equal(url, "ws://192.168.1.6:9876");
    assert.ok(!url.includes("localhost"), "La URL local NO debe caer a localhost cuando hay location.hostname.");
});
