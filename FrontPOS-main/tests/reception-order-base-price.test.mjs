// resolveOrderBasePrice: costo de pedido guardado como base o como bruto.
// Datos reales de la base de la tienda (productos RAMO, 2026-10-26).
import test from "node:test";
import assert from "node:assert/strict";
import { resolveOrderBasePrice, calculateGrossCost } from "../src/lib/reception-pricing.mjs";

const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

test("pedido actual con costo BRUTO (2083.61, IVA 19 + IBUA 20) → base 1499", () => {
  const base = resolveOrderBasePrice(2083.61, 2083.61, 19, 0, 20);
  assert.ok(near(base, 1499), `base=${base}`);
  // Subtotal 6 und = 8.994 y total = 12.502, como la factura.
  assert.ok(near(base * 6, 8994, 0.1));
  assert.ok(near(calculateGrossCost(base, 19, 0, 20) * 6, 12501.66, 0.1));
});

test("pedido antiguo con costo BASE (1499) se respeta", () => {
  assert.equal(resolveOrderBasePrice(1499, 2083.61, 19, 0, 20), 1499);
});

test("Gansito: bruto 1915.90 → base 1610; base 1610 se respeta", () => {
  assert.ok(near(resolveOrderBasePrice(1915.9, 1915.9, 19, 0, 0), 1610));
  assert.equal(resolveOrderBasePrice(1610, 1915.9, 19, 0, 0), 1610);
});

test("sin costo en el pedido cae al bruto del producto descompuesto", () => {
  assert.ok(near(resolveOrderBasePrice(0, 2083.61, 19, 0, 20), 1499));
  assert.ok(near(resolveOrderBasePrice(undefined, 2083.61, 19, 0, 20), 1499));
});

test("sin impuestos el costo del pedido se usa tal cual", () => {
  assert.equal(resolveOrderBasePrice(5000, 5000, 0, 0, 0), 5000);
});

test("producto sin costo vigente: se respeta el costo del pedido", () => {
  assert.equal(resolveOrderBasePrice(1499, 0, 19, 0, 20), 1499);
});
