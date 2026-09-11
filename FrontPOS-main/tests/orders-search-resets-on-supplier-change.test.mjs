import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ordersPage = join(here, "..", "src", "app", "(app)", "inventory", "orders", "page.tsx");

/**
 * GUARDIAN: al cambiar de proveedor se limpia la busqueda de productos.
 *
 * REPORTE DEL DUENO (2026-09-11): "en el provedor de zenu solo me esta
 * mostrando 4 productos" ... "me toco recargar y ahi si salio bien".
 *
 * La busqueda de esta pantalla es server-side: el texto viaja en la URL junto
 * al supplier_id. El termino sobrevivia al cambio de proveedor, asi que al
 * elegir Zenu la lista mostraba solo los productos de Zenu que coincidian con
 * lo que habia quedado escrito de la busqueda anterior. Recargar la pagina lo
 * "arreglaba" porque searchInput arranca vacio.
 *
 * Por que importa mas que un detalle de comodidad: el dueno concluye que el
 * proveedor tiene 4 productos y manda el pedido incompleto. Un filtro invisible
 * en la pantalla que decide que se compra es una perdida de plata silenciosa.
 *
 * (includeAll NO puede ser la causa de este sintoma: se persiste en
 * localStorage, asi que una recarga lo conserva.)
 */

test("cambiar de proveedor limpia el texto de busqueda", async () => {
  const source = await readFile(ordersPage, "utf8");

  // Debe existir un efecto que reaccione al cambio de proveedor.
  assert.match(
    source,
    /supplierAnterior/,
    "falta el ref que detecta el cambio de proveedor para limpiar la busqueda",
  );

  // Y ese efecto debe limpiar LAS DOS variables. Si solo limpiara searchInput,
  // el debounce dejaria 300 ms pidiendo con el termino viejo.
  const efecto = source.slice(
    source.indexOf("const supplierAnterior"),
    source.indexOf("const supplierAnterior") + 600,
  );
  assert.match(efecto, /setSearchInput\(""\)/, "el efecto debe limpiar searchInput");
  assert.match(efecto, /setDebouncedSearch\(""\)/, "el efecto debe limpiar debouncedSearch");
  assert.match(
    efecto,
    /\[selectedSupplier\]/,
    "el efecto debe depender de selectedSupplier",
  );
});

test("el termino de busqueda sigue viajando al backend", async () => {
  const source = await readFile(ordersPage, "utf8");

  // Regresion inversa: limpiar la busqueda no puede haber desconectado el
  // parametro que la manda al servidor.
  assert.match(
    source,
    /search:\s*debouncedSearch/,
    "debouncedSearch debe seguir alimentando el endpoint de sugerencias",
  );
});

test("includeAll se persiste y por eso no explica el sintoma", async () => {
  const source = await readFile(ordersPage, "utf8");

  // Documenta el descarte: si algun dia includeAll dejara de persistirse,
  // volveria a ser candidato a "solo me muestra N productos".
  assert.match(
    source,
    /localStorage\.getItem\("pos_orders_include_all"\)/,
    "includeAll se lee de localStorage; si eso cambia, revisar de nuevo este sintoma",
  );
});
