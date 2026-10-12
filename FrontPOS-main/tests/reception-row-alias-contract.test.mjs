import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * GUARDIANES ESTÁTICOS — ReceptionRow camino secundario (`isMatched === false`).
 *
 * Historia:
 *   La versión antigua de `handleSaveQuickEdit` cuando `item.isMatched === false`
 *   leía el supplierId desde `localStorage` (dos claves distintas), caía a `"0"`
 *   si no había nada, hacía un `fetch` directo a `/inventory/save-alias` y
 *   después afirmaba al usuario "el sistema lo recordará" sin comprobar el
 *   resultado. Si el supplier venía 0, el backend aceptaba el payload pero no
 *   recordaba el alias, y el usuario era engañado con un toast de éxito.
 *
 * Contrato nuevo (preservando edición/carrito):
 *   1. ReceptionRow recibe `supplierId` por prop desde `page.tsx`.
 *   2. Se persiste el alias reutilizando `persistAlias` del helper puro
 *      `src/lib/alias-persistence.mjs` (NO fetch directo).
 *   3. Nunca se lee `localStorage` dentro de `handleSaveQuickEdit`.
 *   4. Nunca se usa `supplierId: 0` como fallback.
 *   5. Después de llamar al helper, se inspecciona `verdict.ok` ANTES de
 *      decirle al usuario que el OCR lo recordará (toast success solo si ok;
 *      toast destructive con mensaje humano cuando no).
 *   6. page.tsx pasa `supplierId={selectedGlobalSupplier || undefined}` a
 *      cada ReceptionRow.
 */

