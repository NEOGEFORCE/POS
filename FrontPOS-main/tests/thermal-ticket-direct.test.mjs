import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const thermalTicket = join(here, "..", "src", "lib", "thermal-ticket.ts");
const posBridge = join(here, "..", "src", "lib", "pos-bridge.ts");

// =============================================================================
// R2/R4 — Impresión directa por bridge sin diálogo.
//
// El sprint exige:
//   - "Modo directo sin diálogo únicamente cuando window.posBridge soporta
//     impresión, sin fingir que el navegador puede imprimir silenciosamente."
//   - "Si impresión directa está seleccionada pero no hay bridge, no abrir
//     diálogo automáticamente: mostrar error accionable."
//
// Estos tests validan por lectura estática + ejecución del helper puro
// `printThermalTicketDirect` que:
//   1. El contrato `window.posBridge` está tipado en un módulo central.
//   2. `hasPosBridgePrint()` detecta la presencia real del bridge.
//   3. `printThermalTicketDirect` rechaza con `DIRECT_PRINT_UNAVAILABLE`
//      cuando no hay bridge.
//   4. Cuando hay bridge, el payload lleva el shape convenido con el
//      bridge local (ticket, texto compuesto, connection, receipt).
//   5. Un rechazo del bridge se propaga con el mismo sentinel para que el
//      consumidor sepa diferenciar.
//   6. `printThermalTicketAuto` consulta `deliveryMode` y nunca cae al
//      iframe si el admin eligió "bridge" sin bridge disponible.
// =============================================================================

async function read(path) {
  return readFile(path, "utf8");
}

// --------------------------------------------------------------------------
// Contrato tipado
// --------------------------------------------------------------------------

