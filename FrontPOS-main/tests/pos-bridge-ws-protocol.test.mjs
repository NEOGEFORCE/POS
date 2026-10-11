// =============================================================================
// tests/pos-bridge-ws-protocol.test.mjs
//
// Guardián de PROTOCOLO cruzado: valida que el envelope que `sendRequest`
// produce es exactamente lo que `scale-bridge/printer-bridge.js` acepta en
// `validatePrinterRequest`. Si cualquiera de los dos lados cambia el shape
// sin coordinar con el otro, este test falla *antes* de que llegue a
// producción.
//
// No abre sockets reales: evalúa el cuerpo del método privado
// `sendRequest` del cliente WS igual que los otros tests estáticos y
// pasa la salida directamente al validador del bridge.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const wsSource = join(here, "..", "src", "lib", "pos-bridge-ws.ts");
const printerBridgePath = join(here, "..", "..", "scale-bridge", "printer-bridge.js");

async function read(path) {
  return readFile(path, "utf8");
}

// Harness compartido para extraer el cuerpo de `sendRequest` como función
// evaluable sin pasar por el tsc.
async function buildSendRequestRunner() {
  const src = await read(wsSource);
  const start = src.indexOf("private sendRequest(");
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
  const bodyRaw = src.slice(openBrace + 1, end);
  const body = bodyRaw
    .replace(/new Promise<[^>]+>/g, "new Promise")
    .replace(/const (\w+)\s*:\s*[A-Za-z_][\w.<>|&\s[\]]*?\s*=/g, "const $1 =")
    .replace(/\bthis\./g, "instance.");
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFn(
    "instance", "action", "payload", "WebSocket", "DIRECT_PRINT_UNAVAILABLE",
    body,
  );
}

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
}

function makeInstance(id = "pos-cross-1") {
  const ws = new MockWebSocket();
  return {
    ws,
    isConnected: () => true,
    nextRequestId: () => id,
    timeoutMs: 1000,
    pending: new Map(),
  };
}

test("protocolo: validatePrinterRequest ACEPTA lo que sendRequest envía (print)", async () => {
  const { validatePrinterRequest } = require(printerBridgePath);
  const run = await buildSendRequestRunner();
  const instance = makeInstance("pos-cross-print");
  // Fire and forget — el timeout no importa para este guardián.
  run(instance, "print", { type: "thermal-receipt", ticketText: "HOLA" }, MockWebSocket, "DIRECT_PRINT_UNAVAILABLE")
    .catch(() => {});
  assert.equal(instance.ws.sent.length, 1);
  const parsed = JSON.parse(instance.ws.sent[0]);

  // El wire envelope exacto.
  assert.equal(parsed.type, "printer.request");
  assert.equal(parsed.action, "print");
  assert.equal(parsed.requestId, "pos-cross-print");

  // Y el bridge lo valida sin tocar strings.
  const r = validatePrinterRequest(parsed);
  assert.equal(r.ok, true,
    `validatePrinterRequest debe aceptar el envelope canónico de sendRequest. Rechazó: ${r.message || "(sin mensaje)"}`);
  assert.equal(r.request.action, "print");
  assert.equal(r.request.requestId, "pos-cross-print");
  assert.deepEqual(r.request.payload, { type: "thermal-receipt", ticketText: "HOLA" });
});

test("protocolo: validatePrinterRequest ACEPTA lo que sendRequest envía (printTestPage)", async () => {
  const { validatePrinterRequest } = require(printerBridgePath);
  const run = await buildSendRequestRunner();
  const instance = makeInstance("pos-cross-test");
  run(instance, "printTestPage", { target: "receipt", config: {} }, MockWebSocket, "DIRECT_PRINT_UNAVAILABLE")
    .catch(() => {});
  const parsed = JSON.parse(instance.ws.sent[0]);
  const r = validatePrinterRequest(parsed);
  assert.equal(r.ok, true);
  assert.equal(r.request.action, "printTestPage");
});

test("protocolo: validatePrinterRequest ACEPTA lo que sendRequest envía (kickDrawer)", async () => {
  const { validatePrinterRequest } = require(printerBridgePath);
  const run = await buildSendRequestRunner();
  const instance = makeInstance("pos-cross-kick");
  run(instance, "kickDrawer", { command: "\\x1B\\x70\\x00\\x19\\xFA", connection: {} }, MockWebSocket, "DIRECT_PRINT_UNAVAILABLE")
    .catch(() => {});
  const parsed = JSON.parse(instance.ws.sent[0]);
  const r = validatePrinterRequest(parsed);
  assert.equal(r.ok, true);
  assert.equal(r.request.action, "kickDrawer");
});

