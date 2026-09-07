import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEditItemsPayload,
  buildEditSalePayload,
  buildStockAdjustmentMap,
  computeEditDeltaTotal,
  computeItemDelta,
  computeItemDeltaSubtotal,
  getEditMode,
  hasEditChanges,
} from '../src/lib/sales-edit-helpers.mjs';

// Helper para construir un item de carrito de edición sin repetir campos.
function item(overrides = {}) {
  return {
    barcode: '7702001',
    cartQuantity: 0,
    originalQuantity: 0,
    salePrice: 1100,
    purchasePrice: 800,
    isPreexisting: false,
    ...overrides,
  };
}

test('preexisting sin cambio produce delta cero y no entra al payload', () => {
  const items = [item({ isPreexisting: true, originalQuantity: 3, cartQuantity: 3 })];
  assert.equal(computeItemDelta(items[0]), 0);
  assert.equal(hasEditChanges(items), false);
  assert.equal(getEditMode(items), 'no-changes');
  assert.deepEqual(buildEditItemsPayload(items), []);
});

test('preexisting con menos cantidad produce delta negativo y lo conserva aunque cartQuantity sea 0', () => {
  const items = [item({ isPreexisting: true, originalQuantity: 2, cartQuantity: 0, salePrice: 1100 })];
  assert.equal(computeItemDelta(items[0]), -2);
  assert.equal(computeItemDeltaSubtotal(items[0]), -2200);
  assert.equal(computeEditDeltaTotal(items), -2200);
  assert.equal(getEditMode(items), 'refund');
});

test('nuevo (no preexisting) suma su cartQuantity como delta positivo', () => {
  const items = [item({ isPreexisting: false, cartQuantity: 2, salePrice: 1100 })];
  assert.equal(computeItemDelta(items[0]), 2);
  assert.equal(computeItemDeltaSubtotal(items[0]), 2200);
  assert.equal(getEditMode(items), 'charge');
});

test('cobro adicional +2200 en efectivo NO deja los canales en cero al enviar', () => {
  const items = [item({ isPreexisting: false, cartQuantity: 2, salePrice: 1100 })];
  const payload = buildEditSalePayload({
    items,
    payment: {
      cash: 2200,
      transfer: 0,
      transferNequi: 0,
      transferDaviplata: 0,
      credit: 0,
      transferSource: '',
    },
  });

  assert.equal(payload.mode, 'charge');
  assert.equal(payload.deltaTotal, 2200);
  assert.equal(payload.cashAmount, 2200);
  assert.equal(payload.transferAmount, 0);
  assert.equal(payload.transferNequi, 0);
  assert.equal(payload.transferDaviplata, 0);
  assert.equal(payload.creditAmount, 0);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].quantity, 2);
  assert.equal(payload.items[0].subtotal, 2200);
});

test('reducción -2200 viaja como items firmados y canales en MAGNITUD POSITIVA (backend aplica el signo)', () => {
  const items = [item({ isPreexisting: true, originalQuantity: 3, cartQuantity: 1, salePrice: 1100 })];
  const payload = buildEditSalePayload({
    items,
    payment: {
      cash: 2200,
      transfer: 0,
      transferNequi: 0,
      transferDaviplata: 0,
      credit: 0,
      transferSource: '',
    },
  });

  assert.equal(payload.mode, 'refund');
  assert.equal(payload.deltaTotal, -2200);
  // Backend contract: magnitudes SIEMPRE positivas. El servicio Go
  // rechaza magnitudes negativas y decide el signo aplicado por el
  // delta monetario derivado de los items firmados.
  assert.equal(payload.cashAmount, 2200);
  assert.equal(payload.transferAmount, 0);
  // Los items sí viajan con cantidad firmada: es el mecanismo de
  // señalización de la dirección de la edición.
  assert.equal(payload.items[0].quantity, -2);
  assert.equal(payload.items[0].subtotal, -2200);
});

test('devolución por canal digital envía Nequi en MAGNITUD POSITIVA y respeta transferSource', () => {
  const items = [item({ isPreexisting: true, originalQuantity: 3, cartQuantity: 2, salePrice: 1100 })];
  const payload = buildEditSalePayload({
    items,
    payment: {
      cash: 0,
      transfer: 1100,
      transferNequi: 1100,
      transferDaviplata: 0,
      credit: 0,
      transferSource: 'NEQUI',
    },
  });
  assert.equal(payload.mode, 'refund');
  assert.equal(payload.cashAmount, 0);
  // Magnitudes SIEMPRE positivas; el backend infiere el signo del delta.
  assert.equal(payload.transferNequi, 1100);
  assert.equal(payload.transferDaviplata, 0);
  assert.equal(payload.transferAmount, 1100);
  assert.equal(payload.transferSource, 'NEQUI');
});

