import { test } from "node:test";
import assert from "node:assert/strict";

import { isAlreadyOrdered, orderSuggestions } from "../src/lib/restock-ordering.mjs";

// ============================================================================
// REGLA DEL DUENO (2026-09-10, textual): "en los productos que ya se pidieron,
// si se pidio por cualquier provedor necesito que me salga mejor que ya se pidio
// y si ya se pidio que salga en la partes de al fondoooo, asi no se cruza con lo
// que falta pedir".
//
// El problema: un producto AGOTADO con mercancia en camino sigue en banda ROJA,
// asi que encabezaba la lista aunque no hubiera nada que hacer con el. El dueno
// tenia que leer tarjeta por tarjeta para separar "hay que pedirlo" de "ya
// viene".
// ============================================================================

function item(over = {}) {
  return {
    productId: "P",
    productName: "PRODUCTO",
    stockBand: "RED",
    liveStock: 0,
    minStock: 3,
    avgDailySales: 0.5,
    inTransitQty: 0,
    suggestedOrderQty: 0,
    ...over,
  };
}

test("lo ya pedido y cubierto se va al fondo, aunque este en rojo", () => {
  const lista = [
    item({ productId: "YA-PEDIDO", stockBand: "RED", inTransitQty: 6, suggestedOrderQty: 0 }),
    item({ productId: "FALTA", stockBand: "RED", inTransitQty: 0, suggestedOrderQty: 4 }),
    item({ productId: "OPTIMO", stockBand: "GREEN", inTransitQty: 0, suggestedOrderQty: 0 }),
  ];

  const orden = orderSuggestions(lista).map((i) => i.productId);

  assert.deepEqual(orden, ["FALTA", "OPTIMO", "YA-PEDIDO"],
    "el que ya viene en camino no puede competir con el que hay que pedir");
});

test("varios ya pedidos quedan todos al final, entre ellos con el orden normal", () => {
  const lista = [
    item({ productId: "PEDIDO-VERDE", stockBand: "GREEN", inTransitQty: 2, suggestedOrderQty: 0 }),
    item({ productId: "FALTA-AMARILLO", stockBand: "YELLOW", inTransitQty: 0, suggestedOrderQty: 2 }),
    item({ productId: "PEDIDO-ROJO", stockBand: "RED", inTransitQty: 5, suggestedOrderQty: 0 }),
    item({ productId: "FALTA-ROJO", stockBand: "RED", inTransitQty: 0, suggestedOrderQty: 7 }),
  ];

  const orden = orderSuggestions(lista).map((i) => i.productId);

  // Primero lo que falta pedir (rojo antes que amarillo), despues lo ya pedido
  // (y entre ellos, rojo antes que verde).
  assert.deepEqual(orden, ["FALTA-ROJO", "FALTA-AMARILLO", "PEDIDO-ROJO", "PEDIDO-VERDE"]);
});

test("si esta pedido pero AUN falta, se queda arriba", () => {
  // Tiene 2 en camino pero la sugerencia pide 5 mas: sigue siendo trabajo por
  // hacer y no puede esconderse al fondo.
  const lista = [
    item({ productId: "CUBIERTO", inTransitQty: 10, suggestedOrderQty: 0 }),
    item({ productId: "PARCIAL", inTransitQty: 2, suggestedOrderQty: 5 }),
  ];

  const orden = orderSuggestions(lista).map((i) => i.productId);
  assert.deepEqual(orden, ["PARCIAL", "CUBIERTO"]);
});

test("isAlreadyOrdered exige transito Y que no quede nada pendiente", () => {
  assert.equal(isAlreadyOrdered(item({ inTransitQty: 3, suggestedOrderQty: 0 })), true);
  assert.equal(isAlreadyOrdered(item({ inTransitQty: 3, suggestedOrderQty: 2 })), false,
    "con sugerencia pendiente todavia hay que pedir");
  assert.equal(isAlreadyOrdered(item({ inTransitQty: 0, suggestedOrderQty: 0 })), false,
    "sin transito no esta pedido");
});

test("tolera datos ausentes o basura", () => {
  assert.equal(isAlreadyOrdered(null), false);
  assert.equal(isAlreadyOrdered(undefined), false);
  assert.equal(isAlreadyOrdered({}), false);
  assert.equal(isAlreadyOrdered(item({ inTransitQty: NaN, suggestedOrderQty: 0 })), false);
  assert.equal(isAlreadyOrdered(item({ inTransitQty: -3, suggestedOrderQty: 0 })), false);
  // Sugerencia no numerica se trata como "nada pendiente".
  assert.equal(isAlreadyOrdered(item({ inTransitQty: 4, suggestedOrderQty: null })), true);
});

test("el orden sigue siendo estable y simetrico", () => {
  // Guardian del comparador: ordenar dos veces da lo mismo, y no explota con
  // listas donde todo empata.
  const lista = [
    item({ productId: "A", inTransitQty: 1, suggestedOrderQty: 0 }),
    item({ productId: "B", inTransitQty: 1, suggestedOrderQty: 0 }),
    item({ productId: "C", inTransitQty: 1, suggestedOrderQty: 0 }),
  ];
  const uno = orderSuggestions(lista).map((i) => i.productId);
  const dos = orderSuggestions(orderSuggestions(lista)).map((i) => i.productId);
  assert.deepEqual(uno, dos);
});

test("no muta la lista original", () => {
  const lista = [
    item({ productId: "YA", inTransitQty: 5, suggestedOrderQty: 0 }),
    item({ productId: "FALTA", suggestedOrderQty: 3 }),
  ];
  const copia = lista.map((i) => i.productId);
  orderSuggestions(lista);
  assert.deepEqual(lista.map((i) => i.productId), copia);
});
