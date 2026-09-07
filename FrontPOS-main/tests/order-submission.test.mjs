import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canConfirmOrder,
  formatOrderValueInput,
  normalizeOrderValueInput,
  parseOrderValue,
  resolveOrderTotal,
  suggestedQuantities,
} from '../src/lib/order-submission.mjs';

// ============================================================================
// Formato COP en vivo
// ============================================================================

test('el valor del pedido muestra separadores de miles mientras se escribe', () => {
  assert.equal(formatOrderValueInput('3'), '3');
  assert.equal(formatOrderValueInput('3120'), '3.120');
  assert.equal(formatOrderValueInput('312000'), '312.000');
  assert.equal(formatOrderValueInput('1250000'), '1.250.000');
});

test('pegar moneda colombiana conserva únicamente el valor entero autoritativo', () => {
  assert.equal(normalizeOrderValueInput('$ 1.250.000,00'), '1250000');
  assert.equal(normalizeOrderValueInput('1250000.50'), '1250000');
  assert.equal(normalizeOrderValueInput('1,250,000'), '1250000');
  assert.equal(normalizeOrderValueInput('000312000'), '312000');
  assert.equal(normalizeOrderValueInput(''), '');
});

// ============================================================================
// parseOrderValue
// ============================================================================

test('parseOrderValue lee montos escritos como se escriben en Colombia', () => {
  assert.equal(parseOrderValue('1250000'), 1250000);
  assert.equal(parseOrderValue('1.250.000'), 1250000);
  assert.equal(parseOrderValue('1,250,000'), 1250000);
  assert.equal(parseOrderValue('$ 1.250.000'), 1250000);
  assert.equal(parseOrderValue(' 500 000 '), 500000);
});

test('parseOrderValue devuelve 0 cuando no hay monto usable', () => {
  assert.equal(parseOrderValue(''), 0);
  assert.equal(parseOrderValue('   '), 0);
  assert.equal(parseOrderValue('abc'), 0);
  assert.equal(parseOrderValue('$'), 0);
  assert.equal(parseOrderValue('0'), 0);
  assert.equal(parseOrderValue('000'), 0);
});

test('parseOrderValue tolera entradas que no son texto', () => {
  assert.equal(parseOrderValue(undefined), 0);
  assert.equal(parseOrderValue(null), 0);
  assert.equal(parseOrderValue(1250000), 0);
});

// ============================================================================
// canConfirmOrder: el pedido del dueño
// ============================================================================

test('sin proveedor nunca se puede enviar', () => {
  assert.equal(
    canConfirmOrder({ hasSupplier: false, selectedCount: 3, declaredValue: 500000 }),
    false
  );
  assert.equal(
    canConfirmOrder({ hasSupplier: false, selectedCount: 0, declaredValue: 0 }),
    false
  );
});

test('con productos seleccionados se puede enviar sin escribir valor', () => {
  assert.equal(
    canConfirmOrder({ hasSupplier: true, selectedCount: 3, declaredValue: 0 }),
    true
  );
});

test('EL PEDIDO DEL DUENO: sin productos pero con valor se puede enviar', () => {
  assert.equal(
    canConfirmOrder({ hasSupplier: true, selectedCount: 0, declaredValue: 500000 }),
    true
  );
});

test('sin productos y sin valor no registra nada, se bloquea', () => {
  assert.equal(
    canConfirmOrder({ hasSupplier: true, selectedCount: 0, declaredValue: 0 }),
    false
  );
});

// ============================================================================
// resolveOrderTotal
// ============================================================================

test('el valor escrito a mano manda sobre el total de los productos', () => {
  assert.equal(resolveOrderTotal(320000, 500000), 500000);
});

test('sin valor escrito se usa el total de los productos', () => {
  assert.equal(resolveOrderTotal(320000, 0), 320000);
});

test('un pedido sin productos ni valor da total cero', () => {
  assert.equal(resolveOrderTotal(0, 0), 0);
});

test('un total de productos negativo se corrige a cero', () => {
  assert.equal(resolveOrderTotal(-50, 0), 0);
});

// ============================================================================
// suggestedQuantities: no se filtra por clase ABC
// ============================================================================

test('la sugerencia del backend se respeta tal cual, incluso en clase C', () => {
  // Este es el caso que el frontend rompia: un clase C bajo el minimo llega
  // con cantidad 10 y antes se prellenaba en 0.
  const items = [
    { productId: 'A1', abcCategory: 'A', suggestedOrderQty: 19 },
    { productId: 'C1', abcCategory: 'C', suggestedOrderQty: 10 },
  ];
  assert.deepEqual(suggestedQuantities(items), { A1: 19, C1: 10 });
});

test('una sugerencia en cero o negativa se prellena en cero', () => {
  const items = [
    { productId: 'C2', abcCategory: 'C', suggestedOrderQty: 0 },
    { productId: 'C3', abcCategory: 'C', suggestedOrderQty: -5 },
    { productId: 'C4', abcCategory: 'C' },
  ];
  assert.deepEqual(suggestedQuantities(items), { C2: 0, C3: 0, C4: 0 });
});

test('suggestedQuantities tolera una lista vacia o ausente', () => {
  assert.deepEqual(suggestedQuantities([]), {});
  assert.deepEqual(suggestedQuantities(undefined), {});
});
