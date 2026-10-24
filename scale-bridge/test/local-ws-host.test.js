// =============================================================================
// test/local-ws-host.test.js
//
// Verificaciones estáticas sobre `index.js`:
//
//   1. El WS local escucha en 127.0.0.1 por defecto (SCALE_WS_HOST con
//      fallback a `'127.0.0.1'`), y la opción `host:` se le pasa al
//      `WebSocket.Server`.
//   2. El handler de mensajes vive en una función aparte
//      (`handleIncomingMessage`) que recibe un `responder` abstracto en
//      lugar del `ws` concreto. Esto es lo que habilita que el relay-agent
//      reutilice el mismo pipeline sin duplicar lógica.
//   3. El relay-agent se carga sólo detrás del gating por env vars
//      (readConfigFromEnv() → cfg o null).
//
// Son checks de código fuente (regex / análisis léxico simple), no spawnean
// ni abren el bridge real: así son robustos aunque no haya puertos COM, no
// haya red, y no haya backend.
// =============================================================================

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const INDEX_PATH = path.join(__dirname, "..", "index.js");
const SOURCE = fs.readFileSync(INDEX_PATH, "utf8");

// -----------------------------------------------------------------------------
// 1. WS local en 127.0.0.1 por defecto
// -----------------------------------------------------------------------------

test("SCALE_WS_HOST default es 127.0.0.1 (loopback)", () => {
    // La variable se define con fallback a '127.0.0.1' (loopback).
    assert.match(
        SOURCE,
        /process\.env\.SCALE_WS_HOST\s*\|\|\s*['"]127\.0\.0\.1['"]/,
        "SCALE_WS_HOST debe tener fallback a '127.0.0.1'",
    );
});

test("el WebSocket.Server recibe host: WS_HOST", () => {
    assert.match(
        SOURCE,
        /host:\s*WS_HOST/,
        "WebSocket.Server debe pasarle host: WS_HOST para bindear a loopback por defecto",
    );
});

test("el WS local YA NO escucha en todas las interfaces por default", () => {
    // Guardarraíl contra regresión: no debe haber `host: '0.0.0.0'` fijo,
    // ni usarse una constante del paquete 'os' que materialice IPs públicas.
    assert.doesNotMatch(SOURCE, /host:\s*['"]0\.0\.0\.0['"]/, "no debe haber host hardcoded a 0.0.0.0");
    assert.doesNotMatch(SOURCE, /host:\s*['"]::['"]/, "no debe haber host hardcoded a '::'");
});

// -----------------------------------------------------------------------------
// 2. Handler extraído del ws concreto
// -----------------------------------------------------------------------------

test("handleIncomingMessage es una función independiente del ws concreto", () => {
    // La función debe aceptar `(data, responder)` para que relay-agent la
    // pueda reusar con un responder envoltorio.
    assert.match(
        SOURCE,
        /function\s+handleIncomingMessage\s*\(\s*data\s*,\s*responder\s*\)/,
        "handleIncomingMessage debe tener firma (data, responder)",
    );
});

test("processPrinterMessage recibe un responder, no un ws", () => {
    assert.match(
        SOURCE,
        /async\s+function\s+processPrinterMessage\s*\(\s*responder\s*,\s*raw\s*\)/,
        "processPrinterMessage debe recibir (responder, raw)",
    );
    // Dentro del cuerpo, debe llamar responder.send(...) (no safeSend sobre ws).
    assert.match(SOURCE, /responder\.send\(/);
});

test("el cliente local arma su propio responder sobre safeSend", () => {
    // El handler del WS local construye un localResponder que escribe al ws.
    assert.match(SOURCE, /const\s+localResponder\s*=\s*\{\s*send:/);
});

// -----------------------------------------------------------------------------
// 3. Gating del relay-agent por variables de entorno
// -----------------------------------------------------------------------------

test("el relay-agent se instancia detrás de readConfigFromEnv()", () => {
    // index.js importa readConfigFromEnv y createRelayAgent.
    assert.match(SOURCE, /readConfigFromEnv/);
    assert.match(SOURCE, /createRelayAgent/);
    // El código debe retornar temprano si cfg es null (modo desactivado).
    assert.match(
        SOURCE,
        /const\s+cfg\s*=\s*readConfigFromEnv\(\s*\)[\s\S]*?if\s*\(\s*!cfg\s*\)/,
        "la ruta de activación del agente debe salir temprano cuando cfg es null",
    );
});

test("broadcast() también publica al relay (si está activo)", () => {
    // Dentro de broadcast, debe haber un camino hacia relayAgent.broadcast.
    assert.match(
        SOURCE,
        /function\s+broadcast\s*\([\s\S]*?relayAgent\.broadcast/,
        "broadcast() debe reenviar también al relay",
    );
});

test("SIGINT/SIGTERM detienen el relay-agent (no deja timers huérfanos)", () => {
    // El teardown del proceso debe llamar relayAgent.stop() antes de
    // cerrar el puerto y el wss. Evita que un bridge cerrado deje el
    // intervalo de ping o el timer de reconexión colgado.
    const sigint = SOURCE.slice(SOURCE.indexOf("'SIGINT'"));
    assert.match(sigint, /relayAgent\.stop\(\)/);
    const sigterm = SOURCE.slice(SOURCE.indexOf("'SIGTERM'"));
    assert.match(sigterm, /relayAgent\.stop\(\)/);
});

// -----------------------------------------------------------------------------
// 4. Compatibilidad con el ritmo anterior: `scanAndConnect` sigue adentro
//     del callback de listening (invariante singleton, ver singleton-startup).
// -----------------------------------------------------------------------------

test("scanAndConnect sigue dentro del callback de listening (no top-level)", () => {
    const listeningLog = SOURCE.indexOf("Servidor WebSocket escuchando");
    const scanInCallback = SOURCE.indexOf("scanAndConnect();", listeningLog);
    assert.ok(
        listeningLog >= 0 && scanInCallback > listeningLog,
        "scanAndConnect debe seguir disparándose dentro del callback de listening",
    );
    // No debe aparecer una llamada top-level sin indentación en el tail.
    const tail = SOURCE.slice(SOURCE.indexOf("function scheduleReconnect"));
    const directCalls = tail.match(/^scanAndConnect\(\);\s*$/gm) || [];
    assert.equal(directCalls.length, 0);
});
