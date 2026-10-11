// =============================================================================
// tests/pos-bridge-ws.test.mjs
//
// Tests ejecutables del cliente WebSocket que respalda `window.posBridge`.
//
// Como el módulo real vive en TypeScript (`src/lib/pos-bridge-ws.ts`), esta
// batería lo ejerce de dos formas complementarias:
//
//   1. CONTRATO ESTÁTICO (lectura de fuente): verifica que exista la clase
//      `PosBridgeWsClient`, el helper `installWebSocketPosBridge`, el guard
//      "no sobreescribir bridges nativos", el manejo de requestId y los
//      timeouts.
//
//   2. CONTRATO DINÁMICO (eval controlada): extrae el cuerpo del método
//      `sendRequest` y lo prueba con un WebSocket mock, demostrando que el
//      envelope `{ type, requestId, payload }` sale al socket y que la
//      respuesta con el mismo requestId resuelve la promesa.
//
// Lo clave: el sentinel `DIRECT_PRINT_UNAVAILABLE` acompaña cada rechazo,
// y una preexistente `window.posBridge.print` NO se sobreescribe.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wsSource = join(here, "..", "src", "lib", "pos-bridge-ws.ts");
const bridgeSource = join(here, "..", "src", "lib", "pos-bridge.ts");
const providersSource = join(here, "..", "src", "app", "providers.tsx");

async function read(path) {
  return await readFile(path, "utf8");
}

// ============================================================================
// Contrato estático
// ============================================================================

test("pos-bridge-ws.ts: expone la clase PosBridgeWsClient con los métodos del contrato", async () => {
  const src = await read(wsSource);
  assert.match(src, /export class PosBridgeWsClient implements PosBridge/,
    "Debe implementar la interfaz pública PosBridge.");
  for (const method of ["print(", "printTestPage(", "kickDrawer(", "isConnected()", "onStatusChange("]) {
    assert.ok(src.includes(method),
      `La clase debe exponer el método \`${method}\` del contrato PosBridge.`);
  }
  assert.match(src, /connect\(\)/, "Debe exponer connect() para abrir la WS.");
  assert.match(src, /disconnect\(\)/, "Debe exponer disconnect() para cerrarla.");
});

test("pos-bridge-ws.ts: cada solicitud lleva requestId único y un timeout configurable", async () => {
  const src = await read(wsSource);
  // Envelope canónico del bridge: { type:"printer.request", action, requestId, payload }
  // (coincide con validatePrinterRequest en scale-bridge/printer-bridge.js).
  assert.match(
    src,
    /const message = \{ type: "printer\.request", action, requestId, payload \}/,
    'sendRequest debe armar el envelope { type:"printer.request", action, requestId, payload } del bridge.',
  );
  // Timeout por request con sentinel al mensaje. El sentinel viaja como
  // interpolación `${DIRECT_PRINT_UNAVAILABLE}` dentro del template literal.
  const timeoutBlock = /setTimeout\([\s\S]*?this\.pending\.delete\(requestId\)[\s\S]*?DIRECT_PRINT_UNAVAILABLE[\s\S]*?timeout del bridge/;
  assert.match(src, timeoutBlock,
    "sendRequest debe programar un setTimeout que rechaza con el sentinel DIRECT_PRINT_UNAVAILABLE y la frase 'timeout del bridge'.");
  // Mapa de pendientes para hacer el matching req/response.
  assert.match(src, /this\.pending\.set\(requestId, \{ action, resolve, reject, timer \}\)/,
    "Debe mantener un Map<requestId, pending> con la action del request para resolver respuestas.");
});

test("pos-bridge-ws.ts: timeoutMs default de 10s y reconnectDelayMs default de 2s", async () => {
  const src = await read(wsSource);
  assert.match(src, /this\.timeoutMs = options\.timeoutMs \?\? 10_000/,
    "Default de timeout debe ser 10s para evitar que el POS se cuelgue.");
  assert.match(src, /this\.reconnectDelayMs = options\.reconnectDelayMs \?\? 2_000/,
    "Default de reconexión debe ser 2s.");
});

test("pos-bridge-ws.ts: installWebSocketPosBridge NO sobreescribe bridges nativos preexistentes", async () => {
  const src = await read(wsSource);
  // El guard preserva el bridge nativo si ya existe.
  assert.match(src, /if \(existing && typeof existing\.print === "function" && !\(existing instanceof PosBridgeWsClient\)\)/,
    "El installer debe detectar un bridge nativo preexistente y preservarlo.");
  assert.match(src, /return null;/,
    "Cuando hay bridge nativo, el installer devuelve null sin tocar window.posBridge.");
});

test("pos-bridge-ws.ts: rechaza con DIRECT_PRINT_UNAVAILABLE cuando el socket no está abierto", async () => {
  const src = await read(wsSource);
  // Si readyState !== OPEN, Promise.reject con el sentinel.
  const fn = src.indexOf("private sendRequest(");
  assert.ok(fn > 0);
  const scope = src.slice(fn, fn + 2000);
  assert.match(scope, /if \(!this\.isConnected\(\) \|\| !this\.ws\)/,
    "sendRequest debe comprobar isConnected() antes de enviar.");
  // El sentinel viaja como interpolación `${DIRECT_PRINT_UNAVAILABLE}` en el
  // template literal (en runtime se expande a 'DIRECT_PRINT_UNAVAILABLE: bridge WS no conectado').
  assert.match(scope, /DIRECT_PRINT_UNAVAILABLE\}: bridge WS no conectado/,
    "Sin conexión, el reject usa el mensaje exacto esperado por el consumidor.");
});

