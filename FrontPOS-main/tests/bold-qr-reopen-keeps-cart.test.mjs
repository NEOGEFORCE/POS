import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => readFile(join(here, "..", "src", ...p), "utf8");

// Bug 2026-10-23: con "Reabrir QR" y luego cerrar, se borraba la venta
// que el cajero estaba registrando, o se cancelaba el cobro en espera.
test("QR reabierto: cerrar no cancela la intención en espera", async () => {
    const modal = await src("components", "shared", "ModalPagoBoldQR.tsx");
    const cancelIdx = modal.indexOf("const handleCancel = useCallback(");
    const reopenIdx = modal.indexOf("if (reopened) {", cancelIdx);
    const apiIdx = modal.indexOf('"/pos/pagos-qr/cancelar"', cancelIdx);
    assert.ok(reopenIdx > cancelIdx && reopenIdx < apiIdx, "La salida por reopened va antes del POST /cancelar");
    assert.match(modal, /CERRAR Y SEGUIR ATENDIENDO/);
});

test("QR reabierto: no se reencola con el carrito actual y cerrar cierra el cobro", async () => {
    const upm = await src("components", "shared", "UniversalPaymentModal.tsx");
    assert.match(upm, /onEnqueueAndClose=\{isBoldQrReopen \? undefined : onBoldQrEnqueueRequested\}/);
    assert.match(upm, /reopened=\{isBoldQrReopen\}/);
    assert.match(upm, /if \(isBoldQrReopen\) \{[\s\S]{0,300}onOpenChange\(false\)/);
});

test("QR reabierto: al aprobarse no libera el carrito activo", async () => {
    const page = await src("app", "(app)", "sales", "new", "page.tsx");
    assert.match(page, /reopenedVentaTempIdRef\.current = item\.ventaTempId;/);
    assert.match(page, /if \(wasReopened\) return;(\s*\/\/[^\n]*)*\s*confirmEnqueuedAndFreeCart\(\);/);
});