test("protocolo: validatePrinterRequest RECHAZA el envelope viejo type:'pos.print' (regresión)", async () => {
  // Guardián de regresión: si alguien reintroduce el shape incompatible
  // `{type:"pos.print", ...}` el bridge lo rechazaría con INVALID_REQUEST.
  // El test documenta y protege contra ese drift silencioso.
  const { validatePrinterRequest } = require(printerBridgePath);
  const legacy = { type: "pos.print", requestId: "x", payload: {} };
  const r = validatePrinterRequest(legacy);
  assert.equal(r.ok, false);
  assert.equal(r.code, "INVALID_REQUEST");
});

test("protocolo: handleIncoming resuelve `printer.response` con ok:true leyendo `result`", async () => {
  // Validación del lado inverso: la respuesta que el bridge envía la
  // resuelve correctamente el cliente. Verificamos extrayendo
  // handleIncoming del fuente igual que con sendRequest.
  const src = await read(wsSource);
  const start = src.indexOf("private handleIncoming(");
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
  const bodyRaw = src.slice(openBrace + 1, end);
  const body = bodyRaw
    .replace(/let msg: unknown;/g, "let msg;")
    .replace(/const obj = msg as Record<string, unknown>;/g, "const obj = msg;")
    .replace(/const requestId = typeof obj\.requestId === "string" \? obj\.requestId : null;/g,
      'const requestId = typeof obj.requestId === "string" ? obj.requestId : null;')
    .replace(/const (\w+)\s*:\s*[A-Za-z_][\w.<>|&\s[\]]*?\s*=/g, "const $1 =")
    .replace(/\bthis\./g, "instance.");
  const Fn = Function;
  const handle = new Fn("instance", "event", body);

  // Caso 1: ok:true con `result` payload.
  let resolved = null;
  const pending = new Map();
  pending.set("r-ok", {
    resolve: (v) => { resolved = v; },
    reject: (e) => { throw e; },
    timer: setTimeout(() => {}, 10_000),
    action: "print",
  });
  const instance = { pending };
  handle(instance, {
    data: JSON.stringify({
      type: "printer.response",
      requestId: "r-ok",
      ok: true,
      result: { transport: "tcp", bytes: 42, kind: "receipt" },
    }),
  });
  assert.deepEqual(resolved, { transport: "tcp", bytes: 42, kind: "receipt" },
    "handleIncoming debe resolver con el `result` del bridge, no con el envelope entero.");
  assert.equal(pending.size, 0,
    "La entrada en `pending` debe limpiarse tras la respuesta exitosa.");
});

test("protocolo: handleIncoming rechaza `printer.response` con ok:false y prefija el errorCode", async () => {
  const src = await read(wsSource);
  const start = src.indexOf("private handleIncoming(");
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
  const bodyRaw = src.slice(openBrace + 1, end);
  const body = bodyRaw
    .replace(/let msg: unknown;/g, "let msg;")
    .replace(/const obj = msg as Record<string, unknown>;/g, "const obj = msg;")
    .replace(/const (\w+)\s*:\s*[A-Za-z_][\w.<>|&\s[\]]*?\s*=/g, "const $1 =")
    .replace(/\bthis\./g, "instance.");
  const Fn = Function;
  const handle = new Fn("instance", "event", body);

  let rejectedWith = null;
  const pending = new Map();
  pending.set("r-fail", {
    resolve: () => { throw new Error("no debía resolver"); },
    reject: (e) => { rejectedWith = e; },
    timer: setTimeout(() => {}, 10_000),
    action: "print",
  });
  const instance = { pending };
  handle(instance, {
    data: JSON.stringify({
      type: "printer.response",
      requestId: "r-fail",
      ok: false,
      error: "10.0.0.5:9100 no respondió en 7000ms",
      errorCode: "TCP_TIMEOUT",
    }),
  });
  assert.ok(rejectedWith instanceof Error);
  // El mensaje debe arrancar con el errorCode canónico del bridge para
  // que `thermal-ticket.printThermalTicketDirect` matchee prefijo sin
  // perder el detalle humano. Nunca cae silencioso al iframe.
  assert.match(rejectedWith.message, /^TCP_TIMEOUT: 10\.0\.0\.5:9100 no respondió en 7000ms$/,
    "El reject debe conservar el errorCode como prefijo y el mensaje del bridge intacto.");
});
