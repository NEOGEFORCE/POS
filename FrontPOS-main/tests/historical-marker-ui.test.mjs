import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * GUARDIÁN: la pantalla de catálogo maneja HISTORICAL_MARKER_RESERVED con un
 * AlertDialog propio, no con window.confirm ni un toast que confunda.
 *
 * Este test es estático, corre en `node --test` y falla si alguien regresa la
 * regresión (usar un confirm nativo, borrar el diálogo o dejar de reaccionar al
 * 409).
 */

const here = dirname(fileURLToPath(import.meta.url));
const productsPage = join(here, '..', 'src', 'app', '(app)', 'products', 'page.tsx');
const dialogFile = join(
  here,
  '..',
  'src',
  'app',
  '(app)',
  'products',
  'components',
  'HistoricalMarkerMergeDialog.tsx',
);

async function readSource(path) {
  const raw = await readFile(path, 'utf8');
  // Ignorar comentarios: los que quedan mencionan window.confirm a propósito.
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('la pantalla de productos NO usa diálogos nativos del navegador', async () => {
  const source = await readSource(productsPage);
  const forbidden = [
    { pattern: /window\.confirm\s*\(/, name: 'window.confirm' },
    { pattern: /window\.alert\s*\(/, name: 'window.alert' },
    { pattern: /window\.prompt\s*\(/, name: 'window.prompt' },
    { pattern: /(^|[^.\w])alert\s*\(/m, name: 'alert() suelto' },
  ];
  for (const { pattern, name } of forbidden) {
    assert.ok(
      !pattern.test(source),
      `products/page.tsx volvió a usar ${name}. Usa el AlertDialog de HistoricalMarkerMergeDialog o el ConfirmDialog de HeroUI.`,
    );
  }
});

test('products/page.tsx importa y renderiza el HistoricalMarkerMergeDialog', async () => {
  const source = await readSource(productsPage);
  assert.ok(
    source.includes('HistoricalMarkerMergeDialog'),
    'se perdió la referencia al HistoricalMarkerMergeDialog en products/page.tsx',
  );
  assert.ok(
    /import\s*\(\s*['"]\.\/components\/HistoricalMarkerMergeDialog['"]/.test(source),
    'products/page.tsx debe cargar HistoricalMarkerMergeDialog vía dynamic import (patrón del resto de modales premium)',
  );
});

test('products/page.tsx reacciona al código HISTORICAL_MARKER_RESERVED', async () => {
  const source = await readSource(productsPage);
  assert.ok(
    source.includes('isHistoricalMarkerError'),
    'se perdió el detector isHistoricalMarkerError; sin él el 409 vuelve a caer al toast genérico',
  );
  assert.ok(
    source.includes('extractHistoricalMarkerMetadata'),
    'se perdió la extracción de metadata: el diálogo debe recibir realBarcode/markerBarcode/markerName',
  );
  assert.ok(
    source.includes('/admin/products/merge-historical'),
    'products/page.tsx dejó de llamar al endpoint admin de fusión',
  );
  assert.ok(
    source.includes('stripStaleTimestamp'),
    'el reintento del PUT tras la fusión debe omitir updatedAt obsoleto (stripStaleTimestamp)',
  );
});

test('el AlertDialog de fusión usa la primitiva shadcn y respeta accesibilidad', async () => {
  const raw = await readFile(dialogFile, 'utf8');
  assert.ok(
    /from\s+['"]@\/components\/ui\/alert-dialog['"]/.test(raw),
    'HistoricalMarkerMergeDialog debe importar la primitiva shadcn AlertDialog',
  );
  for (const symbol of [
    'AlertDialog',
    'AlertDialogContent',
    'AlertDialogTitle',
    'AlertDialogDescription',
    'AlertDialogFooter',
    'AlertDialogCancel',
    'AlertDialogAction',
  ]) {
    assert.ok(raw.includes(symbol), `HistoricalMarkerMergeDialog perdió el uso de ${symbol}`);
  }
  assert.ok(
    /aria-describedby="historical-marker-desc"/.test(raw) && /id="historical-marker-desc"/.test(raw),
    'HistoricalMarkerMergeDialog debe emparejar aria-describedby con el id de la descripción',
  );
});

test('el diálogo esconde el botón de fusión cuando isAdmin es false y muestra la instrucción', async () => {
  const raw = await readFile(dialogFile, 'utf8');
  assert.ok(
    /!isAdmin\s*&&/.test(raw),
    'HistoricalMarkerMergeDialog debe pintar una indicación cuando el usuario NO es admin',
  );
  assert.ok(
    /isAdmin\s*&&\s*[\s\S]*AlertDialogAction/.test(raw),
    'HistoricalMarkerMergeDialog sólo debe pintar el AlertDialogAction (fusionar) para admins',
  );
});
