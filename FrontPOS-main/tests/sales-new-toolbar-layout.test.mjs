import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, "..", "src", "app", "(app)", "sales", "new", "page.tsx");

test("sales/new: las facturas viven en una sola fila con scroll horizontal", async () => {
    const src = await readFile(pagePath, "utf8");
    assert.match(src, /flex-1 min-w-0 overflow-x-auto overscroll-contain custom-scrollbar/,
        "El contenedor de facturas debe tomar el espacio libre y desplazar horizontalmente.");
    assert.match(src, /flex items-center flex-nowrap gap-1\.5 w-max/,
        "Las facturas deben permanecer en una sola fila.");
    assert.doesNotMatch(src, /flex items-center flex-wrap gap-1\.5 max-w-\[500px\]/,
        "No debe volver el layout que apilaba facturas.");
});

test("sales/new: las acciones superiores son compactas y no se encogen", async () => {
    const src = await readFile(pagePath, "utf8");
    assert.match(src, /flex items-center gap-1\.5 shrink-0/);
    assert.match(src, /aria-label="Seleccionar cliente \(Re Pág\)"/);
    assert.match(src, /aria-label="Dividir factura \(Av Pág\)"/);
    assert.match(src, /aria-label="Buscar producto \(Insert\)"/);
    assert.match(src, /hidden 2xl:flex items-center gap-1\.5 px-2 py-1/,
        "El contador de catálogo sólo debe ocupar espacio en pantallas muy anchas.");
});
