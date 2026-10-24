import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const modalPath = join(here, "..", "src", "components", "shared", "UniversalPaymentModal.tsx");

test("pantalla de éxito: overlay desplazable y tarjeta centrada con my-auto", async () => {
    const src = await readFile(modalPath, "utf8");
    assert.match(src, /absolute inset-0 z-\[100\][^"]*flex flex-col items-center overflow-y-auto overscroll-contain/,
        "El overlay de éxito debe permitir scroll para que CONTINUAR nunca quede oculto en el modal de 500px.");
    assert.match(src, /className="my-auto bg-white dark:bg-\[#18181b\] p-5 md:p-6/,
        "La tarjeta debe centrarse con my-auto (no justify-center, que recorta arriba al desbordar).");
    assert.doesNotMatch(src, /absolute inset-0 z-\[100\][^"]*justify-center p-4 md:p-8/,
        "No debe volver el overlay que recortaba el botón CONTINUAR.");
});

test("pantalla de éxito: CONTINUAR sigue presente y no se encoge", async () => {
    const src = await readFile(modalPath, "utf8");
    assert.match(src, /className="mt-3 shrink-0[^"]*h-11/);
    assert.match(src, /CONTINUAR \[ENTER\]/);
});