const here = dirname(fileURLToPath(import.meta.url));
const receptionRow = join(
  here, '..', 'src', 'app', '(app)', 'inventory', 'receive', 'components', 'ReceptionRow.tsx',
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

/**
 * Extrae el cuerpo de la rama `isMatched === false` dentro de
 * `handleSaveQuickEdit`. Delimitado desde la condición hasta el `return;`
 * que cierra la rama.
 */
function sliceIsMatchedFalseBranch(src) {
  const marker = 'if (item.isMatched === false)';
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const rest = src.slice(start);
  // La rama termina con `return;` + un salto de línea. Tomamos la primera
  // ocurrencia después del marker.
  const endIdx = rest.indexOf('return;');
  if (endIdx === -1) return null;
  return rest.slice(0, endIdx + 'return;'.length);
}

// ─────────────────────────────────────────────────────────────────────────
// GUARDIANES — ReceptionRow.tsx
// ─────────────────────────────────────────────────────────────────────────

test('ReceptionRow importa persistAlias desde alias-persistence.mjs', async () => {
  const src = await readSource(receptionRow);
  assert.ok(
    /from\s+['"]@\/lib\/alias-persistence\.mjs['"]/.test(src),
    'ReceptionRow debe importar desde @/lib/alias-persistence.mjs',
  );
  assert.ok(
    /\bpersistAlias\b/.test(src),
    'ReceptionRow debe usar el helper persistAlias',
  );
});

test('ReceptionRowProps declara la prop supplierId', async () => {
  const src = await readSource(receptionRow);
  // Buscamos la declaración de la prop dentro de la interface — tolera
  // reformateo multi-línea sin romper por whitespace.
  assert.ok(
    /interface\s+ReceptionRowProps\s*\{[\s\S]*?\bsupplierId\?:\s*string\s*\|\s*number\s*\|\s*null\s*;/.test(src),
    'ReceptionRowProps debe declarar supplierId?: string | number | null',
  );
});

test('ReceptionRow desestructura supplierId en la firma del memo', async () => {
  const src = await readSource(receptionRow);
  assert.ok(
    /memo\(\(\{[^}]*\bsupplierId\b[^}]*\}:\s*ReceptionRowProps\)/.test(src),
    'ReceptionRow debe desestructurar supplierId: memo(({ ..., supplierId, ... }: ReceptionRowProps) => ...)',
  );
});

test('ReceptionRow.handleSaveQuickEdit rama isMatched=false NO lee localStorage', async () => {
  const src = await readSource(receptionRow);
  const branch = sliceIsMatchedFalseBranch(src);
  assert.ok(branch, 'no se encontró la rama `isMatched === false`');
  assert.ok(
    !/\blocalStorage\b/.test(branch),
    'la rama isMatched=false no debe leer localStorage (ni org-pos-reception-supplier ni selectedSupplierId)',
  );
  assert.ok(
    !/org-pos-reception-supplier/.test(branch),
    'referencia prohibida a org-pos-reception-supplier dentro de la rama',
  );
  assert.ok(
    !/selectedSupplierId/.test(branch),
    'referencia prohibida a selectedSupplierId dentro de la rama',
  );
});

test('ReceptionRow.handleSaveQuickEdit rama isMatched=false NO cae a supplierId=0', async () => {
  const src = await readSource(receptionRow);
  const branch = sliceIsMatchedFalseBranch(src);
  assert.ok(branch, 'no se encontró la rama `isMatched === false`');
  // Buscamos literal `"0"` (fallback del código viejo) o `supplierId: 0`.
  assert.ok(
    !/\bsupplierId:\s*0\b/.test(branch),
    'la rama no debe pasar supplierId: 0 como fallback',
  );
  assert.ok(
    !/Number\(\s*supplierId\s*\)/.test(branch),
    'la rama no debe envolver supplierId en Number(...) con la coerción tradicional (el helper lo normaliza)',
  );
  assert.ok(
    !/\|\|\s*["']0["']/.test(branch),
    'la rama no debe caer a "0" como fallback por OR',
  );
});

test('ReceptionRow.handleSaveQuickEdit rama isMatched=false NO hace fetch directo a /inventory/save-alias', async () => {
  const src = await readSource(receptionRow);
  const branch = sliceIsMatchedFalseBranch(src);
  assert.ok(branch, 'no se encontró la rama `isMatched === false`');
  assert.ok(
    !/save-alias/.test(branch),
    'la rama ya no debe mencionar save-alias (lo hace persistAlias)',
  );
  // Buscamos cualquier `fetch(` que tenga 'inventory/save-alias' cerca.
  assert.ok(
    !/fetch\s*\(\s*[`'"][^)]*save-alias/.test(branch),
    'la rama no debe disparar fetch directo al endpoint de alias',
  );
});

test('ReceptionRow.handleSaveQuickEdit rama isMatched=false llama persistAlias con supplierId por prop', async () => {
  const src = await readSource(receptionRow);
  const branch = sliceIsMatchedFalseBranch(src);
  assert.ok(branch, 'no se encontró la rama `isMatched === false`');
  assert.ok(
    /persistAlias\s*\(/.test(branch),
    'la rama debe invocar persistAlias(...)',
  );
  // La invocación debe usar `supplierId` tal como lo recibe por prop, no
  // una variable local inventada. Toleramos tanto `supplierId,` (shorthand)
  // como `supplierId: supplierId` explícito.
  assert.ok(
    /persistAlias\s*\(\s*\{[\s\S]*?\bsupplierId(,|\s*:\s*supplierId)/.test(branch),
    'persistAlias debe recibir supplierId (prop) directamente',
  );
  // Y debe pasar el invoiceName del item (preservando el original) y el
  // barcode del producto emparejado.
  assert.ok(
    /invoiceName:\s*\(item as any\)\.invoiceName\s*\|\|\s*item\.productName/.test(branch),
    'persistAlias debe recibir invoiceName del item (fallback a productName)',
  );
  assert.ok(
    /productBarcode:\s*realProduct\.barcode/.test(branch),
    'persistAlias debe recibir productBarcode del producto emparejado',
  );
});

test('ReceptionRow.handleSaveQuickEdit rama isMatched=false comprueba verdict.ok antes de afirmar que será recordado', async () => {
  const src = await readSource(receptionRow);
  const branch = sliceIsMatchedFalseBranch(src);
  assert.ok(branch, 'no se encontró la rama `isMatched === false`');
  // Debe haber una variable que capture el veredicto (nombre libre pero
  // lo esperamos como aliasVerdict por convención del repo).
  assert.ok(
    /const\s+aliasVerdict\s*=\s*await\s+persistAlias\s*\(/.test(branch),
    'la rama debe capturar el veredicto en aliasVerdict',
  );
  // Debe inspeccionar `aliasVerdict.ok` (if o ternario) antes del toast
  // optimista.
  assert.ok(
    /aliasVerdict\.ok/.test(branch),
    'la rama debe inspeccionar aliasVerdict.ok',
  );
  // Debe existir una rama destructive para el caso en que persistAlias falla.
  assert.ok(
    /variant:\s*['"]destructive['"]/.test(branch),
    'la rama debe mostrar un toast destructive cuando persistAlias no ok',
  );
  // Y debe mantener el toast de éxito.
  assert.ok(
    /variant:\s*['"]success['"]/.test(branch),
    'la rama debe mantener el toast success cuando persistAlias ok',
  );
});

test('ReceptionRow.handleSaveQuickEdit rama isMatched=false actualiza la fila (contrato de carrito) incluso cuando falla el alias', async () => {
  const src = await readSource(receptionRow);
  const branch = sliceIsMatchedFalseBranch(src);
  assert.ok(branch, 'no se encontró la rama `isMatched === false`');
  // La llamada a onUpdate debe estar fuera del condicional de aliasVerdict.ok
  // para garantizar que el carrito se actualiza aunque falle el alias.
  // Heurística: onUpdate aparece ANTES del primer uso de aliasVerdict.ok en
  // el flujo lineal del branch.
  const idxUpdate = branch.indexOf('onUpdate(item.lineId');
  const idxVerdictOk = branch.indexOf('aliasVerdict.ok');
  assert.ok(idxUpdate > -1, 'la rama debe invocar onUpdate(item.lineId, ...) para actualizar el carrito');
  assert.ok(idxVerdictOk > -1, 'la rama debe inspeccionar aliasVerdict.ok');
  assert.ok(
    idxUpdate < idxVerdictOk,
    'onUpdate(item.lineId, ...) debe ocurrir ANTES del chequeo de aliasVerdict.ok (contrato: carrito se actualiza aunque falle el alias)',
  );
  // El payload debe seguir seteando isMatched: true (promueve la fila
  // a emparejada).
  assert.ok(
    /isMatched:\s*true/.test(branch),
    'la fila debe quedar marcada como isMatched: true tras el emparejamiento manual',
  );
});

// ─────────────────────────────────────────────────────────────────────────
// GUARDIANES — page.tsx: supplierId se pasa como prop
// ─────────────────────────────────────────────────────────────────────────

test('page.tsx pasa supplierId={selectedGlobalSupplier...} al ReceptionRow', async () => {
  const src = await readSource(receivePage);
  // Buscamos la etiqueta JSX <ReceptionRow ... supplierId=...> dentro del
  // archivo. Dado que es la única ReceptionRow renderizada, la ventana
  // es amplia.
  assert.ok(
    /<ReceptionRow[\s\S]*?supplierId=\{selectedGlobalSupplier[^}]*\}/.test(src),
    'page.tsx debe pasar supplierId={selectedGlobalSupplier ...} al ReceptionRow',
  );
  // No debe caer a 0 ni a Number(0) en la prop.
  assert.ok(
    !/<ReceptionRow[\s\S]*?supplierId=\{0\}/.test(src),
    'page.tsx no debe pasar supplierId={0} como fallback',
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Guardianes positivos: la rama matched (edición normal) no se tocó
// ─────────────────────────────────────────────────────────────────────────

test('ReceptionRow preserva la rama de edición normal (apiFetch sobre /products/update-products)', async () => {
  const src = await readSource(receptionRow);
  // El contrato normal de edición debe seguir intacto: usa apiFetch para
  // leer y actualizar el producto, y hace broadcastRevalidate('PRODUCT_UPDATE').
  assert.ok(
    /apiFetch[\s\S]*?\/products\/get-products\/\$\{item\.barcode\}/.test(src),
    'la rama normal debe seguir usando apiFetch para get-products',
  );
  assert.ok(
    /apiFetch[\s\S]*?\/products\/update-products\/\$\{item\.barcode\}/.test(src),
    'la rama normal debe seguir usando apiFetch para update-products',
  );
  assert.ok(
    /broadcastRevalidate\(['"]PRODUCT_UPDATE['"]\)/.test(src),
    'la rama normal debe seguir broadcasteando PRODUCT_UPDATE',
  );
});
