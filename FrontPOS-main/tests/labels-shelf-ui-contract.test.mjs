import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shelfPage = join(here, "..", "src", "app", "(app)", "labels", "shelf", "page.tsx");
const workspace = join(here, "..", "src", "app", "(app)", "labels", "components", "LabelsWorkspace.tsx");
const shelfHelper = join(here, "..", "src", "lib", "shelf-labels.mjs");
const shelfPreview = join(here, "..", "src", "app", "(app)", "labels", "components", "ShelfLabelsPreview.tsx");
const configPage = join(here, "..", "src", "app", "(app)", "labels", "config", "page.tsx");
const printingConfig = join(here, "..", "src", "lib", "printing-config.mjs");

// ============================================================================
// Guardianes de /labels/shelf — hoja de góndola 80×40 mm, landscape.
//
// Formato activo (Carta / Oficio) lo decide la config persistida
// `pos_printing_config_v1 → gondola.format`. La geometría física por
// formato (Letter 3×5=15 · Legal 4×5=20) vive en el helper puro
// `shelf-labels.mjs` y nunca se duplica fuera. El workspace comparte queue
// y scanner con /labels (térmica), pero el handler de impresión
// `handlePrintShelfSheet` sólo se activa cuando `mode === "shelf"` y usa
// EXCLUSIVAMENTE el diálogo del navegador (iframe aislado) — nunca el
// bridge térmico.
// ============================================================================

async function read(path) {
  return await readFile(path, "utf8");
}

function functionRegion(src, name, nextName) {
  const start = src.indexOf(`const ${name} = useCallback`);
  assert.ok(start >= 0, `No se encontró ${name}.`);
  // Buscamos primero otro useCallback del nombre pedido; si no existe
  // (p.ej. porque ese callback fue retirado) caemos a marcadores
  // estructurales conocidos para no estirar la región hasta el final
  // del archivo (que arrastraría el <style dangerouslySetInnerHTML> del
  // render y daría falsos positivos).
  const candidates = [];
  if (nextName) {
    candidates.push(src.indexOf(`const ${nextName} = useCallback`, start + 1));
  }
  candidates.push(src.indexOf("// Renderizado", start + 1));
  candidates.push(src.indexOf("const headerTitle", start + 1));
  candidates.push(src.indexOf("return (", start + 1));
  const end = candidates.filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
  return src.slice(start, end >= 0 ? end : undefined);
}

