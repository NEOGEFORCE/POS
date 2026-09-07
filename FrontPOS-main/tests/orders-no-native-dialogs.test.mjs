import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ordersPage = join(here, '..', 'src', 'app', '(app)', 'inventory', 'orders', 'page.tsx');

/**
 * GUARDIÁN: la pantalla de Pedidos Inteligentes no usa diálogos del navegador.
 *
 * Historia: el aviso de "estos productos ya fueron pedidos" era un
 * window.confirm(). El navegador lo pinta como un cuadro gris del sistema con
 * la IP del servidor en el título ("192.168.1.6:3000 dice"), aplasta la lista
 * de productos en texto plano y no respeta nada del diseño del POS. El dueño
 * lo reportó textualmente como "esos mensajes que se ven horribles".
 *
 * Ahora se pregunta con un modal propio. Este test es estático, igual que los
 * guardianes del backend, y falla si alguien vuelve a meter un diálogo nativo.
 *
 * Si algún día hace falta preguntar algo nuevo en esta pantalla, la respuesta
 * es un modal (ver el patrón de `transitPrompt` o el de `unlinkTarget`), no un
 * window.confirm.
 */

const FORBIDDEN = [
  { pattern: /window\.confirm\s*\(/, name: 'window.confirm' },
  { pattern: /window\.alert\s*\(/, name: 'window.alert' },
  { pattern: /window\.prompt\s*\(/, name: 'window.prompt' },
  // alert(...) suelto, sin el prefijo window. Se excluye .alert( de objetos
  // propios exigiendo que no venga precedido de un punto.
  { pattern: /(^|[^.\w])alert\s*\(/m, name: 'alert() suelto' },
];

test('la pantalla de pedidos no usa dialogos nativos del navegador', async () => {
  const source = await readFile(ordersPage, 'utf8');

  // Se ignoran los comentarios: los que quedan mencionan window.confirm a
  // propósito, para explicar por qué ya no se usa.
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  for (const { pattern, name } of FORBIDDEN) {
    assert.ok(
      !pattern.test(withoutComments),
      `La pantalla de pedidos volvió a usar ${name}. ` +
      'Usa un modal propio: mirá el patrón de transitPrompt en esa misma página.'
    );
  }
});

test('el aviso de mercancia en camino sigue existiendo como modal propio', async () => {
  const source = await readFile(ordersPage, 'utf8');

  // No basta con borrar el window.confirm: la pregunta TIENE que seguir
  // haciéndose, porque evita pedir dos veces lo mismo.
  assert.ok(
    source.includes('askTransitConfirmation'),
    'desapareció askTransitConfirmation: ya no se le pregunta al operador por la mercancía en camino'
  );
  assert.ok(
    /role="dialog"/.test(source) && source.includes('titulo-ya-pedido'),
    'el modal de mercancía en camino no está, o perdió su rol de diálogo accesible'
  );
  assert.ok(
    source.includes('PRODUCTS_IN_TRANSIT_CONFIRMATION_REQUIRED'),
    'se perdió el manejo del 409 que dispara el aviso'
  );
});