test("pos-bridge-ws.ts: al cerrarse el socket, rechaza TODOS los pendientes con el sentinel", async () => {
  const src = await read(wsSource);
  const onCloseIdx = src.indexOf("ws.onclose = () => {");
  assert.ok(onCloseIdx > 0, "Debe haber un handler onclose.");
  const scope = src.slice(onCloseIdx, onCloseIdx + 1200);
  assert.match(scope, /this\.rejectAllPending\(new Error\(`\$\{DIRECT_PRINT_UNAVAILABLE\}: bridge WS cerrado`\)\)/,
    "onclose debe rechazar los pendientes con el sentinel para que el consumidor pueda detectar el drop.");
  assert.match(scope, /this\.scheduleReconnect\(\)/,
    "onclose debe programar reconexión salvo que se haya hecho disconnect() explícito.");
});

test("pos-bridge-ws.ts: isConnected refleja fielmente readyState === OPEN", async () => {
  const src = await read(wsSource);
  assert.match(src, /isConnected\(\):\s*boolean\s*\{\s*return\s*!!this\.ws\s*&&\s*this\.ws\.readyState === WebSocket\.OPEN;/,
    "isConnected debe depender de WebSocket.OPEN, no de un flag paralelo.");
});

test("pos-bridge-ws.ts: onStatusChange notifica el estado inicial antes de registrar al suscriptor", async () => {
  const src = await read(wsSource);
  const idx = src.indexOf("onStatusChange(listener");
  assert.ok(idx > 0);
  const scope = src.slice(idx, idx + 500);
  // listener inicial + registro en el set.
  assert.match(scope, /this\.listeners\.add\(listener\);[\s\S]*listener\(this\.getStatus\(\)\)/,
    "El suscriptor debe recibir el estado inicial inmediatamente.");
});

// ============================================================================
// pos-bridge.ts: hasPosBridgePrint es honesto con isConnected()
// ============================================================================

test("pos-bridge.ts: hasPosBridgePrint honra isConnected() cuando el bridge lo expone", async () => {
  const src = await read(bridgeSource);
  const fnStart = src.indexOf("export function hasPosBridgePrint()");
  assert.ok(fnStart > 0);
  const scope = src.slice(fnStart, src.indexOf("export function hasPosBridgeTestPrint"));
  assert.match(scope, /typeof bridge\.isConnected === "function"/,
    "hasPosBridgePrint debe mirar si el bridge expone isConnected().");
  assert.match(scope, /return !!bridge\.isConnected\(\)/,
    "Debe devolver el booleano reportado por el bridge.");
  // BC con bridges externos sin isConnected.
  assert.match(scope, /\/\/ Bridge sin método isConnected: se asume disponible/,
    "El fallback para bridges externos (nativos) debe estar documentado.");
});

test("pos-bridge.ts: subscribePosBridgeStatus delega al bridge si expone onStatusChange", async () => {
  const src = await read(bridgeSource);
  assert.match(src, /export function subscribePosBridgeStatus/,
    "Debe exportar el helper subscribePosBridgeStatus.");
  const scope = src.slice(src.indexOf("export function subscribePosBridgeStatus"));
  assert.match(scope, /bridge\.onStatusChange\(listener\)/,
    "Si el bridge expone onStatusChange debe delegar.");
});

// ============================================================================
// providers.tsx: instalación global del bridge WS
// ============================================================================

test("providers.tsx: instala el cliente WS dentro de un useEffect (no en SSR)", async () => {
  const src = await read(providersSource);
  assert.match(src, /from\s+["']@\/lib\/pos-bridge-ws["']/,
    "Debe importar el helper installWebSocketPosBridge.");
  assert.match(src, /installWebSocketPosBridge\(\)/,
    "Debe invocar installWebSocketPosBridge en el conector.");
  // No se llama en el initializer de un useState ni al nivel de módulo.
  assert.match(src, /useEffect\(\(\) => \{\s*installWebSocketPosBridge\(\);\s*\}, \[\]\)/,
    "La instalación debe ocurrir dentro de useEffect con deps vacías (una vez por sesión).");
});

// ============================================================================
// Contrato dinámico: eval del método sendRequest con WebSocket mock
// ============================================================================

/**
 * Mock mínimo de WebSocket: implementa `send`, `readyState` y las propiedades
 * `OPEN/CLOSED` requeridas por `pos-bridge-ws.ts`. Soporta inyectar respuestas
 * desde los tests.
 */
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  constructor() {
    this.readyState = MockWebSocket.OPEN;
    this.sent = [];
    this.onmessage = null;
  }
  send(data) {
    this.sent.push(data);
  }
  emitResponse(data) {
    if (typeof this.onmessage === "function") {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }
}

test("sendRequest: envía envelope { type:'printer.request', action, requestId, payload } y resuelve con la respuesta correcta", async () => {
  const src = await read(wsSource);
  // Localizar y extraer el cuerpo del método privado sendRequest. En TS lleva
  // anotaciones de tipo que convertimos a JS puro para poder evaluarlo.
  const start = src.indexOf("private sendRequest(");
  assert.ok(start > 0);
  // Firma TS: "private sendRequest(action: string, payload: unknown): Promise<unknown> {"
  const openBrace = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = openBrace; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > openBrace);
  const bodyRaw = src.slice(openBrace + 1, end);
  // Convertimos TypeScript → JS puro:
  //  - quitamos anotaciones ": T" tras parámetros, variables y funciones de flecha
  //  - quitamos genéricos TS en Promise/new Promise
  const body = bodyRaw
    .replace(/new Promise<[^>]+>/g, "new Promise")
    .replace(/const (\w+)\s*:\s*[A-Za-z_][\w.<>|&\s[\]]*?\s*=/g, "const $1 =")
    .replace(/\bthis\./g, "instance.");

  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  // El cuerpo original accede a `this` → envolvemos en una fn que recibe un
  // objeto `instance` y adaptamos las referencias. También inyectamos la
  // constante `DIRECT_PRINT_UNAVAILABLE` (originalmente módulo-level).
  const run = new AsyncFn(
    "instance", "action", "payload", "WebSocket", "DIRECT_PRINT_UNAVAILABLE",
    body,
  );

  // Build the "instance" that sendRequest expects.
  const ws = new MockWebSocket();
  const pending = new Map();
  const instance = {
    ws,
    isConnected: () => true,
    nextRequestId: () => "pos-test-1",
    timeoutMs: 1000,
    pending,
  };

  const promise = run(instance, "print", { ticketText: "HOLA" }, MockWebSocket, "DIRECT_PRINT_UNAVAILABLE");
  assert.equal(ws.sent.length, 1, "El socket debe recibir exactamente un mensaje.");
  const parsed = JSON.parse(ws.sent[0]);
  assert.equal(parsed.type, "printer.request",
    'El wire envelope debe llevar type:"printer.request" (coincide con validatePrinterRequest del bridge).');
  assert.equal(parsed.action, "print",
    'La acción (print|printTestPage|kickDrawer) va en el campo "action".');
  assert.equal(parsed.requestId, "pos-test-1");
  assert.deepEqual(parsed.payload, { ticketText: "HOLA" });
  assert.ok(pending.has("pos-test-1"), "La solicitud debe quedar registrada en pending.");

  // Emulamos la respuesta del bridge con el requestId esperado.
  const pendingEntry = pending.get("pos-test-1");
  // El handleIncoming vive en otro método; aquí resolvemos directamente la
  // promesa como lo haría ese handler.
  clearTimeout(pendingEntry.timer);
  pendingEntry.resolve({ ok: true });
  pending.delete("pos-test-1");

  const result = await promise;
  assert.deepEqual(result, { ok: true });
});

test("sendRequest: timeout rechaza con DIRECT_PRINT_UNAVAILABLE y mensaje de timeout", async () => {
  const src = await read(wsSource);
  const start = src.indexOf("private sendRequest(");
  const openBrace = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = openBrace; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const bodyRaw = src.slice(openBrace + 1, end);
  const body = bodyRaw
    .replace(/new Promise<[^>]+>/g, "new Promise")
    .replace(/const (\w+)\s*:\s*[A-Za-z_][\w.<>|&\s[\]]*?\s*=/g, "const $1 =")
    .replace(/\bthis\./g, "instance.");

  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFn(
    "instance", "action", "payload", "WebSocket", "DIRECT_PRINT_UNAVAILABLE",
    body,
  );

  const ws = new MockWebSocket();
  const pending = new Map();
  const instance = {
    ws,
    isConnected: () => true,
    nextRequestId: () => "pos-test-timeout",
    timeoutMs: 5, // 5ms → se dispara el timeout rapidísimo
    pending,
  };

  await assert.rejects(
    () => run(instance, "print", {}, MockWebSocket, "DIRECT_PRINT_UNAVAILABLE"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /^DIRECT_PRINT_UNAVAILABLE: timeout del bridge/,
        "El timeout debe propagar el sentinel con la frase canónica 'timeout del bridge'.");
      return true;
    },
  );
  // Al rechazar por timeout la entrada de `pending` queda limpia (no fuga de pendientes).
  assert.equal(pending.size, 0,
    "El timeout debe limpiar la entrada de `pending` para evitar fugas al reconectar.");
});

test("sendRequest: WS no conectado rechaza inmediatamente con DIRECT_PRINT_UNAVAILABLE", async () => {
  const src = await read(wsSource);
  const start = src.indexOf("private sendRequest(");
  const openBrace = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = openBrace; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const bodyRaw = src.slice(openBrace + 1, end);
  const body = bodyRaw
    .replace(/new Promise<[^>]+>/g, "new Promise")
    .replace(/const (\w+)\s*:\s*[A-Za-z_][\w.<>|&\s[\]]*?\s*=/g, "const $1 =")
    .replace(/\bthis\./g, "instance.");

  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFn(
    "instance", "action", "payload", "WebSocket", "DIRECT_PRINT_UNAVAILABLE",
    body,
  );

  const instance = {
    ws: null,
    isConnected: () => false,
    nextRequestId: () => "nope",
    timeoutMs: 1000,
    pending: new Map(),
  };

  await assert.rejects(
    () => run(instance, "print", {}, MockWebSocket, "DIRECT_PRINT_UNAVAILABLE"),
    (err) => {
      assert.match(err.message, /^DIRECT_PRINT_UNAVAILABLE: bridge WS no conectado/,
        "Sin conexión, el reject es inmediato con el mensaje exacto.");
      return true;
    },
  );
});
