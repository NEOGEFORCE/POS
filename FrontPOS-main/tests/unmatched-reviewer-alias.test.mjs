import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ALIAS_FAILURE_MESSAGES,
  buildAliasPayload,
  classifyAliasResponse,
  persistAlias,
} from '../src/lib/alias-persistence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const unmatchedReviewer = join(
  here, '..', 'src', 'app', '(app)', 'inventory', 'receive', 'components', 'UnmatchedItemsReviewer.tsx',
);
const receivePage = join(
  here, '..', 'src', 'app', '(app)', 'inventory', 'receive', 'page.tsx',
);

async function readSource(path) {
  const raw = await readFile(path, 'utf8');
  // Quitamos comentarios para que los guardianes por regex no capturen
  // menciones a patrones viejos en bloques de documentación.
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ─────────────────────────────────────────────────────────────────────────
// HELPER PURO: buildAliasPayload
// ─────────────────────────────────────────────────────────────────────────

test('buildAliasPayload normaliza supplierId, invoiceName y productBarcode', () => {
  const result = buildAliasPayload({
    supplierId: 42,
    invoiceName: '  Coca Cola 350  ',
    productBarcode: '  770010'.toLowerCase() + 'xy  ',
  });
  assert.equal(result.ok, true);
  assert.equal(result.payload.supplierId, 42);
  assert.equal(result.payload.invoiceName, 'Coca Cola 350');
  assert.equal(result.payload.productBarcode, '770010XY');
});

test('buildAliasPayload rechaza supplierId 0, negativo, NaN o no numérico', () => {
  for (const supplierId of [0, -1, Number.NaN, null, undefined, '', 'abc']) {
    const r = buildAliasPayload({ supplierId, invoiceName: 'X', productBarcode: '770' });
    assert.equal(r.ok, false, `supplierId ${JSON.stringify(supplierId)} debe fallar`);
    assert.equal(r.reason, 'missing-supplier');
  }
});

test('buildAliasPayload rechaza invoiceName vacío o solo whitespace', () => {
  for (const invoiceName of ['', '   ', null, undefined, 42]) {
    const r = buildAliasPayload({ supplierId: 1, invoiceName, productBarcode: '770' });
    assert.equal(r.ok, false, `invoiceName ${JSON.stringify(invoiceName)} debe fallar`);
    assert.equal(r.reason, 'missing-invoice-name');
  }
});

test('buildAliasPayload rechaza productBarcode vacío o no string', () => {
  for (const productBarcode of ['', '   ', null, undefined, 123]) {
    const r = buildAliasPayload({ supplierId: 1, invoiceName: 'X', productBarcode });
    assert.equal(r.ok, false, `productBarcode ${JSON.stringify(productBarcode)} debe fallar`);
    assert.equal(r.reason, 'missing-barcode');
  }
});

test('buildAliasPayload acepta supplierId numérico como string ("12")', () => {
  const r = buildAliasPayload({ supplierId: '12', invoiceName: 'X', productBarcode: '770' });
  assert.equal(r.ok, true);
  assert.equal(r.payload.supplierId, 12);
});

// ─────────────────────────────────────────────────────────────────────────
// HELPER PURO: classifyAliasResponse
// ─────────────────────────────────────────────────────────────────────────

test('classifyAliasResponse: ok=true, status 2xx => veredicto ok', () => {
  const v = classifyAliasResponse({ ok: true, status: 200 });
  assert.equal(v.ok, true);
  assert.equal(v.status, 200);
});

test('classifyAliasResponse: 401 y 403 => reason unauthorized con mensaje', () => {
  for (const status of [401, 403]) {
    const v = classifyAliasResponse({ ok: false, status });
    assert.equal(v.ok, false);
    assert.equal(v.status, status);
    assert.equal(v.reason, 'unauthorized');
    assert.ok(v.message && v.message.length > 10);
  }
});

test('classifyAliasResponse: 4xx / 5xx distintos de auth => reason http-error', () => {
  for (const status of [400, 404, 409, 422, 500, 502]) {
    const v = classifyAliasResponse({ ok: false, status });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'http-error');
    assert.equal(v.message, ALIAS_FAILURE_MESSAGES['http-error']);
  }
});

