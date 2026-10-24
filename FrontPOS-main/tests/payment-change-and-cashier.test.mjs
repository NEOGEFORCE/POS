import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Regresión 2026-10-24: la pantalla de "operación exitosa" y la factura
// mostraban siempre cambio $0 y el cajero salía como "OPERADOR".

const here = dirname(fileURLToPath(import.meta.url));
const upmPath = join(here, "..", "src", "components", "shared", "UniversalPaymentModal.tsx");
const hookPath = join(here, "..", "src", "app", "(app)", "sales", "new", "hooks", "useNewSale.ts");

// Réplica de la fórmula de vueltas para validar los casos de caja.
function computeChange({ effectiveTotal, cash, tendered, nequi = 0, davi = 0, credit = 0, isAbono = false, refund = 0 }) {
    const effectiveCash = tendered > 0 ? tendered : cash;
    const cashNeeded = Math.max(0, effectiveTotal - nequi - davi - credit);
    const extra = isAbono
        ? Math.max(0, effectiveCash - cash)
        : Math.max(0, Math.max(effectiveCash, cash) - cashNeeded);
    return refund + extra;
}

test("vueltas: billete digitado en el teclado (cash = tendered = 50.000 sobre 32.000)", () => {
    assert.equal(computeChange({ effectiveTotal: 32000, cash: 50000, tendered: 50000 }), 18000);
});

test("vueltas: pago exacto da 0", () => {
    assert.equal(computeChange({ effectiveTotal: 32000, cash: 32000, tendered: 32000 }), 0);
});

test("vueltas: mixto Nequi + efectivo sólo devuelve sobre la parte en efectivo", () => {
    assert.equal(computeChange({ effectiveTotal: 30000, cash: 20000, tendered: 20000, nequi: 10000 }), 0);
    assert.equal(computeChange({ effectiveTotal: 30000, cash: 50000, tendered: 50000, nequi: 10000 }), 30000);
});

test("vueltas: todo digital no genera cambio", () => {
    assert.equal(computeChange({ effectiveTotal: 30000, cash: 0, tendered: 0, nequi: 30000 }), 0);
});

test("UniversalPaymentModal calcula las vueltas contra lo que el efectivo debía cubrir", async () => {
    const src = await readFile(upmPath, "utf8");
    assert.match(src, /const cashNeeded = Math\.max\(0, effectiveTotal - finalNequi - finalDaviplata - finalCredit\)/);
    assert.match(src, /Math\.max\(effectiveCash, finalCash\) - cashNeeded/);
});

test("La factura de la venta lleva el nombre del cajero registrado", async () => {
    const src = await readFile(hookPath, "utf8");
    assert.match(src, /employeeName: user\?\.name \|\| user\?\.Name \|\| user\?\.dni/);
});
