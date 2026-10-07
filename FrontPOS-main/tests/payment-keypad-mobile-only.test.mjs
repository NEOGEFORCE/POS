// Guardián 2026-10-07: el botón "Teclado" del cobro en efectivo es sólo de
// celular. En escritorio el numpad vive fijo a la derecha; el botón ancho
// con aspect-ratio salía enorme y forzaba scroll.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const MODAL = new URL("../src/components/shared/UniversalPaymentModal.tsx", import.meta.url);

test("pago: el botón Teclado sólo aparece en celular y no usa aspect-ratio ni col-span", async () => {
  const src = await readFile(MODAL, "utf8");
  const idx = src.indexOf("onPress={() => setIsMobileNumpadOpen(true)}");
  assert.ok(idx > 0, "debe existir el botón que abre el numpad móvil");
  const tagStart = src.lastIndexOf("<Button", idx);
  const tag = src.slice(tagStart, idx);
  assert.match(tag, /\bmd:hidden\b/, "el botón Teclado debe ocultarse desde md");
  assert.doesNotMatch(tag, /aspect-\[/, "sin aspect-ratio: era lo que lo hacía gigante");
  assert.doesNotMatch(tag, /col-span-2/, "sin col-span-2 en la grilla de billetes");
});
