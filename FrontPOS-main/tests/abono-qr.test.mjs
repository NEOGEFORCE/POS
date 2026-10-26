// Contrato UI: abono de fiado por QR / llave Daviplata.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p) => readFile(path.join(src, ...p), "utf8");

test("UPM permite QR en abonos (no excluye isAbono en canUseBoldQr)", async () => {
    const upm = await read("components", "shared", "UniversalPaymentModal.tsx");
    const idx = upm.indexOf("const canUseBoldQr");
    const scope = upm.slice(idx, upm.indexOf("[", idx + 30) + 200);
    assert.doesNotMatch(scope, /!isAbono/);
});

test("Clientes: el abono conecta el QR con abonoClientDni y cierra con onBoldQrFinalized", async () => {
    const page = await read("app", "(app)", "customers", "page.tsx");
    assert.match(page, /onBoldQrRequested=\{prepareAbonoQrIntent\}/);
    assert.match(page, /onBoldQrFinalized=\{handleAbonoQrFinalized\}/);
    assert.match(page, /abonoClientDni: payingClient\.dni/);
    assert.match(page, /'\/pos\/pagos-qr\/iniciar'/);
});
