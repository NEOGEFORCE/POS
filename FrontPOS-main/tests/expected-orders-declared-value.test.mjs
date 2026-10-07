import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const inventoryPage = join(here, "..", "src", "app", "(app)", "inventory", "page.tsx");
const ordersPage = join(here, "..", "src", "app", "(app)", "inventory", "orders", "page.tsx");

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

// ============================================================================
// NO SE PIDE REFERENCIA / FACTURA AL CONFIRMAR UN PEDIDO
// ============================================================================
//
// El dueño pidió quitarlo: "en pedidos quita el campo de referencia o factura
// (no hay factura todavía)". El pedido se confirma cuando el preventista pasa;
// la factura real llega después, al recibir la mercancía.
//
// El backend conserva la columna por histórico (los jobs y el cron todavía la
// leen como override del valor cuando el pedido se registró sin ítems), así
// que una migración 017 posterior la limpiará cuando sea seguro. En el
// frontend quedó erradicado.

test("el formulario de pedido ya no pide referencia / factura", async () => {
  const source = await readFile(ordersPage, "utf8");

  // El input visible: su label era "Referencia / factura" con placeholder "Opcional".
  assert.ok(
    !/Referencia\s*\/\s*factura/.test(source),
    "quedó texto 'Referencia / factura' en el formulario: debe eliminarse"
  );
  assert.ok(
    !/value=\{form\.invoiceRef\}/.test(source),
    "sigue el <input value={form.invoiceRef}> en el formulario; hay que borrarlo"
  );
  // Ni el estado ni los helpers deben tocar invoiceRef en el envío.
  assert.ok(
    !/updateForm\(.*invoiceRef/.test(source),
    "updateForm todavía escribe invoiceRef"
  );
});

test("el payload que viaja al backend no incluye invoice_ref", async () => {
  const source = await readFile(ordersPage, "utf8");

  // El campo clave del envío: antes era `invoice_ref: form.invoiceRef`.
  assert.ok(
    !/invoice_ref:\s*form\.invoiceRef/.test(source),
    "el payload volvió a enviar invoice_ref desde el formulario"
  );
  // El contrato del payload (ConfirmOrderPayload) no debería declarar invoice_ref.
  const payloadInterface = source.slice(
    source.indexOf("interface ConfirmOrderPayload"),
    source.indexOf("interface TransitWarningProduct"),
  );
  assert.ok(
    !/invoice_ref/.test(payloadInterface),
    "ConfirmOrderPayload sigue declarando invoice_ref: elimínalo del tipo"
  );
});

test("GroupForm ya no declara invoiceRef", async () => {
  const source = await readFile(ordersPage, "utf8");
  const formInterface = source.slice(
    source.indexOf("interface GroupForm"),
    source.indexOf("interface SuggestionGroup"),
  );
  assert.ok(
    !/invoiceRef/.test(formInterface),
    "GroupForm todavía tiene invoiceRef: hay que removerlo del estado"
  );
});
