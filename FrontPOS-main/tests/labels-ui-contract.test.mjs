import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const labelsPage = join(here, "..", "src", "app", "(app)", "labels", "page.tsx");
const shelfPage = join(here, "..", "src", "app", "(app)", "labels", "shelf", "page.tsx");
const workspace = join(here, "..", "src", "app", "(app)", "labels", "components", "LabelsWorkspace.tsx");
const configPage = join(here, "..", "src", "app", "(app)", "labels", "config", "page.tsx");
const sidebar = join(here, "..", "src", "components", "app-sidebar.tsx");

// ============================================================================
// Guardianes del módulo /labels — tres entradas INDEPENDIENTES.
//
// Tras el sprint "frontend-printing-v2":
//
//   - `/labels`        → sólo impresión térmica.
//   - `/labels/shelf`  → sólo hoja de góndola Letter 2×6 (ver
//                        `labels-shelf-ui-contract.test.mjs`).
//   - `/labels/config` → admin, sin cambios de ruta.
//
// La LÓGICA compartida (catálogo, cola, scanner, idempotencia /labels/codes,
// enriquecimiento del bridge payload, apertura manual de cajón) vive en el
// workspace parametrizable `components/LabelsWorkspace.tsx`. Las dos páginas
// son wrappers de 2 líneas que seleccionan el modo.
//
// Confirmaciones estáticas (sin render):
//
//   - El workspace llama a POST /labels/codes al añadir items (idempotencia).
//   - El workspace registra el lote en POST /labels/print-jobs ANTES del
//     bridge o del window.print() (audit-first).
//   - El workspace tiene el botón "Abrir cajón" que llama POST /cash-drawer/open.
//   - El workspace documenta la limitación del hardware (bridge local).
//   - El sidebar expone las tres entradas con `exact: true` para que no
//     activen las tres a la vez cuando el pathname empieza por /labels.
//   - /labels/config lleva "Probar cajón" que llama al mismo endpoint.
// ============================================================================

async function leer(path) {
  return await readFile(path, "utf8");
}

// ---------------------------------------------------------------------------
// Páginas thin: /labels y /labels/shelf son wrappers mínimos.
// ---------------------------------------------------------------------------

