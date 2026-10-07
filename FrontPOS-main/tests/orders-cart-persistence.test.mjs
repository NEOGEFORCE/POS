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
const suggestionCardPath = join(ordersRoot, "components", "SuggestionCard.tsx");

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

  assert.match(source, /CARTS_STORAGE_KEY/, "debe existir una clave de almacenamiento para el borrador");
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
  assert.match(source, /localStorage\.setItem\(CARTS_STORAGE_KEY/, "debe guardarse el borrador al cambiar");
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

test("el borrador es POR PROVEEDOR y persiste al cambiar de supplier", async () => {
  const source = await readFile(hookPath, "utf8");
  // El storage ahora es un mapa { [supplierKey]: PersistedCart } bajo
  // CARTS_STORAGE_KEY. Al cambiar de proveedor NO se descartan los otros
  // borradores: se cargan los del proveedor nuevo y se dejan intactos los
  // demás para no perder lo armado.
  assert.match(source, /CARTS_STORAGE_KEY = "pos_restock_carts_by_supplier_v1"/,
    "la clave canónica es la del mapa por proveedor");
  assert.match(source, /PersistedCartsMap/, "la estructura es un mapa por proveedor");
  // Y al cambiar de proveedor no se tira el storage completo: solo se
  // cargan los datos del proveedor nuevo.
  assert.ok(
    !/removeItem\(CARTS_STORAGE_KEY\)/.test(source),
    "no se puede borrar todos los borradores al cambiar de proveedor"
  );
  assert.match(
    source,
    /CART_MAX_AGE_MS/,
    "el borrador debe vencer con el tiempo"
  );
});

test("se migra el borrador legacy sin perder lo que había guardado", async () => {
  const source = await readFile(hookPath, "utf8");
  assert.match(source, /CART_STORAGE_KEY_LEGACY = "pos_restock_cart_v1"/,
    "debe reconocerse la clave anterior para migrarla");
  assert.match(source, /function migrateLegacyCart/,
    "la migración debe ser explícita y limpiar la clave vieja");
  assert.match(source, /removeItem\(CART_STORAGE_KEY_LEGACY\)/,
    "la clave legacy se purga tras migrar");
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



// ============================================================================
// CROSS-PROVEEDOR: aviso de borrador duplicado
// ============================================================================

test("avisa cuando un producto ya está en el borrador de otro proveedor", async () => {
  const hook = await readFile(hookPath, "utf8");
  // El hook debe exportar un índice de productos en borradores foráneos para
  // que la UI pueda pintar el aviso sin tener que leer localStorage por su
  // cuenta en cada tarjeta.
  assert.match(hook, /export function readForeignCartIndex/,
    "existe el helper que recorre todos los borradores y descarta el del proveedor activo");
  assert.match(hook, /foreignCartIndex/,
    "el hook expone el índice como estado derivado");

  const card = await readFile(suggestionCardPath, "utf8");
  // La tarjeta debe pintar un aviso visible cuando el producto esté en otro
  // borrador. El backend sigue siendo la autoridad al confirmar.
  assert.match(card, /foreignDraft/,
    "la tarjeta recibe la info del borrador foráneo");
  assert.match(card, /borrador de/, "el texto del aviso debe mencionar 'borrador de'");
});
