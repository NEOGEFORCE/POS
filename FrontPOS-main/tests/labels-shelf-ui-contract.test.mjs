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

test("workspace: expone handlePrintShelfSheet como useCallback dedicado", async () => {
  const src = await read(workspace);
  assert.match(src, /const handlePrintShelfSheet = useCallback/,
    "El workspace debe seguir teniendo el handler dedicado para góndola.");
  assert.match(src, /data-testid="labels-shelf-print-btn"/,
    "El botón 'Hoja góndola' debe conservar su test-id.");
});

test("workspace: góndola registra sizeTemplateId null y layout antes de imprimir", async () => {
  const src = await read(workspace);
  const region = functionRegion(src, "handlePrintShelfSheet", "handleOpenDrawer");
  assert.match(region, /sizeTemplateId:\s*null/,
    "Góndola no debe proyectarse como plantilla térmica de /labels/sizes.");
  assert.match(region, /meta:\s*buildAuditMeta\s*\(/,
    "La metadata debe pasar por buildAuditMeta (fija el layout canónico).");
  const audit = region.indexOf('await apiFetch("/labels/print-jobs"');
  const iframe = region.indexOf('document.createElement("iframe")');
  const print = region.indexOf("iframe.contentWindow?.print()");
  assert.ok(audit >= 0 && iframe > audit && print > iframe,
    "Orden obligatorio: auditar → crear documento aislado → imprimir.");
});

test("workspace: góndola pasa el formato activo a buildAuditMeta y buildShelfLabelsPrintHtml", async () => {
  const src = await read(workspace);
  const region = functionRegion(src, "handlePrintShelfSheet", "handleOpenDrawer");
  // Auditoría: buildAuditMeta recibe el formato como segundo argumento.
  assert.match(region, /buildAuditMeta\([\s\S]*?,\s*gondolaFormat\s*,?\s*\)/,
    "buildAuditMeta debe recibir gondolaFormat como segundo argumento.");
  // Print HTML: buildShelfLabelsPrintHtml recibe `{ now, format }`.
  assert.match(region, /buildShelfLabelsPrintHtml\(items,[\s\S]*?format:\s*gondolaFormat/,
    "buildShelfLabelsPrintHtml debe recibir format: gondolaFormat.");
});

test("workspace: góndola usa SIEMPRE el diálogo del navegador (iframe.print), nunca el bridge térmico", async () => {
  const src = await read(workspace);
  const region = functionRegion(src, "handlePrintShelfSheet", "handleOpenDrawer");
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
    "El camino de góndola no debe usar dangerouslySetInnerHTML.");
  assert.doesNotMatch(codeOnly, /window\.print\(\)/,
    "Góndola debe imprimir el iframe, no el documento térmico de la app.");
  // Y NO debe invocar al bridge térmico en el flujo de góndola.
  assert.doesNotMatch(codeOnly, /posBridge\?\.print\(|posBridge\.print\(/,
    "Góndola nunca envía al bridge térmico: siempre iframe + diálogo del navegador.");
  assert.doesNotMatch(codeOnly, /kickDrawer/,
    "Góndola nunca abre el cajón al imprimir.");
});

test("workspace: limpieza opcional ocurre sólo tras iframe.print", async () => {
  const src = await read(workspace);
  const region = functionRegion(src, "handlePrintShelfSheet", "handleOpenDrawer");
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
  assert.match(
    src,
    /shelfSummary\.totalLabels\} etiquetas en cola \(\$\{shelfSummary\.fullPages\} páginas completas \+ \$\{shelfSummary\.remainder\} sobrantes\)/,
    "El contador debe expresar total, páginas completas y sobrantes exactos.",
  );
  assert.match(src, /shelfSummary\.totalPages\} página\(s\)/,
    "Debe mostrar el total de páginas.");
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

test("workspace: la góndola es 100% separada del térmico — handlePrintShelfSheet NO toca labelItems", async () => {
  const src = await read(workspace);
  const region = functionRegion(src, "handlePrintShelfSheet", "handleOpenDrawer");
  assert.ok(!/labelItems/.test(region),
    "La hoja góndola NO debe compartir el shape labelItems del térmico.");
  assert.match(region, /buildShelfLabelsPrintHtml/,
    "La hoja góndola debe seguir usando buildShelfLabelsPrintHtml (iframe aislado).");
  assert.match(region, /buildAuditMeta/,
    "La hoja góndola debe seguir pasando buildAuditMeta al POST.");
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

test("labels/config: la tab Góndola nunca invoca al bridge térmico", async () => {
  const src = await read(configPage);
  // Buscamos la función GondolaTab y verificamos que no haya referencias al bridge.
  const idx = src.indexOf("function GondolaTab(");
  assert.ok(idx > 0, "Debe existir el componente GondolaTab.");
  const end = src.indexOf("\n// =====", idx + 20);
  const body = src.slice(idx, end > 0 ? end : idx + 4000);
  const codeOnly = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(codeOnly, /posBridge/,
    "GondolaTab no debe invocar al bridge térmico.");
  assert.doesNotMatch(codeOnly, /kickDrawer/,
    "GondolaTab no debe tocar el cajón.");
  assert.doesNotMatch(codeOnly, /window\.print\(\)/,
    "GondolaTab no debe disparar impresión directa.");
});

test("labels/config: no renombra ni elimina las tabs existentes (BC)", async () => {
  const src = await read(configPage);
  for (const key of ["perfil", "recibo", "etiquetas", "gondola"]) {
    assert.ok(src.includes(`key="${key}"`),
      `La pestaña ${key} debe seguir existiendo.`);
  }
});
