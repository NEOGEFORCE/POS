import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildConfirmItems } from "../src/lib/order-submission.mjs";

// ============================================================================
// EL BUG DEL DUENO (2026-09-10)
//
// "cuando estoy buscando un producto en pedidos, cuando lo voy a mandar y
//  todavia estoy buscando solo se me manda el que estoy buscando y los demas
//  que tenia selecionados se pierden"
//
// La busqueda de la pantalla de pedidos es del lado del SERVIDOR: al escribir,
// el backend devuelve unicamente las coincidencias y los grupos por proveedor
// se arman con esa respuesta recortada. El envio iteraba group.items, o sea
// solo lo visible, y el resto del pedido desaparecia en silencio.
//
// El carrito ya sobrevivia al filtro (useSmartRestock guarda una foto de cada
// producto elegido). El envio no usaba esas fotos: ese era el hueco.
// ============================================================================

/** Carrito tipico: 3 productos elegidos, de los cuales solo 1 esta en la vista. */
function carritoConBusquedaActiva() {
  return [
    // El que se esta buscando ahora mismo
    { productId: "AZUCAR-1K", productName: "AZUCAR 1KG", quantity: 10, unitCost: 3500, primarySupplierId: 7, enVista: true },
    // Los que ya estaban elegidos y salieron de la vista al buscar
    { productId: "ARROZ-500", productName: "ARROZ 500G", quantity: 24, unitCost: 2400, primarySupplierId: 7, enVista: false },
    { productId: "ACEITE-1L", productName: "ACEITE 1L", quantity: 6, unitCost: 8000, primarySupplierId: 7, enVista: false },
  ];
}

test("manda TODO lo seleccionado, no solo lo que quedo visible al buscar", () => {
  const items = buildConfirmItems({
    selectedItems: carritoConBusquedaActiva(),
    groupSupplierId: 7,
    supplierFilterActive: true,
  });

  assert.equal(items.length, 3, "los 3 productos elegidos deben viajar en el pedido");
  const ids = items.map((i) => i.product_id).sort();
  assert.deepEqual(ids, ["ACEITE-1L", "ARROZ-500", "AZUCAR-1K"]);
});

test("conserva la cantidad y el costo de los productos fuera de la vista", () => {
  const items = buildConfirmItems({
    selectedItems: carritoConBusquedaActiva(),
    groupSupplierId: 7,
    supplierFilterActive: true,
  });

  const arroz = items.find((i) => i.product_id === "ARROZ-500");
  assert.equal(arroz.quantity, 24, "la cantidad no puede perderse por estar fuera de la vista");
  assert.equal(arroz.unit_cost, 2400, "el costo sale de la foto guardada");
  // barcode y product_id son el mismo codigo: el backend espera ambos.
  assert.equal(arroz.barcode, "ARROZ-500");
});

test("el total del pedido enviado coincide con el del carrito", () => {
  const carrito = carritoConBusquedaActiva();
  const items = buildConfirmItems({
    selectedItems: carrito,
    groupSupplierId: 7,
    supplierFilterActive: true,
  });

  const totalCarrito = carrito.reduce((s, i) => s + i.quantity * i.unitCost, 0);
  const totalEnviado = items.reduce((s, i) => s + i.quantity * i.unit_cost, 0);
  assert.equal(totalEnviado, totalCarrito,
    "si el total enviado es menor que el del carrito, se perdieron productos");
  // 10*3500 + 24*2400 + 6*8000 = 35000 + 57600 + 48000
  assert.equal(totalEnviado, 140600);
});

test("descarta cantidades en cero, negativas o no numericas", () => {
  const items = buildConfirmItems({
    selectedItems: [
      { productId: "A", quantity: 5, unitCost: 100, primarySupplierId: 1 },
      { productId: "B", quantity: 0, unitCost: 100, primarySupplierId: 1 },
      { productId: "C", quantity: -3, unitCost: 100, primarySupplierId: 1 },
      { productId: "D", quantity: NaN, unitCost: 100, primarySupplierId: 1 },
      { productId: "", quantity: 9, unitCost: 100, primarySupplierId: 1 },
    ],
    groupSupplierId: 1,
    supplierFilterActive: true,
  });
  assert.deepEqual(items.map((i) => i.product_id), ["A"]);
});

