import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  INVOICE_FILE_MAX_BYTES,
  clampPercentage,
  entryTypeFromLineType,
  fillInvoiceItemDefaults,
  makeOcrLocalId,
  normalizeLineType,
  resolveCartDiscountFromOcr,
  sanitizeBonusQuantity,
  validateInvoiceFile,
} from '../src/lib/invoice-reader-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receivePage = join(here, '..', 'src', 'app', '(app)', 'inventory', 'receive', 'page.tsx');
const invoiceReaderModal = join(
  here, '..', 'src', 'app', '(app)', 'inventory', 'receive', 'components', 'InvoiceReaderModal.tsx',
);
const unmatchedReviewer = join(
  here, '..', 'src', 'app', '(app)', 'inventory', 'receive', 'components', 'UnmatchedItemsReviewer.tsx',
);

async function readSource(path) {
  const raw = await readFile(path, 'utf8');
  // Elimina comentarios para que las aserciones por regex no capturen
  // menciones en documentación obsoleta.
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS PUROS: validateInvoiceFile / clampPercentage / normalizeLineType
// ─────────────────────────────────────────────────────────────────────────

test('INVOICE_FILE_MAX_BYTES vale exactamente 10 MB', () => {
  assert.equal(INVOICE_FILE_MAX_BYTES, 10 * 1024 * 1024);
});

test('validateInvoiceFile rechaza archivos vacios y no imagen', () => {
  assert.equal(validateInvoiceFile(null).ok, false);
  assert.equal(validateInvoiceFile(undefined).ok, false);
  assert.equal(validateInvoiceFile({ type: 'application/pdf', size: 1024 }).ok, false);
  assert.equal(validateInvoiceFile({ type: 'text/plain', size: 100 }).ok, false);
});

test('validateInvoiceFile acepta imagenes dentro del limite', () => {
  assert.deepEqual(validateInvoiceFile({ type: 'image/jpeg', size: 500 * 1024 }), { ok: true });
  assert.deepEqual(validateInvoiceFile({ type: 'image/png', size: 9 * 1024 * 1024 }), { ok: true });
});

test('validateInvoiceFile rechaza imagenes por encima de 10 MB', () => {
  const result = validateInvoiceFile({ type: 'image/jpeg', size: 11 * 1024 * 1024 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too-large');
  assert.match(String(result.message || ''), /11\.0 MB/);
});

test('clampPercentage tolera NaN, strings y negativos', () => {
  assert.equal(clampPercentage(0), 0);
  assert.equal(clampPercentage(-5), 0);
  assert.equal(clampPercentage('abc'), 0);
  assert.equal(clampPercentage(Number.NaN), 0);
  assert.equal(clampPercentage(null), 0);
  assert.equal(clampPercentage(undefined), 0);
  assert.equal(clampPercentage(42), 42);
  assert.equal(clampPercentage('18'), 18);
  assert.equal(clampPercentage(99.99), 99.99);
  assert.equal(clampPercentage(150), 100, 'debe saturar a 100');
  assert.equal(clampPercentage(1_000_000), 100);
});

test('normalizeLineType uppercase cuando es string, pasa-through si no', () => {
  assert.equal(normalizeLineType('bonus'), 'BONUS');
  assert.equal(normalizeLineType('Return'), 'RETURN');
  assert.equal(normalizeLineType('REGULAR'), 'REGULAR');
  assert.equal(normalizeLineType('weird'), 'WEIRD');
  assert.equal(normalizeLineType(undefined), undefined);
  assert.equal(normalizeLineType(null), null);
});

test('sanitizeBonusQuantity: entero positivo o 0', () => {
  assert.equal(sanitizeBonusQuantity(3), 3);
  assert.equal(sanitizeBonusQuantity(0), 0);
  assert.equal(sanitizeBonusQuantity(-2), 0);
  assert.equal(sanitizeBonusQuantity('5'), 5);
  assert.equal(sanitizeBonusQuantity('abc'), 0);
  assert.equal(sanitizeBonusQuantity(2.7), 2, 'debe truncar a entero');
  assert.equal(sanitizeBonusQuantity(Number.NaN), 0);
  assert.equal(sanitizeBonusQuantity(null), 0);
});

test('makeOcrLocalId produce ids unicos', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(makeOcrLocalId());
  assert.equal(ids.size, 50, 'colisiones en makeOcrLocalId');
  for (const id of ids) {
    assert.match(id, /^ocr-/, 'prefijo por defecto ocr-');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// fillInvoiceItemDefaults: normaliza impuestos, descuento, metadata y asigna id
// ─────────────────────────────────────────────────────────────────────────

test('fillInvoiceItemDefaults clampea impuestos y descuento del backend', () => {
  const out = fillInvoiceItemDefaults({
    invoiceName: 'COCA LATA 330',
    quantity: 12,
    unitPrice: 1500,
    iva_percentage: 19,
    ibua_percentage: 18,
    icui_percentage: 150, // claude confundido — hay que saturar
    discount_percentage: -3, // negativos aplanan a 0
  });
  assert.equal(out.iva_percentage, 19);
  assert.equal(out.ibua_percentage, 18);
  assert.equal(out.icui_percentage, 100);
  assert.equal(out.discount_percentage, 0);
  assert.match(out.__ocrLocalId, /^ocr-/);
});

test('fillInvoiceItemDefaults preserva line_type y bonus_quantity del backend', () => {
  const out = fillInvoiceItemDefaults({
    invoiceName: 'PAN TAJADO',
    quantity: 1,
    unitPrice: 0,
    line_type: 'bonus',
    bonus_quantity: 1,
  });
  assert.equal(out.line_type, 'BONUS');
  assert.equal(out.bonus_quantity, 1);
});

test('fillInvoiceItemDefaults respeta __ocrLocalId si viene del backend', () => {
  const out = fillInvoiceItemDefaults({ __ocrLocalId: 'external-123', invoiceName: 'X' });
  assert.equal(out.__ocrLocalId, 'external-123');
});

test('fillInvoiceItemDefaults tolera input vacio o invalido', () => {
  const outNull = fillInvoiceItemDefaults(null);
  assert.ok(outNull.__ocrLocalId, 'siempre genera un id');
  const outString = fillInvoiceItemDefaults('not-an-object');
  assert.ok(outString.__ocrLocalId);
});

// ─────────────────────────────────────────────────────────────────────────
// entryTypeFromLineType + resolveCartDiscountFromOcr: contrato BONUS/RETURN
// ─────────────────────────────────────────────────────────────────────────

test('entryTypeFromLineType mapea segun el contrato OCR', () => {
  assert.equal(entryTypeFromLineType('BONUS'), 'gift');
  assert.equal(entryTypeFromLineType('bonus'), 'gift');
  assert.equal(entryTypeFromLineType('RETURN'), 'return');
  assert.equal(entryTypeFromLineType('return'), 'return');
  assert.equal(entryTypeFromLineType('REGULAR'), 'purchase');
  assert.equal(entryTypeFromLineType(''), 'purchase');
  assert.equal(entryTypeFromLineType(undefined), 'purchase');
  assert.equal(entryTypeFromLineType(null), 'purchase');
});

test('resolveCartDiscountFromOcr: BONUS fuerza 0 incluso si viene DTO alto', () => {
  assert.equal(resolveCartDiscountFromOcr({ lineType: 'BONUS', discount_percentage: 25 }), 0);
  assert.equal(resolveCartDiscountFromOcr({ lineType: 'bonus', discount_percentage: 99 }), 0);
});

test('resolveCartDiscountFromOcr: RETURN preserva DTO del OCR', () => {
  assert.equal(resolveCartDiscountFromOcr({ lineType: 'RETURN', discount_percentage: 12 }), 12);
  assert.equal(resolveCartDiscountFromOcr({ lineType: 'RETURN', discount_percentage: 0 }), 0);
});

test('resolveCartDiscountFromOcr: REGULAR propaga DTO del OCR con clamp', () => {
  assert.equal(resolveCartDiscountFromOcr({ lineType: 'REGULAR', discount_percentage: 15 }), 15);
  assert.equal(resolveCartDiscountFromOcr({ lineType: 'REGULAR', discount_percentage: 150 }), 100);
  assert.equal(resolveCartDiscountFromOcr({ lineType: undefined, discount_percentage: 5 }), 5);
});

// ─────────────────────────────────────────────────────────────────────────
// GUARDIANES ESTATICOS — InvoiceReaderModal.tsx
// ─────────────────────────────────────────────────────────────────────────

test('InvoiceReaderModal importa validateInvoiceFile desde el helper puro', async () => {
  const src = await readSource(invoiceReaderModal);
  assert.ok(
    /from\s+['"]@\/lib\/invoice-reader-helpers\.mjs['"]/.test(src),
    'debe importar desde @/lib/invoice-reader-helpers.mjs',
  );
  for (const sym of ['validateInvoiceFile', 'fillInvoiceItemDefaults', 'INVOICE_FILE_MAX_BYTES']) {
    assert.ok(new RegExp(`\\b${sym}\\b`).test(src), `InvoiceReaderModal debe usar ${sym}`);
  }
});

test('InvoiceReaderModal es no descartable durante procesamiento (isDismissable + hideCloseButton)', async () => {
  const src = await readSource(invoiceReaderModal);
  assert.ok(
    /isDismissable=\{!isProcessing\}/.test(src),
    'el modal debe aplicar isDismissable={!isProcessing}',
  );
  assert.ok(
    /hideCloseButton=\{isProcessing\}/.test(src),
    'el modal debe aplicar hideCloseButton={isProcessing}',
  );
  assert.ok(
    /isKeyboardDismissDisabled=\{isProcessing\}/.test(src),
    'el modal debe deshabilitar ESC durante procesamiento',
  );
});

test('InvoiceReaderModal expone un Progress accesible mientras procesa', async () => {
  const src = await readSource(invoiceReaderModal);
  assert.ok(
    /isProcessing\s*&&\s*\([\s\S]*?<Progress/.test(src),
    'debe renderizarse <Progress /> dentro del bloque isProcessing',
  );
  assert.ok(
    /role="status"/.test(src) || /aria-live="polite"/.test(src),
    'el bloque de procesamiento debe exponer role=status o aria-live=polite',
  );
});

test('InvoiceReaderModal envia expectedTaxes al endpoint OCR', async () => {
  const src = await readSource(invoiceReaderModal);
  assert.ok(
    /expectedTaxes:\s*\{\s*iva:\s*expectIVA/.test(src),
    'el payload debe incluir expectedTaxes: { iva: expectIVA, ibua: expectIBUA, icui: false }',
  );
});

test('InvoiceReaderModal NO reasigna defaults monetarios ni manipula discount en frontend', async () => {
  const src = await readSource(invoiceReaderModal);
  // La función `fillTaxDefaults` legacy inyectaba 19/20 como fallback. El
  // contrato nuevo delega esa normalización al backend; en el frontend NO
  // debe aparecer un bloque que fuerce defaults sobre impuestos leídos de OCR.
  assert.ok(
    !/const\s+fillTaxDefaults\s*=/.test(src),
    'el frontend ya no debe tener fillTaxDefaults — el backend normaliza impuestos',
  );
});

// ─────────────────────────────────────────────────────────────────────────
// GUARDIANES ESTATICOS — page.tsx (receive)
// ─────────────────────────────────────────────────────────────────────────

test('receive/page.tsx aplica admin gate al boton "Leer Factura"', async () => {
  const src = await readSource(receivePage);
  // El boton debe estar envuelto en una condicion showAdminControls && (...)
  const buttonBlock = /showAdminControls\s*&&\s*\(\s*<button[\s\S]{0,500}setIsInvoiceReaderOpen\(true\)/;
  assert.ok(
    buttonBlock.test(src),
    'el boton Leer Factura debe estar envuelto en {showAdminControls && (<button ...>)}',
  );
});

test('receive/page.tsx monta el InvoiceReaderModal sólo para admin (defense in depth)', async () => {
  const src = await readSource(receivePage);
  assert.ok(
    /showAdminControls\s*&&\s*\(\s*<InvoiceReaderModal/.test(src),
    'el InvoiceReaderModal debe montar sólo bajo showAdminControls',
  );
});

test('handleInvoiceMatch propaga discount_percentage al carrito en la rama match', async () => {
  const src = await readSource(receivePage);
  // En la rama match (producto encontrado por barcode) el DTO viaja como
  // porcentaje puro desde el OCR. No puede caer el `?? ocr.discount` monetario.
  assert.ok(
    !/discount:\s*\(isBonus\s*\|\|\s*isReturn\)\s*\?\s*0\s*:\s*Number\(ocr\.discount_percentage\s*\?\?\s*ocr\.discount/.test(src),
    'eliminado el fallback a ocr.discount (monto) — debe usar solo discount_percentage',
  );
  assert.ok(
    /discount:\s*isBonus\s*\?\s*0\s*:\s*ocrDtoPct/.test(src),
    'la rama match debe asignar discount: isBonus ? 0 : ocrDtoPct',
  );
});

test('handleInvoiceMatch actualiza discount en la rama "existe en carrito"', async () => {
  const src = await readSource(receivePage);
  // Antes la rama existente SOLO actualizaba IVA/ICUI/IBUA, perdía DTO.
  assert.ok(
    /newList\[existIdx\]\.discount\s*=\s*newDiscount/.test(src),
    'la rama "existe en carrito" debe propagar newDiscount al row',
  );
  // Y debe elevar matchStatus a warning cuando cambie el DTO del OCR.
  assert.ok(
    /discountChanged[\s\S]*?matchStatus\s*=\s*['"]warning['"]/.test(src),
    'si el DTO cambia, matchStatus debe ser "warning"',
  );
});

test('handleInvoiceMatch empuja TODA la metadata del OCR al unmatchedQueue', async () => {
  const src = await readSource(receivePage);
  // La cola de no emparejados debe recibir impuestos, DTO, lineType y bonus
  // para que el reviewer pueda proyectar fiscalmente los items sin volver a
  // llamar al OCR. Buscamos todos los campos en el mismo bloque unmatched.push({...}).
  const pushMatch = src.match(/unmatched\.push\(\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(pushMatch, 'no se encontró unmatched.push({ ... }) en handleInvoiceMatch');
  const block = pushMatch[1];
  for (const field of [
    'iva_percentage',
    'ibua_percentage',
    'icui_percentage',
    'discount_percentage',
    'lineType',
    'bonus_quantity',
    '__ocrLocalId',
  ]) {
    assert.ok(
      block.includes(field),
      `handleInvoiceMatch debe empujar ${field} al unmatchedQueue`,
    );
  }
});

test('handleUnmatchedResolved usa r.discount, no 0 fijo, y respeta lineType BONUS/RETURN', async () => {
  const src = await readSource(receivePage);
  // No puede quedar un `discount: 0` hardcoded dentro del push de la rama
  // "producto no existe aún en carrito".
  assert.ok(
    !/matchStatus:\s*r\.isNew\s*\?\s*['"]extra['"]\s*:\s*['"]match['"][\s\S]{0,200}discount:\s*0[,\n]/.test(src),
    'eliminado el discount: 0 hardcoded — debe venir de r.discount',
  );
  assert.ok(
    /discount:\s*resolvedDiscount/.test(src),
    'debe asignar discount: resolvedDiscount en el push',
  );
  // El entryType debe derivarse del lineType, no quedar fijo en 'purchase'.
  assert.ok(
    /resolvedEntryType/.test(src),
    'debe computar resolvedEntryType a partir del lineType del reviewer',
  );
});

test('handleRequestCreateFromReviewer propaga discount_percentage al nuevo producto', async () => {
  const src = await readSource(receivePage);
  // El contrato con el ProductFormModal: el prefill incluye discount_percentage
  // y se asigna como `discount` en el modelo nuevo.
  assert.ok(
    /discount_percentage:\s*number/.test(src),
    'el prefill debe tipar discount_percentage: number',
  );
  assert.ok(
    /discount:\s*clampPct\(prefill\.discount_percentage\)/.test(src),
    'debe mapear prefill.discount_percentage → newProduct.discount con clamp',
  );
});

// ─────────────────────────────────────────────────────────────────────────
// GUARDIANES ESTATICOS — UnmatchedItemsReviewer.tsx
// ─────────────────────────────────────────────────────────────────────────

test('UnmatchedItem tipado con discount_percentage, lineType, bonus_quantity y __ocrLocalId', async () => {
  const src = await readSource(unmatchedReviewer);
  for (const field of ['discount_percentage?:', 'lineType?:', 'bonus_quantity?:', '__ocrLocalId?:']) {
    assert.ok(
      src.includes(field),
      `UnmatchedItem debe declarar ${field}`,
    );
  }
});

test('ResolvedReceiveLine incluye discount: number', async () => {
  const src = await readSource(unmatchedReviewer);
  assert.ok(
    /discount:\s*number;/.test(src),
    'ResolvedReceiveLine debe declarar discount: number;',
  );
});

test('CreateProductPrefill incluye discount_percentage: number', async () => {
  const src = await readSource(unmatchedReviewer);
  assert.ok(
    /discount_percentage:\s*number;/.test(src),
    'CreateProductPrefill debe declarar discount_percentage: number;',
  );
});

test('UnmatchedItemsReviewer usa precio y margen del catálogo al asignar a existente', async () => {
  const src = await readSource(unmatchedReviewer);
  // El helper buildResolvedForExisting debe usar Number(prod.salePrice) y
  // Number(prod.marginPercentage), NO hardcodear 0/20.
  assert.ok(
    /newSalePrice:\s*Number\(prod\.salePrice\)/.test(src),
    'buildResolvedForExisting debe tomar newSalePrice del catálogo (prod.salePrice)',
  );
  assert.ok(
    /marginPercentage:\s*Number\(prod\.marginPercentage\)/.test(src),
    'buildResolvedForExisting debe tomar marginPercentage del catálogo',
  );
  assert.ok(
    /oldPurchasePrice:\s*Number\(prod\.purchasePrice\)/.test(src),
    'buildResolvedForExisting debe hidratar oldPurchasePrice desde el catálogo',
  );
});

test('UnmatchedItemsReviewer propaga discount en las 3 ramas (sugerencia, manual, escáner)', async () => {
  const src = await readSource(unmatchedReviewer);
  // Las tres ramas pasan por buildResolvedForExisting o lo mismo via
  // discountForCart. Verificamos que la función exista y se use.
  assert.ok(
    /function discountForCart\(/.test(src),
    'debe existir el helper discountForCart',
  );
  assert.ok(
    /discount:\s*discountForCart\(item\)/.test(src),
    'buildResolvedForExisting debe usar discountForCart para el DTO del reviewer',
  );
});

test('UnmatchedItemsReviewer: handleGoBack usa identidad estable (__ocrLocalId / stableKeyFor)', async () => {
  const src = await readSource(unmatchedReviewer);
  // Ya no debe filtrar por invoiceName solo, que falla cuando dos items
  // tienen el mismo nombre (BONUS repetido, saltos de pagina).
  assert.ok(
    /function stableKeyFor\(/.test(src),
    'debe existir el helper stableKeyFor para identidad estable',
  );
  assert.ok(
    /__ocrLocalId/.test(src),
    'handleGoBack debe referenciar __ocrLocalId',
  );
});

test('UnmatchedItemsReviewer no es descartable (preserva resoluciones en progreso)', async () => {
  const src = await readSource(unmatchedReviewer);
  assert.ok(
    /isDismissable=\{false\}/.test(src),
    'el reviewer debe mantener isDismissable={false}',
  );
  assert.ok(
    /hideCloseButton\b/.test(src),
    'el reviewer debe mantener hideCloseButton',
  );
});

// ─────────────────────────────────────────────────────────────────────────
// SNAPSHOT contractual del payload bulk-receive (sin ejecutar handleConfirmReceive):
// verifica que la construcción del `entries` no reintroduzca el bug donde
// `discount` (monto) viajaba al backend como "monto por unidad". El backend
// no lo lee, pero mantenerlo invita a interpretaciones ambiguas aguas abajo.
// Dejamos sitio para que un futuro refactor lo elimine o renombre.
// ─────────────────────────────────────────────────────────────────────────

test('payload /products/bulk-receive separa discountPct (%) de discount (monto trazabilidad)', async () => {
  const src = await readSource(receivePage);
  // discountPct debe ser el porcentaje puro.
  assert.ok(
    /discountPct:\s*discountPct/.test(src),
    'el payload debe mandar discountPct como porcentaje puro',
  );
  // Y la rama que convierte a monto debe seguir siendo multiplicativa:
  // unitDiscountAmount = priceWithTaxes * (discountPct / 100). Si alguien
  // la cambia para RESTAR del costo, el backend fiscal se rompe.
  assert.ok(
    /unitDiscountAmount\s*=\s*priceWithTaxes\s*\*\s*\(discountPct\s*\/\s*100\)/.test(src),
    'unitDiscountAmount debe calcularse como priceWithTaxes * discountPct/100',
  );
});

test('receive/page.tsx: BONUS fuerza newPurchasePrice=0 en el entry', async () => {
  const src = await readSource(receivePage);
  assert.ok(
    /newPurchasePrice:\s*isGift\s*\?\s*0\s*:\s*basePrice/.test(src),
    'el entry debe forzar newPurchasePrice=0 cuando entryType=gift (BONUS)',
  );
});

test('receive/page.tsx: RETURN envia addedQuantity negativo', async () => {
  const src = await readSource(receivePage);
  assert.ok(
    /addedQuantity:\s*isReturn\s*\?\s*-finalQuantity\s*:\s*finalQuantity/.test(src),
    'el entry debe negar la cantidad cuando entryType=return',
  );
});
