import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ordersRoot = join(here, "..", "src", "app", "(app)", "inventory", "orders");
const pagePath = join(ordersRoot, "page.tsx");
const hookPath = join(ordersRoot, "hooks", "useSmartRestock.ts");
const cardPath = join(ordersRoot, "components", "SuggestionCard.tsx");

// ============================================================================
// PEDIDOS CROSS-PROVEEDOR — guardianes estáticos
// ============================================================================
//
// Regla del dueño: cuando un producto YA está pedido en una orden PENDING o
// IN_TRANSIT a OTRO proveedor, la pantalla de /inventory/orders tiene que
// avisarlo antes de confirmar. El 409 del backend llega con el desglose
// (proveedor, cantidad, fecha, id del pedido) y la UI lo pinta como
// `6 en camino de HERMARLY · ya pedido`.
//
// El backend sigue siendo la autoridad al confirmar; estos tests sólo validan
// que la UI pinte el aviso con la forma correcta y que el modelo de datos
// soporte el desglose de forma compatible.

test("InTransitProduct se extiende de forma compatible con proveedor origen", async () => {
  const page = await readFile(pagePath, "utf8");
  const block = page.slice(page.indexOf("interface TransitWarningProduct"));
  const upperBlock = block.slice(0, 1200);
  // supplierId / supplierName son opcionales para no romper el contrato viejo.
  assert.match(upperBlock, /supplierId\?: number \| null/,
    "supplierId se agrega como opcional");
  assert.match(upperBlock, /supplierName\?: string \| null/,
    "supplierName se agrega como opcional");
  // Fecha e ID del pedido son opcionales — si el backend no los trae, no se
  // inventan. "si ya está disponible sin inventar", según la especificación.
  assert.match(upperBlock, /expectedDate\?: string \| null/,
    "expectedDate es opcional");
  assert.match(upperBlock, /orderId\?: string \| number \| null/,
    "orderId es opcional");
});

test("el modal 409 muestra el formato pedido 'N en camino de PROVEEDOR · ya pedido'", async () => {
  const page = await readFile(pagePath, "utf8");
  // La cadena final se arma con un supplierLabel derivado de supplierName.
  // Lo importante: que el texto renderice el nombre del proveedor desde el
  // producto en tránsito.
  assert.match(page, /supplierLabel = \(product\.supplierName/,
    "el modal extrae el nombre del proveedor en tránsito");
  assert.match(page, /en camino de \$\{supplierLabel\}/,
    "el string del aviso incluye 'en camino de <supplierLabel>'");
  assert.match(page, /ya pedido/, "mantiene la etiqueta 'ya pedido' pedida por el dueño");
  // Y mantiene el bloque de confirmación con allow_in_transit=true tras el
  // consentimiento (no se bloquea de raíz).
  assert.match(page, /allow_in_transit = true/,
    "el aviso NO bloquea: tras confirmar se envía allow_in_transit=true");
});

test("el modelo RestockSuggestion acepta el desglose en camino por proveedor sin romper", async () => {
  const hook = await readFile(hookPath, "utf8");
  assert.match(hook, /inTransitSuppliers\?: Array</,
    "existe el campo opcional de desglose por proveedor");
  assert.match(hook, /supplierId: number;\s*supplierName: string;\s*quantity: number;/,
    "cada entrada incluye supplierId, supplierName y quantity");
  assert.match(hook, /expectedDate\?: string \| null;\s*orderId\?: string \| number \| null;/,
    "expectedDate y orderId son opcionales cuando el back los puede dar sin inventarlos");
});

test("la tarjeta muestra la línea 'N en camino de PROVEEDOR · ya pedido' por proveedor", async () => {
  const card = await readFile(cardPath, "utf8");
  // Cuando el backend provee desglose, la tarjeta pinta un chip por
  // proveedor. Cuando no, cae al genérico que ya existía (compatible).
  assert.match(card, /inTransitSuppliers/,
    "la tarjeta debe consumir inTransitSuppliers cuando venga");
  assert.match(card, /en camino de \{entry\.supplierName\}/,
    "el texto de cada chip es 'N en camino de SUPPLIER · ya pedido'");
  assert.match(card, /ya pedido/, "mantiene la etiqueta 'ya pedido' pedida por el dueño");
});

test("el aviso 409 lista el proveedor origen y cantidad en el prompt (sin inventar fecha)", async () => {
  const page = await readFile(pagePath, "utf8");
  // Si el backend NO trae supplierName, el UI cae al mensaje corto para no
  // mentir con una fuente inventada.
  assert.match(page, /supplierName \?\? ""/,
    "cuando no hay supplierName, no se inventa un nombre");
  assert.match(page, /\$\{product\.quantity\} en camino de \$\{supplierLabel\}/,
    "cuando sí hay, se pinta 'N en camino de NOMBRE'");
});
