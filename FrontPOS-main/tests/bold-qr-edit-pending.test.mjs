// Contrato UI: "Editar" un cobro QR en espera reabre la venta en el carrito.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "(app)", "sales", "new");
const read = (...p) => readFile(path.join(root, ...p), "utf8");

test("page.tsx: handleEditPending llama /pos/pagos-qr/editar y restaura el carrito", async () => {
    const src = await read("page.tsx");
    assert.match(src, /'\/pos\/pagos-qr\/editar'/);
    assert.match(src, /restoreCartFromQr\(\{/);
    assert.match(src, /onEdit=\{handleEditPending\}/);
});

test("bandeja: Editar pide confirmación antes de cancelar el QR", async () => {
    const src = await read("components", "BoldQrTrayPopover.tsx");
    assert.match(src, /data-testid="bold-qr-edit-button"/);
    assert.match(src, /data-testid="bold-qr-edit-confirm-button"/);
    // El click inicial sólo abre la confirmación; onEdit va en "Sí, editar".
    const editBtn = src.indexOf('data-testid="bold-qr-edit-button"');
    const before = src.lastIndexOf("onClick", editBtn);
    assert.match(src.slice(before, editBtn), /setEditConfirmId\(item\.ventaTempId\)/);
});

test("useNewSale: restoreCartFromQr reabre ventas editadas como Factura EDIT-<id>", async () => {
    const src = await read("hooks", "useNewSale.ts");
    assert.match(src, /const restoreCartFromQr = useCallback/);
    assert.match(src, /`Factura EDIT-\$\{editId\}`/);
});

test("bandeja global (dashboard): Editar lleva a /sales/new?editarQr= y la página lo procesa", async () => {
    const tray = await readFile(path.join(root, "..", "..", "..", "..", "components", "shared", "GlobalBoldQrTray.tsx"), "utf8");
    assert.match(tray, /data-testid="bold-qr-global-edit-button"/);
    assert.match(tray, /\/sales\/new\?editarQr=\$\{encodeURIComponent\(item\.ventaTempId\)\}/);
    const page = await read("page.tsx");
    assert.match(page, /params\.get\('editarQr'\)/);
    assert.match(page, /window\.history\.replaceState/);
});
