import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ordersPage = join(here, "..", "src", "app", "(app)", "inventory", "orders", "page.tsx");

/**
 * GUARDIAN: la busqueda de la pantalla de Pedidos Inteligentes es SERVER-SIDE.
 *
 * Historia: la caja de busqueda filtraba en memoria el catalogo completo
 * (visibleGroups.items.filter(...) contra productName y productId). En un
 * catalogo de 2.000+ productos y en celular, eso montaba miles de tarjetas
 * antes de "filtrar" y hacia colapsar la pantalla.
 *
 * Ahora el back devuelve solo lo que hay que pintar. El input de busqueda
 * dispara la peticion con debounce; el frontend NO vuelve a filtrar la lista
 * en memoria por productName/productId/barcode. El filtro ABC (por clase)
 * puede seguir siendo local porque opera sobre una respuesta ya recortada.
 *
 * Este test es estatico: lee el archivo y falla si alguien vuelve a meter
 * filtro por texto local sobre productName o productId.
 */

const FORBIDDEN_PATTERNS = [
  {
    regex: /\.filter\([^)]*productName[^)]*includes/,
    reason: "vuelve a filtrar por productName en memoria",
  },
  {
    regex: /\.filter\([^)]*productId[^)]*includes/,
    reason: "vuelve a filtrar por productId en memoria",
  },
  {
    regex: /\.filter\([^)]*barcode[^)]*includes/,
    reason: "vuelve a filtrar por barcode en memoria",
  },
];

function stripCommentsAndStrings(source) {
  // Se descartan comentarios de una y varias lineas para no leer texto de
  // documentacion, y tambien los strings literales para que un comentario
  // "no uses .filter(productName)" no dispare falso positivo. Se conservan
  // los template strings porque no cabria un filter dentro sin backticks.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/'([^'\\\n]|\\.)*'/g, "''")
    .replace(/"([^"\\\n]|\\.)*"/g, '""');
}

test("la pantalla de pedidos no vuelve a filtrar en memoria por texto", async () => {
  const source = await readFile(ordersPage, "utf8");
  const clean = stripCommentsAndStrings(source);
  for (const { regex, reason } of FORBIDDEN_PATTERNS) {
    assert.ok(
      !regex.test(clean),
      `Pedidos Inteligentes ${reason}. La busqueda es server-side; ` +
        "usa el parametro search del endpoint (buildRestockSuggestionsEndpoint) y deja que el backend devuelva la lista recortada.",
    );
  }
});

test("la pantalla de pedidos usa el builder server-side para la busqueda", async () => {
  const source = await readFile(ordersPage, "utf8");
  // El builder puede vivir en el hook, no necesariamente en la pagina. Se
  // acepta cualquier referencia a search debounced en la pagina O al builder
  // en el hook.
  const hookPath = join(here, "..", "src", "app", "(app)", "inventory", "orders", "hooks", "useSmartRestock.ts");
  const hook = await readFile(hookPath, "utf8");
  const usesBuilder =
    /buildRestockSuggestionsEndpoint/.test(hook) ||
    /buildRestockSuggestionsEndpoint/.test(source);
  assert.ok(
    usesBuilder,
    "no se encontro referencia a buildRestockSuggestionsEndpoint. La busqueda tiene que armar la URL con el helper puro para poder probarla.",
  );
});
