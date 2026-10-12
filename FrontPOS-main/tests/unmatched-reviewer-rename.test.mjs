import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  RENAME_FAILURE_MESSAGES,
  normalizeProposedName,
  shouldPromptRename,
  validateProposedName,
  buildRenameUrl,
  classifyRenameResponse,
  extractRenameErrorMessage,
} from '../src/lib/product-rename.mjs';

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
// HELPER PURO: normalizeProposedName
// ─────────────────────────────────────────────────────────────────────────

test('normalizeProposedName: trim, colapsa espacios, upper-case y mantiene ñ', () => {
  assert.equal(normalizeProposedName('  coca   cola  350 ml '), 'COCA COLA 350 ML');
  assert.equal(normalizeProposedName('Piña Colada'), 'PIÑA COLADA');
  assert.equal(normalizeProposedName('ACÉITE Girasol'), 'ACEITE GIRASOL');
});

test('normalizeProposedName: valores no string → cadena vacía', () => {
  for (const v of [undefined, null, 42, {}, [], true]) {
    assert.equal(normalizeProposedName(v), '', `${JSON.stringify(v)} debería colapsar a ""`);
  }
});

test('normalizeProposedName: whitespace puro → cadena vacía', () => {
  assert.equal(normalizeProposedName('   '), '');
  assert.equal(normalizeProposedName('\t\n'), '');
});

// ─────────────────────────────────────────────────────────────────────────
// HELPER PURO: shouldPromptRename
// ─────────────────────────────────────────────────────────────────────────

test('shouldPromptRename: invoiceName vacío → false (no prompteamos de la nada)', () => {
  assert.equal(shouldPromptRename({ currentName: 'COCA COLA', invoiceName: '' }), false);
  assert.equal(shouldPromptRename({ currentName: 'COCA COLA', invoiceName: '   ' }), false);
  assert.equal(shouldPromptRename({ currentName: 'COCA COLA', invoiceName: null }), false);
});

test('shouldPromptRename: nombres idénticos tras normalizar → false', () => {
  assert.equal(shouldPromptRename({ currentName: 'COCA COLA', invoiceName: 'coca cola' }), false);
  assert.equal(shouldPromptRename({ currentName: 'ACEITE GIRASOL', invoiceName: 'Acéite  Girasol' }), false);
});

test('shouldPromptRename: nombres distintos → true', () => {
  assert.equal(shouldPromptRename({ currentName: 'COCA COLA 350', invoiceName: 'COCA COLA 500 ML' }), true);
});

test('shouldPromptRename: currentName vacío e invoiceName presente → true (prompt seguro)', () => {
  assert.equal(shouldPromptRename({ currentName: '', invoiceName: 'POLA SIX PACK' }), true);
  assert.equal(shouldPromptRename({ currentName: null, invoiceName: 'POLA SIX PACK' }), true);
});

// ─────────────────────────────────────────────────────────────────────────
// HELPER PURO: validateProposedName
// ─────────────────────────────────────────────────────────────────────────

test('validateProposedName: vacío/whitespace → reason empty-name', () => {
  for (const v of ['', '   ', '\n', null, undefined, 42]) {
    const r = validateProposedName(v, 'COCA COLA');
    assert.equal(r.ok, false, `${JSON.stringify(v)} debería fallar`);
    assert.equal(r.reason, 'empty-name');
    assert.equal(r.message, RENAME_FAILURE_MESSAGES['empty-name']);
  }
});

test('validateProposedName: idéntico al actual (post-normalize) → identical-name', () => {
  const r = validateProposedName('coca cola', 'COCA COLA');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'identical-name');
  assert.equal(r.message, RENAME_FAILURE_MESSAGES['identical-name']);
});

test('validateProposedName: válido → { ok: true, name: NORMALIZADO }', () => {
  const r = validateProposedName('  Pola six-pack  ', 'OTRO');
  assert.equal(r.ok, true);
  assert.equal(r.name, 'POLA SIX-PACK');
});

