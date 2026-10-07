import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sheet = join(here, "..", "src", "app", "(app)", "inventory", "receive", "components", "LabelPrintSheet.tsx");

// ============================================================================
// Guardianes del fallback de impresion.
//
// La auditoria del dominio de impresion/codigos encontro que, cuando
// `window.posBridge.print` arrojaba, LabelPrintSheet se limitaba a mostrar un
// toast y hacia `return`, SIN caer a `window.print()`. El usuario quedaba sin
// forma de materializar las etiquetas aunque el stock ya estuviese
// confirmado. En /labels/page.tsx, en cambio, hay un `catch { window.print() }`
// explicito. Esta prueba congela el comportamiento consistente: el sheet
// tambien abre el dialogo del navegador cuando el bridge falla.
// ============================================================================

async function leer(path) { return readFile(path, "utf8"); }

test("LabelPrintSheet: tras un bridge.print fallido, llama a window.print() del navegador", async () => {
  const src = await leer(sheet);
  // Localizar el try/catch del bridge.print
  const match = src.match(/if\s*\(\s*bridge\s*&&\s*typeof\s+bridge\.print\s*===\s*['"]function['"]\s*\)\s*\{[\s\S]*?window\.print\(\);/);
  assert.ok(
    match,
    "falta el flujo bridge → catch → fallback window.print() dentro del handler",
  );
});

test("LabelPrintSheet: el flag bridgeFailed activa el fallback despues del catch", async () => {
  const src = await leer(sheet);
  assert.match(
    src,
    /let\s+bridgeFailed\s*=\s*false/,
    "falta la bandera que indica que el bridge arrojo",
  );
  assert.match(
    src,
    /bridgeFailed\s*=\s*true/,
    "el catch del bridge debe marcar bridgeFailed = true para disparar el fallback",
  );
  assert.match(
    src,
    /bridgeFailed\s*\|\|\s*!bridge/,
    "la condicion del fallback debe cubrir tanto bridge fallido como ausente",
  );
});

test("LabelPrintSheet: el toast de bridge fallido NO revierte stock ni cierra sin fallback", async () => {
  const src = await leer(sheet);
  // Dentro del region del handler: no debe haber `return;` justo despues del
  // toast "BRIDGE LOCAL FALLÓ" sino que el flujo debe continuar al fallback.
  const toastRe = /toast\(\{\s*variant:\s*['"]destructive['"],\s*title:\s*['"]BRIDGE LOCAL FALLÓ['"][\s\S]*?\}\);/;
  const toastMatch = src.match(toastRe);
  assert.ok(toastMatch, "falta el toast de bridge fallido (titulo 'BRIDGE LOCAL FALLÓ')");

  // Confirmar que el toast NO termina en `return;` inmediatamente.
  const after = src.slice((toastMatch.index || 0) + toastMatch[0].length, (toastMatch.index || 0) + toastMatch[0].length + 200);
  assert.doesNotMatch(
    after,
    /^\s*return;/,
    "el toast de bridge fallido no debe cortar el flujo (anterior bug donde window.print nunca se llamaba)",
  );
});

test("LabelPrintSheet: nunca revierte stock (invariante existente)", async () => {
  const src = await leer(sheet);
  assert.ok(!/rollback/i.test(src), "El sheet no debe ejecutar rollback de stock.");
  assert.ok(!/bulk-receive/.test(src), "El sheet no debe tocar la recepcion.");
});

test("LabelPrintSheet: 401 en /labels/codes genera toast y no deja el sheet colgado", async () => {
  const src = await leer(sheet);
  // El flujo general: apiFetch arroja -> catch del handler -> toast -> finally setSubmitting(false).
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
