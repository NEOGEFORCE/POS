import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const modalPath = join(
  here,
  '..',
  'src',
  'app',
  '(app)',
  'products',
  'components',
  'ProductFormModal.tsx'
);

/**
 * GUARDIÁN (2026-10-08): la tarjeta "RECOMENDACIÓN DE STOCK" del
 * ProductFormModal debe respetar la regla del dueño:
 *
 *   minStock <= 0 → NEUTRAL, nunca rojo/crítico.
 *
 * Antes la tarjeta tenía su propia lógica (isOut = current <= 0) y pintaba
 * "SIN STOCK (COMPRAR URGENTE)" en rojo para un producto con stock 0 y
 * mínimo 0, aunque ese caso refleja una decisión deliberada del dueño
 * (producto descontinuado, estacional, consignación). La fuente única del
 * semáforo vive en calculateStockHealth / getStockHealth; esta pantalla
 * ahora delega en el helper central.
 *
 * Este guardián falla si:
 *   1. El modal vuelve a derivar isCritical / isOut de la vieja regla
 *      (`current <= min && current > 0` y `current <= 0`) sin un corte
 *      previo para minStock <= 0.
 *   2. El modal no importa calculateStockHealth.
 *   3. Desaparece la rama explícita que trata minStock <= 0 como neutral.
 */

const README = `
Regla permanente: productos sin minimo configurado nunca aparecen
rojos/criticos. Esta pantalla delega en calculateStockHealth y agrega
una rama explicita neutral para min <= 0.
`;

test('ProductFormModal importa el helper canonico de salud de stock', async () => {
  const source = await readFile(modalPath, 'utf8');
  assert.ok(
    /import\s*{[^}]*calculateStockHealth[^}]*}\s*from\s*["']@\/lib\/utils["']/.test(source),
    'ProductFormModal debe importar calculateStockHealth desde @/lib/utils. ' + README,
  );
});

test('ProductFormModal trata explicitamente minStock<=0 como neutral', async () => {
  const source = await readFile(modalPath, 'utf8');
  // La rama tiene que existir ANTES del calculo de isOut/isCritical para que
  // los productos sin minimo nunca entren en la rama que pinta rojo.
  const neutralBranch = source.search(/if\s*\(\s*min\s*<=\s*0\s*\)/);
  assert.notEqual(
    neutralBranch,
    -1,
    'Falta la rama explicita "if (min <= 0)" que neutraliza la tarjeta de recomendacion. ' + README,
  );
  const isOutIndex = source.indexOf('const isOut = current <= 0');
  assert.notEqual(isOutIndex, -1, 'No se encontro el calculo de isOut en el modal.');
  assert.ok(
    neutralBranch < isOutIndex,
    'La rama minStock<=0 debe aparecer ANTES de calcular isOut/isCritical. ' + README,
  );
});

test('ProductFormModal NO vuelve a derivar isCritical del viejo patron', async () => {
  const source = await readFile(modalPath, 'utf8');
  // Nos interesa SOLO el bloque de RECOMENDACION DE STOCK.
  const start = source.indexOf('{/* RECOMENDACION DE STOCK */}');
  assert.notEqual(start, -1, 'no se encontro el bloque de RECOMENDACION DE STOCK');
  const end = source.indexOf('{/* 4. CONFIGURACION ESPECIAL', start);
  assert.notEqual(end, -1, 'no se encontro el final del bloque de recomendacion');
  const block = source.slice(start, end);

  // El viejo patron NO debe reaparecer sin pasar antes por calculateStockHealth.
  const oldPattern = /isCritical\s*=\s*current\s*<=\s*min\s*&&\s*current\s*>\s*0/;
  assert.ok(
    !oldPattern.test(block),
    'ProductFormModal volvio al patron legacy "current <= min && current > 0". ' +
    'Debe delegar en calculateStockHealth. ' + README,
  );

  // Debe seguir delegando en el helper canonico.
  assert.ok(
    /calculateStockHealth\s*\(/.test(block),
    'El bloque de recomendacion debe llamar a calculateStockHealth(current, min). ' + README,
  );
});

test('ProductFormModal expone el estado "SIN MINIMO CONFIGURADO" como texto', async () => {
  const source = await readFile(modalPath, 'utf8');
  // La UI debe decirle al operador por que la tarjeta esta neutral: no es
  // un bug, es que el producto no tiene minimo configurado.
  assert.ok(
    /SIN MINIMO CONFIGURADO/i.test(source) || /SIN\s*MI?NIMO\s*CONFIGURADO/i.test(source),
    'La tarjeta de recomendacion debe rotular visualmente que el producto no tiene minimo. ' + README,
  );
});
