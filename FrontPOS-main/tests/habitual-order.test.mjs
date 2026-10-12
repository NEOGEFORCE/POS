import assert from "node:assert/strict";
import test from "node:test";

import {
  describeHabitualOrder,
  getHabitualOrderMetadata,
  hasHabitualOrderMetadata,
} from "../src/lib/habitual-order.mjs";

// ============================================================================
// CONTRATO FRONTEND ↔ BACKEND: APRENDIZAJE DE CANTIDAD HABITUAL
// ============================================================================
//
// El backend expone, en la respuesta de /restock/suggestions-v2, dos campos
// opcionales:
//
//   habitualOrderQty         float64  cantidad habitual aprendida (p. ej. 12)
//   habitualReorderThreshold float64  umbral al 20 % calculado por el backend
//                                     (p. ej. 3 ≈ 25 % de 12 por redondeo)
//
// El frontend consume estos valores y los muestra como información
// compacta y SEPARADA de la sugerencia accionable (`suggestedOrderQty`),
// que sigue siendo la autoridad.
//
// Este archivo ejerce el contrato en dos direcciones:
//   1. Metadata PRESENTE: habitualOrderQty=12, habitualReorderThreshold=3
//      produce la frase canónica "Habitual: 12 · reorden ≈ 3".
//   2. Metadata AUSENTE: ningún campo o campos inválidos → null (la UI no
//      pinta la etiqueta).

// ----------------------------------------------------------------------------
// Metadata PRESENTE
// ----------------------------------------------------------------------------

test("extrae cantidad habitual 12 y punto de reposicion 3 cuando el backend los envia", () => {
  const item = {
    productId: "A1",
    habitualOrderQty: 12,
    habitualReorderThreshold: 3,
  };
  const metadata = getHabitualOrderMetadata(item);
  assert.deepEqual(metadata, { habitualOrderQty: 12, habitualReorderThreshold: 3 });
  assert.equal(hasHabitualOrderMetadata(item), true);
});

test("la frase canonica combina ambos valores sin confundirse con suggestedOrderQty", () => {
  const item = { habitualOrderQty: 12, habitualReorderThreshold: 3 };
  const texto = describeHabitualOrder(item);
  assert.equal(texto, "Habitual: 12 · reorden ≈ 3");
  // No debe mencionar "sugerencia" ni "pedido": es informativo, no accionable.
  assert.ok(!/sugerencia|pedido/i.test(String(texto)));
});

test("acepta strings numericos y redondea a enteros (vienen como JSON number pero toleramos coercion)", () => {
  const metadata = getHabitualOrderMetadata({
    habitualOrderQty: "12.4",
    habitualReorderThreshold: "2.6",
  });
  assert.deepEqual(metadata, { habitualOrderQty: 12, habitualReorderThreshold: 3 });
});

test("si solo llega la cantidad habitual, muestra la mitad disponible y la otra queda en null", () => {
  const metadata = getHabitualOrderMetadata({ habitualOrderQty: 12 });
  assert.deepEqual(metadata, { habitualOrderQty: 12, habitualReorderThreshold: null });
  assert.equal(describeHabitualOrder({ habitualOrderQty: 12 }), "Habitual: 12");
});

test("si solo llega el umbral, se muestra con mayuscula inicial (sin cantidad habitual al lado)", () => {
  const metadata = getHabitualOrderMetadata({ habitualReorderThreshold: 3 });
  assert.deepEqual(metadata, { habitualOrderQty: null, habitualReorderThreshold: 3 });
  assert.equal(describeHabitualOrder({ habitualReorderThreshold: 3 }), "Reorden ≈ 3");
});

// ----------------------------------------------------------------------------
// Metadata AUSENTE o invalida: degrada limpio
// ----------------------------------------------------------------------------

test("sin metadata (backend viejo) el helper devuelve null y la UI no pinta nada", () => {
  assert.equal(getHabitualOrderMetadata({}), null);
  assert.equal(getHabitualOrderMetadata({ productId: "X" }), null);
  assert.equal(describeHabitualOrder({}), null);
  assert.equal(hasHabitualOrderMetadata({}), false);
});

test("entradas invalidas (null, undefined, no objetos) devuelven null sin romper", () => {
  assert.equal(getHabitualOrderMetadata(null), null);
  assert.equal(getHabitualOrderMetadata(undefined), null);
  assert.equal(getHabitualOrderMetadata("foo"), null);
  assert.equal(getHabitualOrderMetadata(42), null);
  assert.equal(describeHabitualOrder(null), null);
});

test("valores no finitos o negativos se descartan y degradan a null", () => {
  assert.equal(
    getHabitualOrderMetadata({ habitualOrderQty: NaN, habitualReorderThreshold: Infinity }),
    null,
  );
  assert.equal(
    getHabitualOrderMetadata({ habitualOrderQty: -5, habitualReorderThreshold: -1 }),
    null,
  );
  // Mezcla: solo uno valido queda expuesto.
  assert.deepEqual(
    getHabitualOrderMetadata({ habitualOrderQty: 10, habitualReorderThreshold: -1 }),
    { habitualOrderQty: 10, habitualReorderThreshold: null },
  );
});

test("cantidad habitual 0 explicita se preserva (producto marcado como 'no habitual')", () => {
  // Un backend que explicitamente marca habitualOrderQty=0 esta diciendo
  // "no tengo cantidad habitual aprendida"; igual lo preservamos para que
  // la UI pueda, si quiere, diferenciar null (sin dato) de 0 (sin señal).
  const metadata = getHabitualOrderMetadata({ habitualOrderQty: 0, habitualReorderThreshold: 0 });
  assert.deepEqual(metadata, { habitualOrderQty: 0, habitualReorderThreshold: 0 });
  assert.equal(describeHabitualOrder({ habitualOrderQty: 0, habitualReorderThreshold: 0 }), "Habitual: 0 · reorden ≈ 0");
});

// ----------------------------------------------------------------------------
// GUARDIAN: la frase NO debe presentarse como accionable
// ----------------------------------------------------------------------------
//
// Si alguien edita describeHabitualOrder para que diga "pedir X" o "sugerencia",
// se rompe la separacion que el duenio exigio: suggestedOrderQty es la unica
// cantidad accionable; esta frase es solo pedagogica.

test("la frase informativa jamas usa palabras accionables ('pedir', 'sugerencia', 'ia')", () => {
  const texto = describeHabitualOrder({ habitualOrderQty: 12, habitualReorderThreshold: 3 });
  assert.ok(texto !== null);
  assert.ok(!/pedir|sugerencia|ia\b/i.test(texto));
});
