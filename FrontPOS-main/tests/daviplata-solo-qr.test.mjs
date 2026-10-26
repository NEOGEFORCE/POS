// Contrato UI: con QR disponible, Daviplata se confirma solo por QR/llave.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const upm = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "components", "shared", "UniversalPaymentModal.tsx");

test("UPM oculta el botón manual Daviplata cuando hay flujo QR", async () => {
    const src = await readFile(upm, "utf8");
    assert.match(src, /\.filter\(tab => tab\.id !== 'DAVIPLATA' \|\| typeof onBoldQrRequested !== 'function'\)/);
});
