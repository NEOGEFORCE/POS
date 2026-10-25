// Contrato UI: enlazar un pago QR sin asignar a una venta ya registrada.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p) => readFile(path.join(root, ...p), "utf8");

test("LinkPaymentToSale usa los endpoints admin de candidatas y enlace", async () => {
    const src = await read("components", "shared", "LinkPaymentToSale.tsx");
    assert.match(src, /\/pos\/pagos-qr\/pagos-sin-asignar\/\$\{eventId\}\/ventas/);
    assert.match(src, /\/pos\/pagos-qr\/enlazar-venta/);
    assert.match(src, /event_id:\s*eventId,\s*sale_id:\s*saleId/);
    // Confirmación explícita antes de mutar.
    assert.match(src, /Sí, enlazar/);
});

for (const [name, parts] of [
    ["bandeja de /sales/new", ["app", "(app)", "sales", "new", "components", "BoldQrTrayPopover.tsx"]],
    ["bandeja global", ["components", "shared", "GlobalBoldQrTray.tsx"]],
]) {
    test(`${name}: "Buscar venta" sólo para admin`, async () => {
        const src = await read(...parts);
        assert.match(src, /\{canConfirmManual \? \(\s*<LinkPaymentToSale/);
    });
}