test('validateProposedName: currentName vacío + nombre válido → ok (no hay identical-name sin referencia)', () => {
  const r = validateProposedName('COCA COLA 350', '');
  assert.equal(r.ok, true);
  assert.equal(r.name, 'COCA COLA 350');
});

// ─────────────────────────────────────────────────────────────────────────
// HELPER PURO: buildRenameUrl
// ─────────────────────────────────────────────────────────────────────────

test('buildRenameUrl: barcode válido + apiBase relativo → url correcta', () => {
  const r = buildRenameUrl('/api', '7701234567890');
  assert.equal(r.ok, true);
  assert.equal(r.url, '/api/products/update-products/7701234567890');
  assert.equal(r.barcode, '7701234567890');
});

test('buildRenameUrl: apiBase con slash final se normaliza', () => {
  const r = buildRenameUrl('https://pos.local/api/', 'abc');
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://pos.local/api/products/update-products/ABC');
});

test('buildRenameUrl: barcode con caracteres especiales se encodea', () => {
  const r = buildRenameUrl('/api', 'A/B C+D');
  assert.equal(r.ok, true);
  // encodeURIComponent sobre A/B C+D (upper)
  assert.ok(r.url.includes('/products/update-products/'));
  assert.ok(/%2F/i.test(r.url), 'el / debe estar encodeado');
  assert.ok(/%20|%2B/i.test(r.url), 'espacios o + deben estar encodeados');
});

