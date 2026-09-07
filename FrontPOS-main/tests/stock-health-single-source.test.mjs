import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const utilsPath = join(here, '..', 'src', 'lib', 'utils.ts');

/**
 * GUARDIÁN: una sola fuente de verdad para el semáforo de stock.
 *
 * Historia: había DOS implementaciones con cortes distintos.
 *   - src/lib/stock-health.mjs        -> 25 % / 75 % (la regla del dueño)
 *   - src/lib/utils.ts (calculateStockHealth) -> 25 % / 60 %
 *
 * Resultado: un producto al 65 % de su mínimo salía VERDE en /products y
 * AMARILLO en /inventory/orders. El mismo producto con dos colores según la
 * pantalla es exactamente el tipo de contradicción que el dueño reportó.
 *
 * Este test es estático, igual que los guardianes del backend
 * (TestNoAutoWriteToMinStock, TestNoAutoWriteToVisitDaysOrDeliveryDays):
 * lee el archivo y falla si alguien vuelve a escribir umbrales a mano ahí.
 * calculateStockHealth debe DELEGAR en getStockHealth.
 */

test('calculateStockHealth no define sus propios umbrales de porcentaje', async () => {
  const source = await readFile(utilsPath, 'utf8');

  // Aísla el cuerpo de calculateStockHealth para no analizar todo el archivo.
  const start = source.indexOf('export const calculateStockHealth');
  assert.notEqual(start, -1, 'no se encontró calculateStockHealth en src/lib/utils.ts');
  const end = source.indexOf('export const getStockStatus', start);
  assert.notEqual(end, -1, 'no se encontró el final de calculateStockHealth');
  const body = source.slice(start, end);

  // Patrones prohibidos: comparar un porcentaje o un ratio contra un número
  // literal. Los cortes viven en stock-health.mjs y en ningún otro lugar.
  const forbidden = [
    /percentage\s*[<>]=?\s*\d/,
    /ratio\s*[<>]=?\s*0?\.\d/,
    /\(\s*s\s*\/\s*m\s*\)\s*\*\s*100/,
  ];
  for (const pattern of forbidden) {
    assert.ok(
      !pattern.test(body),
      `calculateStockHealth volvió a definir umbrales propios (${pattern}). ` +
      'Los cortes son del dueño y viven solo en src/lib/stock-health.mjs.'
    );
  }

  // Y debe delegar explícitamente.
  assert.ok(
    body.includes('getStockHealth('),
    'calculateStockHealth debe delegar en getStockHealth de stock-health.mjs'
  );
});

test('utils.ts importa el semaforo canonico', async () => {
  const source = await readFile(utilsPath, 'utf8');
  assert.ok(
    /from\s+["']@\/lib\/stock-health\.mjs["']/.test(source),
    'src/lib/utils.ts debe importar los helpers de @/lib/stock-health.mjs'
  );
});
