import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const globalsPath = new URL("../src/app/globals.css", import.meta.url);
const tailwindPath = new URL("../tailwind.config.ts", import.meta.url);

const read = (url) => readFile(url, "utf8");

test("Tailwind escanea el theme HeroUI aunque npm lo instale anidado", async () => {
  const src = await read(tailwindPath);
  assert.match(
    src,
    /@heroui\/\*\*\/node_modules\/@heroui\/theme\/dist\/components/,
    "Sin el glob anidado, Tailwind purga bg-content1 y el popover queda transparente.",
  );
});

test("el tema define una superficie de popover opaca en claro y oscuro", async () => {
  const css = await read(globalsPath);
  const values = [...css.matchAll(/--bg-popover:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(values.length >= 2, "Debe haber --bg-popover para ambos temas.");
  for (const value of values) {
    assert.match(value, /^#[0-9a-f]{6}$/i, "La superficie debe ser un color hexadecimal opaco.");
  }
});

test("Select y Autocomplete HeroUI tienen fallback global de superficie", async () => {
  const css = await read(globalsPath);
  assert.match(css, /\[data-slot="listboxWrapper"\]/);
  assert.match(css, /\[data-slot="content"\]:has\(\[data-slot="listboxWrapper"\]\)/);
  assert.match(css, /background-color:\s*var\(--bg-popover\)\s*!important/);
  assert.match(css, /opacity:\s*1\s*!important/);
});