test('breakdown mixto Nequi + Daviplata viaja completo al backend', () => {
  const items = [item({ isPreexisting: false, cartQuantity: 3, salePrice: 1100 })];
  const payload = buildEditSalePayload({
    items,
    payment: {
      cash: 1100,
      transfer: 2200,
      transferNequi: 1200,
      transferDaviplata: 1000,
      credit: 0,
      transferSource: 'MIXTO',
    },
  });
  assert.equal(payload.mode, 'charge');
  assert.equal(payload.cashAmount, 1100);
  assert.equal(payload.transferNequi, 1200);
  assert.equal(payload.transferDaviplata, 1000);
  assert.equal(payload.transferAmount, 2200);
  assert.equal(payload.transferSource, 'MIXTO');
});

test('mezcla de suma y resta con neto cero es NEUTRAL y viaja con pagos cero', () => {
  const items = [
    item({ barcode: 'AGUA', isPreexisting: true, originalQuantity: 2, cartQuantity: 1, salePrice: 1500 }), // -1500
    item({ barcode: 'GALLETA', isPreexisting: false, cartQuantity: 3, salePrice: 500 }), // +1500
  ];
  assert.equal(computeEditDeltaTotal(items), 0);
  assert.equal(hasEditChanges(items), true);
  assert.equal(getEditMode(items), 'neutral');

  const payload = buildEditSalePayload({
    items,
    payment: {
      cash: 0,
      transfer: 0,
      transferNequi: 0,
      transferDaviplata: 0,
      credit: 0,
      transferSource: '',
    },
  });
  assert.equal(payload.mode, 'neutral');
  assert.equal(payload.cashAmount, 0);
  assert.equal(payload.transferAmount, 0);
  assert.equal(payload.items.length, 2);
  const aguaLine = payload.items.find((it) => it.barcode === 'AGUA');
  const galletaLine = payload.items.find((it) => it.barcode === 'GALLETA');
  assert.equal(aguaLine.quantity, -1);
  assert.equal(galletaLine.quantity, 3);
});

test('eliminación completa (cantidad 0) de un preexistente igual conserva el delta negativo', () => {
  const items = [item({ isPreexisting: true, originalQuantity: 4, cartQuantity: 0, salePrice: 900 })];
  const payload = buildEditItemsPayload(items);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].quantity, -4);
  assert.equal(payload[0].subtotal, -3600);
});

test('sin ningún cambio (todos los preexistentes con misma cantidad) no genera payload y modo es no-changes', () => {
  const items = [
    item({ isPreexisting: true, originalQuantity: 1, cartQuantity: 1, salePrice: 800 }),
    item({ isPreexisting: true, originalQuantity: 3, cartQuantity: 3, salePrice: 1500 }),
  ];
  assert.equal(hasEditChanges(items), false);
  assert.equal(getEditMode(items), 'no-changes');
  const payload = buildEditSalePayload({
    items,
    payment: { cash: 0, transfer: 0, transferNequi: 0, transferDaviplata: 0, credit: 0, transferSource: '' },
  });
  assert.deepEqual(payload.items, []);
  assert.equal(payload.mode, 'no-changes');
  assert.equal(payload.deltaTotal, 0);
});

test('buildStockAdjustmentMap devuelve deltas firmados por barcode', () => {
  const items = [
    item({ barcode: 'A', isPreexisting: true, originalQuantity: 2, cartQuantity: 0 }), // -2
    item({ barcode: 'B', isPreexisting: false, cartQuantity: 3 }), // +3
    item({ barcode: 'C', isPreexisting: true, originalQuantity: 5, cartQuantity: 5 }), // 0, no entra
  ];
  const map = buildStockAdjustmentMap(items);
  assert.equal(map.get('A'), -2);
  assert.equal(map.get('B'), 3);
  assert.equal(map.has('C'), false);
});

test('modo se puede forzar y sigue enviando magnitudes positivas (backend aplica el signo)', () => {
  const items = [item({ isPreexisting: false, cartQuantity: 2, salePrice: 1100 })];
  const forced = buildEditSalePayload({
    items,
    payment: { cash: 2200, transfer: 0, transferNequi: 0, transferDaviplata: 0, credit: 0, transferSource: '' },
    mode: 'refund',
  });
  // Aunque forcemos 'refund', el backend rechaza magnitudes negativas.
  assert.equal(forced.cashAmount, 2200);
  assert.equal(forced.mode, 'refund');
});



// ==========================================================================
// Guardián del contrato con /sales/add-items/:id (backend Go).
//
// El backend valida en dos capas (handler + service) que TODAS las
// magnitudes sean >= 0. Estos tests fallarán si alguien vuelve a meter la
// lógica de "negativo = refund", que hacía que cada devolución rebotara
// con HTTP 400.
// ==========================================================================

test('contrato Go: +2200 efectivo en carrito nuevo llega como cashAmount=2200 (positivo)', () => {
  const items = [item({ isPreexisting: false, cartQuantity: 2, salePrice: 1100 })];
  const payload = buildEditSalePayload({
    items,
    payment: { cash: 2200, transfer: 0, transferNequi: 0, transferDaviplata: 0, credit: 0, transferSource: '' },
  });
  assert.equal(payload.mode, 'charge');
  assert.equal(payload.cashAmount, 2200);
  assert.equal(payload.transferAmount, 0);
  assert.equal(payload.creditAmount, 0);
  // items firmados sí (positivo = agregar).
  assert.equal(payload.items[0].quantity, 2);
});