test('classifyAliasResponse: null / undefined / shape rara => reason http-error', () => {
  for (const bad of [null, undefined, {}, { ok: 'yes' }, { ok: true /* no status */ }]) {
    const v = classifyAliasResponse(bad);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'http-error');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// persistAlias — contratos de las cuatro ramas de error / éxito
// ─────────────────────────────────────────────────────────────────────────

function makeFetchSpy({ ok = true, status = 200, throws = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (throws) throw throws;
    return { ok, status };
  };
  return { calls, fetchImpl };
}

test('persistAlias: éxito 200 — construye URL y Authorization correctos', async () => {
  const { calls, fetchImpl } = makeFetchSpy({ ok: true, status: 200 });
  const result = await persistAlias({
    supplierId: 7,
    invoiceName: 'POLA SIX PACK',
    productBarcode: '7701',
    token: 'eyJ.test',
    apiBase: '/api',
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, {
    supplierId: 7,
    invoiceName: 'POLA SIX PACK',
    productBarcode: '7701',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/inventory/save-alias');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers['Authorization'], 'Bearer eyJ.test');
  const parsed = JSON.parse(calls[0].init.body);
  assert.deepEqual(parsed, {
    supplierId: 7,
    invoiceName: 'POLA SIX PACK',
    productBarcode: '7701',
  });
});

test('persistAlias: sin token no manda Authorization pero sí llama al endpoint', async () => {
  const { calls, fetchImpl } = makeFetchSpy({ ok: true, status: 200 });
  const result = await persistAlias({
    supplierId: 7,
    invoiceName: 'X',
    productBarcode: '1',
    apiBase: '/api',
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].init.headers['Authorization'], undefined);
});

test('persistAlias: supplierId=0 no llama a la red (payload inválido)', async () => {
  const { calls, fetchImpl } = makeFetchSpy({ ok: true, status: 200 });
  const result = await persistAlias({
    supplierId: 0,
    invoiceName: 'X',
    productBarcode: '1',
    apiBase: '/api',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-supplier');
  assert.equal(calls.length, 0, 'nunca debe pegarle al endpoint con supplier 0');
});

test('persistAlias: invoiceName vacío no llama a la red', async () => {
  const { calls, fetchImpl } = makeFetchSpy({ ok: true, status: 200 });
  const result = await persistAlias({
    supplierId: 3,
    invoiceName: '   ',
    productBarcode: '1',
    apiBase: '/api',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-invoice-name');
  assert.equal(calls.length, 0);
});

test('persistAlias: barcode vacío no llama a la red', async () => {
  const { calls, fetchImpl } = makeFetchSpy({ ok: true, status: 200 });
  const result = await persistAlias({
    supplierId: 3,
    invoiceName: 'X',
    productBarcode: '',
    apiBase: '/api',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-barcode');
  assert.equal(calls.length, 0);
});

test('persistAlias: 500 del backend => reason http-error con mensaje humano', async () => {
  const { fetchImpl } = makeFetchSpy({ ok: false, status: 500 });
  const result = await persistAlias({
    supplierId: 1,
    invoiceName: 'X',
    productBarcode: '770',
    apiBase: '/api',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'http-error');
  assert.ok(result.message && result.message.length > 10);
  assert.deepEqual(result.payload, {
    supplierId: 1,
    invoiceName: 'X',
    productBarcode: '770',
  });
});

test('persistAlias: 401 => reason unauthorized', async () => {
  const { fetchImpl } = makeFetchSpy({ ok: false, status: 401 });
  const result = await persistAlias({
    supplierId: 1,
    invoiceName: 'X',
    productBarcode: '770',
    apiBase: '/api',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unauthorized');
});

test('persistAlias: error de red => reason network-error, no revienta', async () => {
  const { fetchImpl } = makeFetchSpy({ throws: new TypeError('Failed to fetch') });
  const result = await persistAlias({
    supplierId: 1,
    invoiceName: 'X',
    productBarcode: '770',
    apiBase: '/api',
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network-error');
  assert.equal(result.message, ALIAS_FAILURE_MESSAGES['network-error']);
});

test('persistAlias: apiBase con slash final se normaliza', async () => {
  const { calls, fetchImpl } = makeFetchSpy({ ok: true, status: 200 });
  await persistAlias({
    supplierId: 1,
    invoiceName: 'X',
    productBarcode: '770',
    apiBase: 'https://pos.local/api/',
    fetchImpl,
  });
  assert.equal(calls[0].url, 'https://pos.local/api/inventory/save-alias');
});

test('persistAlias: sin fetchImpl ni fetch global => reason network-error', async () => {
  // Guardamos el fetch global si existe y lo quitamos temporalmente.
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    const result = await persistAlias({
      supplierId: 1,
      invoiceName: 'X',
      productBarcode: '770',
      apiBase: '/api',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'network-error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GUARDIANES ESTÁTICOS: UnmatchedItemsReviewer.tsx
// ─────────────────────────────────────────────────────────────────────────

test('UnmatchedItemsReviewer declara la prop onSaveAlias en su interfaz', async () => {
  const src = await readSource(unmatchedReviewer);
  // La prop onSaveAlias puede estar formateada en varias líneas por prettier,
  // así que buscamos la combinación "onSaveAlias?:" + "AliasLinkRequest"
  // dentro de una ventana cercana (misma declaración de prop).
  const propRegion = src.match(/onSaveAlias\?:[\s\S]{0,400}?AliasLinkRequest[\s\S]{0,200}?=>/);
  assert.ok(
    propRegion,
    'la interfaz debe declarar onSaveAlias?: (link: AliasLinkRequest) => ...',
  );
  assert.ok(
    /interface\s+AliasLinkRequest\b/.test(src),
    'debe exportar o declarar AliasLinkRequest con shape { invoiceName, productBarcode, isNew, source }',
  );
});

test('UnmatchedItemsReviewer: scheduleAliasSave existe y es llamado por las 4 ramas', async () => {
  const src = await readSource(unmatchedReviewer);
  assert.ok(
    /const\s+scheduleAliasSave\s*=/.test(src),
    'debe existir el helper scheduleAliasSave',
  );
  // Las 4 ramas deben ejercitarse en el bundle:
  //   - 'suggestion' / 'manual' / 'scanner' se setean al abrir el diálogo
  //     via openRenamePrompt('<source>', ...). scheduleAliasSave recibe
  //     el `source` destructurado desde `pendingLink`.
  //   - 'created' se mantiene inline en el useEffect de externalResolution
  //     con `source: 'created'`.
  for (const source of ['suggestion', 'manual', 'scanner']) {
    const re = new RegExp(`openRenamePrompt\\(\\s*['\"]${source}['\"]`);
    assert.ok(
      re.test(src),
      `debe abrir el diálogo con openRenamePrompt('${source}', ...)`,
    );
  }
  assert.ok(
    /source:\s*['\"]created['\"]/.test(src),
    "la rama 'created' debe seguir pasando source: 'created' a scheduleAliasSave",
  );
});

test('UnmatchedItemsReviewer: cada rama pasa el invoiceName del item y el barcode del producto emparejado', async () => {
  const src = await readSource(unmatchedReviewer);
  // Tras el sprint "rename-and-link" las ramas suggestion/manual/scanner
  // persisten el alias dentro de handleLinkOnly y handleRenameAndLink,
  // leyendo `pendingLink.item.invoiceName` y `pendingLink.product.barcode`.
  // La rama 'created' sigue inline en el useEffect de externalResolution.
  //
  // El contrato invariante es:
  //   1. invoiceName nunca viene del productName canónico; siempre del OCR.
  //   2. productBarcode viene del producto resuelto (no de `current` que no
  //      tiene barcode).
  //
  // Buscamos las menciones correctas por rama.
  assert.ok(
    /productBarcode:\s*externalResolution\.barcode/.test(src),
    "rama 'created' debe pasar productBarcode: externalResolution.barcode",
  );
  // Para las 3 ramas confirmadas vía diálogo, el productBarcode viene del
  // producto resuelto del catálogo (ahora empaquetado en pendingLink).
  const linkOnly = src.match(/const\s+handleLinkOnly\s*=\s*useCallback\(([\s\S]*?)\n\s*\}\s*,\s*\[/);
  assert.ok(linkOnly, 'no se encontró handleLinkOnly');
  assert.ok(
    /productBarcode:\s*product\.barcode/.test(linkOnly[1]),
    'handleLinkOnly debe pasar productBarcode: product.barcode (producto resuelto, no current)',
  );
  const renameAndLink = src.match(/const\s+handleRenameAndLink\s*=\s*useCallback\(async[\s\S]*?\n\s*\}\s*,\s*\[/);
  assert.ok(renameAndLink, 'no se encontró handleRenameAndLink');
  assert.ok(
    /productBarcode:\s*product\.barcode/.test(renameAndLink[0]),
    'handleRenameAndLink debe pasar productBarcode: product.barcode',
  );
  // El invoiceName debe venir del item (current o pendingLink.item), nunca
  // del productName canónico. Debe existir al menos una referencia por
  // cada rama.
  const invoiceNameExprs = src.match(/invoiceName:\s*(current|item)\.invoiceName/g) || [];
  assert.ok(
    invoiceNameExprs.length >= 3,
    `scheduleAliasSave debe recibir el invoiceName del item en al menos 3 ramas (encontrado ${invoiceNameExprs.length})`,
  );
  // Ningún scheduleAliasSave debe mandar el productName del catálogo.
  assert.ok(
    !/invoiceName:\s*(product|selectedProd|suggestion)\.productName/.test(src),
    'ninguna rama debe mandar invoiceName: product.productName (sería renombrar al cajero)',
  );
});

test('UnmatchedItemsReviewer: la rama created (producto recién creado) también persiste alias (sin guard !r.isNew)', async () => {
  const src = await readSource(unmatchedReviewer);
  // El guard antiguo era `!r.isNew`. En el reviewer no debe existir ningún
  // guard que impida persistir para producto nuevo.
  assert.ok(
    !/if\s*\(\s*!r\.isNew/.test(src),
    'el reviewer no puede llevar guard !r.isNew — el producto recién creado también persiste alias',
  );
  // La llamada con source: 'created' debe estar dentro del useEffect de
  // externalResolution. Verificamos secuencia textual.
  const idxExternal = src.indexOf("externalResolution.resolutionId === lastResolutionId");
  const idxCreatedCall = src.indexOf("source: 'created'");
  assert.ok(idxExternal > 0 && idxCreatedCall > idxExternal,
    "scheduleAliasSave({source:'created'}) debe vivir dentro del useEffect de externalResolution");
});

test('UnmatchedItemsReviewer: scheduleAliasSave vive FUERA de setState/useState', async () => {
  const src = await readSource(unmatchedReviewer);
  // El antipatrón era disparar fetch dentro de setReceiveList(prev => ...).
  // En el reviewer el estado se gestiona con setResolvedItems(prev=>) y
  // setCurrentIdx(idx=>). scheduleAliasSave no debe ser llamado dentro de
  // esas lambdas.
  // Buscamos cualquier `setResolvedItems(prev => { ... scheduleAliasSave`
  // o `setCurrentIdx(idx => { ... scheduleAliasSave`
  const insideSetState = /set(ResolvedItems|CurrentIdx)\s*\(\s*(prev|idx)\s*=>\s*\{[^}]*scheduleAliasSave/s;
  assert.ok(
    !insideSetState.test(src),
    'scheduleAliasSave no puede llamarse dentro de un updater de setState',
  );
});

// ─────────────────────────────────────────────────────────────────────────
// GUARDIANES ESTÁTICOS: receive/page.tsx
// ─────────────────────────────────────────────────────────────────────────

test('receive/page.tsx importa persistAlias desde alias-persistence.mjs', async () => {
  const src = await readSource(receivePage);
  assert.ok(
    /from\s+['"]@\/lib\/alias-persistence\.mjs['"]/.test(src),
    'page.tsx debe importar desde @/lib/alias-persistence.mjs',
  );
  assert.ok(
    /\bpersistAlias\b/.test(src),
    'page.tsx debe usar persistAlias',
  );
});

test('receive/page.tsx: handleReviewerSaveAlias usa selectedGlobalSupplier real, nunca localStorage ni 0', async () => {
  const src = await readSource(receivePage);
  // Debe existir el callback con el nombre esperado y debe leer el estado
  // selectedGlobalSupplier directamente.
  assert.ok(
    /const\s+handleReviewerSaveAlias\s*=/.test(src),
    'debe existir handleReviewerSaveAlias',
  );
  const callbackBlock = src.match(/const\s+handleReviewerSaveAlias\s*=\s*useCallback\(([\s\S]*?)\n\s*\}\s*,\s*\[/);
  assert.ok(callbackBlock, 'no se encontró el bloque useCallback de handleReviewerSaveAlias');
  const body = callbackBlock[1];
  assert.ok(
    /supplierId:\s*selectedGlobalSupplier/.test(body),
    'handleReviewerSaveAlias debe pasar supplierId: selectedGlobalSupplier',
  );
  assert.ok(
    !/localStorage/.test(body),
    'handleReviewerSaveAlias NO debe leer localStorage para resolver el supplierId',
  );
  assert.ok(
    !/supplierId:\s*0\b/.test(body),
    'handleReviewerSaveAlias NO debe pasar supplierId: 0 como fallback',
  );
  // Debe invocar persistAlias con token real.
  assert.ok(
    /persistAlias\s*\(/.test(body),
    'handleReviewerSaveAlias debe llamar persistAlias',
  );
});

test('receive/page.tsx: handleUnmatchedResolved NO contiene fetch("...save-alias") ni guard !r.isNew', async () => {
  const src = await readSource(receivePage);
  const handlerMatch = src.match(/const\s+handleUnmatchedResolved\s*=\s*useCallback\(([\s\S]*?)\n\s*\}\s*,\s*\[/);
  assert.ok(handlerMatch, 'no se encontró el bloque de handleUnmatchedResolved');
  const body = handlerMatch[1];
  // El fetch inline a save-alias se movió al reviewer; aquí ya no debe existir.
  assert.ok(
    !/save-alias/.test(body),
    'handleUnmatchedResolved ya no debe disparar POST a /inventory/save-alias (lo hace el reviewer)',
  );
  // Y el guard !r.isNew que excluía productos recién creados se eliminó.
  assert.ok(
    !/!r\.isNew/.test(body),
    'handleUnmatchedResolved ya no debe contener el guard !r.isNew',
  );
});

test('receive/page.tsx: handleReviewerSaveAlias es pasado como prop onSaveAlias al reviewer', async () => {
  const src = await readSource(receivePage);
  assert.ok(
    /<UnmatchedItemsReviewer[\s\S]*?onSaveAlias=\{handleReviewerSaveAlias\}/.test(src),
    'el UnmatchedItemsReviewer debe recibir onSaveAlias={handleReviewerSaveAlias}',
  );
});

test('receive/page.tsx: handleReviewerSaveAlias comprueba res.ok vía persistAlias y surface toast en error', async () => {
  const src = await readSource(receivePage);
  const callbackBlock = src.match(/const\s+handleReviewerSaveAlias\s*=\s*useCallback\(([\s\S]*?)\n\s*\}\s*,\s*\[/);
  assert.ok(callbackBlock, 'no se encontró el bloque de handleReviewerSaveAlias');
  const body = callbackBlock[1];
  // Debe verificar que `!verdict.ok` y disparar toast con variant destructive.
  assert.ok(
    /!verdict\.ok/.test(body),
    'handleReviewerSaveAlias debe inspeccionar verdict.ok',
  );
  assert.ok(
    /variant:\s*['\"]destructive['\"]/.test(body),
    'handleReviewerSaveAlias debe mostrar toast destructive cuando falla la persistencia',
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Contract de las 4 ramas: la UI dispara scheduleAliasSave ANTES de advanceTo
// (persistir lo antes posible)
// ─────────────────────────────────────────────────────────────────────────

test('UnmatchedItemsReviewer: cada rama ejecuta scheduleAliasSave ANTES de advanceTo (persistir lo antes posible)', async () => {
  const src = await readSource(unmatchedReviewer);
  // Tras el sprint "rename-and-link" los handlers del diálogo
  // (handleLinkOnly / handleRenameAndLink) son los que persisten el alias
  // y avanzan. El contrato de orden "scheduleAliasSave antes de advanceTo"
  // sigue vigente, sólo que ahora vive en esos handlers; el useEffect de
  // externalResolution ('created') lo preserva inline.
  function sliceCallback(name) {
    // Soporta `useCallback((...)=>{...})` tanto async como sync.
    const re = new RegExp(`const\\s+${name}\\s*=\\s*useCallback\\(\\s*(async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\s*,\\s*\\[`);
    const match = src.match(re);
    return match ? match[2] : null;
  }

  for (const name of ['handleLinkOnly', 'handleRenameAndLink']) {
    const body = sliceCallback(name);
    assert.ok(body, `no se encontró el handler ${name}`);
    const idxSchedule = body.indexOf('scheduleAliasSave');
    const idxAdvance = body.indexOf('advanceTo');
    assert.ok(idxSchedule > -1, `${name} debe llamar scheduleAliasSave`);
    assert.ok(idxAdvance > -1, `${name} debe llamar advanceTo`);
    assert.ok(
      idxSchedule < idxAdvance,
      `${name}: scheduleAliasSave debe ocurrir ANTES de advanceTo (persistir lo antes posible)`,
    );
  }

  // El useEffect de externalResolution también sigue el mismo contrato.
  const effectMatch = src.match(/externalResolution\.resolutionId === lastResolutionId[\s\S]*?onExternalResolutionConsumed\?\.\(\)/);
  assert.ok(effectMatch, 'no se encontró el useEffect de externalResolution');
  const effectBody = effectMatch[0];
  const idxScheduleEff = effectBody.indexOf('scheduleAliasSave');
  const idxAdvanceEff = effectBody.indexOf('advanceTo');
  assert.ok(
    idxScheduleEff > -1 && idxAdvanceEff > idxScheduleEff,
    "rama 'created': scheduleAliasSave debe ocurrir antes de advanceTo",
  );
});