test("labels/page: wrapper mínimo que renderiza <LabelsWorkspace mode='thermal' />", async () => {
  const src = await leer(labelsPage);
  assert.match(src, /from\s+["']@\/app\/\(app\)\/labels\/components\/LabelsWorkspace["']/,
    "/labels/page.tsx debe importar el workspace compartido.");
  assert.match(src, /<LabelsWorkspace\s+mode=\{?["']thermal["']\}?\s*\/?>/,
    "/labels/page.tsx debe renderizar el workspace en modo thermal.");
});

test("labels/shelf/page: wrapper mínimo que renderiza <LabelsWorkspace mode='shelf' />", async () => {
  const src = await leer(shelfPage);
  assert.match(src, /from\s+["']@\/app\/\(app\)\/labels\/components\/LabelsWorkspace["']/,
    "/labels/shelf/page.tsx debe importar el workspace compartido.");
  assert.match(src, /<LabelsWorkspace\s+mode=\{?["']shelf["']\}?\s*\/?>/,
    "/labels/shelf/page.tsx debe renderizar el workspace en modo shelf.");
});

// ---------------------------------------------------------------------------
// Workspace: lógica compartida.
// ---------------------------------------------------------------------------

test("workspace: usa POST /labels/codes antes de poner nada en cola", async () => {
  const src = await leer(workspace);
  assert.ok(
    src.includes('"/labels/codes"'),
    "El workspace debe llamar POST /labels/codes al añadir items (idempotencia).",
  );
});

test("workspace: registra el lote en POST /labels/print-jobs antes de window.print", async () => {
  const src = await leer(workspace);
  assert.ok(
    src.includes('"/labels/print-jobs"'),
    "El workspace debe POSTear a /labels/print-jobs para auditoría del lote.",
  );
});

test("workspace: ya no expone la apertura manual del cajón en la UI", async () => {
  const src = await leer(workspace);
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.ok(!/Abrir cajón/.test(codeOnly),
    "El workspace NO debe mostrar un botón visible 'Abrir cajón'.");
  assert.ok(!/handleOpenDrawer/.test(codeOnly),
    "El callback muerto `handleOpenDrawer` debe quedar eliminado.");
  assert.ok(!/caj[oó]n/i.test(codeOnly),
    "Ninguna cadena visible del workspace puede mencionar al cajón.");
});

test("workspace: documenta en pantalla la dependencia del bridge local", async () => {
  const src = await leer(workspace);
  assert.ok(/bridge/i.test(src),
    "El workspace debe advertir al usuario que impresora y cajón requieren bridge local.");
});

test("workspace: handlePrint audita primero y luego delega al bridge (térmica)", async () => {
  const src = await leer(workspace);
  const match = /const\s+handlePrint\s*=\s*useCallback\s*\(\s*async[\s\S]*?^\s*\},\s*\[/m.exec(src);
  const handlePrintBody = match ? match[0] : src;
  const idxPost = handlePrintBody.indexOf('"/labels/print-jobs"');
  const idxWinPrint = handlePrintBody.indexOf("window.print()");
  assert.ok(idxPost >= 0, "handlePrint debe POSTear a /labels/print-jobs.");
  if (idxWinPrint >= 0) {
    assert.ok(idxPost < idxWinPrint,
      "El POST debe aparecer antes que window.print() (auditoría primero).");
  }
});

// ---------------------------------------------------------------------------
// labels/config
// ---------------------------------------------------------------------------

test("labels/config: ya no expone la configuración visible del cajón", async () => {
  const src = await leer(configPage);
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.ok(!/Probar cajón/.test(codeOnly),
    "labels/config NO debe mostrar un botón visible 'Probar cajón'.");
  assert.ok(!/testDrawer\b/.test(codeOnly),
    "El callback muerto `testDrawer` debe quedar eliminado.");
  assert.ok(!/caj[oó]n/i.test(codeOnly),
    "Ninguna cadena visible de /labels/config puede mencionar al cajón.");
  assert.ok(!/"\/cash-drawer\/open"/.test(codeOnly),
    "La pantalla de configuración ya no debe disparar POST /cash-drawer/open.");
});

// ---------------------------------------------------------------------------
// Sidebar: tres entradas INDEPENDIENTES.
// ---------------------------------------------------------------------------

test("app-sidebar: expone /labels, /labels/shelf y /labels/config como entradas independientes", async () => {
  const src = await leer(sidebar);
  assert.match(src, /href:\s*"\/labels"/,
    "El menú lateral debe conservar /labels.");
  assert.match(src, /href:\s*"\/labels\/shelf"/,
    "El menú lateral debe exponer /labels/shelf.");
  assert.match(src, /href:\s*"\/labels\/config"/,
    "El menú lateral debe exponer /labels/config.");
  // Cada entrada tiene `exact: true` para evitar que las tres se activen
  // simultáneamente cuando pathname empieza por /labels.
  assert.match(
    src,
    /href:\s*"\/labels",[^}]*exact:\s*true/,
    "La entrada /labels debe marcarse con `exact: true`.",
  );
  assert.match(
    src,
    /href:\s*"\/labels\/shelf",[^}]*exact:\s*true/,
    "La entrada /labels/shelf debe marcarse con `exact: true`.",
  );
  assert.match(
    src,
    /href:\s*"\/labels\/config",[^}]*adminOnly:\s*true,?\s*exact:\s*true|href:\s*"\/labels\/config",[^}]*exact:\s*true,?\s*adminOnly:\s*true/,
    "La entrada /labels/config debe ser adminOnly y exact: true.",
  );
});

test("app-sidebar: isActive honra `exact` para no iluminar múltiples items de /labels", async () => {
  const src = await leer(sidebar);
  assert.match(src, /item\.exact\s*\?\s*pathname\s*===\s*item\.href/,
    "El sidebar debe usar pathname === item.href cuando item.exact es true.");
});

// ============================================================================
// Guardianes del triggerSource del lote.
//
// La invariante: NO podemos hardcodear "new" en el payload. La semántica
// debe reflejar los flags `created` que vinieron de `POST /labels/codes`.
// ============================================================================

test("workspace: no hardcodea triggerSource='new' y pasa por el helper puro", async () => {
  const src = await leer(workspace);
  assert.ok(
    !/triggerSource:\s*["']new["']/.test(src),
    'workspace NO debe hardcodear `triggerSource: "new"`.',
  );
  assert.match(src, /labelBatchTriggerSource/,
    "workspace debe derivar triggerSource con labelBatchTriggerSource().");
  assert.match(src, /from\s+["']@\/lib\/label-print-trigger\.mjs["']/,
    "El import debe venir de @/lib/label-print-trigger.mjs.");
});

test("workspace: QueueItem propaga el flag `created` del response de /labels/codes", async () => {
  const src = await leer(workspace);
  assert.match(src, /interface QueueItem\s*\{[\s\S]*?created\s*:\s*boolean\s*;[\s\S]*?\}/,
    "QueueItem debe incluir `created: boolean` como campo del tipo.");
  assert.match(src, /created:\s*!!resp\.created|created:\s*resp\.created|created:\s*Boolean\(resp\.created\)/,
    "El flag `created` debe propagarse al QueueItem.");
});

test("workspace: handlePrint deriva el triggerSource de queue.map(q => q.created)", async () => {
  const src = await leer(workspace);
  assert.match(
    src,
    /labelBatchTriggerSource\(\s*queue\.map\(\s*\(?\s*q\s*\)?\s*=>\s*q\.created\s*\)\s*\)/,
    "handlePrint debe llamar labelBatchTriggerSource(queue.map(q => q.created)).",
  );
});

// ============================================================================
// Thermal only — hoja góndola queda 100% separada en /labels/shelf.
// (los guardianes de góndola viven en labels-shelf-ui-contract.test.mjs)
// ============================================================================

test("workspace: conserva impresión térmica y el handler de góndola, discriminados por `mode`", async () => {
  const src = await leer(workspace);
  assert.match(src, /data-testid="labels-thermal-print-btn"/,
    "El botón térmico debe seguir disponible.");
  assert.match(src, /data-testid="labels-shelf-print-btn"/,
    "El botón de góndola debe seguir disponible (en modo shelf).");
  assert.match(src, /mode === "thermal"/,
    "El workspace debe discriminar visualmente por mode === 'thermal'.");
  assert.match(src, /mode === "shelf"/,
    "El workspace debe discriminar visualmente por mode === 'shelf'.");
  assert.match(src, /w\.posBridge\?\.print/,
    "La ruta térmica debe conservar el bridge local.");
  assert.match(src, /loadPrintingConfig\(\)/,
    "La ruta térmica debe conservar su configuración persistida.");
});
