// =============================================================================
// tests/pos-bridge-ws-list-printers.test.mjs
//
// Guardian del nuevo contrato "listPrinters" del cliente WS. Verifica
// tres capas:
//
//   1. CONTRATO ESTATICO (lectura de fuente de pos-bridge-ws.ts y
//      pos-bridge.ts): existencia del metodo `listPrinters(payload?)` en
//      la clase, inclusion opcional en la interfaz publica PosBridge y
//      helper `hasPosBridgeListPrinters()` compatible con bridges
//      nativos sin isConnected.
//
//   2. CONTRATO DINAMICO (eval de sendRequest con WebSocket mock):
//      cuando el consumidor llama `client.listPrinters({refresh:true})`,
//      el envelope `{type:"printer.request", action:"listPrinters",
//      requestId, payload:{refresh:true}}` sale al socket; el requestId
//      es unico; la respuesta `{ok:true, result:{printers:[...]}}` del
//      bridge resuelve la promesa.
//
//   3. CONTRATO DE PARSEO: `parseDetectedPrintersResult` extrae el
//      shape `{name, driver, port, status, online, isDefault}` tanto
//      cuando el bridge devuelve `{kind,printers,...}` directamente
//      como cuando el envelope viene anidado dentro de `result`.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wsSource = join(here, "..", "src", "lib", "pos-bridge-ws.ts");
const bridgeSource = join(here, "..", "src", "lib", "pos-bridge.ts");

async function read(path) { return readFile(path, "utf8"); }

// ----------------------------------------------------------------------------
// 1. Contrato estatico
// ----------------------------------------------------------------------------

test("pos-bridge.ts: interface PosBridge declara listPrinters opcional", async () => {
  const src = await read(bridgeSource);
  assert.match(
    src,
    /listPrinters\?\(payload\?: unknown\): Promise<unknown>;/,
    "Debe declararse listPrinters?(payload?: unknown): Promise<unknown> en el contrato publico.",
  );
});

test("pos-bridge.ts: helper hasPosBridgeListPrinters honra isConnected", async () => {
  const src = await read(bridgeSource);
  assert.match(
    src,
    /export function hasPosBridgeListPrinters\(\)/,
    "falta la exportacion del helper hasPosBridgeListPrinters()",
  );
  const idx = src.indexOf("export function hasPosBridgeListPrinters()");
  const slice = src.slice(idx, idx + 600);
  assert.match(
    slice,
    /typeof bridge\.listPrinters !== "function"/,
    "El helper debe comprobar que el metodo exista antes de confiar en isConnected()",
  );
  assert.match(
    slice,
    /typeof bridge\.isConnected === "function"/,
    "El helper debe honrar isConnected() cuando el bridge lo expone",
  );
});

test("pos-bridge.ts: parseDetectedPrintersResult se re-exporta desde pos-bridge-printers.mjs", async () => {
  const src = await read(bridgeSource);
  assert.match(
    src,
    /from "\.\/pos-bridge-printers\.mjs"/,
    "pos-bridge.ts debe reexportar el helper desde el modulo .mjs puro para que los tests `node --test` lo importen directo.",
  );
  assert.match(
    src,
    /parseDetectedPrintersResult/,
    "parseDetectedPrintersResult debe seguir siendo publico desde pos-bridge.ts (BC con consumidores).",
  );
});

test("pos-bridge-ws.ts: PosBridgeWsClient expone listPrinters(payload?) que delega a sendRequest", async () => {
  const src = await read(wsSource);
  assert.match(
    src,
    /listPrinters\(payload\?:\s*unknown\):\s*Promise<unknown>\s*\{\s*return this\.sendRequest\("listPrinters",\s*payload\s*\?\?\s*\{\}\);/,
    "El metodo listPrinters debe delegar en sendRequest('listPrinters', payload ?? {})",
  );
});

// ----------------------------------------------------------------------------
// 2. Contrato dinamico — sendRequest construye el envelope correcto
// ----------------------------------------------------------------------------

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  constructor() {
    this.readyState = MockWebSocket.OPEN;
    this.sent = [];
    this.onmessage = null;
  }
  send(data) { this.sent.push(data); }
}

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
  return new AsyncFn("instance", "action", "payload", "WebSocket", "DIRECT_PRINT_UNAVAILABLE", body);
}

test("listPrinters: envelope saliente {type,action,requestId,payload} coincide con el contrato del bridge", async () => {
  const run = await buildSendRequestRunner();
  const ws = new MockWebSocket();
  const pending = new Map();
  const instance = {
    ws,
    isConnected: () => true,
    nextRequestId: () => "pos-list-1",
    timeoutMs: 1000,
    pending,
  };
  const promise = run(instance, "listPrinters", { refresh: true }, MockWebSocket, "DIRECT_PRINT_UNAVAILABLE");

  assert.equal(ws.sent.length, 1, "El socket debe recibir exactamente un mensaje.");
  const parsed = JSON.parse(ws.sent[0]);
  assert.equal(parsed.type, "printer.request",
    'El wire envelope debe llevar type:"printer.request" (compat con validatePrinterRequest).');
  assert.equal(parsed.action, "listPrinters", 'La accion debe ir en "action".');
  assert.equal(parsed.requestId, "pos-list-1", "El requestId sale al socket.");
  assert.deepEqual(parsed.payload, { refresh: true },
    "payload llega sin mutaciones (incluye refresh).");

  // Resolvemos la promesa como lo haria handleIncoming al recibir
  // {type:"printer.response", requestId:"pos-list-1", ok:true, result:...}.
  const entry = pending.get("pos-list-1");
  assert.ok(entry);
  clearTimeout(entry.timer);
  entry.resolve({
    kind: "printer-list",
    platform: "win32",
    defaultName: "POS80",
    printers: [
      { name: "POS80", driver: "Generic / Text Only", port: "USB002", status: "online", online: true, isDefault: true },
    ],
  });
  pending.delete("pos-list-1");

  const result = await promise;
  assert.equal(result.kind, "printer-list");
  assert.equal(result.printers.length, 1);
  assert.equal(result.printers[0].name, "POS80");
});