test('buildRenameUrl: barcode vacío o no string → missing-barcode', () => {
  for (const v of ['', '   ', null, undefined, 42, {}]) {
    const r = buildRenameUrl('/api', v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} debe fallar`);
    assert.equal(r.reason, 'missing-barcode');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// HELPER PURO: classifyRenameResponse
// ─────────────────────────────────────────────────────────────────────────

test('classifyRenameResponse: 2xx → ok', () => {
  assert.equal(classifyRenameResponse({ ok: true, status: 200 }).ok, true);
  assert.equal(classifyRenameResponse({ ok: true, status: 204 }).ok, true);
});

test('classifyRenameResponse: 401 y 403 → unauthorized', () => {
  for (const status of [401, 403]) {
    const v = classifyRenameResponse({ ok: false, status });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'unauthorized');
    assert.equal(v.message, RENAME_FAILURE_MESSAGES['unauthorized']);
  }
});

test('classifyRenameResponse: 4xx y 5xx no-auth → http-error', () => {
  for (const status of [400, 404, 409, 422, 500, 502]) {
    const v = classifyRenameResponse({ ok: false, status });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'http-error');
    assert.equal(v.message, RENAME_FAILURE_MESSAGES['http-error']);
  }
});

test('classifyRenameResponse: null/undefined/shape rara → http-error', () => {
  for (const bad of [null, undefined, {}, { ok: true }, { status: 200 }]) {
    const v = classifyRenameResponse(bad);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'http-error');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// HELPER PURO: extractRenameErrorMessage
// ─────────────────────────────────────────────────────────────────────────

test('extractRenameErrorMessage: ApiError con mensaje → preserva mensaje del backend', () => {
  const err = { status: 400, message: 'El código ya existe.' };
  assert.equal(extractRenameErrorMessage(err), 'El código ya existe.');
});

test('extractRenameErrorMessage: ApiError 401/403 → unauthorized', () => {
  for (const status of [401, 403]) {
    const err = { status, message: 'Session expired' };
    assert.equal(extractRenameErrorMessage(err), RENAME_FAILURE_MESSAGES['unauthorized']);
  }
});

test('extractRenameErrorMessage: TypeError → network-error', () => {
  const err = new TypeError('Failed to fetch');
  assert.equal(extractRenameErrorMessage(err), RENAME_FAILURE_MESSAGES['network-error']);
});

test('extractRenameErrorMessage: string suelto → se devuelve trim', () => {
  assert.equal(extractRenameErrorMessage('  Vaya error  '), 'Vaya error');
});

test('extractRenameErrorMessage: null/undefined → http-error default', () => {
  assert.equal(extractRenameErrorMessage(null), RENAME_FAILURE_MESSAGES['http-error']);
  assert.equal(extractRenameErrorMessage(undefined), RENAME_FAILURE_MESSAGES['http-error']);
});

// ─────────────────────────────────────────────────────────────────────────
// GUARDIANES ESTÁTICOS — UnmatchedItemsReviewer.tsx
// ─────────────────────────────────────────────────────────────────────────

test('UnmatchedItemsReviewer importa AlertDialog e Input de shadcn', async () => {
  const src = await readSource(unmatchedReviewer);
  assert.ok(
    /from\s+['"]@\/components\/ui\/alert-dialog['"]/.test(src),
    'debe importar AlertDialog desde @/components/ui/alert-dialog',
  );
  assert.ok(
    /from\s+['"]@\/components\/ui\/input['"]/.test(src),
    'debe importar Input desde @/components/ui/input',
  );
  for (const name of [
    'AlertDialog',
    'AlertDialogContent',
    'AlertDialogHeader',
    'AlertDialogTitle',
    'AlertDialogDescription',
    'AlertDialogFooter',
    'AlertDialogAction',
    'AlertDialogCancel',
  ]) {
    assert.ok(
      new RegExp(`\\b${name}\\b`).test(src),
      `debe usar ${name} de shadcn`,
    );
  }
});

test('UnmatchedItemsReviewer importa validateProposedName del helper puro', async () => {
  const src = await readSource(unmatchedReviewer);
  assert.ok(
    /from\s+['"]@\/lib\/product-rename\.mjs['"]/.test(src),
    'debe importar desde @/lib/product-rename.mjs',
  );
  assert.ok(/\bvalidateProposedName\b/.test(src), 'debe usar validateProposedName');
});

test('UnmatchedItemsReviewer declara la prop tipada onRenameProduct', async () => {
  const src = await readSource(unmatchedReviewer);
  // La interface RenameLinkRequest es exportada / declarada
  assert.ok(
    /\binterface\s+RenameLinkRequest\b/.test(src),
    'debe declarar interface RenameLinkRequest',
  );
  assert.ok(
    /\binterface\s+RenameOutcome\b/.test(src),
    'debe declarar interface RenameOutcome',
  );
  // La prop existe con tipo callback que recibe RenameLinkRequest y
  // promete RenameOutcome.
  const propRe = /onRenameProduct\?:[\s\S]{0,200}?RenameLinkRequest[\s\S]{0,200}?Promise<RenameOutcome>/;
  assert.ok(
    propRe.test(src),
    'debe declarar onRenameProduct?: (req: RenameLinkRequest) => Promise<RenameOutcome>',
  );
});

test('UnmatchedItemsReviewer: las 3 ramas (suggestion/manual/scanner) abren el diálogo, NO advance directo', async () => {
  const src = await readSource(unmatchedReviewer);

  function sliceHandler(name) {
    const startRe = new RegExp(`const\\s+${name}\\s*=[\\s\\S]*?=>\\s*\\{`);
    const start = src.search(startRe);
    if (start === -1) return null;
    const rest = src.slice(start);
    const nextDecl = rest.search(/\n\s*(const\s+handle|useEffect\(|if\s*\(!current\)\s*return null;)/);
    const end = nextDecl === -1 ? Math.min(rest.length, 3000) : nextDecl;
    return rest.slice(0, end);
  }

  for (const name of ['handleAssignToSuggestion', 'handleAssignToManual', 'handleScanResult']) {
    const body = sliceHandler(name);
    assert.ok(body, `no se encontró el handler ${name}`);
    // Debe llamar openRenamePrompt
    assert.ok(
      /openRenamePrompt\s*\(/.test(body),
      `${name} debe abrir el diálogo via openRenamePrompt`,
    );
    // NO debe llamar advanceTo directamente — eso ahora vive en
    // handleLinkOnly / handleRenameAndLink.
    assert.ok(
      !/advanceTo\s*\(/.test(body),
      `${name} NO debe llamar advanceTo directamente: eso vive en los handlers del diálogo`,
    );
    // NO debe llamar scheduleAliasSave directamente (misma razón).
    assert.ok(
      !/scheduleAliasSave\s*\(/.test(body),
      `${name} NO debe llamar scheduleAliasSave directamente`,
    );
  }
});

test('UnmatchedItemsReviewer: handleLinkOnly guarda alias y avanza (sin PUT)', async () => {
  const src = await readSource(unmatchedReviewer);
  const match = src.match(/const\s+handleLinkOnly\s*=\s*useCallback\(([\s\S]*?)\n\s*\}\s*,\s*\[/);
  assert.ok(match, 'no se encontró el handler handleLinkOnly');
  const body = match[1];
  assert.ok(/scheduleAliasSave\s*\(/.test(body), 'handleLinkOnly debe guardar alias');
  assert.ok(/advanceTo\s*\(/.test(body), 'handleLinkOnly debe avanzar al siguiente item');
  assert.ok(/closeRenamePrompt\s*\(\s*\)/.test(body), 'handleLinkOnly debe cerrar el diálogo');
  // NO debe llamar al callback de rename.
  assert.ok(
    !/onRenameProduct\s*\(/.test(body),
    'handleLinkOnly NO debe llamar al callback de rename',
  );
  // NO debe mencionar update-products — pertenece al rename flow.
  assert.ok(
    !/update-products/.test(body),
    'handleLinkOnly NO debe hablar del endpoint update-products',
  );
});

test('UnmatchedItemsReviewer: handleRenameAndLink llama onRenameProduct y SÓLO avanza si ok', async () => {
  const src = await readSource(unmatchedReviewer);
  const match = src.match(/const\s+handleRenameAndLink\s*=\s*useCallback\(async\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\n\s*\}\s*,\s*\[/);
  assert.ok(match, 'no se encontró el handler handleRenameAndLink');
  const body = match[1];
  // Debe llamar al callback con la forma tipada.
  assert.ok(
    /onRenameProduct\s*\(\s*\{[\s\S]*?productBarcode[\s\S]*?newName[\s\S]*?source[\s\S]*?\}/.test(body),
    'handleRenameAndLink debe invocar onRenameProduct({productBarcode, newName, source, ...})',
  );
  // Debe validar el input antes de llamar al endpoint.
  assert.ok(
    /validateProposedName\s*\(/.test(body),
    'handleRenameAndLink debe validar el input via validateProposedName',
  );
  // Guard de doble submit.
  assert.ok(
    /renameInFlight\.current/.test(body),
    'handleRenameAndLink debe usar la ref anti-doble-submit',
  );
  assert.ok(
    /setIsRenaming\s*\(\s*true\s*\)/.test(body),
    'handleRenameAndLink debe marcar isRenaming=true',
  );
  // Si outcome.ok !== true, se mantiene el diálogo abierto con error.
  assert.ok(
    /outcome\.ok\s*!==\s*true|!outcome\.ok|outcome\.ok\s*===\s*false|!\s*outcome\s*\|\|/.test(body),
    'handleRenameAndLink debe chequear outcome.ok',
  );
  assert.ok(
    /setRenameError\s*\(/.test(body),
    'handleRenameAndLink debe setear renameError cuando falla',
  );
  // Si ok, debe guardar alias + advance + cerrar.
  assert.ok(/scheduleAliasSave\s*\(/.test(body), 'handleRenameAndLink debe guardar alias en éxito');
  assert.ok(/advanceTo\s*\(/.test(body), 'handleRenameAndLink debe avanzar en éxito');
  assert.ok(/closeRenamePrompt\s*\(\s*\)/.test(body), 'handleRenameAndLink debe cerrar el diálogo en éxito');
});

test('UnmatchedItemsReviewer: handleCancelRename no avanza ni enlaza', async () => {
  const src = await readSource(unmatchedReviewer);
  const match = src.match(/const\s+handleCancelRename\s*=\s*useCallback\(\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\n\s*\}\s*,\s*\[/);
  assert.ok(match, 'no se encontró el handler handleCancelRename');
  const body = match[1];
  assert.ok(
    !/scheduleAliasSave\s*\(/.test(body),
    'handleCancelRename NO debe guardar alias',
  );
  assert.ok(
    !/advanceTo\s*\(/.test(body),
    'handleCancelRename NO debe avanzar',
  );
  assert.ok(
    !/onRenameProduct\s*\(/.test(body),
    'handleCancelRename NO debe llamar al callback de rename',
  );
  assert.ok(/closeRenamePrompt\s*\(\s*\)/.test(body), 'handleCancelRename debe cerrar el diálogo');
  // Debe tener guard isRenaming (no cancelar mid-PUT).
  assert.ok(
    /isRenaming/.test(body),
    'handleCancelRename debe respetar isRenaming (no cancelar durante PUT)',
  );
});

test('UnmatchedItemsReviewer: rama "created" (externalResolution) NO abre diálogo ni dispara rename', async () => {
  const src = await readSource(unmatchedReviewer);
  // El useEffect de externalResolution avanza directo sin prompt.
  const match = src.match(/externalResolution\.resolutionId === lastResolutionId[\s\S]*?onExternalResolutionConsumed\?\.\(\)/);
  assert.ok(match, 'no se encontró el useEffect de externalResolution');
  const body = match[0];
  assert.ok(
    !/openRenamePrompt\s*\(/.test(body),
    'la rama created NO debe abrir el diálogo de rename (el producto se acaba de crear con su nombre canónico)',
  );
  assert.ok(
    !/onRenameProduct\s*\(/.test(body),
    'la rama created NO debe invocar el callback de rename',
  );
  // La rama sigue haciendo scheduleAliasSave + advanceTo como antes.
  assert.ok(/scheduleAliasSave\s*\(/.test(body), 'la rama created sigue persistiendo alias');
  assert.ok(/advanceTo\s*\(/.test(body), 'la rama created sigue avanzando');
});

test('UnmatchedItemsReviewer: el AlertDialog bloquea doble submit (disabled vía isRenaming)', async () => {
  const src = await readSource(unmatchedReviewer);
  // Busca al menos un AlertDialogAction con disabled={isRenaming ...}
  const re = /AlertDialogAction[^>]*disabled=\{[^}]*isRenaming/;
  assert.ok(
    re.test(src),
    'al menos un AlertDialogAction debe estar deshabilitado durante isRenaming',
  );
  // El AlertDialogCancel también se protege.
  const reCancel = /AlertDialogCancel[^>]*disabled=\{\s*isRenaming\s*\}/;
  assert.ok(
    reCancel.test(src),
    'AlertDialogCancel debe estar deshabilitado durante isRenaming',
  );
  // La ref anti-doble-submit vive al alcance del componente.
  assert.ok(
    /useRef<boolean>\s*\(\s*false\s*\)/.test(src) || /useRef\(\s*false\s*\)/.test(src),
    'debe existir una ref anti-doble-submit inicializada en false',
  );
  // aria-busy en el botón de confirmación de rename.
  assert.ok(
    /aria-busy=\{isRenaming\}/.test(src),
    'el botón "Actualizar nombre y enlazar" debe exponer aria-busy',
  );
});

test('UnmatchedItemsReviewer: el input de rename usa <Input> de shadcn con label asociado y autoFocus', async () => {
  const src = await readSource(unmatchedReviewer);
  // Capturamos el bloque <Input .../> completo con [\s\S] porque las
  // expresiones JSX (p.ej. onChange={(e) => {...}}) contienen `>` y
  // romperían un [^>]* ingenuo.
  const inputBlock = src.match(/<Input\b[\s\S]*?\/>/);
  assert.ok(inputBlock, 'no se encontró el <Input .../> del diálogo');
  const inputStr = inputBlock[0];

  assert.ok(
    /id="unmatched-rename-input"/.test(inputStr),
    'el input de rename debe tener id="unmatched-rename-input"',
  );
  assert.ok(
    /htmlFor="unmatched-rename-input"/.test(src),
    'debe existir un <label htmlFor> asociado al input',
  );
  assert.ok(
    /\bautoFocus\b/.test(inputStr),
    'el input debe tener autoFocus para pre-llenar y editar inmediatamente',
  );
  assert.ok(
    /disabled=\{isRenaming\}/.test(inputStr),
    'el input debe deshabilitarse mientras isRenaming=true',
  );
  // aria-invalid vinculado al mensaje de error.
  assert.ok(
    /aria-invalid=\{renameError\s*\?\s*['"]true['"]\s*:\s*['"]false['"]\}/.test(inputStr),
    'el input debe exponer aria-invalid cuando hay renameError',
  );
});

test('UnmatchedItemsReviewer: el input se prellena con invoiceName (no con el nombre canónico)', async () => {
  const src = await readSource(unmatchedReviewer);
  // En openRenamePrompt el draftName se setea desde item.invoiceName.
  const match = src.match(/const\s+openRenamePrompt\s*=\s*\([\s\S]*?\n\s*\};/);
  assert.ok(match, 'no se encontró openRenamePrompt');
  assert.ok(
    /setDraftName\(invoiceName\)/.test(match[0])
    || /setDraftName\(\s*item\.invoiceName/.test(match[0]),
    'openRenamePrompt debe prellenar draftName con el invoiceName',
  );
});

test('UnmatchedItemsReviewer: AlertDialogDescription está presente para accesibilidad', async () => {
  const src = await readSource(unmatchedReviewer);
  assert.ok(
    /<AlertDialogDescription\b[^>]*>/.test(src),
    'debe existir AlertDialogDescription asociada al diálogo',
  );
  assert.ok(
    /aria-describedby="unmatched-rename-desc"/.test(src),
    'AlertDialogContent debe apuntar al id de la descripción',
  );
});

test('UnmatchedItemsReviewer: NUNCA renombra automáticamente — rename sólo tras click explícito', async () => {
  const src = await readSource(unmatchedReviewer);
  // openRenamePrompt NO llama onRenameProduct.
  const match = src.match(/const\s+openRenamePrompt\s*=\s*\([\s\S]*?\n\s*\};/);
  assert.ok(match, 'no se encontró openRenamePrompt');
  assert.ok(
    !/onRenameProduct\s*\(/.test(match[0]),
    'openRenamePrompt NO debe disparar el callback de rename',
  );
  // Los branches NO llaman onRenameProduct — solo lo hace handleRenameAndLink.
  const invocations = src.match(/onRenameProduct\s*\(/g) || [];
  assert.equal(
    invocations.length, 1,
    `onRenameProduct debe invocarse exactamente una vez (en handleRenameAndLink), hubo ${invocations.length}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// GUARDIANES ESTÁTICOS — receive/page.tsx
// ─────────────────────────────────────────────────────────────────────────

test('receive/page.tsx: handleReviewerRenameProduct existe y usa sanitizeProductPayload', async () => {
  const src = await readSource(receivePage);
  assert.ok(
    /const\s+handleReviewerRenameProduct\s*=\s*useCallback\(/.test(src),
    'debe existir handleReviewerRenameProduct',
  );
  const match = src.match(/const\s+handleReviewerRenameProduct\s*=\s*useCallback\(async\s*\(([\s\S]*?)\n\s*\}\s*,\s*\[/);
  assert.ok(match, 'no se encontró el bloque useCallback');
  const body = match[1];
  // Debe pasar por sanitizeProductPayload.
  assert.ok(
    /sanitizeProductPayload\s*\(/.test(body),
    'handleReviewerRenameProduct debe construir el payload con sanitizeProductPayload',
  );
  // Debe pegar al endpoint correcto con PUT.
  assert.ok(
    /\/products\/update-products\//.test(body),
    'handleReviewerRenameProduct debe PUT a /products/update-products/:barcode',
  );
  assert.ok(
    /method:\s*['"]PUT['"]/.test(body),
    'handleReviewerRenameProduct debe usar method: "PUT"',
  );
});

test('receive/page.tsx: handleReviewerRenameProduct SÓLO broadcastRevalidate y setProducts en éxito', async () => {
  const src = await readSource(receivePage);
  const match = src.match(/const\s+handleReviewerRenameProduct\s*=\s*useCallback\(async\s*\(([\s\S]*?)\n\s*\}\s*,\s*\[/);
  assert.ok(match, 'no se encontró handleReviewerRenameProduct');
  const body = match[1];
  // Debe existir una llamada a broadcastRevalidate('PRODUCT_UPDATE').
  assert.ok(
    /broadcastRevalidate\s*\(\s*['"]PRODUCT_UPDATE['"]\s*\)/.test(body),
    'debe emitir broadcastRevalidate("PRODUCT_UPDATE") tras éxito',
  );
  assert.ok(
    /setProducts\s*\(/.test(body),
    'debe actualizar el estado local products tras éxito',
  );
  // El broadcast y setProducts deben estar DENTRO del try (antes del catch).
  const idxTry = body.indexOf('try');
  const idxCatch = body.indexOf('catch');
  const idxBroadcast = body.indexOf('broadcastRevalidate');
  const idxSetProducts = body.indexOf('setProducts');
  assert.ok(idxTry > -1 && idxCatch > idxTry, 'debe existir un bloque try/catch');
  assert.ok(
    idxBroadcast > idxTry && idxBroadcast < idxCatch,
    'broadcastRevalidate debe estar dentro del try (antes del catch)',
  );
  assert.ok(
    idxSetProducts > idxTry && idxSetProducts < idxCatch,
    'setProducts debe estar dentro del try (antes del catch)',
  );
});

test('receive/page.tsx: handleReviewerRenameProduct retorna {ok:false, message} en error, nunca lanza', async () => {
  const src = await readSource(receivePage);
  const match = src.match(/const\s+handleReviewerRenameProduct\s*=\s*useCallback\(async\s*\(([\s\S]*?)\n\s*\}\s*,\s*\[/);
  assert.ok(match, 'no se encontró handleReviewerRenameProduct');
  const body = match[1];
  // No debe re-lanzar en el catch.
  assert.ok(
    !/throw\s+err/.test(body),
    'handleReviewerRenameProduct no debe re-lanzar: el reviewer espera un veredicto',
  );
  // El catch retorna { ok: false, ... }.
  assert.ok(
    /return\s*\{\s*ok:\s*false/.test(body),
    'handleReviewerRenameProduct debe retornar { ok: false, message } en error',
  );
});

test('receive/page.tsx: handleReviewerRenameProduct NO toca setProducts en el catch', async () => {
  const src = await readSource(receivePage);
  const match = src.match(/const\s+handleReviewerRenameProduct\s*=\s*useCallback\(async\s*\(([\s\S]*?)\n\s*\}\s*,\s*\[/);
  assert.ok(match, 'no se encontró handleReviewerRenameProduct');
  const body = match[1];
  // Localizamos el catch block.
  const catchMatch = body.match(/catch\s*\(err[^)]*\)\s*\{([\s\S]*?)\}\s*$/m);
  if (catchMatch) {
    const catchBody = catchMatch[1];
    assert.ok(
      !/setProducts\s*\(/.test(catchBody),
      'el catch de rename NO debe tocar setProducts',
    );
    assert.ok(
      !/broadcastRevalidate\s*\(/.test(catchBody),
      'el catch de rename NO debe emitir PRODUCT_UPDATE',
    );
  }
});

test('receive/page.tsx: pasa handleReviewerRenameProduct como prop onRenameProduct al reviewer', async () => {
  const src = await readSource(receivePage);
  assert.ok(
    /<UnmatchedItemsReviewer[\s\S]*?onRenameProduct=\{handleReviewerRenameProduct\}/.test(src),
    'el UnmatchedItemsReviewer debe recibir onRenameProduct={handleReviewerRenameProduct}',
  );
});
