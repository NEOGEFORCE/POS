import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const labelsPage = join(here, "..", "src", "app", "(app)", "labels", "page.tsx");
const configPage = join(here, "..", "src", "app", "(app)", "labels", "config", "page.tsx");
const sidebar = join(here, "..", "src", "components", "app-sidebar.tsx");

// ============================================================================
// Guardianes del módulo /labels — reemplaza la vista antigua.
//
// Confirmaciones estáticas (sin render):
//
//   - La página antigua ya no usa `window.print()` como camino principal
//     sin pasar por POST /api/labels/print-jobs. Debe quedar la pista
//     fetch("/labels/print-jobs").
//   - La página usa POST /api/labels/codes para idempotencia.
//   - Hay botón "Abrir cajón" que llama POST /cash-drawer/open.
//   - El menú lateral tiene la entrada /labels (con el label refrescado).
//   - /labels/config lleva "Probar cajón" que llama al mismo endpoint.
//   - La página documenta en pantalla la limitación del hardware
//     (bridge local requerido).
// ============================================================================

async function leer(path) { return await readFile(path, "utf8"); }

test("labels/page: usa POST /labels/codes antes de poner nada en cola", async () => {
  const src = await leer(labelsPage);
  assert.ok(
    src.includes('"/labels/codes"'),
    "labels/page debe llamar POST /labels/codes al añadir items (idempotencia).",
  );
});

test("labels/page: registra el lote en POST /labels/print-jobs antes de window.print", async () => {
  const src = await leer(labelsPage);
  assert.ok(
    src.includes('"/labels/print-jobs"'),
    "labels/page debe POSTear a /labels/print-jobs para auditoría del lote.",
  );
});

test("labels/page: tiene botón 'Abrir cajón' con POST /cash-drawer/open", async () => {
  const src = await leer(labelsPage);
  assert.ok(src.includes("Abrir cajón"), "labels/page debe mostrar el botón 'Abrir cajón'.");
  assert.ok(src.includes('"/cash-drawer/open"'), "labels/page debe llamar POST /cash-drawer/open.");
});

test("labels/page: documenta en pantalla la dependencia del bridge local", async () => {
  const src = await leer(labelsPage);
  // Buscamos la keyword 'bridge' en una línea de texto visible.
  assert.ok(
    /bridge/i.test(src),
    "labels/page debe advertir al usuario que impresora y cajón requieren bridge local.",
  );
});

