import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  INVOICE_FILE_MAX_BYTES,
  PACK_MIN_UNITS,
  PACK_MAX_UNITS,
  PACK_MODE_EMPAQUE,
  PACK_MODE_PRESENTACION,
  anyItemRequiresPackConfirmation,
  classifyPackMode,
  clampPercentage,
  convertItemAsPresentation,
  convertItemToIndividualUnits,
  entryTypeFromLineType,
  fillInvoiceItemDefaults,
  getPackHintUnits,
  isValidUnitsPerPack,
  itemRequiresPackConfirmation,
  makeOcrLocalId,
  neutralizeTaxFields,
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

test('InvoiceReaderModal es no descartable durante procesamiento y revisión de empaques', async () => {
  const src = await readSource(invoiceReaderModal);
  // Nuevo contrato: el modal es no-descartable mientras:
  //   - el OCR está en vuelo (isProcessing), O
  //   - se está confirmando el multiplicador de empaques (isCommittingPacks), O
  //   - el usuario está en la etapa interna de revisión de empaques
  //     (stage === 'packReview'), para preservar los items retenidos.
  assert.ok(
    /isDismissable=\{!isProcessing\s*&&\s*!isCommittingPacks\s*&&\s*stage\s*!==\s*['"]packReview['"]\}/.test(src),
    'isDismissable debe contemplar isProcessing, isCommittingPacks y la etapa packReview',
  );
  assert.ok(
    /hideCloseButton=\{isProcessing\s*\|\|\s*isCommittingPacks\}/.test(src),
    'hideCloseButton debe cubrir isProcessing e isCommittingPacks',
  );
  assert.ok(
    /isKeyboardDismissDisabled=\{isProcessing\s*\|\|\s*isCommittingPacks\s*\|\|\s*stage\s*===\s*['"]packReview['"]\}/.test(src),
    'ESC debe quedar bloqueado en procesamiento, commit de empaques y revisión',
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

test('InvoiceReaderModal envia expectedTaxes al endpoint OCR con las 3 opciones independientes', async () => {
  const src = await readSource(invoiceReaderModal);
  // Contrato: `expectedTaxes` refleja exactamente los 3 flags del usuario.
  // Antes el frontend fijaba `icui: false` porque la UI legacy combinaba
  // IBUA/ICUI en un solo toggle. Ahora cada impuesto tiene su propio bool.
  assert.ok(
    /expectedTaxes:\s*\{\s*iva:\s*expectIVA\s*,\s*ibua:\s*expectIBUA\s*,\s*icui:\s*expectICUI\s*,?\s*\}/.test(src),
    'el payload debe incluir expectedTaxes: { iva: expectIVA, ibua: expectIBUA, icui: expectICUI }',
  );
  // Y los tres toggles deben vivir en estado independiente (useState).
  for (const sym of ['expectIVA', 'expectIBUA', 'expectICUI']) {
    assert.ok(
      new RegExp(`setExpectI(VA|BUA|CUI)`).test(src),
      `debe existir setter para ${sym}`,
    );
    assert.ok(
      new RegExp(`\\b${sym}\\b`).test(src),
      `debe existir el estado ${sym}`,
    );
  }
});

test('InvoiceReaderModal reinicia IVA, IBUA e ICUI al cerrar para cada nueva factura', async () => {
  const src = await readSource(invoiceReaderModal);
  const reset = src.match(/const\s+resetAllState\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\};/);
  assert.ok(reset, 'debe existir resetAllState');
  for (const setter of ['setExpectIVA(false)', 'setExpectIBUA(false)', 'setExpectICUI(false)']) {
    assert.ok(
      reset[1].includes(setter),
      `resetAllState debe ejecutar ${setter} para exigir selección explícita por factura`,
    );
  }
});

test('InvoiceReaderModal neutraliza defensivamente los impuestos no esperados', async () => {
  const src = await readSource(invoiceReaderModal);
  // Antes de pasar al padre, cualquier porcentaje residual en los campos
  // iva/ibua/icui (matched) o *_percentage (unmatched) se aplana a 0 si el
  // usuario no marcó el checkbox. Se delega al helper puro neutralizeTaxFields.
  assert.ok(
    /neutralizeTaxFields\s*\(/.test(src),
    'el modal debe llamar neutralizeTaxFields antes de propagar',
  );
  assert.ok(
    /from\s+['"]@\/lib\/invoice-reader-helpers\.mjs['"]/.test(src)
    && /\bneutralizeTaxFields\b/.test(src),
    'neutralizeTaxFields debe importarse desde el helper puro',
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

// ─────────────────────────────────────────────────────────────────────────
// HELPERS PUROS DE IMPUESTOS ESPERADOS: neutralización defensiva
// ─────────────────────────────────────────────────────────────────────────

test('neutralizeTaxFields sin expectedTaxes retorna copia sin modificar valores', () => {
  const item = { iva: 19, ibua: 18, icui: 8, iva_percentage: 19, ibua_percentage: 18, icui_percentage: 8 };
  const out = neutralizeTaxFields(item);
  assert.notStrictEqual(out, item, 'debe retornar una copia, nunca el mismo objeto');
  assert.equal(out.iva, 19);
  assert.equal(out.ibua, 18);
  assert.equal(out.icui, 8);
});

test('neutralizeTaxFields aplana a 0 los campos NO marcados por el usuario', () => {
  const item = {
    invoiceName: 'COCA LATA 330',
    quantity: 10,
    unitPrice: 1500,
    iva: 19, ibua: 18, icui: 8,
    iva_percentage: 19, ibua_percentage: 18, icui_percentage: 8,
    discount_percentage: 5,
  };
  const out = neutralizeTaxFields(item, { iva: true, ibua: false, icui: false });
  assert.equal(out.iva, 19, 'IVA marcado se preserva');
  assert.equal(out.iva_percentage, 19, 'IVA en shape unmatched se preserva');
  assert.equal(out.ibua, 0, 'IBUA no marcado se aplana');
  assert.equal(out.ibua_percentage, 0);
  assert.equal(out.icui, 0, 'ICUI no marcado se aplana');
  assert.equal(out.icui_percentage, 0);
  assert.equal(out.discount_percentage, 5, 'no toca otros campos');
  assert.equal(out.invoiceName, 'COCA LATA 330');
});

test('neutralizeTaxFields: TODOS marcados → nada se neutraliza', () => {
  const item = { iva: 19, ibua: 18, icui: 8 };
  const out = neutralizeTaxFields(item, { iva: true, ibua: true, icui: true });
  assert.equal(out.iva, 19);
  assert.equal(out.ibua, 18);
  assert.equal(out.icui, 8);
});

test('neutralizeTaxFields: NINGUNO marcado → los 3 impuestos quedan en 0', () => {
  const item = {
    iva: 19, ibua: 18, icui: 8,
    iva_percentage: 19, ibua_percentage: 18, icui_percentage: 8,
  };
  const out = neutralizeTaxFields(item, { iva: false, ibua: false, icui: false });
  assert.equal(out.iva, 0);
  assert.equal(out.ibua, 0);
  assert.equal(out.icui, 0);
  assert.equal(out.iva_percentage, 0);
  assert.equal(out.ibua_percentage, 0);
  assert.equal(out.icui_percentage, 0);
});

test('neutralizeTaxFields tolera null/undefined sin lanzar', () => {
  assert.equal(neutralizeTaxFields(null, { iva: true, ibua: false, icui: false }), null);
  assert.equal(neutralizeTaxFields(undefined, { iva: true, ibua: false, icui: false }), undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// HELPERS PUROS DE EMPAQUES: hints, validación, conversión numérica
// ─────────────────────────────────────────────────────────────────────────

test('PACK_MIN_UNITS y PACK_MAX_UNITS tienen rangos coherentes con el negocio', () => {
  assert.equal(PACK_MIN_UNITS, 2, 'el mínimo debe ser 2 (empaque de 1 no es empaque)');
  assert.equal(PACK_MAX_UNITS, 999);
});

test('getPackHintUnits acepta packHintUnits y pack_hint_units; rechaza <2', () => {
  assert.equal(getPackHintUnits({ packHintUnits: 24 }), 24);
  assert.equal(getPackHintUnits({ pack_hint_units: 20 }), 20, 'snake_case defensivo');
  assert.equal(getPackHintUnits({ packHintUnits: '18' }), 18, 'tolera strings');
  assert.equal(getPackHintUnits({ packHintUnits: 1 }), 0, '1 no es empaque');
  assert.equal(getPackHintUnits({ packHintUnits: 0 }), 0);
  assert.equal(getPackHintUnits({ packHintUnits: -5 }), 0);
  assert.equal(getPackHintUnits({ packHintUnits: Number.NaN }), 0);
  assert.equal(getPackHintUnits(null), 0);
  assert.equal(getPackHintUnits(undefined), 0);
  assert.equal(getPackHintUnits({}), 0);
});

test('itemRequiresPackConfirmation exige flag true Y hint >= 2', () => {
  assert.equal(itemRequiresPackConfirmation({ requiresPackConfirmation: true, packHintUnits: 24 }), true);
  assert.equal(itemRequiresPackConfirmation({ requires_pack_confirmation: true, pack_hint_units: 18 }), true);
  assert.equal(itemRequiresPackConfirmation({ requiresPackConfirmation: false, packHintUnits: 24 }), false, 'flag en false → no confirma');
  assert.equal(itemRequiresPackConfirmation({ requiresPackConfirmation: true, packHintUnits: 1 }), false, 'hint < 2 → no confirma');
  assert.equal(itemRequiresPackConfirmation({ requiresPackConfirmation: true }), false, 'sin hint → no confirma');
  assert.equal(itemRequiresPackConfirmation({ packHintUnits: 20 }), false, 'sin flag → no confirma');
  assert.equal(itemRequiresPackConfirmation(null), false);
});

test('anyItemRequiresPackConfirmation: true si al menos uno lo requiere', () => {
  assert.equal(anyItemRequiresPackConfirmation([]), false);
  assert.equal(anyItemRequiresPackConfirmation(null), false);
  assert.equal(anyItemRequiresPackConfirmation(undefined), false);
  assert.equal(anyItemRequiresPackConfirmation([
    { requiresPackConfirmation: false, packHintUnits: 24 },
    { requiresPackConfirmation: false, packHintUnits: 10 },
  ]), false);
  assert.equal(anyItemRequiresPackConfirmation([
    { requiresPackConfirmation: false },
    { requiresPackConfirmation: true, packHintUnits: 20 },
  ]), true);
});

test('isValidUnitsPerPack: entero estrictamente en [2, 999]', () => {
  // Enteros válidos
  for (const v of [2, 24, 100, 999, '18', '2', '999']) {
    assert.equal(isValidUnitsPerPack(v), true, `${JSON.stringify(v)} debería ser válido`);
  }
  // Fuera de rango o no-entero
  for (const v of [0, 1, 1000, 1500, -5, 2.5, '2.5', '24.0', 'abc', '', '  ', null, undefined, {}, [], true, Number.NaN]) {
    assert.equal(isValidUnitsPerPack(v), false, `${JSON.stringify(v)} debería ser inválido`);
  }
});

// Conversiones numéricas obligatorias por contrato
test('convertItemToIndividualUnits: unmatched 1 paquete × 20 unidades → qty 20 / costo /20', () => {
  const item = {
    isMatched: false,
    invoiceName: 'LECHE X 20',
    quantity: 1,
    unitPrice: 60000,
    requiresPackConfirmation: true,
    packHintUnits: 20,
  };
  const out = convertItemToIndividualUnits(item, 20);
  assert.equal(out.quantity, 20);
  assert.equal(out.unitPrice, 3000, 'costo paquete / 20 = 3000');
  assert.equal(out.invoicePackageQuantity, 1);
  assert.equal(out.confirmedUnitsPerPack, 20);
  assert.equal(out.packConversionApplied, true);
  // Valor total de la línea preservado: 1 × 60000 = 20 × 3000 = 60000
  assert.equal(out.quantity * out.unitPrice, item.quantity * item.unitPrice);
});

test('convertItemToIndividualUnits: unmatched 2 paquetes × 18 unidades → qty 36', () => {
  const item = {
    isMatched: false,
    invoiceName: 'GASEOSA X 18',
    quantity: 2,
    unitPrice: 36000,
  };
  const out = convertItemToIndividualUnits(item, 18);
  assert.equal(out.quantity, 36);
  assert.equal(out.unitPrice, 2000, '36000 / 18 = 2000');
  assert.equal(out.invoicePackageQuantity, 2);
  assert.equal(out.confirmedUnitsPerPack, 18);
  // Valor total preservado: 2 × 36000 = 36 × 2000 = 72000
  assert.equal(out.quantity * out.unitPrice, item.quantity * item.unitPrice);
});

test('convertItemToIndividualUnits: matched 1 paquete × 24 → costUnit y pvpSugerido correctamente escalados', () => {
  const item = {
    isMatched: true,
    barcode: '7700000000124',
    productName: 'COCA LATA 330',
    quantity: 1,
    costUnit: 48000,
    costoReal: 48000,
    pvpSugerido: 72000,
    pvpActual: 3200, // ya es unitario; se preserva
    currentStock: 50,
    currentWac: 2000,
    marginUsed: 30,
  };
  const out = convertItemToIndividualUnits(item, 24);
  assert.equal(out.quantity, 24);
  assert.equal(out.costUnit, 2000, 'costo paquete / 24 = 2000');
  assert.equal(out.costoReal, 2000, 'costo real también se divide');
  assert.equal(out.pvpSugerido, 3000, 'PVP sugerido 72000 / 24 = 3000 (entero)');
  // Campos "por producto" no se tocan
  assert.equal(out.pvpActual, 3200, 'PVP actual intacto');
  assert.equal(out.currentStock, 50, 'currentStock intacto');
  assert.equal(out.currentWac, 2000, 'currentWac intacto');
  assert.equal(out.marginUsed, 30, 'marginUsed intacto');
  // Trazabilidad
  assert.equal(out.invoicePackageQuantity, 1);
  assert.equal(out.confirmedUnitsPerPack, 24);
  assert.equal(out.packConversionApplied, true);
  // Valor total costo preservado: 1 × 48000 = 24 × 2000
  assert.equal(out.quantity * out.costUnit, item.quantity * item.costUnit);
});

test('convertItemToIndividualUnits: pvpSugerido redondea coherentemente a entero', () => {
  // 55000 / 24 = 2291.666... → debe quedar en 2292 (round half away from zero)
  const out = convertItemToIndividualUnits(
    { isMatched: true, quantity: 1, costUnit: 48000, pvpSugerido: 55000 },
    24,
  );
  assert.equal(out.pvpSugerido, 2292);
});

test('convertItemToIndividualUnits: bonus_quantity escala por N', () => {
  const out = convertItemToIndividualUnits(
    { isMatched: false, invoiceName: 'PACK 2x1', quantity: 2, unitPrice: 50000, bonus_quantity: 1 },
    24,
  );
  assert.equal(out.quantity, 48);
  assert.equal(out.bonus_quantity, 24, 'bonus 1 paquete regalado → 24 unidades regaladas');
});

test('convertItemToIndividualUnits: totalPrice NO se divide (ya refleja la línea completa)', () => {
  const out = convertItemToIndividualUnits(
    { isMatched: false, quantity: 2, unitPrice: 36000, totalPrice: 72000 },
    18,
  );
  assert.equal(out.totalPrice, 72000, 'totalPrice se preserva intacto');
  assert.equal(out.unitPrice, 2000);
  assert.equal(out.quantity, 36);
});

test('convertItemToIndividualUnits: unitsPerPack inválido retorna copia superficial sin modificar', () => {
  const item = { quantity: 2, unitPrice: 36000, costUnit: 36000 };
  for (const bad of [0, 1, 1.5, -5, 'abc', '', null, undefined, {}]) {
    const out = convertItemToIndividualUnits(item, bad);
    assert.equal(out.quantity, 2, `${JSON.stringify(bad)} no debe modificar quantity`);
    assert.equal(out.unitPrice, 36000);
    assert.equal(out.costUnit, 36000);
    assert.ok(!out.packConversionApplied, 'no debe marcar como aplicado si el input es inválido');
  }
});

test('convertItemToIndividualUnits: tolera input vacío', () => {
  assert.equal(convertItemToIndividualUnits(null, 24), null);
  assert.equal(convertItemToIndividualUnits(undefined, 24), undefined);
});

test('convertItemToIndividualUnits: no toca campos ausentes en el input', () => {
  const out = convertItemToIndividualUnits(
    { isMatched: true, quantity: 1, costUnit: 48000 },
    24,
  );
  assert.ok(!('unitPrice' in out), 'no debe inventar unitPrice si no vino en el input');
  assert.ok(!('pvpSugerido' in out), 'no debe inventar pvpSugerido');
  assert.ok(!('costoReal' in out), 'no debe inventar costoReal');
  assert.ok(!('bonus_quantity' in out), 'no debe inventar bonus_quantity');
});

// ─────────────────────────────────────────────────────────────────────────
// GUARDIANES ESTATICOS adicionales: etapa interna de empaques
// ─────────────────────────────────────────────────────────────────────────

test('InvoiceReaderModal expone 3 toggles independientes para IVA / IBUA / ICUI', async () => {
  const src = await readSource(invoiceReaderModal);
  // Cada toggle tiene su propio useState y setter. La UI es un grid de 3
  // elementos con role="group" para accesibilidad.
  for (const name of ['expectIVA', 'expectIBUA', 'expectICUI']) {
    assert.ok(
      new RegExp(`\\b${name}\\b`).test(src),
      `debe existir el estado ${name}`,
    );
  }
  assert.ok(
    /setExpectIVA\(/.test(src) && /setExpectIBUA\(/.test(src) && /setExpectICUI\(/.test(src),
    'cada toggle debe tener su setter',
  );
  assert.ok(
    /role="group"/.test(src),
    'el bloque de 3 toggles debe exponer role=group para lectores de pantalla',
  );
});

test('InvoiceReaderModal mantiene stage interno packReview y retiene items', async () => {
  const src = await readSource(invoiceReaderModal);
  // La máquina de estado interna del modal: 'upload' | 'packReview'. En
  // packReview no se dispara onExtractedItems ni se cierra; se almacenan los
  // items retenidos y las filas con sus multiplicadores.
  assert.ok(/stage/.test(src) && /['"]packReview['"]/.test(src), 'debe existir una stage "packReview"');
  assert.ok(/pendingItems/.test(src), 'debe retener los items hasta confirmar');
  assert.ok(/packReviewRows/.test(src), 'debe armar la lista de filas de revisión');
  // La política es SIEMPRE individual: no debe existir un botón o rama de
  // "conservar paquete".
  assert.ok(
    !/conservar paquete/i.test(src),
    'el modal NO debe ofrecer la opción de conservar paquete',
  );
});

test('InvoiceReaderModal gatea onExtractedItems detrás del commit de empaques', async () => {
  const src = await readSource(invoiceReaderModal);
  // El commit sólo puede ejecutarse si todas las filas son enteros válidos
  // en el rango permitido (allRowsValid). Esta variable debe existir y
  // alimentar el disabled del botón de confirmar.
  assert.ok(/const\s+allRowsValid\s*=/.test(src), 'debe existir el guard allRowsValid');
  assert.ok(
    /isDisabled=\{!allRowsValid\s*\|\|\s*isCommittingPacks\}/.test(src),
    'el botón de confirmar debe deshabilitarse si allRowsValid=false',
  );
  // Y debe invocar convertItemToIndividualUnits del helper puro para la
  // conversión final.
  assert.ok(
    /convertItemToIndividualUnits\s*\(/.test(src),
    'el modal debe aplicar convertItemToIndividualUnits al confirmar',
  );
});

test('InvoiceReaderModal usa anyItemRequiresPackConfirmation para decidir la rama', async () => {
  const src = await readSource(invoiceReaderModal);
  assert.ok(
    /anyItemRequiresPackConfirmation\s*\(/.test(src),
    'el modal debe consultar anyItemRequiresPackConfirmation antes de cerrar',
  );
  // isValidUnitsPerPack se usa para validar cada input de la etapa interna.
  assert.ok(
    /isValidUnitsPerPack\s*\(/.test(src),
    'cada fila de la etapa interna debe validar con isValidUnitsPerPack',
  );
});

test('InvoiceReaderModal input de empaque: entero requerido con rango accesible', async () => {
  const src = await readSource(invoiceReaderModal);
  // Debe exponer:
  //   - inputMode="numeric" para teclado móvil
  //   - required (confirmación obligatoria por fila)
  //   - aria-invalid cuando el valor no es válido
  //   - aria-describedby con el hint "entero entre 2 y 999"
  for (const token of [
    'inputMode="numeric"',
    'required',
    'aria-invalid',
    'aria-describedby',
  ]) {
    assert.ok(
      src.includes(token),
      `el input de empaque debe exponer ${token} para accesibilidad`,
    );
  }
});

test('receive/page.tsx propaga la trazabilidad del empaque al unmatchedQueue', async () => {
  const src = await readSource(receivePage);
  const pushMatch = src.match(/unmatched\.push\(\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(pushMatch, 'no se encontró unmatched.push({...})');
  const block = pushMatch[1];
  for (const field of ['invoicePackageQuantity', 'confirmedUnitsPerPack', 'packConversionApplied']) {
    assert.ok(
      block.includes(field),
      `unmatched.push debe propagar ${field} para trazabilidad sin re-multiplicar`,
    );
  }
});

test('UnmatchedItemsReviewer: UnmatchedItem tipa la trazabilidad del empaque', async () => {
  const src = await readSource(unmatchedReviewer);
  for (const field of ['invoicePackageQuantity?:', 'confirmedUnitsPerPack?:', 'packConversionApplied?:']) {
    assert.ok(
      src.includes(field),
      `UnmatchedItem debe declarar ${field} para heredar la trazabilidad`,
    );
  }
});


// ─────────────────────────────────────────────────────────────────────────
// HELPERS PUROS: classifyPackMode y convertItemAsPresentation
// ─────────────────────────────────────────────────────────────────────────

test('PACK_MODE constantes expuestas', () => {
  assert.equal(PACK_MODE_EMPAQUE, 'EMPAQUE');
  assert.equal(PACK_MODE_PRESENTACION, 'PRESENTACION');
});

test('classifyPackMode: nombres con magnitud (ml/g/gr/grs/kg/mg/l) → PRESENTACION', () => {
  const magnitudes = [
    'CREMA DENTAL COLGATE X 58 ML',
    'DETERGENTE BLANCOX X 450 GRS',
    'AGUA CRISTAL X 500 ML',
    'ARROZ DIANA X 500 GR',
    'JABON X 500 G',
    'CARNE X 1 KG',
    'CALCIO X 500 MG',
    'ACEITE X 1 L',
    'GASEOSA X 1.5 LT',
    'LECHE EN POLVO X 400 GRAMOS',
  ];
  for (const name of magnitudes) {
    assert.equal(
      classifyPackMode({ invoiceName: name }),
      PACK_MODE_PRESENTACION,
      `${name} debe clasificarse como PRESENTACION`,
    );
  }
});

test('classifyPackMode: nombres con marcador explícito de empaque → EMPAQUE', () => {
  const packs = [
    'CAP X 24 UND',
    'GASEOSA X 24 UNID',
    'COCA PAQUETE X 24',
    'YOGURT X 6 UNIDADES',
    'LECHE CAJA X 12',
    'CHOCOLATINA X 24 BOTELLAS',
    'ATUN X 6 LATAS',
  ];
  for (const name of packs) {
    assert.equal(
      classifyPackMode({ invoiceName: name }),
      PACK_MODE_EMPAQUE,
      `${name} debe clasificarse como EMPAQUE`,
    );
  }
});

test('classifyPackMode: marcador explícito gana sobre magnitud', () => {
  // Si "UND" aparece, es EMPAQUE sin importar que también mencione ML/G.
  const out = classifyPackMode({ invoiceName: 'GASEOSA 500ML X 24 UND' });
  assert.equal(out, PACK_MODE_EMPAQUE);
});

test('classifyPackMode: default conservador EMPAQUE si no reconoce nada', () => {
  assert.equal(classifyPackMode({ invoiceName: 'ALGO X 24' }), PACK_MODE_EMPAQUE);
  assert.equal(classifyPackMode({ invoiceName: 'CAP X 20' }), PACK_MODE_EMPAQUE);
  assert.equal(classifyPackMode({ invoiceName: '' }), PACK_MODE_EMPAQUE);
  assert.equal(classifyPackMode(null), PACK_MODE_EMPAQUE);
  assert.equal(classifyPackMode(undefined), PACK_MODE_EMPAQUE);
  assert.equal(classifyPackMode({}), PACK_MODE_EMPAQUE);
});

test('classifyPackMode: usa productName o name si invoiceName no viene', () => {
  assert.equal(
    classifyPackMode({ productName: 'CREMA X 58 ML' }),
    PACK_MODE_PRESENTACION,
  );
  assert.equal(
    classifyPackMode({ name: 'YOGURT X 6 UND' }),
    PACK_MODE_EMPAQUE,
  );
});

test('convertItemAsPresentation: preserva quantity, unitPrice, costUnit, pvpSugerido, bonus_quantity', () => {
  const item = {
    isMatched: true,
    invoiceName: 'CREMA DENTAL X 58 ML',
    quantity: 3,
    unitPrice: 4800,
    costUnit: 4800,
    costoReal: 4800,
    pvpSugerido: 6200,
    pvpActual: 6200,
    bonus_quantity: 1,
    totalPrice: 14400,
    marginUsed: 30,
    currentStock: 20,
    currentWac: 4700,
  };
  const out = convertItemAsPresentation(item);
  assert.notStrictEqual(out, item, 'debe retornar copia, no mutar');
  assert.equal(out.quantity, 3);
  assert.equal(out.unitPrice, 4800);
  assert.equal(out.costUnit, 4800);
  assert.equal(out.costoReal, 4800);
  assert.equal(out.pvpSugerido, 6200);
  assert.equal(out.pvpActual, 6200);
  assert.equal(out.bonus_quantity, 1);
  assert.equal(out.totalPrice, 14400);
  assert.equal(out.marginUsed, 30);
  assert.equal(out.currentStock, 20);
  assert.equal(out.currentWac, 4700);
});

test('convertItemAsPresentation: setea confirmedUnitsPerPack=1, packConversionApplied y packMode', () => {
  const out = convertItemAsPresentation({
    invoiceName: 'CREMA X 58 ML',
    quantity: 2,
    unitPrice: 5000,
  });
  assert.equal(out.confirmedUnitsPerPack, 1);
  assert.equal(out.packConversionApplied, true);
  assert.equal(out.packMode, PACK_MODE_PRESENTACION);
});

test('convertItemAsPresentation: LIMPIA requiresPackConfirmation y packHintUnits (snake y camel)', () => {
  const out = convertItemAsPresentation({
    invoiceName: 'CREMA X 58 ML',
    quantity: 2,
    unitPrice: 5000,
    requiresPackConfirmation: true,
    requires_pack_confirmation: true,
    packHintUnits: 58,
    pack_hint_units: 58,
  });
  // Downstream nunca debe volver a abrir el flujo de confirmación.
  assert.equal(out.requiresPackConfirmation, false);
  assert.equal(out.requires_pack_confirmation, false);
  assert.equal(out.packHintUnits, 0);
  assert.equal(out.pack_hint_units, 0);
  // Y los helpers deben coincidir con eso.
  assert.equal(itemRequiresPackConfirmation(out), false);
  assert.equal(getPackHintUnits(out), 0);
});

test('convertItemAsPresentation: tolera input vacío sin lanzar', () => {
  assert.equal(convertItemAsPresentation(null), null);
  assert.equal(convertItemAsPresentation(undefined), undefined);
  const out = convertItemAsPresentation({});
  assert.equal(out.confirmedUnitsPerPack, 1);
  assert.equal(out.packConversionApplied, true);
  assert.equal(out.packMode, PACK_MODE_PRESENTACION);
});

test('convertItemToIndividualUnits: marca packMode=EMPAQUE para trazabilidad simétrica', () => {
  const out = convertItemToIndividualUnits(
    { isMatched: false, invoiceName: 'CAP X 24', quantity: 1, unitPrice: 48000 },
    24,
  );
  assert.equal(out.packMode, PACK_MODE_EMPAQUE);
  assert.equal(out.packConversionApplied, true);
});

// ─────────────────────────────────────────────────────────────────────────
// GUARDIANES ESTATICOS adicionales: toggle PRESENTACION / EMPAQUE
// ─────────────────────────────────────────────────────────────────────────

test('InvoiceReaderModal importa helpers de modo de carga desde el helper puro', async () => {
  const src = await readSource(invoiceReaderModal);
  for (const sym of [
    'convertItemAsPresentation',
    'classifyPackMode',
    'PACK_MODE_EMPAQUE',
    'PACK_MODE_PRESENTACION',
  ]) {
    assert.ok(new RegExp(`\\b${sym}\\b`).test(src), `debe importar/usar ${sym}`);
  }
});

test('InvoiceReaderModal: PackReviewRow lleva un campo mode y setRowMode existe', async () => {
  const src = await readSource(invoiceReaderModal);
  assert.ok(
    /mode:\s*PackMode;?/.test(src),
    'PackReviewRow debe declarar un campo mode: PackMode',
  );
  assert.ok(
    /const\s+setRowMode\s*=/.test(src),
    'debe existir setRowMode para cambiar entre PRESENTACION y EMPAQUE',
  );
});

test('InvoiceReaderModal: allRowsValid acepta PRESENTACION aunque unitsInput esté vacío', async () => {
  const src = await readSource(invoiceReaderModal);
  // La validación global debe reconocer que las filas en PRESENTACION son
  // válidas por sí mismas: no requieren un input numérico.
  assert.ok(
    /allRowsValid[\s\S]{0,200}PACK_MODE_PRESENTACION[\s\S]{0,120}isValidUnitsPerPack/.test(src),
    'allRowsValid debe contemplar la rama PRESENTACION antes de llamar a isValidUnitsPerPack',
  );
});

test('InvoiceReaderModal: handleConfirmPacks enruta a convertItemAsPresentation o convertItemToIndividualUnits', async () => {
  const src = await readSource(invoiceReaderModal);
  assert.ok(
    /convertItemAsPresentation\s*\(it\)/.test(src),
    'debe aplicar convertItemAsPresentation a los items en PRESENTACION',
  );
  assert.ok(
    /convertItemToIndividualUnits\s*\(it,\s*decision\.units!/.test(src),
    'debe aplicar convertItemToIndividualUnits con el N para los items en EMPAQUE',
  );
});

test('InvoiceReaderModal: CTA genérico "Confirmar y Continuar"', async () => {
  const src = await readSource(invoiceReaderModal);
  assert.ok(
    /Confirmar y Continuar/i.test(src),
    'el botón principal de la etapa packReview debe llamarse "Confirmar y Continuar"',
  );
});

test('InvoiceReaderModal: toggle de modo expone role="radiogroup" y role="radio" con aria-checked', async () => {
  const src = await readSource(invoiceReaderModal);
  assert.ok(
    /role="radiogroup"/.test(src),
    'el toggle PRESENTACION/EMPAQUE debe exponer role="radiogroup"',
  );
  assert.ok(
    /role="radio"/.test(src),
    'cada botón del toggle debe exponer role="radio"',
  );
  assert.ok(
    /aria-checked=\{row\.mode\s*===\s*PACK_MODE_(PRESENTACION|EMPAQUE)\}/.test(src),
    'cada botón del toggle debe exponer aria-checked segun row.mode',
  );
});

test('InvoiceReaderModal: input de unidades por paquete solo se renderiza en modo EMPAQUE', async () => {
  const src = await readSource(invoiceReaderModal);
  // El input numérico debe estar dentro de una rama condicional que verifica
  // el modo EMPAQUE antes de pintarlo (evita confusión y asegura el gate de
  // habilitación por fila).
  assert.ok(
    /row\.mode\s*===\s*PACK_MODE_EMPAQUE\s*\?[\s\S]{0,2000}inputMode="numeric"/.test(src),
    'el input numérico debe pintarse SOLO cuando row.mode === EMPAQUE',
  );
});