test("sin filtro de proveedor cada pedido se lleva solo lo suyo", () => {
  const carrito = [
    { productId: "P1", quantity: 2, unitCost: 100, primarySupplierId: 7 },
    { productId: "P2", quantity: 3, unitCost: 200, primarySupplierId: 9 },
    { productId: "P3", quantity: 4, unitCost: 300, primarySupplierId: 7 },
  ];

  const delSiete = buildConfirmItems({ selectedItems: carrito, groupSupplierId: 7, supplierFilterActive: false });
  assert.deepEqual(delSiete.map((i) => i.product_id), ["P1", "P3"],
    "el pedido del proveedor 7 no puede arrastrar productos del 9");

  const delNueve = buildConfirmItems({ selectedItems: carrito, groupSupplierId: 9, supplierFilterActive: false });
  assert.deepEqual(delNueve.map((i) => i.product_id), ["P2"]);
});

test("sin filtro, los productos sin proveedor van al grupo sin proveedor", () => {
  const carrito = [
    { productId: "SIN-1", quantity: 1, unitCost: 50, primarySupplierId: null },
    { productId: "CON-1", quantity: 1, unitCost: 50, primarySupplierId: 4 },
  ];
  const sinProveedor = buildConfirmItems({ selectedItems: carrito, groupSupplierId: null, supplierFilterActive: false });
  assert.deepEqual(sinProveedor.map((i) => i.product_id), ["SIN-1"]);
});

test("con filtro activo se envia todo aunque la foto no traiga proveedor", () => {
  // Al elegir un proveedor en el filtro hay UN solo grupo y el hook limpia la
  // seleccion al cambiar de proveedor, asi que no puede colarse nada ajeno.
  // Una foto vieja sin primarySupplierId no debe hacer que se pierda la linea.
  const items = buildConfirmItems({
    selectedItems: [{ productId: "X", quantity: 7, unitCost: 900, primarySupplierId: null }],
    groupSupplierId: 12,
    supplierFilterActive: true,
  });
  assert.equal(items.length, 1, "con filtro activo la atribucion no depende de la foto");
  assert.equal(items[0].quantity, 7);
});

test("tolera entradas ausentes o basura sin explotar", () => {
  assert.deepEqual(buildConfirmItems({ selectedItems: null, groupSupplierId: 1, supplierFilterActive: true }), []);
  assert.deepEqual(buildConfirmItems({ selectedItems: undefined, groupSupplierId: 1, supplierFilterActive: true }), []);
  assert.deepEqual(buildConfirmItems({ selectedItems: [null, undefined], groupSupplierId: 1, supplierFilterActive: true }), []);
});

// ---------------------------------------------------------------------------
// Guardianes estaticos: que el envio no vuelva a leer la lista visible.
// ---------------------------------------------------------------------------

test("la pagina de pedidos arma el envio con buildConfirmItems, no con group.items", () => {
  const page = readFileSync(
    new URL("../src/app/(app)/inventory/orders/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(page, /buildConfirmItems\(/,
    "confirmGroup debe armar las lineas con buildConfirmItems");
  assert.doesNotMatch(page, /const items: ConfirmOrderItem\[\] = group\.items/,
    "volver a iterar group.items reintroduce la perdida de productos al buscar");
});

test("la foto del carrito guarda el proveedor para poder atribuir lo oculto", () => {
  const hook = readFileSync(
    new URL("../src/app/(app)/inventory/orders/hooks/useSmartRestock.ts", import.meta.url),
    "utf8",
  );

  assert.match(hook, /interface SelectedItemSnapshot[\s\S]*?primarySupplierId/,
    "SelectedItemSnapshot necesita primarySupplierId: sin el, un producto fuera de la vista no se puede asignar a su pedido");
  assert.match(hook, /primarySupplierId: item\.primarySupplierId \?\? null/,
    "la foto se debe llenar con el proveedor del producto");
});
