import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * GUARDIÁN estático: handleUnmatchedResolved debe hidratar oldPurchasePrice y
 * oldSalePrice desde el catálogo (`p`) cuando la ResolvedReceiveLine del
 * UnmatchedItemsReviewer no los transporta.
 *
 * Por qué importa: el reviewer sólo acarrea datos de la factura (unitPrice OCR
 * ↔ newPurchasePrice base), no el histórico contable. Si se pushea con
 * oldPurchasePrice=0 pero currentStock=p.quantity>0, ReceptionRow proyecta
 * un WAC colapsado (viejo contado como regalo) y sugiere un PVP mucho más
 * bajo del real. Mantener el fallback al catálogo preserva la coherencia
 * del punto (3) del contrato de recepción.
 */

const here = dirname(fileURLToPath(import.meta.url));
const receivePage = join(
  here, '..', 'src', 'app', '(app)', 'inventory', 'receive', 'page.tsx',
);

async function readSource(path) {
  const raw = await readFile(path, 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('handleUnmatchedResolved cae al catálogo para oldPurchasePrice gross', async () => {
  const src = await readSource(receivePage);

  const purchaseFallback = /oldPurchasePrice:\s*Number\(\s*p\?\.purchasePrice\s*\?\?\s*r\.oldPurchasePrice\s*\?\?\s*0\s*\)/;
  assert.ok(
    purchaseFallback.test(src),
    'handleUnmatchedResolved debe setear oldPurchasePrice: Number(p?.purchasePrice ?? r.oldPurchasePrice ?? 0). ' +
    'Si no, la proyección WAC en ReceptionRow colapsa cuando el reviewer asigna un item a un producto existente con stock.',
  );
});

test('handleUnmatchedResolved cae al catálogo para oldSalePrice', async () => {
  const src = await readSource(receivePage);

  const saleFallback = /oldSalePrice:\s*Number\(\s*p\?\.salePrice\s*\?\?\s*r\.oldSalePrice\s*\?\?\s*0\s*\)/;
  assert.ok(
    saleFallback.test(src),
    'handleUnmatchedResolved debe setear oldSalePrice: Number(p?.salePrice ?? r.oldSalePrice ?? 0). ' +
    'Si no, la UI muestra "Precio anterior: $0" cuando el reviewer asigna a producto existente.',
  );
});

/**
 * GUARDIÁN del contrato OCR del inventario de recepción: los helpers canónicos
 * (resolveBasePrice, resolveEffectivePercentage, grossToBasePrice) deben estar
 * importados y usados en page.tsx para los cuatro puntos de entrada:
 * metadata (fetchEditReception), OCR (handleInvoiceMatch), productos (addToReceive)
 * y órdenes (loadOrderIntoList).
 */

test('page.tsx importa los helpers canónicos de reception-pricing', async () => {
  const src = await readSource(receivePage);
  const importBlock = /from\s+['"]@\/lib\/reception-pricing\.mjs['"]/;
  assert.ok(importBlock.test(src), 'page.tsx debe importar desde @/lib/reception-pricing.mjs');

  for (const sym of ['resolveBasePrice', 'resolveEffectivePercentage', 'grossToBasePrice', 'calculateMarginFromGross']) {
    assert.ok(
      new RegExp(`\\b${sym}\\b`).test(src),
      `page.tsx debe usar ${sym} para mantener el contrato BASE/GROSS canónico`,
    );
  }
});

test('fetchEditReception respeta metadata.newPurchasePrice como base (incluido 0) con fallback gross', async () => {
  const src = await readSource(receivePage);
  // Debe aparecer resolveBasePrice(meta.newPurchasePrice, item.product?.purchasePrice, ...)
  const metaCall = /resolveBasePrice\s*\(\s*meta\.newPurchasePrice\s*,\s*item\.product\?\.purchasePrice/;
  assert.ok(
    metaCall.test(src),
    'fetchEditReception debe usar resolveBasePrice(meta.newPurchasePrice, item.product?.purchasePrice, …).',
  );
});

test('handleInvoiceMatch respeta ocr.costUnit como base (incluido 0) con fallback gross p.purchasePrice', async () => {
  const src = await readSource(receivePage);
  const ocrCall = /resolveBasePrice\s*\(\s*ocr\.costUnit\s*,\s*p\.purchasePrice/;
  assert.ok(
    ocrCall.test(src),
    'handleInvoiceMatch debe usar resolveBasePrice(ocr.costUnit, p.purchasePrice, …).',
  );
  const marginCall = /calculateMarginFromGross\s*\(\s*p\.purchasePrice/;
  assert.ok(
    marginCall.test(src),
    'handleInvoiceMatch debe pasar p.purchasePrice (gross) a calculateMarginFromGross sin reaplicar impuestos.',
  );
});

test('handleInvoiceMatch, rama "match existente": ocr.costUnit se asigna directo como base', async () => {
  const src = await readSource(receivePage);
  // Al actualizar una línea ya existente, se asigna sin dividir por impuestos.
  const directAssign = /newList\[existIdx\]\.newPurchasePrice\s*=\s*Number\(ocr\.costUnit\)/;
  assert.ok(
    directAssign.test(src),
    'La rama de match existente debe asignar Number(ocr.costUnit) tal cual (ya es BASE).',
  );
});

test('addToReceive convierte products.purchasePrice gross a base exactamente una vez', async () => {
  const src = await readSource(receivePage);
  // grossToBasePrice(Number(product.purchasePrice), iva, icui, ibua)
  const gross = /grossToBasePrice\s*\(\s*Number\(product\.purchasePrice\)/;
  assert.ok(
    gross.test(src),
    'addToReceive debe descomponer product.purchasePrice (gross) UNA sola vez vía grossToBasePrice.',
  );
});

test('loadOrderIntoList interpreta el costo del pedido (base o bruto) con resolveOrderBasePrice', async () => {
  const src = await readSource(receivePage);
  const orderCall = /resolveOrderBasePrice\s*\(\s*explicitOrderCost\s*,\s*p\.purchasePrice/;
  assert.ok(
    orderCall.test(src),
    'loadOrderIntoList debe usar resolveOrderBasePrice(explicitOrderCost, p.purchasePrice, …).',
  );
});