test("pos-bridge: centraliza el contrato de window.posBridge en un módulo tipado", async () => {
  const src = await read(posBridge);
  assert.match(src, /export interface PosBridge/,
    "Debe exportar la interfaz PosBridge con los tres métodos opcionales.");
  for (const method of ["print?", "printTestPage?", "kickDrawer?"]) {
    assert.ok(src.includes(method),
      `La firma del bridge debe declarar \`${method}\` como opcional.`);
  }
  assert.match(src, /declare global\s*\{[\s\S]*interface Window\s*\{[\s\S]*posBridge\?:/,
    "Debe aumentar el tipo global Window con posBridge opcional.");
  assert.match(src, /export function hasPosBridgePrint\(\)/,
    "Debe exportar un helper `hasPosBridgePrint` para que todos los consumidores lo compartan.");
});

test("thermal-ticket.ts: re-exporta hasPosBridgePrint y expone printThermalTicketDirect", async () => {
  const src = await read(thermalTicket);
  assert.match(src, /from\s+["']\.\/pos-bridge["']/,
    "thermal-ticket debe importar el helper centralizado del bridge.");
  assert.match(src, /export\s*\{\s*hasPosBridgePrint\s*\}/,
    "thermal-ticket debe re-exportar hasPosBridgePrint (los consumidores importan todo desde @/lib/thermal-ticket).");
  assert.match(src, /export (?:async )?function printThermalTicketDirect\(/,
    "Debe exportar printThermalTicketDirect como función async.");
  assert.match(src, /export (?:async )?function printThermalTicketAuto\(/,
    "Debe exportar printThermalTicketAuto como orquestador estratégico.");
  assert.match(src, /export const DIRECT_PRINT_UNAVAILABLE\s*=\s*["']DIRECT_PRINT_UNAVAILABLE["']/,
    "Debe exportar el sentinel DIRECT_PRINT_UNAVAILABLE.");
});

// --------------------------------------------------------------------------
// Comportamiento ejecutable del helper (sin DOM, sin bridge disponible)
// --------------------------------------------------------------------------

// `printThermalTicketDirect` depende de `window.posBridge.print`. Como
// corremos en Node sin DOM, podemos probar la rama de "no hay bridge"
// evaluando el cuerpo real de la función con dependencias inyectadas.
//
// El helper es muy corto, así que mejor que forzar un bundler, replicamos
// la lógica declarando un stub mínimo que respete el contrato. Si la firma
// pública cambia, estos tests fallan porque dependen de los exports.

test("printThermalTicketDirect: sin bridge devuelve DIRECT_PRINT_UNAVAILABLE (contrato)", async () => {
  const src = await read(thermalTicket);
  // Encontrar el cuerpo de printThermalTicketDirect y verificar que hace
  // el guard `hasPosBridgePrint()` → throw DIRECT_PRINT_UNAVAILABLE.
  const fnStart = src.indexOf("export async function printThermalTicketDirect");
  assert.ok(fnStart > 0, "printThermalTicketDirect debe existir.");
  // Buscar el `{` que abre el cuerpo
  const bodyStart = src.indexOf("{", fnStart + "export async function printThermalTicketDirect".length);
  // Balancear llaves para delimitar el cuerpo
  let depth = 1;
  let i = bodyStart + 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
  }
  const body = src.slice(bodyStart, i);

  assert.match(body, /if\s*\(\s*!hasPosBridgePrint\(\)/,
    "El cuerpo debe comprobar hasPosBridgePrint() antes de llamar al bridge.");
  assert.match(body, /throw new Error\(DIRECT_PRINT_UNAVAILABLE\)/,
    "Sin bridge debe lanzar con el sentinel DIRECT_PRINT_UNAVAILABLE.");
  assert.match(body, /bridge\.print\(/,
    "Cuando hay bridge, debe llamar bridge.print con el payload.");
  // El rechazo del bridge se re-envuelve con el sentinel al principio.
  assert.match(body, /DIRECT_PRINT_UNAVAILABLE[^"']*\$\{detail\}/,
    "Un error del bridge debe propagarse con DIRECT_PRINT_UNAVAILABLE al principio para que el consumidor lo detecte.");
});

test("printThermalTicketDirect: payload incluye type thermal-receipt + connection + receipt", async () => {
  const src = await read(thermalTicket);
  const fnStart = src.indexOf("export async function printThermalTicketDirect");
  const next = src.indexOf("\nexport ", fnStart + 10);
  const scope = src.slice(fnStart, next > 0 ? next : fnStart + 3000);

  assert.match(scope, /type:\s*["']thermal-receipt["']/,
    "El payload debe declarar type='thermal-receipt' para que el bridge lo distinga de etiquetas o cajón.");
  assert.match(scope, /ticketText,/, "El payload debe incluir el texto monoespaciado ya compuesto.");
  assert.match(scope, /connection:\s*sanitized\.connection/,
    "El payload debe llevar la rama connection sanitizada.");
  assert.match(scope, /receipt:\s*sanitized\.receipt/,
    "El payload debe llevar la rama receipt sanitizada.");
  assert.match(scope, /widthMm:\s*pageWidthMm/,
    "El payload debe informar el ancho físico resuelto en mm.");
});

test("printThermalTicketAuto: consulta receipt.deliveryMode antes de delegar", async () => {
  const src = await read(thermalTicket);
  const fnStart = src.indexOf("export async function printThermalTicketAuto");
  assert.ok(fnStart > 0, "printThermalTicketAuto debe existir.");
  const next = src.indexOf("\n// ====", fnStart + 10);
  const scope = src.slice(fnStart, next > 0 ? next : fnStart + 2000);

  assert.match(scope, /receipt\.deliveryMode/,
    "El estratega debe consultar receipt.deliveryMode de la config persistida.");
  assert.match(scope, /RECEIPT_DELIVERY_MODES\.BRIDGE/,
    "Debe comparar contra la constante canónica para evitar strings mágicos.");
  assert.match(scope, /printThermalTicketDirect\(/,
    "La rama bridge delega al helper directo.");
  assert.match(scope, /printThermalTicket\(/,
    "La rama browser cae al helper existente (compat).");
});

// --------------------------------------------------------------------------
// Ejecutar el cuerpo real contra un bridge inyectado — guard dinámico
// --------------------------------------------------------------------------
//
// Simulamos `window.posBridge.print` y comprobamos que:
//   - El payload que recibe el bridge tiene el shape convenido.
//   - Un rechazo del bridge se re-envuelve con el sentinel al inicio.
//
// Como el helper vive dentro de un `.ts` que importa de `./printing-config.mjs`
// y de `./pos-bridge`, no podemos import() directo desde Node. En su lugar
// extraemos el cuerpo de la función y lo evaluamos con dependencias stubs
// inyectadas, igual que hace `thermal-ticket-sharing.test.mjs` para el
// helper de Telegram.

test("printThermalTicketDirect: cuando hay bridge, lo invoca con el payload esperado", async () => {
  const src = await read(thermalTicket);
  const fnStart = src.indexOf("export async function printThermalTicketDirect");
  assert.ok(fnStart > 0);

  // Delimitar el cuerpo (igual que en el guardián de Telegram)
  let parenDepth = 0;
  let angleDepth = 0;
  let openBrace = -1;
  for (let i = fnStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === "<" && parenDepth === 0) angleDepth++;
    else if (ch === ">" && parenDepth === 0 && angleDepth > 0) angleDepth--;
    else if (ch === "{" && parenDepth === 0 && angleDepth === 0) { openBrace = i; break; }
  }
  assert.ok(openBrace > fnStart, "No se encontró el `{` que abre el cuerpo de printThermalTicketDirect.");

  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { closeBrace = i; break; }
    }
  }
  const bodyRaw = src.slice(openBrace + 1, closeBrace);

  // El cuerpo es TypeScript: contiene anotaciones de tipo como
  // `const effectiveWidth: TicketWidth = ...` y `const payload:
  // ThermalBridgePayload = ...`. `new AsyncFunction()` no entiende TS,
  // así que las eliminamos con un replace puntual antes de evaluar.
  // Patrón: `const <ident>: <Type[.Type]> =` → `const <ident> =`.
  const body = bodyRaw.replace(/const\s+(\w+)\s*:\s*[A-Za-z_][\w.<>|&\s]*?\s*=/g, "const $1 =");

  // Capturar lo que recibe el bridge
  const seen = { payloads: [] };
  const fakeBridge = {
    print: async (payload) => {
      seen.payloads.push(payload);
      return undefined;
    },
  };
  const fakeWindow = { posBridge: fakeBridge };

  // Inyectar dependencias que el cuerpo usa como identificadores libres.
  // El cuerpo usa `window`, `hasPosBridgePrint`, `readPersistedConfig`,
  // `sanitizePrintingConfig`, `receiptWidthKey`, `resolveThermalWidthMm`,
  // `composeEffectiveOptions`, `buildTicketText`, `charsPerLine`, y el
  // sentinel `DIRECT_PRINT_UNAVAILABLE`.

  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFn(
    "data", "width", "options",
    "window", "hasPosBridgePrint", "readPersistedConfig", "sanitizePrintingConfig",
    "receiptWidthKey", "resolveThermalWidthMm", "composeEffectiveOptions",
    "buildTicketText", "charsPerLine", "DIRECT_PRINT_UNAVAILABLE",
    body,
  );

  // Config persistida mínima — shape coincide con createDefaultPrintingConfig.
  const persisted = {
    receipt: {
      paper: "58",
      widthMm: 58,
      columns: 32,
      header: {},
      footer: {},
      content: {},
      cut: "AUTO",
      deliveryMode: "bridge",
    },
    connection: { alias: "test", interface: "SYSTEM", protocol: "pdf", usb: {}, network: {}, system: {} },
    drawer: {},
    labels: {},
  };

  await run(
    {
      ticketNumber: 42,
      date: new Date("2026-01-01T12:00:00Z"),
      cashier: "DEMO",
      lines: [],
      subtotal: 0,
      total: 0,
      paymentMethod: "EFECTIVO",
    },
    undefined, // width → cae a receiptWidthKey(persisted)
    undefined, // options
    fakeWindow,
    () => true, // hasPosBridgePrint
    () => persisted, // readPersistedConfig
    (x) => x || persisted, // sanitizePrintingConfig
    () => "58mm", // receiptWidthKey
    (_, custom) => (custom || 58), // resolveThermalWidthMm
    () => ({ columns: 32, cut: "AUTO" }), // composeEffectiveOptions
    () => "TICKET MOCK TEXT", // buildTicketText
    () => 32, // charsPerLine
    "DIRECT_PRINT_UNAVAILABLE",
  );

  assert.equal(seen.payloads.length, 1, "El bridge debe recibir exactamente una llamada por ticket.");
  const payload = seen.payloads[0];
  assert.equal(payload.type, "thermal-receipt", "El payload declara type='thermal-receipt'.");
  assert.equal(payload.ticketText, "TICKET MOCK TEXT", "El payload incluye el texto monoespaciado.");
  assert.equal(payload.ticketNumber, 42, "El payload lleva el ticketNumber recibido.");
  assert.ok(payload.ticket, "El payload también adjunta el TicketData crudo por si el bridge quiere re-renderizar.");
  assert.equal(payload.width, "58mm", "El payload lleva el preset tipográfico.");
  assert.equal(payload.widthMm, 58, "El payload lleva el ancho físico resuelto en mm.");
  assert.ok(payload.connection, "El payload lleva la rama connection sanitizada.");
  assert.ok(payload.receipt, "El payload lleva la rama receipt sanitizada.");
  assert.equal(payload.cut, "AUTO", "El payload transporta el modo de corte efectivo.");
});

test("printThermalTicketDirect: un rechazo del bridge se propaga con DIRECT_PRINT_UNAVAILABLE", async () => {
  const src = await read(thermalTicket);
  const fnStart = src.indexOf("export async function printThermalTicketDirect");
  let parenDepth = 0;
  let angleDepth = 0;
  let openBrace = -1;
  for (let i = fnStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === "<" && parenDepth === 0) angleDepth++;
    else if (ch === ">" && parenDepth === 0 && angleDepth > 0) angleDepth--;
    else if (ch === "{" && parenDepth === 0 && angleDepth === 0) { openBrace = i; break; }
  }
  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { closeBrace = i; break; } }
  }
  const bodyRaw = src.slice(openBrace + 1, closeBrace);
  // Mismo stripping de anotaciones TS.
  const body = bodyRaw.replace(/const\s+(\w+)\s*:\s*[A-Za-z_][\w.<>|&\s]*?\s*=/g, "const $1 =");

  const failingBridge = {
    print: async () => { throw new Error("ESC/POS link down"); },
  };
  const fakeWindow = { posBridge: failingBridge };

  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFn(
    "data", "width", "options",
    "window", "hasPosBridgePrint", "readPersistedConfig", "sanitizePrintingConfig",
    "receiptWidthKey", "resolveThermalWidthMm", "composeEffectiveOptions",
    "buildTicketText", "charsPerLine", "DIRECT_PRINT_UNAVAILABLE",
    body,
  );

  await assert.rejects(
    () => run(
      { ticketNumber: 1, date: new Date(), cashier: "x", lines: [], subtotal: 0, total: 0, paymentMethod: "x" },
      "58mm", undefined,
      fakeWindow,
      () => true,
      () => null,
      () => ({ receipt: { paper: "58", widthMm: 58, cut: "AUTO" }, connection: {} }),
      () => "58mm",
      () => 58,
      () => ({}),
      () => "",
      () => 32,
      "DIRECT_PRINT_UNAVAILABLE",
    ),
    (err) => {
      assert.ok(err instanceof Error, "Debe lanzar Error.");
      assert.match(err.message, /^DIRECT_PRINT_UNAVAILABLE/,
        "El error debe comenzar con el sentinel para que el consumidor pueda matchear por prefijo.");
      assert.match(err.message, /ESC\/POS link down/,
        "Debe preservar el detalle original del bridge para debugging.");
      return true;
    },
  );
});
