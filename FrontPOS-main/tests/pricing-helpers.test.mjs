import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyStoreRounding,
  isHalfHundredPrice,
  normalizeSalePrice,
  roundSaleLineSubtotal,
  roundToNearestFifty,
} from '../src/lib/pricing-helpers.mjs';

test('automatic store rule still pushes non-fifty endings to the next hundred', () => {
  assert.equal(applyStoreRounding(15219), 15200);
  assert.equal(applyStoreRounding(15220), 15300);
  assert.equal(applyStoreRounding(537), 600);
  assert.equal(applyStoreRounding(1200), 1200);
});

test('prices deliberately set to a fifty ending are preserved', () => {
  assert.equal(isHalfHundredPrice(550), true);
  assert.equal(isHalfHundredPrice(15250), true);
  assert.equal(isHalfHundredPrice(600), false);
  assert.equal(normalizeSalePrice(550), 550);
  assert.equal(normalizeSalePrice(15250), 15250);
});

test('non fifty prices keep falling back to the automatic rule', () => {
  assert.equal(normalizeSalePrice(537), 600);
  assert.equal(normalizeSalePrice(15220), 15300);
  assert.equal(normalizeSalePrice(15219), 15200);
  assert.equal(normalizeSalePrice(0), 0);
});

test('manual fifty adjustment uses symmetric rounding', () => {
  assert.equal(roundToNearestFifty(537), 550);
  assert.equal(roundToNearestFifty(520), 500);
  assert.equal(roundToNearestFifty(575), 600);
  assert.equal(roundToNearestFifty(550), 550);
});

test('cost 450 with 20 percent margin: automatic rule gives 600 but manual fifty gives 550', () => {
  const projected = 450 * 1.2;
  assert.equal(projected, 540);
  assert.equal(applyStoreRounding(projected), 600);
  assert.equal(roundToNearestFifty(projected), 550);
  assert.equal(normalizeSalePrice(550), 550);
  assert.equal(roundSaleLineSubtotal(550, 1), 550);
});

test('recalculating from cost and margin keeps a fifty price instead of inflating it', () => {
  // Tras ajustar a 550 el margen queda en 22.22 sobre un costo de 450.
  const recalculated = Math.round(450 * (1 + 22.22 / 100));
  assert.equal(recalculated, 550);
  assert.equal(normalizeSalePrice(recalculated), 550);
  // Un margen que no cae en terminacion 50 sigue subiendo por la regla.
  assert.equal(normalizeSalePrice(Math.round(450 * 1.2)), 600);
});

test('sale subtotals charge fifty prices exactly and leave hundred prices untouched', () => {
  assert.equal(roundSaleLineSubtotal(550, 1), 550);
  assert.equal(roundSaleLineSubtotal(550, 2), 1100);
  assert.equal(roundSaleLineSubtotal(550, 12), 6600);
  assert.equal(roundSaleLineSubtotal(1200, 1), 1200);
  assert.equal(roundSaleLineSubtotal(1200, 3), 3600);
  assert.equal(roundSaleLineSubtotal(12300, 0.5), 6200);
  assert.equal(roundSaleLineSubtotal(550, 0), 0);
});
