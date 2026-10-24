import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, "..", "src", "app", "(app)", "sales", "new");
const read = (p) => readFile(join(base, p), "utf8");

test("bandeja QR: 'Confirmar manual' existe y sólo se muestra a admin", async () => {
    const tray = await read("components/BoldQrTrayPopover.tsx");
    assert.match(tray, /canConfirmManual && typeof onConfirmManual === "function"/);
    assert.match(tray, /\{showManual \? \(/, "El botón depende de showManual");
    assert.match(tray, /Confirmar manual/);
    const page = await read("page.tsx");
    assert.match(page, /canConfirmManual=\{isAdminUser\(user\)\}/);
    assert.match(page, /onConfirmManual=\{qrConfirmManual\}/);
});

test("hook: confirmManualIntent llama /pos/pagos-qr/confirmar-manual sin DNI en el body", async () => {
    const hook = await read("hooks/useBoldQrTray.ts");
    assert.match(hook, /"\/pos\/pagos-qr\/confirmar-manual"/);
    assert.match(hook, /JSON\.stringify\(\{ venta_temp_id: id, nota:/);
    assert.doesNotMatch(hook, /confirmar-manual[\s\S]{0,300}dni/i);
});
