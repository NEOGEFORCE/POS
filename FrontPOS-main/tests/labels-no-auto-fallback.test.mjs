// =============================================================================
// tests/labels-no-auto-fallback.test.mjs
//
// Guardian del contrato "modo bridge = silencioso" para los tres puntos
// del dominio de impresion que ANTES caian a `window.print()` cuando el
// bridge fallaba. El bug operativo: el navegador abria su propio dialogo
// sin aviso y el cajero quedaba convencido de que la impresion directa
// estaba funcionando.
//
// Despues del sprint 2026-10 el contrato invariante es:
//
//   - `LabelsWorkspace.handlePrint`     NO llama a window.print() dentro
//     del catch del bridge ni como else sin-bridge.
//   - `LabelPrintSheet.handlePrint`     IDEM.
//   - `/labels/config.printTestPage`    IDEM (eliminada la rama que caia
//     a `runIframeTestPrint`).
//
// Ademas cada uno de esos puntos expone una ACCION MANUAL separada que
// invoca el dialogo del navegador bajo un boton explicito con copy claro.
//
// Este test es puramente estatico: lee el fuente y busca patterns, igual
// que los otros guardians del repo (frontend-bridge-wire-contract,
// pos-bridge-ws-protocol, etc).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const workspace = join(here, "..", "src", "app", "(app)", "labels", "components", "LabelsWorkspace.tsx");
const sheet = join(here, "..", "src", "app", "(app)", "inventory", "receive", "components", "LabelPrintSheet.tsx");
const configPage = join(here, "..", "src", "app", "(app)", "labels", "config", "page.tsx");

async function leer(path) { return readFile(path, "utf8"); }

/**
 * Extrae el cuerpo de un callback declarado con `const <name> = useCallback(async ...)`
 * o `const <name> = async (...)`. Nos sirve para analizar solo el handler
 * sin arrastrar las acciones manuales separadas.
 */
function extractCallbackBody(src, nameRegex) {
  const idx = src.search(nameRegex);
  if (idx < 0) return "";
  const open = src.indexOf("{", idx);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return "";
}

/**
 * Elimina comentarios de linea (`// ...`) y de bloque (`/* ... *\/`) del
 * cuerpo analizado. Es imprescindible: una mencion a window.print() dentro
 * de un comentario explicando por que NO llamamos ahi, haria el regex
 * matchear falsamente. El contrato se juzga por codigo ejecutable.
 */
function stripJsComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

// ----------------------------------------------------------------------------
// LabelsWorkspace.handlePrint: NO window.print() dentro del handler
// ----------------------------------------------------------------------------

