import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { evaluateClosureSubmission } from "../src/lib/closures-helpers.mjs";

// ============================================================================
// REPORTE DEL DUENO (2026-09-10): "En el cierre cuando no registro billetes no
// me esta dejando cerrar caja".
//
// El boton CERRAR CAJA estaba con isDisabled cuando el campo de efectivo
// contado quedaba vacio. Se veia apagado, sin explicacion, y la unica salida
// era adivinar que habia que llenar la grilla de billetes.
//
// El bloqueo tenia una razon real: cerrar con el campo vacio guardaria $0 de
// efectivo fisico y un faltante falso por todo lo esperado. Asi que la regla no
// es "dejar pasar", es "preguntar una vez".
// ============================================================================

test("con el campo vacio y efectivo esperado, hay que preguntar (no bloquear)", () => {
  const d = evaluateClosureSubmission({ actualCashInput: "", expectedCash: 500000 });

  assert.equal(d.needsCashDeclaration, true, "la pantalla tiene que preguntar");
  assert.equal(d.canSubmit, false, "no se cierra sin declarar ni confirmar");
  assert.equal(d.reason, "falta_declarar_efectivo");
});

test("tras confirmar que no hay efectivo, se puede cerrar", () => {
  const d = evaluateClosureSubmission({
    actualCashInput: "",
    expectedCash: 500000,
    confirmedNoCash: true,
  });

  assert.equal(d.canSubmit, true, "el dueno ya dijo que no hay efectivo");
  assert.equal(d.needsCashDeclaration, false, "no se pregunta dos veces");
  assert.equal(d.reason, "confirmado_sin_efectivo");
});

test("un cero escrito es una declaracion valida, no un campo vacio", () => {
  // Esta es la distincion que importa: "0" significa "conte y no hay nada",
  // mientras que "" significa "todavia no conte". No son lo mismo.
  const d = evaluateClosureSubmission({ actualCashInput: "0", expectedCash: 500000 });

  assert.equal(d.canSubmit, true);
  assert.equal(d.needsCashDeclaration, false);
  assert.equal(d.reason, "declarado");
});

test("con un monto escrito se cierra sin preguntar nada", () => {
  for (const monto of ["500000", "1", "  350000  ", "0.5"]) {
    const d = evaluateClosureSubmission({ actualCashInput: monto, expectedCash: 500000 });
    assert.equal(d.canSubmit, true, `deberia poder cerrar con ${JSON.stringify(monto)}`);
    assert.equal(d.needsCashDeclaration, false);
  }
});

test("si el sistema no esperaba efectivo, el campo vacio no estorba", () => {
  // El dia que se vendio todo por transferencia no hay nada que contar y no
  // tiene sentido pedir una confirmacion.
  for (const esperado of [0, -100, null, undefined, NaN]) {
    const d = evaluateClosureSubmission({ actualCashInput: "", expectedCash: esperado });
    assert.equal(d.canSubmit, true, `esperado=${esperado} deberia poder cerrar`);
    assert.equal(d.needsCashDeclaration, false);
    assert.equal(d.reason, "sin_efectivo_esperado");
  }
});

test("corregir un cierre historico no exige volver a contar", () => {
  const d = evaluateClosureSubmission({
    actualCashInput: "",
    expectedCash: 900000,
    isEditMode: true,
  });

  assert.equal(d.canSubmit, true, "el admin esta editando cifras que ya existen");
  assert.equal(d.needsCashDeclaration, false);
  assert.equal(d.reason, "edit_mode");
});

test("tolera entradas ausentes sin explotar", () => {
  const d = evaluateClosureSubmission({});
  assert.equal(typeof d.canSubmit, "boolean");
  assert.equal(typeof d.needsCashDeclaration, "boolean");
  // Sin efectivo esperado no hay nada que declarar.
  assert.equal(d.canSubmit, true);
});

test("un campo con solo espacios cuenta como vacio", () => {
  const d = evaluateClosureSubmission({ actualCashInput: "   ", expectedCash: 200000 });
  assert.equal(d.needsCashDeclaration, true, "espacios no son una declaracion");
});

// ---------------------------------------------------------------------------
// Guardian estatico: el boton no puede volver a quedar muerto.
// ---------------------------------------------------------------------------

test("el boton CERRAR CAJA no se desactiva por falta de declaracion", () => {
  const page = readFileSync(
    new URL("../src/app/(app)/dashboard/closure/page.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(
    page,
    /isDisabled=\{status === 'PENDING' \|\| isSubmitting\}/,
    "volver a desactivar el boton por status PENDING deja al dueno sin poder " +
      "cerrar caja y sin ninguna explicacion en pantalla",
  );
  assert.match(
    page,
    /evaluateClosureSubmission\(/,
    "la pantalla debe decidir con evaluateClosureSubmission, no con una regla propia",
  );
  assert.match(
    page,
    /setShowNoCashModal\(true\)/,
    "si falta la declaracion hay que PREGUNTAR con el modal, no bloquear",
  );
});
