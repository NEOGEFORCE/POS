import assert from "node:assert/strict";
import test from "node:test";

import { STOCK_HEALTH } from "../src/lib/stock-health.mjs";
import {
  compareSuggestions,
  orderSuggestions,
  resolveBand,
  SUGGESTION_BAND_WEIGHT,
} from "../src/lib/restock-ordering.mjs";

// ----------------------------------------------------------------------------
// resolveBand
// ----------------------------------------------------------------------------

test("resolveBand prefiere el stockBand del backend cuando llega", () => {
  assert.equal(resolveBand({ stockBand: "RED", liveStock: 100, minStock: 10 }), STOCK_HEALTH.CRITICAL);
  assert.equal(resolveBand({ stockBand: "yellow", liveStock: 0, minStock: 10 }), STOCK_HEALTH.WARNING);
  assert.equal(resolveBand({ stockBand: "GREEN" }), STOCK_HEALTH.OPTIMAL);
  assert.equal(resolveBand({ stockBand: "unset" }), STOCK_HEALTH.UNSET);
});

test("resolveBand cae al calculo local cuando el backend no manda stockBand", () => {
  assert.equal(resolveBand({ liveStock: 0, minStock: 10 }), STOCK_HEALTH.CRITICAL);
  assert.equal(resolveBand({ liveStock: 5, minStock: 20 }), STOCK_HEALTH.WARNING);
  assert.equal(resolveBand({ liveStock: 20, minStock: 20 }), STOCK_HEALTH.OPTIMAL);
  assert.equal(resolveBand({ liveStock: 5, minStock: 0 }), STOCK_HEALTH.UNSET);
});

test("resolveBand con stockBand desconocido cae al calculo local", () => {
  assert.equal(resolveBand({ stockBand: "raro", currentStock: 0, minStock: 10 }), STOCK_HEALTH.CRITICAL);
});

// ----------------------------------------------------------------------------
// orden por banda: RED > YELLOW > GREEN > UNSET
// ----------------------------------------------------------------------------

test("las bandas se ordenan critico -> advertencia -> optimo -> sin_minimo", () => {
  const unset = { productId: "u", productName: "sin minimo", stockBand: "UNSET", suggestedOrderQty: 0 };
  const green = { productId: "g", productName: "verde", stockBand: "GREEN", suggestedOrderQty: 0 };
  const yellow = { productId: "y", productName: "amarillo", stockBand: "YELLOW", suggestedOrderQty: 5 };
  const red = { productId: "r", productName: "rojo", stockBand: "RED", suggestedOrderQty: 20 };
  const ordered = orderSuggestions([green, unset, yellow, red]);
  assert.deepEqual(
    ordered.map((item) => item.productId),
    ["r", "y", "g", "u"],
  );
});

test("los pesos de la banda documentan la jerarquia critico=0, advertencia=1, optimo=2, sin_minimo=3", () => {
  assert.equal(SUGGESTION_BAND_WEIGHT[STOCK_HEALTH.CRITICAL], 0);
  assert.equal(SUGGESTION_BAND_WEIGHT[STOCK_HEALTH.WARNING], 1);
  assert.equal(SUGGESTION_BAND_WEIGHT[STOCK_HEALTH.OPTIMAL], 2);
  assert.equal(SUGGESTION_BAND_WEIGHT[STOCK_HEALTH.UNSET], 3);
});

// ----------------------------------------------------------------------------
// desempates dentro de la misma banda
// ----------------------------------------------------------------------------

test("dentro de una banda, sugerencia > 0 va antes que sugerencia = 0", () => {
  const withSuggestion = {
    productId: "a",
    productName: "con sugerencia",
    stockBand: "RED",
    suggestedOrderQty: 12,
    liveStock: 0,
    minStock: 20,
    avgDailySales: 1,
  };
  const withoutSuggestion = {
    productId: "b",
    productName: "sin sugerencia",
    stockBand: "RED",
    suggestedOrderQty: 0,
    liveStock: 0,
    minStock: 20,
    avgDailySales: 1,
  };
  const ordered = orderSuggestions([withoutSuggestion, withSuggestion]);
  assert.deepEqual(ordered.map((item) => item.productId), ["a", "b"]);
});

