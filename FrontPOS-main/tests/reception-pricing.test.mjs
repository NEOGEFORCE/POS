import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateGrossCost,
  calculateMarginFromGross,
  calculateNetCost,
  calculateProjectedPVP,
  calculateProjectedWacGross,
  calculatePVP,
  calculateRawPVP,
  grossToBasePrice,
  parseSubtotalEdit,
  resolveBasePrice,
  resolveEffectivePercentage,
  sumTaxRate,
  unitMultiplier,
} from '../src/lib/reception-pricing.mjs';
import { normalizeSalePrice } from '../src/lib/pricing-helpers.mjs';

// ──────────────────────────────────────────────────────────────────────────
// grossToBasePrice — contrato: `products.purchasePrice` persiste gross con
// IVA+ICUI+IBUA; al cargar en la UI de recepción se descompone exactamente
// UNA VEZ para evitar que los helpers reapliquen los impuestos.
// ──────────────────────────────────────────────────────────────────────────

test('grossToBasePrice: sin impuestos deja el gross intacto', () => {
  assert.equal(grossToBasePrice(1000, 0, 0, 0), 1000);
  assert.equal(grossToBasePrice(1370, 0, 0, 0), 1370);
});

test('grossToBasePrice: IVA 19 % convierte 1190 → 1000', () => {
  assert.equal(Math.round(grossToBasePrice(1190, 19, 0, 0)), 1000);
});

test('grossToBasePrice: IVA 19 + ICUI 8 + IBUA 10 convierte 1370 → 1000', () => {
  const base = grossToBasePrice(1370, 19, 8, 10);
  assert.ok(Math.abs(base - 1000) < 0.0001, `expected ≈1000, got ${base}`);
});

test('grossToBasePrice: segunda carga desde 1370 vuelve a 1000 (nunca 1370)', () => {
  // Simula el bug anterior: cargar un producto que se recibió con base 1000
  // (y se persistió como 1370 gross) y asegurarse de que SI vuelve a 1000.
  const first = grossToBasePrice(1370, 19, 8, 10);
  // La BD guardaría ahora gross=calculateGrossCost(first,...) ≈ 1370.
  // Al recargarlo, debe volver a dar 1000, no 1370 y menos 1877.
  const persistedAgain = calculateGrossCost(first, 19, 8, 10);
  const second = grossToBasePrice(persistedAgain, 19, 8, 10);
  assert.ok(Math.abs(second - 1000) < 0.0001, `expected ≈1000, got ${second}`);
  assert.notEqual(Math.round(second), 1370);
});

test('grossToBasePrice: tolera NaN, texto, negativos y cero', () => {
  assert.equal(grossToBasePrice(Number.NaN, 19, 0, 0), 0);
  assert.equal(grossToBasePrice('abc', 19, 0, 0), 0);
  assert.equal(grossToBasePrice(-100, 19, 0, 0), 0);
  assert.equal(grossToBasePrice(0, 19, 0, 0), 0);
  assert.equal(grossToBasePrice(null, 19, 0, 0), 0);
  assert.equal(grossToBasePrice(undefined, 19, 0, 0), 0);
});

test('grossToBasePrice: ignora porcentajes negativos o inválidos', () => {
  assert.equal(grossToBasePrice(1000, -5, 0, 0), 1000);
  assert.equal(grossToBasePrice(1000, 'abc', 0, 0), 1000);
  assert.equal(sumTaxRate(-5, Number.NaN, undefined), 0);
});

// ──────────────────────────────────────────────────────────────────────────
// Simetría gross/base: aplicar impuestos y des-aplicarlos no debe perder
// precisión notable para los montos que maneja el POS.
// ──────────────────────────────────────────────────────────────────────────