test('contrato Go: refund entrega efectivo con cashAmount=2200 (positivo) e items[-2]', () => {
  const items = [item({ isPreexisting: true, originalQuantity: 3, cartQuantity: 1, salePrice: 1100 })];
  const payload = buildEditSalePayload({
    items,
    payment: { cash: 2200, transfer: 0, transferNequi: 0, transferDaviplata: 0, credit: 0, transferSource: '' },
  });
  assert.equal(payload.mode, 'refund');
  // Backend rechaza magnitudes negativas — el signo del delta viene del
  // item firmado. cashAmount viaja SIEMPRE positivo.
  assert.ok(payload.cashAmount >= 0, `cashAmount debe ser >= 0, fue ${payload.cashAmount}`);
  assert.equal(payload.cashAmount, 2200);
  assert.equal(payload.items[0].quantity, -2);
});

test('contrato Go: ninguna magnitud viaja negativa aunque el modal traiga basura', () => {
  const items = [item({ isPreexisting: true, originalQuantity: 3, cartQuantity: 1, salePrice: 1100 })];
  const payload = buildEditSalePayload({
    items,
    // Valores negativos accidentales del modal (nunca debería pasar,
    // pero el helper NO debe propagarlos al backend).
    payment: { cash: -500, transfer: -300, transferNequi: -300, transferDaviplata: 0, credit: -100, transferSource: 'X' },
  });
  assert.ok(payload.cashAmount >= 0, `cashAmount = ${payload.cashAmount}`);
  assert.ok(payload.transferAmount >= 0, `transferAmount = ${payload.transferAmount}`);
  assert.ok(payload.transferNequi >= 0, `transferNequi = ${payload.transferNequi}`);
  assert.ok(payload.transferDaviplata >= 0, `transferDaviplata = ${payload.transferDaviplata}`);
  assert.ok(payload.creditAmount >= 0, `creditAmount = ${payload.creditAmount}`);
});

test('contrato Go: modo neutral fuerza canales a cero aunque el modal traiga valores residuales', () => {
  // Mezcla de suma y resta con delta neto = 0.
  const items = [
    item({ barcode: 'A', isPreexisting: true, originalQuantity: 2, cartQuantity: 1, salePrice: 1500 }), // -1500
    item({ barcode: 'B', isPreexisting: false, cartQuantity: 3, salePrice: 500 }), // +1500
  ];
  // El usuario podría haber tecleado valores en el modal antes de darse
  // cuenta que el ajuste es neutral. NO deben viajar.
  const payload = buildEditSalePayload({
    items,
    payment: { cash: 400, transfer: 100, transferNequi: 100, transferDaviplata: 0, credit: 50, transferSource: 'NEQUI' },
  });
  assert.equal(payload.mode, 'neutral');
  assert.equal(payload.cashAmount, 0);
  assert.equal(payload.transferAmount, 0);
  assert.equal(payload.transferNequi, 0);
  assert.equal(payload.transferDaviplata, 0);
  assert.equal(payload.creditAmount, 0);
  // Los items sí conservan sus signos: el backend necesita el delta.
  const aLine = payload.items.find((it) => it.barcode === 'A');
  const bLine = payload.items.find((it) => it.barcode === 'B');
  assert.equal(aLine.quantity, -1);
  assert.equal(bLine.quantity, 3);
});

test('contrato Go: crédito adicional viaja como creditAmount positivo (backend suma al canal)', () => {
  const items = [item({ isPreexisting: false, cartQuantity: 1, salePrice: 3000 })];
  const payload = buildEditSalePayload({
    items,
    payment: { cash: 0, transfer: 0, transferNequi: 0, transferDaviplata: 0, credit: 3000, transferSource: '' },
  });
  assert.equal(payload.mode, 'charge');
  assert.equal(payload.creditAmount, 3000);
  assert.equal(payload.cashAmount, 0);
});

test('contrato Go: reducción con reembolso Nequi mixto conserva breakdown positivo y total consistente', () => {
  const items = [item({ isPreexisting: true, originalQuantity: 3, cartQuantity: 1, salePrice: 1100 })];
  const payload = buildEditSalePayload({
    items,
    payment: {
      cash: 0,
      transfer: 2200,
      transferNequi: 1200,
      transferDaviplata: 1000,
      credit: 0,
      transferSource: 'MIXTO',
    },
  });
  assert.equal(payload.mode, 'refund');
  assert.equal(payload.transferNequi, 1200);
  assert.equal(payload.transferDaviplata, 1000);
  // TransferAmount consistente con el breakdown (backend: generic +
  // Nequi + Daviplata; en este caso generic=0 porque el modal solo
  // envía Nequi+Davi).
  assert.equal(payload.transferAmount, 2200);
  assert.equal(payload.transferSource, 'MIXTO');
});