test("listPrinters: respuesta del bridge con ok:false propaga error con errorCode PRINTER_LIST_FAILED", async () => {
  // Hacemos el handshake end-to-end con handleIncoming para asegurar que
  // el consumidor recibe un mensaje legible, no un objeto ok:false opaco.
  const src = await read(wsSource);
  const start = src.indexOf("private handleIncoming(");
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
    .replace(/let msg: unknown;/g, "let msg;")
    .replace(/const obj = msg as Record<string, unknown>;/g, "const obj = msg;")
    .replace(/const (\w+)\s*:\s*[A-Za-z_][\w.<>|&\s[\]]*?\s*=/g, "const $1 =")
    .replace(/\bthis\./g, "instance.");
  const Fn = Function;
  const handle = new Fn("instance", "event", body);

  let rejectedWith = null;
  const pending = new Map();
  pending.set("r-fail", {
    resolve: () => { throw new Error("no debia resolver"); },
    reject: (e) => { rejectedWith = e; },
    timer: setTimeout(() => {}, 10_000),
    action: "listPrinters",
  });
  const instance = { pending };
  handle(instance, {
    data: JSON.stringify({
      type: "printer.response",
      requestId: "r-fail",
      ok: false,
      error: "powershell devolvio exit 1",
      errorCode: "PRINTER_LIST_FAILED",
    }),
  });
  assert.ok(rejectedWith instanceof Error);
  assert.match(
    rejectedWith.message,
    /^PRINTER_LIST_FAILED: powershell devolvio exit 1$/,
    "El reject debe prefijar PRINTER_LIST_FAILED y conservar el detalle humano.",
  );
});

// ----------------------------------------------------------------------------
// 3. parseDetectedPrintersResult — importado directo del helper .mjs
// ----------------------------------------------------------------------------

import {
  parseDetectedPrintersResult,
  DETECTED_PRINTER_STATUSES,
} from "../src/lib/pos-bridge-printers.mjs";

test("parseDetectedPrintersResult: shape raiz {kind,printers,...}", () => {
  const out = parseDetectedPrintersResult({
    kind: "printer-list",
    platform: "win32",
    defaultName: "POS80",
    printers: [
      { name: "POS80", driver: "Generic / Text Only", port: "USB002", status: "online", isDefault: true, online: true },
      { name: "LASER", driver: "HP LJ", port: "192.168.1.5:9100", status: "offline" },
    ],
  });
  assert.ok(out, "debe devolver un result tipado, no null");
  assert.equal(out.kind, "printer-list");
  assert.equal(out.platform, "win32");
  assert.equal(out.defaultName, "POS80");
  assert.equal(out.printers.length, 2);
  assert.equal(out.printers[0].name, "POS80");
  assert.equal(out.printers[0].isDefault, true);
  assert.equal(out.printers[0].online, true);
  assert.equal(out.printers[1].status, "offline");
  assert.equal(out.printers[1].isDefault, false,
    "Para la segunda printer el default debe inferirse comparando con defaultName");
  assert.equal(out.printers[1].online, false,
    "status offline implica online=false cuando el bridge no lo manda explicito");
});

test("parseDetectedPrintersResult: shape anidado {result:{printers}}", () => {
  const out = parseDetectedPrintersResult({
    result: {
      printers: [{ name: "POS80", driver: "Generic", port: "USB002" }],
    },
  });
  assert.ok(out);
  assert.equal(out.printers[0].name, "POS80");
});

test("parseDetectedPrintersResult: payload invalido devuelve null (nunca lanza)", () => {
  assert.equal(parseDetectedPrintersResult(null), null);
  assert.equal(parseDetectedPrintersResult(undefined), null);
  assert.equal(parseDetectedPrintersResult("string suelto"), null);
  assert.equal(parseDetectedPrintersResult({ some: "object", without: "printers" }), null);
});

test("parseDetectedPrintersResult: status desconocido cae a 'unknown' y entry sin name se descarta", () => {
  const out = parseDetectedPrintersResult({
    printers: [
      { name: "", driver: "sin nombre" },
      { name: "   ", status: "online" },
      { name: "OK", status: "ESTADO-INVENTADO" },
    ],
  });
  assert.ok(out);
  assert.equal(out.printers.length, 1, "entries sin name se descartan");
  assert.equal(out.printers[0].name, "OK");
  assert.equal(out.printers[0].status, "unknown",
    "Un status desconocido debe caer al enum 'unknown' en vez de propagar basura");
});

test("DETECTED_PRINTER_STATUSES: expone el enum completo y es inmutable", () => {
  assert.deepEqual([...DETECTED_PRINTER_STATUSES].sort(),
    ["error", "offline", "online", "paper-out", "paused", "unknown"]);
  assert.ok(Object.isFrozen(DETECTED_PRINTER_STATUSES));
});
