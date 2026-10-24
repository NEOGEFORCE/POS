import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const modalPath = join(here, "..", "src", "components", "shared", "UniversalPaymentModal.tsx");

test("pago digital: el recuadro 'MONTO POR ...' sólo aparece en móvil", async () => {
    const src = await readFile(modalPath, "utf8");
    const idx = src.indexOf("`MONTO POR ${activePaymentTab}`");
    assert.ok(idx > 0, "Debe existir el recuadro de monto por canal para móvil.");
    const labelStart = src.lastIndexOf("<label", idx);
    const labelTag = src.slice(labelStart, src.indexOf(">", labelStart));
    assert.match(labelTag, /className=\{`md:hidden /,
        "En escritorio el monto ya aparece en MONTO INGRESADO; el recuadro duplicado debe ocultarse con md:hidden.");
});


test("pago efectivo: el recuadro de efectivo/cambio sólo aparece en móvil y el cambio pasa al resumen", async () => {
    const src = await readFile(modalPath, "utf8");
    const idx = src.indexOf("{cashHeroLabel}");
    assert.ok(idx > 0);
    const divStart = src.lastIndexOf("<div className={`md:hidden p-4 md:p-5 rounded-2xl border-2", idx);
    assert.ok(divStart > 0 && idx - divStart < 2500, "El recuadro de efectivo debe tener md:hidden.");
    assert.match(src, /tileShowsChange \? 'Cambio \(vueltas\)' : 'Restante'/,
        "En escritorio las vueltas se muestran en la tarjeta de resumen.");
    assert.match(src, /if \(activePaymentTab === 'cash'\) setCashTendered\(''\);/,
        "El CE de escritorio limpia los billetes sumados.");
});
