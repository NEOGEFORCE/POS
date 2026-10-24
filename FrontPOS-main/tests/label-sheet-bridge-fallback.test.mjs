// =============================================================================
// tests/label-sheet-bridge-fallback.test.mjs
//
// Guardian REVISADO del contrato "modo bridge = silencioso" para
// LabelPrintSheet (sprint 2026-10). ANTES este test exigia que al fallar
// el bridge se cayera automaticamente a `window.print()`. Esa caida era
// la raiz del bug operativo: el cajero no se enteraba de que el bridge
// habia fallado porque el navegador abria su propio dialogo sin aviso.
//
// EL CONTRATO AHORA:
//
//   1. `handlePrint` NUNCA llama a `window.print()`. Si el bridge falta o
//      rechaza, muestra un toast accionable con un codigo de error cuando
//      lo haya. La impresion directa es silenciosa o avisa — nunca finge
//      exito abriendo un dialogo encubierto.
//   2. Existe un boton MANUAL separado `handleManualBrowserPrint`
//      asociado a su propio Button con copy explicito "Imprimir con
//      navegador (PDF)". Solo ese boton abre el dialogo; `handlePrint` NO.
//   3. La auditoria sigue siendo audit-first y la invariante
//      "no revertir stock / recepcion" se mantiene (igual que antes).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sheet = join(here, "..", "src", "app", "(app)", "inventory", "receive", "components", "LabelPrintSheet.tsx");

async function leer(path) { return readFile(path, "utf8"); }

/**
 * Extrae el cuerpo de una funcion declarada con `const handlePrint = async`
 * o `async function handlePrint`. Devuelve el texto entre `{` y el `}` de
 * cierre del bloque. Es un helper estatico, basado en profundidad de llaves.
 */
function extractFunctionBody(src, declStart) {
  const open = src.indexOf("{", declStart);
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
 * Elimina comentarios de linea y de bloque para que el guardian no
 * matchee `window.print()` escrito dentro de un comentario explicativo
 * (ej. "NO caemos a window.print() aqui porque..."). El contrato se
 * juzga por codigo ejecutable, no por documentacion.
 */
function stripJsComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

test("LabelPrintSheet: handlePrint NO contiene window.print() (fallback automatico eliminado)", async () => {
  const src = await leer(sheet);
  const idx = src.indexOf("const handlePrint = async");
  assert.ok(idx > 0, "falta la declaracion de handlePrint");
  const body = stripJsComments(extractFunctionBody(src, idx));
  assert.ok(body.length > 0, "el cuerpo de handlePrint esta vacio o no se encontro");
  assert.ok(
    !/window\.print\s*\(/.test(body),
    "handlePrint NO debe llamar a window.print(). Esa caida fingia impresiones silenciosas y rompia el contrato 'modo bridge = silencioso'.",
  );
});

test("LabelPrintSheet: existe handleManualBrowserPrint como accion separada", async () => {
  const src = await leer(sheet);
  assert.match(
    src,
    /const\s+handleManualBrowserPrint\s*=\s*async\s*\(/,
    "falta la accion manual separada handleManualBrowserPrint",
  );
  // El manual browser SI puede llamar al iframe/dialogo porque es la
  // ruta separada que el admin elige a sabiendas. Lo verificamos por
  // nombre (la funcion imperativa que arma iframe) o por invocacion
  // directa al diálogo manual.
  const idx = src.indexOf("const handleManualBrowserPrint");
  const body = extractFunctionBody(src, idx);
  assert.ok(
    /openBrowserPrintDialog\(|window\.print\s*\(/.test(body),
    "handleManualBrowserPrint debe abrir el dialogo del navegador (iframe o window.print)",
  );
});

test("LabelPrintSheet: boton 'Imprimir con navegador (PDF)' separado y etiquetado", async () => {
  const src = await leer(sheet);
  assert.match(
    src,
    /onPress=\{\s*handleManualBrowserPrint\s*\}/,
    "falta el Button que invoca handleManualBrowserPrint",
  );
  assert.match(
    src,
    /Imprimir con navegador \(PDF\)/,
    "el label visible del boton manual debe decir 'Imprimir con navegador (PDF)'",
  );
  assert.match(
    src,
    /data-testid="label-sheet-manual-browser-print-btn"/,
    "falta el testid canonico del boton manual separado",
  );
});

test("LabelPrintSheet: bridge fallido muestra toast accionable (sin abrir dialogo)", async () => {
  const src = await leer(sheet);
  const idx = src.indexOf("const handlePrint = async");
  const body = extractFunctionBody(src, idx);
  // Catch del bridge: toast destructivo con guia a la accion manual.
  assert.match(
    body,
    /variant:\s*['"]destructive['"][\s\S]*?Imprimir con navegador \(PDF\)/,
    "el toast de bridge fallido debe guiar al cajero al boton manual 'Imprimir con navegador (PDF)'",
  );
});

test("LabelPrintSheet: nunca revierte stock (invariante existente)", async () => {
  const src = await leer(sheet);
  assert.ok(!/rollback/i.test(src), "El sheet no debe ejecutar rollback de stock.");
  assert.ok(!/bulk-receive/.test(src), "El sheet no debe tocar la recepcion.");
});

test("LabelPrintSheet: 401 en /labels/codes genera toast y no deja el sheet colgado", async () => {
  const src = await leer(sheet);
  assert.match(
    src,
    /catch\s*\(\s*err[\s\S]*?toast\(\s*\{[\s\S]*?variant:\s*['"]destructive['"][\s\S]*?title:\s*['"]NO SE PUDO IMPRIMIR['"]/,
    "falta el catch general que convierte errores de /labels/codes en toast",
  );
  assert.match(
    src,
    /finally\s*\{\s*setSubmitting\(false\);\s*\}/,
    "falta el finally que libera el latch de submitting",
  );
});