test("mismo estado y misma sugerencia: menor cobertura va primero", () => {
  const cover3 = {
    productId: "c3",
    productName: "cobertura 3",
    stockBand: "YELLOW",
    suggestedOrderQty: 5,
    liveStock: 6,
    minStock: 10,
    avgDailySales: 2, // cobertura = 3 dias
  };
  const cover10 = {
    productId: "c10",
    productName: "cobertura 10",
    stockBand: "YELLOW",
    suggestedOrderQty: 5,
    liveStock: 20,
    minStock: 30,
    avgDailySales: 2, // cobertura = 10 dias
  };
  const ordered = orderSuggestions([cover10, cover3]);
  assert.deepEqual(ordered.map((item) => item.productId), ["c3", "c10"]);
});

test("misma cobertura: mayor avgDailySales va primero (se prioriza lo que mas vende)", () => {
  const salesHigh = {
    productId: "vende-mas",
    productName: "vende mas",
    stockBand: "YELLOW",
    suggestedOrderQty: 5,
    liveStock: 10,
    minStock: 20,
    avgDailySales: 5, // cobertura = 2 dias
  };
  const salesLow = {
    productId: "vende-poco",
    productName: "vende poco",
    stockBand: "YELLOW",
    suggestedOrderQty: 5,
    liveStock: 4,
    minStock: 10,
    avgDailySales: 2, // cobertura = 2 dias
  };
  const ordered = orderSuggestions([salesLow, salesHigh]);
  assert.deepEqual(ordered.map((item) => item.productId), ["vende-mas", "vende-poco"]);
});

test("todos los desempates iguales: alfabetico por nombre", () => {
  const anaranjado = {
    productId: "1",
    productName: "ANARANJADO",
    stockBand: "GREEN",
    suggestedOrderQty: 0,
    liveStock: 20,
    minStock: 10,
    avgDailySales: 1,
  };
  const berenjena = {
    productId: "2",
    productName: "BERENJENA",
    stockBand: "GREEN",
    suggestedOrderQty: 0,
    liveStock: 20,
    minStock: 10,
    avgDailySales: 1,
  };
  const ordered = orderSuggestions([berenjena, anaranjado]);
  assert.deepEqual(ordered.map((item) => item.productId), ["1", "2"]);
});

test("productos sin rotacion (avgDailySales 0) caen al final de su banda por cobertura infinita", () => {
  const conVenta = {
    productId: "con",
    productName: "con venta",
    stockBand: "YELLOW",
    suggestedOrderQty: 3,
    liveStock: 10,
    minStock: 20,
    avgDailySales: 1,
  };
  const sinVenta = {
    productId: "sin",
    productName: "sin venta",
    stockBand: "YELLOW",
    suggestedOrderQty: 3,
    liveStock: 10,
    minStock: 20,
    avgDailySales: 0,
  };
  const ordered = orderSuggestions([sinVenta, conVenta]);
  assert.deepEqual(ordered.map((item) => item.productId), ["con", "sin"]);
});

// ----------------------------------------------------------------------------
// orderSuggestions es puro
// ----------------------------------------------------------------------------

test("orderSuggestions no muta la lista original", () => {
  const items = [
    { productId: "g", productName: "z", stockBand: "GREEN", suggestedOrderQty: 0 },
    { productId: "r", productName: "a", stockBand: "RED", suggestedOrderQty: 3 },
  ];
  const snapshot = items.map((item) => item.productId).join(",");
  orderSuggestions(items);
  assert.equal(items.map((item) => item.productId).join(","), snapshot);
});

test("orderSuggestions tolera entradas vacias o invalidas", () => {
  assert.deepEqual(orderSuggestions([]), []);
  assert.deepEqual(orderSuggestions(undefined), []);
  assert.deepEqual(orderSuggestions(null), []);
});

// ----------------------------------------------------------------------------
// compareSuggestions puede reusarse fuera del array.sort
// ----------------------------------------------------------------------------

test("compareSuggestions es simetrica: si A ordena antes que B, B ordena despues que A", () => {
  const red = { productId: "r", productName: "rojo", stockBand: "RED", suggestedOrderQty: 3 };
  const green = { productId: "g", productName: "verde", stockBand: "GREEN", suggestedOrderQty: 0 };
  assert.ok(compareSuggestions(red, green) < 0);
  assert.ok(compareSuggestions(green, red) > 0);
  assert.equal(compareSuggestions(red, red), 0);
});
