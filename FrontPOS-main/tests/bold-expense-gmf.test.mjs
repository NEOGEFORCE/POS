// Contrato UI: el egreso pagado por Bold registra el 4x1000 como Nequi.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modalPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "(app)", "expenses", "components", "ExpensePaymentModal.tsx");

test("ExpensePaymentModal: Bold cobra 4x1000 igual que Nequi", async () => {
    const src = await readFile(modalPath, "utf8");
    assert.match(src, /const isBold = activePaymentTab === 'BOLD_QR';/);
    assert.match(src, /Math\.round\(\(nequiPaid \+ boldQrPaid\) \* 0\.004\)/);
    assert.match(src, /const finalTax = Math\.round\(\(finalNequi \+ finalBoldQr\) \* 0\.004\);/);
    assert.match(src, /GMF 4X1000\{isBold \? " \(QR\)" : ""\}/);
});
