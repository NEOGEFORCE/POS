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

// ============================================================================
// Guardianes de /labels/shelf — hoja de góndola Letter 2x6 inmutable.
//
// La geometría física (SHEET_* / LABEL_* / grid 2×6) vive en el helper puro
// `shelf-labels.mjs` y nunca se duplica. El workspace comparte queue y
// scanner con /labels (térmica), pero el handler de impresión
// `handlePrintShelfSheet` sólo se activa cuando `mode === "shelf"`.
// ============================================================================

async function read(path) {
  return await readFile(path, "utf8");
}

function functionRegion(src, name, nextName) {
  const start = src.indexOf(`const ${name} = useCallback`);
  assert.ok(start >= 0, `No se encontró ${name}.`);
  const end = nextName
    ? src.indexOf(`const ${nextName} = useCallback`, start + 1)
    : -1;
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

test("workspace: góndola usa documento iframe aislado y no interpola datos en dangerouslySetInnerHTML", async () => {
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
  assert.doesNotMatch(region, /window\.print\(\)/,
    "Góndola debe imprimir el iframe, no el documento térmico de la app.");
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
// Helpers inmutables de góndola — ninguno de estos valores físicos debe
// cambiar sin intención explícita (SHEET Letter, grid 2x6, 80×40mm).
// ============================================================================

test("shelf-labels helper: fija Letter 215.9x279.4, 80x40, 2x6, sin gap y padding físico", async () => {
  const src = await read(shelfHelper);
  assert.match(src, /SHEET_WIDTH_MM\s*=\s*215\.9/);
  assert.match(src, /SHEET_HEIGHT_MM\s*=\s*279\.4/);
  assert.match(src, /LABEL_WIDTH_MM\s*=\s*80/);
  assert.match(src, /LABEL_HEIGHT_MM\s*=\s*40/);
  assert.match(src, /COLUMNS\s*=\s*2/);
  assert.match(src, /ROWS\s*=\s*6/);
  assert.match(src, /PAGE_PADDING_X_MM\s*=\s*\(SHEET_WIDTH_MM\s*-\s*COLUMNS\s*\*\s*LABEL_WIDTH_MM\)\s*\/\s*2/);
  assert.match(src, /PAGE_PADDING_Y_MM\s*=\s*\(SHEET_HEIGHT_MM\s*-\s*ROWS\s*\*\s*LABEL_HEIGHT_MM\)\s*\/\s*2/);
  assert.match(src, /size:\s*Letter portrait/);
  assert.match(src, /margin:\s*0/);
  assert.match(src, /gap:\s*0/);
  assert.match(src, /border:\s*0\.2mm dashed #c4c4c4/);
});

test("shelf-labels helper: mantiene 12 slots con null y escapa toda interpolación", async () => {
  const src = await read(shelfHelper);
  assert.match(src, /while \(chunk\.length < LABELS_PER_PAGE\) chunk\.push\(null\)/,
    "La última página debe rellenarse con null hasta 12 slots.");
  assert.match(src, /const name = escapeHtml\(/);
  assert.match(src, /const price = escapeHtml\(/);
  assert.match(src, /const footerLeft = escapeHtml\(/);
  assert.match(src, /const footerRight = escapeHtml\(/);
  assert.match(src, /-webkit-line-clamp:\s*2/,
    "El nombre debe limitarse a dos líneas.");
});

test("ShelfLabelsPreview: pagina con el helper canónico y pinta blanks", async () => {
  const src = await read(shelfPreview);
  assert.match(src, /expandItemsToSlots\(items\)/);
  assert.match(src, /paginateSlots\(slots\)/);
  assert.match(src, /if \(!slot\)[\s\S]*aria-hidden="true"/,
    "Los blanks deben conservar su celda/guía sin contenido accesible.");
});
