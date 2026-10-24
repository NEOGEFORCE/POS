import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const PAGE = new URL("../src/app/(app)/sales/new/page.tsx", import.meta.url);

async function source() {
  return readFile(PAGE, "utf8");
}

test("el teclado lateral separa operaciones, números y confirmación", async () => {
  const src = await source();
  assert.match(src, /aria-label="Operaciones rápidas"[^>]*grid grid-cols-4 gap-2 h-12/);
  assert.match(src, /aria-label="Teclado numérico de ventas"[^>]*grid grid-cols-3 grid-rows-4 gap-2/);
  assert.match(src, /className="w-full h-14 min-h-14[^\"]*"/);
});

test("el botón de confirmar ya no es una columna alta y angosta", async () => {
  const src = await source();
  assert.doesNotMatch(src, /col-span-3 grid grid-cols-3 gap-1/);
  assert.doesNotMatch(src, /col-span-1 h-full min-h-\[40px\][^\"]*text-2xl/);
});

test("la columna lateral tiene ancho táctil suficiente", async () => {
  const src = await source();
  assert.match(src, /lg:w-\[280px\] xl:w-\[300px\]/);
  assert.match(src, /min-h-\[44px\]/);
});
