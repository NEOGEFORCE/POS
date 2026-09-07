import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ordersRoot = join(here, "..", "src", "app", "(app)", "inventory", "orders");
const hookPath = join(ordersRoot, "hooks", "useSmartRestock.ts");
const pagePath = join(ordersRoot, "page.tsx");
const cartPath = join(ordersRoot, "components", "OrderCartModal.tsx");

// ============================================================================
// EL PEDIDO A MEDIO ARMAR NO SE PIERDE
// ============================================================================
//
// Dos bugs reportados por el dueño el 2026-09-05:
//
//  1. "agrego algo, busco otro producto y cuando vuelvo a todos se borra el
//     numero que habia puesto"
//  2. "si me salgo por equivocacion y vuelvo y entro me tiene que cargar lo que
//     ya tenia seleccionado"
//
// CAUSA DEL PRIMERO: el efecto que reacciona a `data` reconstruia el mapa de
// cantidades SOLO con los productos de la respuesta actual. Al buscar, `data`
// se reducia a las coincidencias y las cantidades de todo lo demas se
// DESCARTABAN. Ademas orderTotal y orderItemCount se calculaban sobre
// `suggestions`, asi que el total tambien bajaba al buscar.
//
// CAUSA DEL SEGUNDO: no habia persistencia; el pedido vivia solo en memoria.

test("las cantidades de lo ya elegido no se descartan al cambiar la vista", async () => {
  const source = await readFile(hookPath, "utf8");

  // El efecto debe preservar lo editado recorriendo editedProducts, no solo data.
  assert.match(
    source,
    /for \(const productId of editedProducts\.current\)/,
    "el efecto debe recorrer editedProducts para preservar lo ya elegido aunque no venga en la respuesta actual"
  );

  // Y no puede volver el patron que descartaba todo lo que no estuviera en data.
  assert.ok(
    !/next\[item\.productId\] = editedProducts\.current\.has\(item\.productId\)/.test(source),
    "volvio el patron que reconstruia las cantidades solo desde data y borraba el resto"
  );
});

test("el total y el contador se calculan sobre lo elegido, no sobre lo visible", async () => {
  const source = await readFile(hookPath, "utf8");

  assert.match(
    source,
    /orderTotal = useMemo\(\s*\(\) => selectedItems\.reduce/,
    "orderTotal debe sumar selectedItems; si suma sobre suggestions, el total baja al buscar"
  );
  assert.ok(
    !/suggestions\.reduce\(\s*\(total, item\) => total \+ \(orderQuantities/.test(source),
    "volvio el total calculado sobre suggestions: baja cuando el usuario busca algo"
  );
  assert.match(
    source,
    /orderItemCount = useMemo\(\(\) => selectedItems\.length/,
    "el contador debe medir selectedItems"
  );
});

test("el pedido se guarda y se restaura al salir y volver a entrar", async () => {
  const source = await readFile(hookPath, "utf8");

  assert.match(source, /CART_STORAGE_KEY/, "debe existir una clave de almacenamiento para el borrador");
  assert.match(
    source,
    /loadPersistedCart/,
    "debe existir la restauracion del borrador guardado"
  );
  // La restauracion va en el inicializador del estado, no en un efecto, para que
  // la primera pintura ya traiga las cantidades.
  assert.match(
    source,
    /useState<Record<string, number>>\(\(\) => \{[\s\S]*?loadPersistedCart/,
    "la restauracion debe ir en el inicializador perezoso de useState"
  );
  assert.match(source, /localStorage\.setItem\(CART_STORAGE_KEY/, "debe guardarse el borrador al cambiar");
});

test("lo restaurado se marca como editado para que el efecto no lo ponga en cero", async () => {
  const source = await readFile(hookPath, "utf8");
  // Sin esto, el efecto que reacciona a `data` consideraria las cantidades
  // restauradas como "no tocadas" y las volveria a cero.
  assert.match(
    source,
    /restoredOnce[\s\S]{0,400}editedProducts\.current\.add\(productId\)/,
    "las cantidades restauradas deben registrarse en editedProducts"
  );
});

test("el borrador es por proveedor y no revive pedidos viejos", async () => {
  const source = await readFile(hookPath, "utf8");
  assert.match(source, /parsed\.supplierKey !== supplierKey/, "el borrador solo aplica al mismo proveedor");
  assert.match(source, /CART_MAX_AGE_MS/, "el borrador debe vencer con el tiempo");
  assert.match(
    source,
    /removeItem\(CART_STORAGE_KEY\)/,
    "al cambiar de proveedor o quedar vacio, el borrador se descarta"
  );
});

test("un borrador corrupto no puede tumbar la pantalla", async () => {
  const source = await readFile(hookPath, "utf8");
  const bloque = source.slice(source.indexOf("function loadPersistedCart"));
  assert.match(bloque.slice(0, 700), /catch/, "la lectura del borrador debe estar protegida");
});

// ============================================================================
// EL CARRITO
// ============================================================================

test("el carrito lista solo lo que tiene cantidad y permite ajustarla", async () => {
  const source = await readFile(cartPath, "utf8");

  // Recibe ya filtrado desde el hook (selectedItems solo trae quantity > 0).
  assert.match(source, /items: SelectedItem\[\]/, "el carrito recibe los items seleccionados");
  assert.match(source, /onSetQuantity/, "debe poder ajustar cantidades sin salir del carrito");
  assert.match(source, /Confirmar pedido/, "debe tener la accion de confirmar");
  assert.match(source, /Seguir agregando/, "debe poder volver a la lista sin perder nada");

  // Estado vacio explicado, no una pantalla en blanco.
  assert.match(source, /Todavía no hay productos con cantidad|Escribí una cantidad/, "debe explicar el estado vacio");

  // Accesibilidad en los botones de accion.
  assert.match(source, /aria-label/, "los botones del carrito deben tener etiqueta accesible");
});

test("la barra del pedido tiene el boton del carrito junto al total", async () => {
  const source = await readFile(pagePath, "utf8");
  assert.match(source, /setIsCartOpen\(true\)/, "debe existir el boton que abre el carrito");
  assert.match(source, /ShoppingCart/, "el boton debe usar el icono de carrito");
  assert.match(source, /<OrderCartModal/, "el carrito debe estar montado en la pagina");
  assert.match(source, /items=\{selectedItems\}/, "el carrito recibe los items del hook");
});

test("confirmar desde el carrito lleva al formulario en vez de enviar sin fecha", async () => {
  const source = await readFile(pagePath, "utf8");
  // El envio real exige fecha de entrega y valor del pedido; el carrito no debe
  // saltarselos.
  assert.match(source, /data-order-confirm-form/, "el formulario de confirmacion debe estar marcado");
  assert.match(
    source,
    /querySelector\("\[data-order-confirm-form\]"\)/,
    "confirmar desde el carrito debe llevar al formulario"
  );
});
