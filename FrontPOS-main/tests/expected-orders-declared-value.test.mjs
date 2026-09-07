import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const inventoryPage = join(here, "..", "src", "app", "(app)", "inventory", "page.tsx");

// ============================================================================
// EL VALOR DEL PEDIDO ES EL QUE ESCRIBIO EL DUENO
// ============================================================================
//
// El dueno lo pidio TRES VECES: "el valor de pedido es el que me tiene que
// decir en entregas programadas... si no sale el que yo pongo no va a salir el
// valor de la factura que va a llegar".
//
// MOTIVO DE NEGOCIO: el desglose por productos conocidos suma MENOS que la
// factura real cuando el proveedor manda referencias nuevas que todavia no
// existen en el catalogo. Caso real: proveedor 83, estimado por productos
// $30.583, factura real $67.800. El valor escrito a mano es la unica cifra que
// anticipa la plata que hay que tener.
//
// BUG QUE HABIA ADEMAS: la pantalla hacia parseFloat(invoiceRef) y mostraba el
// resultado como pesos. invoiceRef es el NUMERO de la factura, no un monto, asi
// que un numero de factura se sumaba al VALOR TOTAL como si fuera plata.

test("no se parsea la referencia de factura como si fuera un monto", async () => {
  const source = await readFile(inventoryPage, "utf8");

  assert.ok(
    !/parseFloat\(\s*\(?\s*(?:o|order)\.invoiceRef/.test(source),
    "invoiceRef es el NUMERO de la factura, no un monto: no se puede parsear como plata"
  );
  assert.ok(
    !/invoiceRef \|\| ''\)\.replace\(\/\[\^0-9/.test(source),
    "volvio el patron que limpiaba invoiceRef para usarlo como cifra"
  );
});

test("el valor mostrado sale de un helper unico y prefiere el declarado", async () => {
  const source = await readFile(inventoryPage, "utf8");

  assert.match(
    source,
    /function orderDisplayValue\(/,
    "debe existir un helper unico que resuelva el valor a mostrar"
  );

  const helper = source.slice(source.indexOf("function orderDisplayValue("), source.indexOf("interface OrderDetailItem"));
  assert.match(helper, /declaredValue/, "el helper debe preferir el valor declarado a mano");
  assert.ok(
    helper.indexOf("declaredValue") < helper.indexOf("estimatedCost"),
    "el valor declarado debe evaluarse ANTES del estimado"
  );
  assert.ok(!/invoiceRef/.test(helper), "el helper no puede mirar invoiceRef");
});

test("tanto la fila como el total usan el mismo helper", async () => {
  const source = await readFile(inventoryPage, "utf8");
  const usos = source.match(/orderDisplayValue\(/g) ?? [];
  // Una vez la declaracion, una la fila, una el total.
  assert.ok(
    usos.length >= 3,
    `orderDisplayValue debe usarse en la fila Y en el total; apariciones: ${usos.length}`
  );
  assert.match(
    source,
    /reduce\(\(acc, o\) => acc \+ orderDisplayValue\(o\), 0\)/,
    "el VALOR TOTAL debe sumar con el mismo helper que cada fila"
  );
});

test("el tipo documenta que invoiceRef no es plata", async () => {
  const source = await readFile(inventoryPage, "utf8");
  const bloque = source.slice(source.indexOf("interface ExpectedOrder"), source.indexOf("interface Product"));
  assert.match(bloque, /declaredValue\?: number/, "el tipo debe exponer el valor declarado");
  assert.match(
    bloque,
    /REFERENCIA de la factura|no un monto|NO un monto/,
    "el tipo debe advertir que invoiceRef no es un monto"
  );
});
