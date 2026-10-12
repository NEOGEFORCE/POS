// =============================================================================
// tests/reception-row-print-selection.test.mjs
//
// Guardianes ESTÁTICOS para la nueva "selección previa de etiquetas"
// (contrato A del rediseño). ReceptionRow:
//
//   1. NO renderiza botón Printer en el DRAFT (sin importar `onPrintLabels`,
//      sin icono Printer de lucide-react).
//   2. Expone un Checkbox shadcn controlado con `id` único y `<label htmlFor>`
//      asociado correctamente (accesibilidad obligatoria).
//   3. El Checkbox se deshabilita cuando `entryType === 'return'`
//      (devolución nunca imprime etiqueta — sale stock, no entra).
//   4. El onCheckedChange publica `printLabelAfterReceive` vía `onUpdate`.
//   5. No hace POST a /labels/print-jobs ni /labels/codes al tocar el
//      checkbox (la selección es sólo in-memory en el DRAFT).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const row = join(
    here,
    "..",
    "src",
    "app",
    "(app)",
    "inventory",
    "receive",
    "components",
    "ReceptionRow.tsx",
);

async function readRow() {
    return readFile(row, "utf8");
}

// Elimina comentarios para que los asserts busquen literales en CÓDIGO
// EJECUTABLE y no en documentación.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
}

test("ReceptionRow importa Checkbox de shadcn (@/components/ui/checkbox)", async () => {
    const src = await readRow();
    assert.ok(
        /from\s+["']@\/components\/ui\/checkbox["']/.test(src),
        "ReceptionRow debe importar el Checkbox shadcn del repo (no inventar su propio control).",
    );
    assert.ok(
        /\{\s*[^}]*\bCheckbox\b[^}]*\}\s*from\s+["']@\/components\/ui\/checkbox["']/.test(src),
        "El import debe desestructurar `Checkbox` explícitamente.",
    );
});

test("ReceptionRow NO importa Printer de lucide-react", async () => {
    const src = await readRow();
    // Buscamos cualquier import que mencione `Printer` desde lucide-react.
    assert.ok(
        !/import[^;]*\bPrinter\b[^;]*from\s+["']lucide-react["']/.test(src),
        "ReceptionRow NO debe importar el icono Printer de lucide-react — está retirado del DRAFT.",
    );
});

test("ReceptionRow NO renderiza un elemento <Printer ... /> (JSX)", async () => {
    const code = stripComments(await readRow());
    assert.ok(
        !/<Printer\b/.test(code),
        "ReceptionRow NO debe tener un <Printer /> en su render (contrato A — sin Printer).",
    );
});

test("ReceptionRow NO expone la prop onPrintLabels en su contrato", async () => {
    const code = stripComments(await readRow());
    assert.ok(
        !/onPrintLabels/.test(code),
        "La prop `onPrintLabels` quedó retirada del contrato de ReceptionRow.",
    );
});

test("ReceptionRow renderiza <Checkbox> con `id` dinámico por línea", async () => {
    const src = await readRow();
    assert.ok(
        /<Checkbox[\s\S]*?id=\{`print-label-\$\{item\.lineId\}`\}/.test(src)
        || /<Checkbox[\s\S]*?id=\{checkboxId\}/.test(src),
        "El Checkbox debe tener un `id` único por línea (ej. `print-label-${item.lineId}`).",
    );
});

test("ReceptionRow asocia <label htmlFor> con el `id` del Checkbox", async () => {
    const src = await readRow();
    assert.ok(
        /<label[\s\S]*?htmlFor=\{checkboxId\}/.test(src)
        || /<label[\s\S]*?htmlFor=\{`print-label-\$\{item\.lineId\}`\}/.test(src),
        "La etiqueta <label htmlFor> debe apuntar al mismo id dinámico del Checkbox (accesibilidad).",
    );
});

test("ReceptionRow fuerza `disabled` cuando entryType === 'return'", async () => {
    const src = await readRow();
    assert.ok(
        /entryType\s*===\s*['"]return['"]/.test(src),
        "ReceptionRow debe inspeccionar entryType === 'return' para decidir disabled.",
    );
    assert.ok(
        /<Checkbox[\s\S]*?disabled=\{isReturn\}/.test(src)
        || /disabled=\{item\.entryType\s*===\s*['"]return['"]\}/.test(src),
        "El Checkbox debe deshabilitarse cuando el entry es una devolución.",
    );
});

test("ReceptionRow fuerza `aria-disabled` para feedback accesible cuando RETURN", async () => {
    const src = await readRow();
    assert.ok(
        /aria-disabled=\{isReturn\}/.test(src)
        || /aria-disabled=\{item\.entryType\s*===\s*['"]return['"]\}/.test(src),
        "El Checkbox debe exponer aria-disabled coherente con disabled para los lectores de pantalla.",
    );
});

test("ReceptionRow onCheckedChange publica printLabelAfterReceive vía onUpdate", async () => {
    const src = await readRow();
    // La firma del callback debe convertir el valor del Radix Checkbox
    // (`boolean | 'indeterminate'`) en un `boolean` estricto antes de
    // enviar al padre.
    assert.ok(
        /onCheckedChange=\{\s*\(v\)\s*=>\s*\{[\s\S]*?printLabelAfterReceive/.test(src),
        "onCheckedChange debe publicar `printLabelAfterReceive` al padre.",
    );
    assert.ok(
        /onUpdate\(\s*item\.lineId\s*,\s*\{\s*printLabelAfterReceive:/.test(src),
        "El valor publicado al padre debe nombrarse `printLabelAfterReceive` (contrato A).",
    );
});

test("ReceptionRow bloquea cambios desde RETURN (defense in depth)", async () => {
    const src = await readRow();
    // El handler onCheckedChange debe hacer early-return si isReturn,
    // para que ni un touch imprudente desde pruebas automáticas publique
    // true en una devolución.
    assert.ok(
        /if\s*\(isReturn\)\s*return;?/.test(src),
        "onCheckedChange debe cortocircuitar cuando `isReturn === true`.",
    );
});

test("ReceptionRow NO hace POST a /labels/print-jobs ni /labels/codes al tocar el checkbox", async () => {
    const code = stripComments(await readRow());
    assert.ok(
        !/\/labels\/print-jobs/.test(code),
        "El DRAFT nunca audita impresión. La impresión ocurre tras la sincronización, en /labels.",
    );
    assert.ok(
        !/\/labels\/codes/.test(code),
        "El DRAFT nunca resuelve codes contra el backend; eso lo hace /labels al imprimir.",
    );
});