test("labels/shelf/page.tsx: existe y es un wrapper que selecciona mode='shelf'", async () => {
  const src = await read(shelfPage);
  assert.match(src, /LabelsWorkspace/,
    "El page debe importar y renderizar el workspace compartido.");
  assert.match(src, /mode=\{?["']shelf["']\}?/,
    "El page debe pasar mode='shelf'.");
});

test("workspace: expone handlePrintShelfSheet, handlePrintShelfSheetSheet y handlePrintShelfSheetThermal", async () => {
  const src = await read(workspace);
  assert.match(src, /const handlePrintShelfSheet = useCallback/,
    "Dispatcher principal: `handlePrintShelfSheet` como useCallback.");
  assert.match(src, /const handlePrintShelfSheetSheet = useCallback/,
    "Rama LETTER/LEGAL: `handlePrintShelfSheetSheet` como useCallback dedicado.");
  assert.match(src, /const handlePrintShelfSheetThermal = useCallback/,
    "Rama THERMAL_80: `handlePrintShelfSheetThermal` como useCallback dedicado.");
  assert.match(src, /data-testid="labels-shelf-print-btn"/,
    "El botón del header debe conservar su test-id.");
});

test("workspace (LETTER/LEGAL): registra sizeTemplateId null y layout antes de imprimir", async () => {
  const src = await read(workspace);
  // El guardián se acota a handlePrintShelfSheetSheet (LETTER/LEGAL).
  const region = functionRegion(src, "handlePrintShelfSheetSheet", "handlePrintShelfSheetThermal");
  assert.match(region, /sizeTemplateId:\s*null/,
    "Góndola Carta/Oficio no debe proyectarse como plantilla térmica de /labels/sizes.");
  assert.match(region, /meta:\s*buildAuditMeta\s*\(/,
    "La metadata debe pasar por buildAuditMeta (fija el layout canónico).");
  const audit = region.indexOf('await apiFetch("/labels/print-jobs"');
  const iframe = region.indexOf('document.createElement("iframe")');
  const print = region.indexOf("iframe.contentWindow?.print()");
  assert.ok(audit >= 0 && iframe > audit && print > iframe,
    "Orden obligatorio en Carta/Oficio: auditar → crear documento aislado → imprimir.");
});

test("workspace (LETTER/LEGAL): pasa el formato activo a buildAuditMeta y buildShelfLabelsPrintHtml", async () => {
  const src = await read(workspace);
  const region = functionRegion(src, "handlePrintShelfSheetSheet", "handlePrintShelfSheetThermal");
  // Auditoría: buildAuditMeta recibe el formato como segundo argumento.
  assert.match(region, /buildAuditMeta\([\s\S]*?,\s*gondolaFormat\s*,?\s*\)/,
    "buildAuditMeta debe recibir gondolaFormat como segundo argumento.");
  // Print HTML: buildShelfLabelsPrintHtml recibe `{ now, format }`.
  assert.match(region, /buildShelfLabelsPrintHtml\(items,[\s\S]*?format:\s*gondolaFormat/,
    "buildShelfLabelsPrintHtml debe recibir format: gondolaFormat.");
});

test("workspace (LETTER/LEGAL): usa SIEMPRE el diálogo del navegador (iframe.print), nunca el bridge térmico", async () => {
  const src = await read(workspace);
  const region = functionRegion(src, "handlePrintShelfSheetSheet", "handlePrintShelfSheetThermal");
  assert.match(region, /buildShelfLabelsPrintHtml\(items/,
    "Debe construir HTML con el helper puro que escapa contenido.");
  assert.match(region, /document\.createElement\("iframe"\)/,
    "Debe crear un iframe aislado.");
  assert.match(region, /doc\.open\(\)[\s\S]*doc\.write\(html\)[\s\S]*doc\.close\(\)/,
    "El documento aislado debe escribirse y cerrarse explícitamente.");
  const codeOnly = region
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(codeOnly, /dangerouslySetInnerHTML/,
    "El camino de Carta/Oficio no debe usar dangerouslySetInnerHTML.");
  assert.doesNotMatch(codeOnly, /window\.print\(\)/,
    "Carta/Oficio debe imprimir el iframe, no el documento térmico de la app.");
  // Y NO debe invocar al bridge térmico en la rama LETTER/LEGAL.
  assert.doesNotMatch(codeOnly, /posBridge\?\.print\(|posBridge\.print\(/,
    "Carta/Oficio nunca envía al bridge: siempre iframe + diálogo del navegador.");
  assert.doesNotMatch(codeOnly, /kickDrawer/,
    "Carta/Oficio nunca abre el cajón al imprimir.");
});

test("workspace (LETTER/LEGAL): limpieza opcional ocurre sólo tras iframe.print", async () => {
  const src = await read(workspace);
  const region = functionRegion(src, "handlePrintShelfSheetSheet", "handlePrintShelfSheetThermal");
  const cleanupMatch = /const cleanup = \(\) => \{([\s\S]*?)\n\s*\};/.exec(region);
  assert.ok(cleanupMatch, "Falta cleanup posterior al diálogo de impresión.");
  assert.match(cleanupMatch[1], /if \(clearQueueOnPrintClose\)[\s\S]*setQueue\(\[\]\)/,
    "La cola sólo se vacía cuando el checkbox está activo.");
  const fireMatch = /const fire = \(\) => \{([\s\S]*?)\n\s*\};/.exec(region);
  assert.ok(fireMatch, "Falta fire() del iframe.");
  const fire = fireMatch[1];
  const print = fire.indexOf("iframe.contentWindow?.print()");
  const scheduledCleanup = fire.indexOf("setTimeout(cleanup", print);
  assert.ok(print >= 0 && scheduledCleanup > print,
    "cleanup debe programarse después de invocar iframe.print().");
  const beforeFire = region.slice(0, region.indexOf("const fire"));
  const cleanupDefinitionStart = beforeFire.indexOf("const cleanup");
  const outsideCleanup = cleanupDefinitionStart >= 0
    ? beforeFire.slice(0, cleanupDefinitionStart)
    : beforeFire;
  assert.doesNotMatch(outsideCleanup, /setQueue\(\[\]\)/,
    "No puede vaciarse la cola antes del print.");
});

test("workspace: muestra checkbox, contador exacto y páginas totales en modo shelf", async () => {
  const src = await read(workspace);
  assert.match(src, /Limpiar cola al cerrar impresión/,
    "Debe mostrar el checkbox solicitado.");
  // Formato LETTER/LEGAL: "X etiquetas en cola (Y páginas completas + Z sobrantes)".
  assert.match(
    src,
    /shelfSummary\.totalLabels\} etiquetas en cola \(\$\{shelfSummary\.fullPages\} páginas completas \+ \$\{shelfSummary\.remainder\} sobrantes\)/,
    "El contador debe expresar total, páginas completas y sobrantes exactos para Carta/Oficio.",
  );
  // Formato THERMAL_80: "X etiquetas (una por producto)" — texto distinto.
  assert.match(
    src,
    /shelfSummary\.totalLabels\} etiquetas \(una por producto\)/,
    "El contador de THERMAL_80 debe decir 'una por producto'.",
  );
  // Chip del total de páginas Carta/Oficio.
  assert.match(src, /shelfSummary\.totalPages\} página\(s\)/,
    "Debe mostrar el total de páginas para Carta/Oficio.");
  // Chip del total de etiquetas en THERMAL_80.
  assert.match(src, /shelfSummary\.totalPages\} etiqueta\(s\)/,
    "El Chip de THERMAL_80 debe decir 'etiqueta(s)' en vez de 'página(s)'.");
});

test("workspace: hidrata el formato de góndola desde la config persistida", async () => {
  const src = await read(workspace);
  assert.match(src, /loadPrintingConfig\(\)/,
    "El workspace debe cargar la config persistida al montar.");
  assert.match(src, /useState<GondolaFormat>\("LETTER"\)/,
    "Debe mantener un estado tipado del formato con default LETTER.");
  assert.match(src, /resolveGondolaLayout\(gondolaFormat\)/,
    "Debe calcular la geometría a partir del formato activo.");
  assert.match(src, /summarizeShelfLabels\([\s\S]*?,\s*gondolaFormat\s*,?\s*\)/,
    "El resumen contable debe recibir el formato activo.");
  // Y debe propagarlo al preview visible.
  assert.match(src, /ShelfLabelsPreview[\s\S]*format=\{gondolaFormat\}/,
    "El preview visible debe recibir el formato activo.");
});

test("workspace (LETTER/LEGAL): 100% separada del térmico — handlePrintShelfSheetSheet NO toca labelItems", async () => {
  const src = await read(workspace);
  const region = functionRegion(src, "handlePrintShelfSheetSheet", "handlePrintShelfSheetThermal");
  assert.ok(!/labelItems/.test(region),
    "La hoja góndola (Carta/Oficio) NO debe compartir el shape labelItems del térmico de recibos.");
  assert.match(region, /buildShelfLabelsPrintHtml/,
    "La hoja góndola (Carta/Oficio) debe seguir usando buildShelfLabelsPrintHtml (iframe aislado).");
  assert.match(region, /buildAuditMeta/,
    "La hoja góndola (Carta/Oficio) debe seguir pasando buildAuditMeta al POST.");
});

// ----------------------------------------------------------------------------
// Nuevos guardianes de la rama THERMAL_80 — bridge directo, sin iframe.
// ----------------------------------------------------------------------------

test("workspace (THERMAL_80): handlePrintShelfSheetThermal usa bridge directo, nunca iframe ni window.print", async () => {
  const src = await read(workspace);
  const region = functionRegion(src, "handlePrintShelfSheetThermal", "handlePrintShelfSheet");
  // Debe llamar al bridge con type "shelf-labels".
  assert.match(region, /posBridge\?\.print|posBridge\.print/,
    "THERMAL_80 debe invocar al bridge.");
  // El payload wire se construye con el helper puro (que fuerza el type correcto).
  assert.match(region, /buildShelfLabelsBridgePayload\(/,
    "THERMAL_80 debe armar el payload con buildShelfLabelsBridgePayload.");
  // Prohibido: iframe, window.print, dangerouslySetInnerHTML, kickDrawer.
  const codeOnly = region
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(codeOnly, /document\.createElement\(["']iframe["']\)/,
    "THERMAL_80 nunca crea iframe — es ruta bridge pura.");
  assert.doesNotMatch(codeOnly, /window\.print\(\)/,
    "THERMAL_80 nunca llama a window.print() del documento principal.");
  assert.doesNotMatch(codeOnly, /dangerouslySetInnerHTML/,
    "THERMAL_80 no inyecta HTML directo.");
  assert.doesNotMatch(codeOnly, /kickDrawer/,
    "THERMAL_80 nunca abre el cajón.");
});

test("workspace (THERMAL_80): AUDIT-FIRST antes de llamar al bridge", async () => {
  const src = await read(workspace);
  const region = functionRegion(src, "handlePrintShelfSheetThermal", "handlePrintShelfSheet");
  const audit = region.indexOf('await apiFetch("/labels/print-jobs"');
  const bridge = region.search(/w\.posBridge\?\.print|posBridge\.print/);
  assert.ok(audit > 0, "THERMAL_80 debe auditar en /labels/print-jobs.");
  assert.ok(bridge > audit,
    "La llamada al bridge debe ocurrir DESPUÉS de la auditoría (audit-first).");
});

test("workspace (THERMAL_80): pasa 'THERMAL_80' a buildAuditMeta — layout canónico garantizado", async () => {
  const src = await read(workspace);
  const region = functionRegion(src, "handlePrintShelfSheetThermal", "handlePrintShelfSheet");
  assert.match(region, /buildAuditMeta\([\s\S]*?,\s*["']THERMAL_80["']\s*,?\s*\)/,
    "buildAuditMeta debe recibir 'THERMAL_80' como segundo argumento para producir el layout 'gondola-shelf-thermal-80x40'.");
});

test("workspace (THERMAL_80): sin bridge o rechazo → NO limpia la cola", async () => {
  const src = await read(workspace);
  const region = functionRegion(src, "handlePrintShelfSheetThermal", "handlePrintShelfSheet");
  // Buscamos las dos ramas de fallo: (1) sin bridge y (2) bridge rechaza.
  // La primera debe emitir un toast y `return;` sin tocar storage ni queue.
  // La segunda igual: después del catch, `return;` sin limpieza.
  assert.ok(/typeof\s+w\.posBridge\?\.print\s*!==\s*["']function["']/.test(region),
    "THERMAL_80 debe comprobar la disponibilidad del bridge antes de llamar.");
  // En ambos fallbacks: `return;` sale sin tocar setQueue ni removePersistentEntry.
  // La limpieza (removePersistentEntry / setQueue) debe ocurrir SÓLO tras un await exitoso.
  const bridgeCall = region.indexOf("w.posBridge.print(bridgePayload)");
  const removeIdx = region.indexOf("removePersistentEntry");
  assert.ok(bridgeCall > 0 && removeIdx > bridgeCall,
    "removePersistentEntry sólo ocurre DESPUÉS de la llamada al bridge (en el bloque de éxito).");
});

test("workspace (THERMAL_80): payload del bridge NUNCA incluye openDrawerOnSale:true ni kickDrawer", async () => {
  const src = await read(workspace);
  const region = functionRegion(src, "handlePrintShelfSheetThermal", "handlePrintShelfSheet");
  const codeOnly = region
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(codeOnly, /openDrawerOnSale\s*:\s*true/,
    "THERMAL_80 nunca puede proponer `openDrawerOnSale: true` en su payload.");
  assert.doesNotMatch(codeOnly, /type\s*:\s*["']kickDrawer["']/,
    "THERMAL_80 nunca emite un payload con type 'kickDrawer'.");
});

// ============================================================================
// Helpers inmutables de góndola — formato DEFAULT LETTER landscape 3×5.
// ============================================================================

test("shelf-labels helper: expone GONDOLA_FORMATS + resolveGondolaLayout + default LETTER landscape", async () => {
  const src = await read(shelfHelper);
  assert.match(src, /export const GONDOLA_FORMATS\s*=/,
    "Debe exportar el enum de formatos.");
  assert.match(src, /export const GONDOLA_FORMAT_SPECS\s*=/,
    "Debe exportar la spec de cada formato.");
  assert.match(src, /export function resolveGondolaLayout\(/,
    "Debe exportar resolveGondolaLayout.");
  assert.match(src, /LABEL_WIDTH_MM\s*=\s*80/);
  assert.match(src, /LABEL_HEIGHT_MM\s*=\s*40/);
  // El DEFAULT es Letter landscape 3×5=15.
  assert.match(src, /sheetWidthMm:\s*279\.4/, "Letter landscape width");
  assert.match(src, /sheetHeightMm:\s*215\.9/, "Letter landscape height");
  assert.match(src, /layoutMetaId:\s*"gondola-80x40-letter-landscape-3x5"/);
  assert.match(src, /cssPageSize:\s*"Letter landscape"/);
  // Y Legal landscape 4×5=20.
  assert.match(src, /sheetWidthMm:\s*355\.6/, "Legal landscape width");
  assert.match(src, /layoutMetaId:\s*"gondola-80x40-legal-landscape-4x5"/);
  assert.match(src, /cssPageSize:\s*"Legal landscape"/);
});

test("shelf-labels helper: @page landscape + margin 0 + sin gap + borde dashed tenue", async () => {
  const src = await read(shelfHelper);
  assert.match(src, /size:\s*\$\{layout\.cssPageSize\}/,
    "El @page debe tomar el tamaño del layout resuelto, no un literal fijo.");
  assert.match(src, /margin:\s*0/);
  assert.match(src, /gap:\s*0/);
  assert.match(src, /border:\s*0\.2mm dashed #c4c4c4/);
});

test("shelf-labels helper: paginate/summarize/buildAuditMeta aceptan formato y producen capacidad dinámica", async () => {
  const src = await read(shelfHelper);
  assert.match(src, /export function paginateSlots\(slots,\s*format\)/,
    "paginateSlots debe recibir el formato como segundo argumento.");
  assert.match(src, /export function summarizeShelfLabels\(items,\s*format\)/,
    "summarizeShelfLabels debe recibir el formato.");
  assert.match(src, /export function buildAuditMeta\(extra,\s*format\)/,
    "buildAuditMeta debe recibir el formato.");
  assert.match(src, /layout:\s*layout\.layoutMetaId/,
    "El layout canónico se deriva de la spec, no de un literal.");
});

test("shelf-labels helper: mantiene relleno con null hasta labelsPerPage y escapa toda interpolación", async () => {
  const src = await read(shelfHelper);
  assert.match(src, /while \(chunk\.length < layout\.labelsPerPage\) chunk\.push\(null\)/,
    "La última página debe rellenarse con null hasta llenar los slots del formato.");
  assert.match(src, /const name = escapeHtml\(/);
  assert.match(src, /const price = escapeHtml\(/);
  assert.match(src, /const footerLeft = escapeHtml\(/);
  assert.match(src, /const footerRight = escapeHtml\(/);
  assert.match(src, /-webkit-line-clamp:\s*2/,
    "El nombre debe limitarse a dos líneas.");
});

test("ShelfLabelsPreview: pagina con el helper canónico, acepta `format`, pinta blanks", async () => {
  const src = await read(shelfPreview);
  assert.match(src, /expandItemsToSlots\(items\)/);
  assert.match(src, /paginateSlots\(slots,\s*layout\.format\)/);
  assert.match(src, /resolveGondolaLayout\(format\)/);
  assert.match(src, /format\?:\s*GondolaFormat/,
    "El preview debe aceptar el formato activo como prop tipada.");
  assert.match(src, /if \(!slot\)[\s\S]*aria-hidden="true"/,
    "Los blanks deben conservar su celda/guía sin contenido accesible.");
});

// ============================================================================
// printing-config: rama `gondola` tipada + sanitize + preset.
// ============================================================================

test("printing-config: default `gondola.format` es LETTER (Carta)", async () => {
  const src = await read(printingConfig);
  assert.match(src, /export const GONDOLA_FORMATS\s*=\s*Object\.freeze\(\{/,
    "Debe existir el enum de formatos.");
  assert.match(src, /LETTER:\s*"LETTER"/);
  assert.match(src, /LEGAL:\s*"LEGAL"/);
  assert.match(src, /DEFAULT_GONDOLA_FORMAT\s*=\s*GONDOLA_FORMATS\.LETTER/,
    "El default debe ser Carta/Letter.");
  assert.match(src, /gondola:\s*\{[\s\S]*?format:\s*DEFAULT_GONDOLA_FORMAT/,
    "createDefaultPrintingConfig debe exponer la rama gondola con el default.");
});

test("printing-config: sanitize valida gondola.format y cae a LETTER en basura", async () => {
  const src = await read(printingConfig);
  const sanitizeIdx = src.indexOf("export function sanitizePrintingConfig(");
  assert.ok(sanitizeIdx > 0);
  const scope = src.slice(sanitizeIdx);
  assert.match(scope, /gondola:\s*\{[\s\S]*?format:/,
    "La rama gondola debe estar en el objeto sanitizado.");
  assert.match(scope, /GONDOLA_FORMATS\.LETTER/,
    "El sanitize debe comparar explícitamente contra LETTER.");
  assert.match(scope, /GONDOLA_FORMATS\.LEGAL/,
    "El sanitize debe comparar explícitamente contra LEGAL.");
});

test("printing-config: applyGondolaFormatPreset es exportado y toca sólo la rama gondola", async () => {
  const src = await read(printingConfig);
  assert.match(src, /export function applyGondolaFormatPreset\(config,\s*format\)/,
    "Debe exportar un preset mutator idempotente.");
  // No debe tocar connection ni receipt ni labels ni drawer.
  const fnIdx = src.indexOf("export function applyGondolaFormatPreset(");
  const fnEnd = src.indexOf("\n// -----", fnIdx + 20);
  const body = src.slice(fnIdx, fnEnd > 0 ? fnEnd : fnIdx + 1200);
  for (const branch of ["connection", "receipt.widthMm", "labels.widthMm", "drawer.enabled"]) {
    assert.doesNotMatch(body, new RegExp(`base\\.${branch.replace(".", "\\.")}\\s*=`),
      `El preset no debe mutar la rama ${branch}.`);
  }
});

// ============================================================================
// /labels/config: nueva tab Góndola con selector persistido.
// ============================================================================

test("labels/config: expone la tab Góndola con test-id del selector", async () => {
  const src = await read(configPage);
  assert.match(src, /<Tab key="gondola" title="Góndola"/,
    "Debe existir la tab 'Góndola'.");
  assert.match(src, /data-testid="labels-config-gondola-format-group"/,
    "El selector del formato debe ser accesible por test-id.");
  // El test-id de cada opción se arma con `${opt.key.toLowerCase()}` → el
  // guardián busca el patrón que entrega template literal + enum LETTER/LEGAL.
  assert.match(
    src,
    /data-testid=\{`labels-config-gondola-format-\$\{opt\.key\.toLowerCase\(\)\}`\}/,
    "Debe armar un test-id por formato (letter/legal) desde el enum.",
  );
  assert.match(src, /key:\s*GONDOLA_FORMATS\.LETTER/,
    "Debe existir la opción Carta.");
  assert.match(src, /key:\s*GONDOLA_FORMATS\.LEGAL/,
    "Debe existir la opción Oficio/Legal.");
});

test("labels/config: el selector usa applyGondolaFormatPreset del helper puro", async () => {
  const src = await read(configPage);
  assert.match(src, /applyGondolaFormatPreset/,
    "El page debe importar y usar applyGondolaFormatPreset.");
  assert.match(src, /GONDOLA_FORMATS\.LETTER/,
    "El page debe referenciar el enum (no strings sueltos).");
  assert.match(src, /GONDOLA_FORMATS\.LEGAL/);
});

test("labels/config: la tab Góndola no toca el cajón ni abre diálogo directo del navegador", async () => {
  const src = await read(configPage);
  // Buscamos la función GondolaTab y verificamos las garantías duras.
  const idx = src.indexOf("function GondolaTab(");
  assert.ok(idx > 0, "Debe existir el componente GondolaTab.");
  // Buscamos un fin razonable: el próximo bloque de sub-paneles helpers
  // (ThermalPhysicalGroup) o el próximo `// ====` o `// ----`. Un slice
  // de hasta ~20k caracteres cubre tanto la tab como sus helpers de
  // panel térmico, que también deben respetar las reglas.
  const end = (() => {
    const candidates = [
      src.indexOf("\n// =====", idx + 20),
      src.indexOf("\n// -----\n// Preview panel", idx + 20),
      src.indexOf("function PreviewPanel(", idx + 20),
    ].filter((i) => i >= 0);
    return candidates.length ? Math.min(...candidates) : idx + 20000;
  })();
  const body = src.slice(idx, end);
  const codeOnly = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  // La tab Góndola PUEDE invocar al bridge con type:"test-page" + target:"shelf"
  // (la prueba de rollo térmico). Lo que NO puede es:
  //   - kickDrawer (nunca abre cajón)
  //   - window.print() (nunca abre diálogo del navegador)
  //   - dangerouslySetInnerHTML (no inyecta HTML directo)
  assert.doesNotMatch(codeOnly, /kickDrawer/,
    "GondolaTab no debe tocar el cajón.");
  assert.doesNotMatch(codeOnly, /window\.print\(\)/,
    "GondolaTab no debe disparar impresión directa.");
  assert.doesNotMatch(codeOnly, /dangerouslySetInnerHTML/,
    "GondolaTab no debe inyectar HTML directo.");
  // Si invoca al bridge, el payload debe ser `type:"test-page"` con
  // `target:"shelf"` — nunca un recibo térmico ni etiquetas directas.
  if (/posBridge\.print|posBridge\?\.print/.test(codeOnly)) {
    assert.match(codeOnly, /target\s*:\s*["']shelf["']/,
      "Si GondolaTab invoca al bridge, debe hacerlo con target:'shelf' (prueba de rollo térmico).");
    assert.match(codeOnly, /type\s*:\s*["']test-page["']/,
      "Si GondolaTab invoca al bridge, el type debe ser 'test-page'.");
    // Y NO debe invocar al bridge con type thermal-receipt ni shelf-labels
    // (shelf-labels viaja por LabelsWorkspace, no por la tab de config).
    assert.doesNotMatch(codeOnly, /type\s*:\s*["']thermal-receipt["']/,
      "GondolaTab nunca invoca al bridge con type:'thermal-receipt'.");
  }
});

test("labels/config: no renombra ni elimina las tabs existentes (BC)", async () => {
  const src = await read(configPage);
  for (const key of ["perfil", "recibo", "etiquetas", "gondola"]) {
    assert.ok(src.includes(`key="${key}"`),
      `La pestaña ${key} debe seguir existiendo.`);
  }
});



// ============================================================================
// /labels/config: tab Góndola extendida con THERMAL_80 + panel térmico.
// ============================================================================

test("labels/config: tab Góndola incluye la opción THERMAL_80 (Térmica 80 mm)", async () => {
  const src = await read(configPage);
  // El selector del formato tiene su test-id, y el loop pinta uno por
  // opción con la key en minúscula. Verificamos la referencia al enum
  // GONDOLA_FORMATS.THERMAL_80 + el test-id esperado.
  assert.match(src, /key:\s*GONDOLA_FORMATS\.THERMAL_80/,
    "La opción Térmica 80 mm debe venir del enum GONDOLA_FORMATS.");
  // El patrón de test-id "labels-config-gondola-format-${opt.key.toLowerCase()}"
  // seguirá produciendo IDs letter / legal / thermal_80 directamente.
  // Comprobamos que la opción THERMAL_80 se liste en el array del selector:
  assert.match(src, /title:\s*["']Térmica 80 mm["']/,
    "El título visible debe ser 'Térmica 80 mm'.");
});

test("labels/config: tab Góndola muestra el panel térmico sólo cuando THERMAL_80 está activo", async () => {
  const src = await read(configPage);
  const idx = src.indexOf("function GondolaTab(");
  assert.ok(idx > 0);
  const body = src.slice(idx, idx + 20000);
  // El panel térmico vive dentro de `{isThermal && (...)}` (o
  // equivalente contra GONDOLA_FORMATS.THERMAL_80). No puede renderizarse
  // sin la bandera.
  assert.match(body, /const isThermal\s*=\s*activeFormat\s*===\s*GONDOLA_FORMATS\.THERMAL_80/,
    "Debe calcularse `isThermal` desde el formato activo.");
  assert.match(body, /\{isThermal\s*&&/,
    "El panel térmico debe estar guardado por `{isThermal && ...}`.");
  // Y el test-id del panel está documentado:
  assert.match(body, /data-testid="labels-config-gondola-thermal-panel"/,
    "El panel térmico debe exponer el test-id canónico.");
});

test("labels/config: panel térmico expone campos editables críticos con test-ids", async () => {
  const src = await read(configPage);
  const idx = src.indexOf("function GondolaTab(");
  const body = src.slice(idx, idx + 20000);
  for (const tid of [
    "labels-config-gondola-thermal-width-input",
    "labels-config-gondola-thermal-printable-input",
    "labels-config-gondola-thermal-height-input",
    "labels-config-gondola-thermal-gap-input",
    "labels-config-gondola-thermal-name-font",
    "labels-config-gondola-thermal-price-font",
    "labels-config-gondola-thermal-density-input",
    "labels-config-gondola-thermal-show-code-switch",
    "labels-config-gondola-thermal-show-date-switch",
    // Rediseño 2026-10: nuevos toggles y campos.
    "labels-config-gondola-thermal-show-barcode-switch",
    "labels-config-gondola-thermal-show-unit-switch",
    "labels-config-gondola-thermal-unit-label-input",
    "labels-config-gondola-thermal-barcode-height-input",
  ]) {
    assert.ok(src.includes(tid),
      `El campo con test-id "${tid}" debe existir en la tab Góndola.`);
  }
});

test("labels/config: botón 'Probar en rollo térmico' con test-id canónico", async () => {
  const src = await read(configPage);
  assert.match(src, /data-testid="labels-config-print-test-shelf"/,
    "Debe existir el botón de prueba del rollo térmico.");
  assert.match(src, /Probar en rollo térmico/i,
    "El label visible del botón debe mencionar 'rollo térmico'.");
});

test("labels/config: tab Góndola usa setGondolaThermalParams para cambios atómicos", async () => {
  const src = await read(configPage);
  assert.match(src, /setGondolaThermalParams/,
    "La tab debe mutar los campos térmicos con setGondolaThermalParams (idempotente + clamp).");
});

test("ShelfLabelsPreview: THERMAL_80 renderiza una sola etiqueta por slot (sin grid de hoja)", async () => {
  const src = await read(shelfPreview);
  // Debe existir una rama que detecte el formato THERMAL_80 y renderice
  // una lista de slots en vez de la hoja landscape.
  assert.match(src, /layout\.format\s*===\s*["']THERMAL_80["']/,
    "El preview debe tener una rama dedicada para THERMAL_80.");
});

test("ShelfLabelsPreview: acepta prop `thermal: GondolaThermalConfig` para el preview térmico", async () => {
  const src = await read(shelfPreview);
  assert.match(src, /thermal\?:\s*GondolaThermalConfig/,
    "El preview debe aceptar la config térmica como prop tipada opcional.");
  assert.match(src, /from\s+["']@\/lib\/printing-config\.mjs["']/,
    "El preview debe importar DEFAULT_GONDOLA_THERMAL_CONFIG como fallback.");
  assert.match(src, /DEFAULT_GONDOLA_THERMAL_CONFIG/,
    "Debe caer al default cuando `thermal` viene undefined.");
});

test("ShelfLabelsPreview: THERMAL_80 refleja los toggles del rediseño (showBarcode/showUnitLabel/showCode/showDate)", async () => {
  const src = await read(shelfPreview);
  // Los data-attributes del slot preview exponen los toggles para que
  // los guardianes puedan verificar que la UI responde al estado.
  for (const attr of [
    "data-shelf-show-barcode",
    "data-shelf-show-unit",
    "data-shelf-show-code",
    "data-shelf-show-date",
  ]) {
    assert.ok(src.includes(attr),
      `El slot THERMAL_80 debe exponer el atributo "${attr}" en el DOM.`);
  }
  // El literal corto (PRECIO UND o custom) debe venir de la config, no de
  // un string hardcoded en el componente.
  assert.match(src, /thermal\.unitLabel/,
    "El preview debe leer thermal.unitLabel (nunca hardcodear 'PRECIO UND').");
});

test("LabelsWorkspace: hidrata gondolaThermal desde la config persistida y lo pasa al preview", async () => {
  const src = await read(workspace);
  assert.match(src, /useState<GondolaThermalConfig \| undefined>/,
    "El workspace debe mantener un estado del thermal hidratado desde la config.");
  assert.match(src, /setGondolaThermal\(cfg\.gondola\?\.thermal\)/,
    "La hidratación debe leer `cfg.gondola.thermal` al cargar y en `storage` events.");
  assert.match(src, /ShelfLabelsPreview[\s\S]{0,2000}?thermal=\{gondolaThermal\}/,
    "El preview visible debe recibir `thermal={gondolaThermal}` para honrar los toggles del admin.");
});