test("LabelsWorkspace.handlePrint NO contiene window.print() (fallback automatico eliminado)", async () => {
  const src = await leer(workspace);
  const body = stripJsComments(extractCallbackBody(src, /const\s+handlePrint\s*=\s*useCallback\(/));
  assert.ok(body.length > 0, "no se encontro handlePrint");
  assert.ok(
    !/window\.print\s*\(/.test(body),
    "handlePrint NO debe llamar a window.print(). Fallback automatico eliminado por contrato 'bridge silencioso'.",
  );
});

test("LabelsWorkspace: bridge sin instalar muestra toast accionable con BRIDGE_NOT_INSTALLED", async () => {
  const src = await leer(workspace);
  const body = extractCallbackBody(src, /const\s+handlePrint\s*=\s*useCallback\(/);
  assert.match(
    body,
    /BRIDGE_NOT_INSTALLED/,
    "Cuando no hay bridge, el handler debe emitir un error con codigo BRIDGE_NOT_INSTALLED para el toast.",
  );
  assert.match(
    body,
    /IMPRESIÓN FALLÓ/,
    "El toast de bridge faltante debe tener el titulo 'IMPRESIÓN FALLÓ' para que el cajero entienda que es un fallo real.",
  );
});

test("LabelsWorkspace expone handleManualBrowserPrint como accion separada", async () => {
  const src = await leer(workspace);
  const body = extractCallbackBody(src, /const\s+handleManualBrowserPrint\s*=\s*useCallback\(/);
  assert.ok(body.length > 0, "falta handleManualBrowserPrint");
  // Esta funcion SI puede abrir el dialogo (es la accion manual).
  assert.match(
    body,
    /window\.print\s*\(/,
    "handleManualBrowserPrint es la ruta separada que SI abre el dialogo del navegador.",
  );
  // Y debe auditar antes de abrirlo.
  assert.match(
    body,
    /\/labels\/print-jobs/,
    "La ruta manual tambien tiene que auditar en /labels/print-jobs (audit-first).",
  );
});

test("LabelsWorkspace: boton 'Navegador (PDF)' separado con testid canonico", async () => {
  const src = await leer(workspace);
  assert.match(
    src,
    /onPress=\{handleManualBrowserPrint\}/,
    "falta el Button que invoca handleManualBrowserPrint",
  );
  assert.match(
    src,
    /data-testid="labels-thermal-manual-browser-print-btn"/,
    "falta el testid del boton manual separado",
  );
  assert.match(
    src,
    />Navegador \(PDF\)</,
    "El label del boton manual debe decir 'Navegador (PDF)'",
  );
});

// ----------------------------------------------------------------------------
// LabelPrintSheet.handlePrint: NO window.print() dentro del handler
// ----------------------------------------------------------------------------

test("LabelPrintSheet.handlePrint NO contiene window.print() dentro de su cuerpo", async () => {
  const src = await leer(sheet);
  const body = stripJsComments(extractCallbackBody(src, /const\s+handlePrint\s*=\s*async\s*\(/));
  assert.ok(body.length > 0, "no se encontro handlePrint en LabelPrintSheet");
  assert.ok(
    !/window\.print\s*\(/.test(body),
    "handlePrint del sheet NO debe caer a window.print(). El contrato manda toast accionable.",
  );
});

test("LabelPrintSheet.handlePrint muestra 'IMPRESIÓN FALLÓ' en el catch del bridge", async () => {
  const src = await leer(sheet);
  const body = extractCallbackBody(src, /const\s+handlePrint\s*=\s*async\s*\(/);
  assert.match(
    body,
    /IMPRESIÓN FALLÓ/,
    "El toast de bridge rechazado debe titularse 'IMPRESIÓN FALLÓ' para que el cajero no asuma exito encubierto.",
  );
  assert.match(
    body,
    /SIN BRIDGE LOCAL/,
    "El toast de bridge faltante debe titularse 'SIN BRIDGE LOCAL' (sin dialogo encubierto).",
  );
});

// ----------------------------------------------------------------------------
// /labels/config.printTestPage: NO runIframeTestPrint dentro del catch
// ----------------------------------------------------------------------------

test("/labels/config.printTestPage NO llama a runIframeTestPrint dentro del handler", async () => {
  const src = await leer(configPage);
  const body = stripJsComments(extractCallbackBody(src, /const\s+printTestPage\s*=\s*useCallback\(/));
  assert.ok(body.length > 0, "no se encontro printTestPage");
  assert.ok(
    !/runIframeTestPrint\s*\(/.test(body),
    "printTestPage NO debe caer a runIframeTestPrint. Fallback automatico eliminado por contrato.",
  );
});

test("/labels/config expone printManualBrowser como accion separada", async () => {
  const src = await leer(configPage);
  const body = extractCallbackBody(src, /const\s+printManualBrowser\s*=\s*useCallback\(/);
  assert.ok(body.length > 0, "falta printManualBrowser");
  assert.match(
    body,
    /runIframeTestPrint\s*\(/,
    "printManualBrowser es la ruta separada que SI abre el iframe aislado + window.print().",
  );
});

test("/labels/config: boton 'Probar en navegador (PDF)' separado y etiquetado", async () => {
  const src = await leer(configPage);
  assert.match(
    src,
    /data-testid="labels-config-print-test-browser"/,
    "falta el testid canonico del boton manual separado para la prueba",
  );
  assert.match(
    src,
    /Probar en navegador \(PDF\)/,
    "El label del boton manual debe decir 'Probar en navegador (PDF)'",
  );
  assert.match(
    src,
    /data-testid="labels-config-print-test-bridge"/,
    "falta el testid canonico del boton principal 'Imprimir pagina de prueba' (bridge)",
  );
});