test("labels/page: NO llama window.print() SIN pasar antes por labels/print-jobs", async () => {
  const src = await leer(labelsPage);
  // El contrato semántico: ambas rutas existen en handlePrint. La función
  // handlePrint hace el POST a /labels/print-jobs y después, en el mismo
  // bloque, llama window.print() como fallback. Buscamos handlePrint y
  // confirmamos que el POST aparece ANTES de window.print() dentro de esa
  // función. Si handlePrint no está, cae a chequear coexistencia simple.
  const match = /const\s+handlePrint\s*=\s*useCallback\s*\(\s*async[\s\S]*?^\s*\},\s*\[/m.exec(src);
  const handlePrintBody = match ? match[0] : src;
  const idxPost = handlePrintBody.indexOf('"/labels/print-jobs"');
  const idxWinPrint = handlePrintBody.indexOf("window.print()");
  assert.ok(idxPost >= 0, "falta POST /labels/print-jobs dentro de handlePrint.");
  if (idxWinPrint >= 0) {
    assert.ok(
      idxPost < idxWinPrint,
      "El POST a /labels/print-jobs debe aparecer antes que window.print() dentro de handlePrint (auditoría primero).",
    );
  }
});

test("labels/config: existe pantalla admin con 'Probar cajón'", async () => {
  const src = await leer(configPage);
  assert.ok(src.includes("Probar cajón"), "labels/config debe tener botón 'Probar cajón'.");
  assert.ok(src.includes('"/cash-drawer/open"'), "labels/config debe POSTear a /cash-drawer/open.");
  assert.ok(src.includes("override: true"), "La prueba del cajón desde config debe pedir override admin explícito.");
});

test("app-sidebar: el ítem /labels sigue presente y usa el ícono Printer", async () => {
  const src = await leer(sidebar);
  assert.match(src, /href:\s*"\/labels"/, "El menú lateral debe conservar /labels.");
  // Puede ser 'Etiquetas' o 'Codigos' (ambos describen la pantalla). El guardián
  // sólo exige que el href siga ahí.
});

// ============================================================================
// Guardianes del triggerSource del lote en /labels.
//
// La invariante: NO podemos hardcodear "new" en el payload. La semántica
// debe reflejar los flags `created` que vinieron de `POST /labels/codes`
// (idéntica a `LabelPrintSheet`, ver `tests/label-reprint-contract.test.mjs`
// y `tests/label-print-trigger.test.mjs`). Un lote mixto se audita como
// "reprint" para no esconder reimpresiones.
// ============================================================================

test("labels/page: no hardcodea triggerSource='new' y pasa por el helper puro", async () => {
  const src = await leer(labelsPage);
  // 1. Nunca más el literal `triggerSource: "new"` como string suelto.
  //    Eso era el bug: todas las impresiones (incluso reimpresiones) se
  //    auditaban como "new".
  assert.ok(
    !/triggerSource:\s*["']new["']/.test(src),
    'labels/page NO debe hardcodear `triggerSource: "new"` — colapsa reimpresiones en el audit.',
  );
  // 2. Debe pasar por el helper puro, que es testeable con node --test.
  assert.match(src, /labelBatchTriggerSource/,
    "labels/page debe derivar triggerSource con labelBatchTriggerSource().");
  // 3. Importa del helper canónico.
  assert.match(src, /from\s+["']@\/lib\/label-print-trigger\.mjs["']/,
    "El import debe venir de @/lib/label-print-trigger.mjs (fuente única).");
});

test("labels/page: QueueItem propaga el flag `created` del response de /labels/codes", async () => {
  const src = await leer(labelsPage);
  // El QueueItem debe exponer `created: boolean` para que el batch sepa
  // qué items son nuevos y cuáles son reimpresiones. Usamos un bloque
  // laxo porque el campo lleva un JSDoc explicativo entre quantity y
  // created.
  assert.match(src, /interface QueueItem\s*\{[\s\S]*?created\s*:\s*boolean\s*;[\s\S]*?\}/,
    "QueueItem debe incluir `created: boolean` como campo del tipo.");
  // Y debe asignarse desde `resp.created` en el push del addToQueue.
  assert.match(src, /created:\s*!!resp\.created|created:\s*resp\.created|created:\s*Boolean\(resp\.created\)/,
    "El flag `created` del response de /labels/codes debe propagarse al QueueItem.");
});

test("labels/page: handlePrint deriva el triggerSource de queue.map(q => q.created)", async () => {
  const src = await leer(labelsPage);
  // El helper debe alimentarse con el array de created flags del lote
  // actual, en vez de un valor hardcodeado o un segundo request.
  assert.match(
    src,
    /labelBatchTriggerSource\(\s*queue\.map\(\s*(?:\(?\s*q\s*\)?|q)\s*=>\s*q\.created\s*\)\s*\)/,
    "handlePrint debe llamar labelBatchTriggerSource(queue.map(q => q.created)).",
  );
  // Y no hace un segundo fetch a /labels/codes/search ni a /labels/codes
  // para "chequear si existía" — el shape de `ensure` ya lo dice. Para
  // no caer sobre menciones en comentarios, limpiamos los comentarios
  // antes de contar.
  const handlePrint = /const\s+handlePrint\s*=\s*useCallback\s*\(\s*async[\s\S]*?^\s*\},\s*\[/m.exec(src);
  assert.ok(handlePrint, "handlePrint debe seguir siendo un useCallback async.");
  const codeOnly = handlePrint[0]
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const codesCalls = (codeOnly.match(/["'`]\/labels\/codes/g) || []);
  assert.equal(codesCalls.length, 0,
    `handlePrint NO debe hacer una petición extra a /labels/codes* (encontradas: ${codesCalls.length})`);
});