test('simetría: calculateGrossCost ∘ grossToBasePrice ≈ identidad', () => {
  const cases = [
    [1190, 19, 0, 0],
    [1370, 19, 8, 10],
    [2500, 5, 0, 0],
    [537, 19, 0, 0],
  ];
  for (const [gross, iva, icui, ibua] of cases) {
    const base = grossToBasePrice(gross, iva, icui, ibua);
    const back = calculateGrossCost(base, iva, icui, ibua);
    assert.ok(
      Math.abs(back - gross) < 0.0001,
      `simetría rota: ${gross} → ${base} → ${back}`,
    );
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Costo neto y PVP — combinaciones de impuestos y descuento.
// ──────────────────────────────────────────────────────────────────────────

test('calculateNetCost: base 1000 con IVA19+ICUI8+IBUA10+DTO12 → 1370 × 0.88', () => {
  const net = calculateNetCost(1000, 19, 8, 10, 12);
  assert.ok(Math.abs(net - 1370 * 0.88) < 0.0001);
});

test('calculatePVP: sólo GAN 30 % sobre base 1000 → normalizar(1300)', () => {
  assert.equal(calculatePVP(1000, 0, 0, 0, 30, 0), normalizeSalePrice(1300));
});

test('calculatePVP: IVA 19 + GAN 30 sobre base 1000 → normalizar(1547)', () => {
  // 1000 × 1.19 × 1.3 = 1547
  assert.equal(calculatePVP(1000, 19, 0, 0, 30, 0), normalizeSalePrice(1547));
});

test('calculatePVP: IVA19 + ICUI8 + IBUA10 + DTO12 + GAN20 → raw 1868.18, normalizado 1900', () => {
  const raw = calculateRawPVP(1000, 19, 8, 10, 20, 12);
  // gross = 1370; baseForPvp = 1370/0.88 = 1556.818...; ×1.2 = 1868.18...
  assert.ok(Math.abs(raw - (1370 / 0.88) * 1.2) < 0.0001, `raw ${raw}`);
  const normalized = calculatePVP(1000, 19, 8, 10, 20, 12);
  assert.equal(normalized, normalizeSalePrice(raw));
  // Documentación del valor esperado: el helper actual lleva 1868 → 1900.
  assert.equal(normalized, 1900);
});

test('calculatePVP: descuento 100 % no divide por cero', () => {
  const pvp = calculateRawPVP(1000, 19, 0, 0, 20, 100);
  assert.ok(Number.isFinite(pvp));
  // baseForPvp cae al gross (sin dividir por 0): 1190 × 1.2 = 1428
  assert.ok(Math.abs(pvp - 1190 * 1.2) < 0.0001);
});

// ──────────────────────────────────────────────────────────────────────────
// parseSubtotalEdit — habilita "escribir subtotal y sincronizar sin blur".
// ──────────────────────────────────────────────────────────────────────────

test('parseSubtotalEdit: "1.370" con qty 1 → base 1370', () => {
  const r = parseSubtotalEdit('1.370', 1);
  assert.equal(r.isValid, true);
  assert.equal(r.subtotal, 1370);
  assert.equal(r.basePrice, 1370);
});

test('parseSubtotalEdit: "1370" sin formato también vale', () => {
  const r = parseSubtotalEdit('1370', 1);
  assert.equal(r.isValid, true);
  assert.equal(r.basePrice, 1370);
});

test('parseSubtotalEdit: LB cuenta como 0.5 (qty 4 LB → effective 2)', () => {
  const effective = 4 * unitMultiplier('LB');
  assert.equal(effective, 2);
  const r = parseSubtotalEdit('2.000', effective);
  assert.equal(r.isValid, true);
  assert.equal(r.subtotal, 2000);
  assert.equal(r.basePrice, 1000);
});

test('parseSubtotalEdit: qty > 1 reparte proporcionalmente', () => {
  const r = parseSubtotalEdit('6.000', 3);
  assert.equal(r.isValid, true);
  assert.equal(r.basePrice, 2000);
});

test('parseSubtotalEdit: vacío e inválidos no producen base', () => {
  assert.deepEqual(parseSubtotalEdit('', 1), { isValid: false, basePrice: 0, subtotal: 0 });
  assert.deepEqual(parseSubtotalEdit('   ', 1), { isValid: false, basePrice: 0, subtotal: 0 });
  assert.deepEqual(parseSubtotalEdit('abc', 1), { isValid: false, basePrice: 0, subtotal: 0 });
  assert.deepEqual(parseSubtotalEdit('-100', 1), { isValid: false, basePrice: 0, subtotal: 100 });
  assert.deepEqual(parseSubtotalEdit('0', 1), { isValid: false, basePrice: 0, subtotal: 0 });
  assert.deepEqual(parseSubtotalEdit(null, 1), { isValid: false, basePrice: 0, subtotal: 0 });
  assert.deepEqual(parseSubtotalEdit(undefined, 1), { isValid: false, basePrice: 0, subtotal: 0 });
});

test('parseSubtotalEdit: effectiveQty inválido invalida la operación', () => {
  const r = parseSubtotalEdit('1.370', 0);
  assert.equal(r.isValid, false);
  assert.equal(r.basePrice, 0);
});

test('escribir subtotal y sincronizar sin blur: el helper produce basePrice y PVP correctos a partir del texto visible', () => {
  // Flujo real: el usuario escribió "1.370" en SUBT. mientras el input
  // aún tenía foco. onChange NO esperó al blur y empujó el base al padre.
  // Al pulsar "Sincronizar" se usa ese basePrice derivado directamente del
  // texto visible, no el valor anterior del estado.
  const typed = '1.370';
  const effectiveQty = 1;
  const taxes = { iva: 19, icui: 8, ibua: 10, dto: 12, margin: 20 };

  const parsed = parseSubtotalEdit(typed, effectiveQty);
  assert.equal(parsed.isValid, true);
  assert.equal(parsed.basePrice, 1370);

  // El payload hacia bulk-receive manda base pre-impuestos:
  const payloadNewPurchasePrice = parsed.basePrice;
  assert.equal(payloadNewPurchasePrice, 1370);

  // Y PVP se recalcula desde ese base, nunca desde un valor "antiguo".
  const pvp = calculatePVP(
    parsed.basePrice,
    taxes.iva,
    taxes.icui,
    taxes.ibua,
    taxes.margin,
    taxes.dto,
  );
  assert.ok(pvp > 0);
  assert.equal(pvp, normalizeSalePrice(calculateRawPVP(
    parsed.basePrice, taxes.iva, taxes.icui, taxes.ibua, taxes.margin, taxes.dto,
  )));
});

test('cambiar IVA/ICUI/IBUA/DTO/GAN después de editar SUBT. no restaura el subtotal viejo', () => {
  // Simula: usuario editó SUBT. a 2.000 (base 2000). Luego cambia IVA a 19.
  // El basePrice vigente sigue siendo 2000 — solo el PVP y los costos
  // derivados deben recalcularse. No puede volver "al subtotal anterior".
  const edited = parseSubtotalEdit('2.000', 1);
  assert.equal(edited.basePrice, 2000);

  // Antes del cambio de IVA
  const pvpAntes = calculatePVP(edited.basePrice, 0, 0, 0, 30, 0);
  // Despues del cambio de IVA
  const pvpDespues = calculatePVP(edited.basePrice, 19, 0, 0, 30, 0);
  assert.notEqual(pvpAntes, pvpDespues);

  // El subtotal "vigente" sigue derivándose del basePrice vigente × qty.
  // No existe caché del subtotal viejo que pueda sobrescribir el nuevo.
  const subtotalVigente = edited.basePrice * 1;
  assert.equal(subtotalVigente, 2000);
});

// ──────────────────────────────────────────────────────────────────────────
// unitMultiplier — contrato chico pero contagioso.
// ──────────────────────────────────────────────────────────────────────────

test('unitMultiplier: LB = 0.5, otros = 1', () => {
  assert.equal(unitMultiplier('LB'), 0.5);
  assert.equal(unitMultiplier('KG'), 1);
  assert.equal(unitMultiplier('UND'), 1);
  assert.equal(unitMultiplier(''), 1);
  assert.equal(unitMultiplier(null), 1);
  assert.equal(unitMultiplier(undefined), 1);
});


// ──────────────────────────────────────────────────────────────────────────
// Rutas secundarias: metadata histórica, OCR, órdenes y proyección WAC/PVP.
// ──────────────────────────────────────────────────────────────────────────

test('edición sin metadata: fallback gross 1370 → base 1000', () => {
  const iva = resolveEffectivePercentage(undefined, 19);
  const icui = resolveEffectivePercentage(undefined, 8);
  const ibua = resolveEffectivePercentage(undefined, 10);
  const base = resolveBasePrice(undefined, 1370, iva, icui, ibua);
  assert.ok(Math.abs(base - 1000) < 0.0001, `expected ≈1000, got ${base}`);
});

test('edición: metadata.newPurchasePrice 0 es base explícita y no usa fallback gross', () => {
  assert.equal(resolveBasePrice(0, 1370, 19, 8, 10), 0);
});

test('OCR sin costUnit: fallback purchasePrice gross 1370 → base 1000', () => {
  const iva = resolveEffectivePercentage(undefined, 19);
  const icui = resolveEffectivePercentage(undefined, 8);
  const ibua = resolveEffectivePercentage(undefined, 10);
  const base = resolveBasePrice(undefined, 1370, iva, icui, ibua);
  assert.ok(Math.abs(base - 1000) < 0.0001, `expected ≈1000, got ${base}`);
});

test('OCR costUnit 1000 ya es base y no se divide por impuestos', () => {
  assert.equal(resolveBasePrice(1000, 1370, 19, 8, 10), 1000);
});

test('porcentajes efectivos: OCR 0 explícito prevalece sobre producto', () => {
  assert.equal(resolveEffectivePercentage(0, 19), 0);
  assert.equal(resolveEffectivePercentage(undefined, 19), 19);
  assert.equal(resolveEffectivePercentage(null, 8), 8);
});

test('margen de producto usa purchasePrice gross sin reaplicar impuestos', () => {
  assert.ok(Math.abs(calculateMarginFromGross(1370, 1644, 30) - 20) < 0.0001);
});

test('WAC proyectado: old gross1190 stock2 + nueva base1000 IVA19 qty1 = gross1190', () => {
  const projected = calculateProjectedWacGross(1190, 2, 1000, 1, 19, 0, 0);
  assert.ok(Math.abs(projected - 1190) < 0.0001, `expected 1190, got ${projected}`);
});

test('WAC proyectado: LB usa cantidad efectiva y no la cantidad capturada', () => {
  const capturedQty = 2;
  const effectiveQty = capturedQty * unitMultiplier('LB');
  assert.equal(effectiveQty, 1);

  const projected = calculateProjectedWacGross(1000, 1, 2000, effectiveQty, 0, 0, 0);
  assert.equal(projected, 1500);
  assert.notEqual(projected, calculateProjectedWacGross(1000, 1, 2000, capturedQty, 0, 0, 0));
});

test('PVP proyectado incluye DTO y usa la normalización canónica frontend', () => {
  // WAC gross permanece 1190. Con DTO10 y GAN20:
  // raw = 1190 / 0.90 * 1.20 = 1586.66... → normalizeSalePrice = 1600.
  const withDiscount = calculateProjectedPVP(1190, 2, 1000, 1, 19, 0, 0, 20, 10);
  const withoutDiscount = calculateProjectedPVP(1190, 2, 1000, 1, 19, 0, 0, 20, 0);
  assert.equal(withDiscount, 1600);
  assert.equal(withDiscount, normalizeSalePrice((1190 / 0.9) * 1.2));
  assert.notEqual(withDiscount, withoutDiscount);
});


test('reviewer→cart: oldPurchasePrice y oldSalePrice vienen del catálogo cuando el reviewer no los transporta', () => {
  // Contrato: UnmatchedItemsReviewer.ResolvedReceiveLine NO incluye los
  // campos "old*" porque sólo acarrea lo que llegó por la factura OCR.
  // handleUnmatchedResolved compensa cayendo al producto resuelto del
  // catálogo (gross persistido) antes de usar 0 como último fallback.
  //
  // Si no se hace, currentStock>0 con oldPurchasePrice=0 rompe la
  // proyección WAC en ReceptionRow: el "old" se trataría como regalo y
  // el WAC/PVP sugerido caerían a una fracción del valor real.

  const resolvedFromReviewer = {
    barcode: 'X',
    productName: 'JUGO 500 ML',
    addedQuantity: 1,
    newPurchasePrice: 1000,   // base pre-impuestos (contrato OCR)
    newSalePrice: 0,
    marginPercentage: 20,
    iva: 19, icui: 0, ibua: 0,
    isNew: false,             // asignado a un producto existente
    invoiceName: 'JUGO 500ML',
    supplierId: 1,
    // ¡No trae oldPurchasePrice ni oldSalePrice!
  };
  const catalogProduct = {
    barcode: 'X',
    purchasePrice: 1190,       // gross persistido en products.purchasePrice
    salePrice: 1600,
    quantity: 5,
  };

  // Lógica exacta aplicada en handleUnmatchedResolved tras el fix:
  const oldPurchasePrice = Number(
    catalogProduct?.purchasePrice ?? resolvedFromReviewer.oldPurchasePrice ?? 0,
  );
  const oldSalePrice = Number(
    catalogProduct?.salePrice ?? resolvedFromReviewer.oldSalePrice ?? 0,
  );

  assert.equal(oldPurchasePrice, 1190, 'oldPurchasePrice debe venir del catálogo (gross)');
  assert.equal(oldSalePrice, 1600, 'oldSalePrice debe venir del catálogo');

  // Con el fix, la proyección WAC coincide con el gross real (viejo=nuevo).
  const projectedWac = calculateProjectedWacGross(
    oldPurchasePrice,
    catalogProduct.quantity,
    resolvedFromReviewer.newPurchasePrice,
    1,
    resolvedFromReviewer.iva, 0, 0,
  );
  assert.ok(
    Math.abs(projectedWac - 1190) < 0.0001,
    `WAC proyectado debería ≈1190 con fix, se obtuvo ${projectedWac}`,
  );

  // Documentación del bug anterior: sin fallback al catálogo el WAC
  // habría sido (0*5 + 1190*1)/(5+1) = 198.33 y el PVP sugerido ≈ 300.
  const wacSinFix = calculateProjectedWacGross(
    0,
    catalogProduct.quantity,
    resolvedFromReviewer.newPurchasePrice,
    1,
    resolvedFromReviewer.iva, 0, 0,
  );
  assert.ok(wacSinFix < 300, 'control: sin fix el WAC colapsaba muy por debajo del real');
  assert.notEqual(Math.round(projectedWac), Math.round(wacSinFix));
});

test('reviewer→cart: isNew=true sin coincidencia en catálogo mantiene fallback 0 (no hay histórico contable)', () => {
  // Un producto recién creado todavía puede no estar en el array `products`
  // local al momento de empujarse al carrito. En ese caso NO existe un
  // "oldPurchasePrice" contable y la cadena de fallbacks debe aterrizar en 0.
  const resolved = {
    barcode: 'NEW',
    newPurchasePrice: 1000,
    newSalePrice: 1500,
    marginPercentage: 20,
    iva: 19, icui: 0, ibua: 0,
    isNew: true,
    invoiceName: 'NUEVO',
    supplierId: 1,
  };
  const catalogProduct = undefined; // aún no está en products

  const oldPurchasePrice = Number(catalogProduct?.purchasePrice ?? resolved.oldPurchasePrice ?? 0);
  const oldSalePrice = Number(catalogProduct?.salePrice ?? resolved.oldSalePrice ?? 0);
  assert.equal(oldPurchasePrice, 0);
  assert.equal(oldSalePrice, 0);
});
