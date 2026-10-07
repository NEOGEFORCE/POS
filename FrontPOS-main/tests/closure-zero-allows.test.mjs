import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import { evaluateClosureSubmission } from "../src/lib/closures-helpers.mjs";

// ============================================================================
// CIERRE DE CAJA: contrato "cerrar con todo en 0 debe funcionar"
//
// Pedido del duenio (2026-10-03):
// "Revisar y corregir el cierre de caja para que permita cerrar cuando no haya
// dinero y todos los campos esten en 0. La unica condicion de bloqueo debe ser
// que exista un faltante real."
//
// Las trampas historicas eran:
//   1. `if (!actualCashInput) return 'PENDING'`  → "" y "0" se trataban igual.
//   2. `isDisabled={status === 'PENDING' || ...}` → boton muerto sin explicar.
//
// La correccion vive en src/lib/closures-helpers.mjs (`evaluateClosureSubmission`)
// y en src/app/(app)/dashboard/closure/page.tsx (`isDisabled={isSubmitting}`
// + handleCloseRegister con modales).
//
// Este archivo congela, mediante pruebas, los cinco escenarios pedidos:
//   A) esperado=0 / contado=0            → permite cierre.
//   B) esperado>0 / contado=esperado     → permite cierre (BALANCED).
//   C) contado>esperado                  → permite cierre (SURPLUS).
//   D) contado<esperado                  → helper permite, UI bloquea
//                                            con modal de autorizacion admin
//                                            (unica condicion de bloqueo real).
//   E) campos cero explicitos no se interpretan como ausentes.
// ============================================================================

// ----- A) esperado=0 / contado=0 ------------------------------------------

test("A1) esperado=0 y campo vacio: cierre permitido sin preguntar", () => {
  // El dia que se vendio todo por transferencia no hay nada que contar: ni
  // el campo vacio ni el valor "0" tiene por que estorbar.
  const d = evaluateClosureSubmission({ actualCashInput: "", expectedCash: 0 });
  assert.equal(d.canSubmit, true);
  assert.equal(d.needsCashDeclaration, false);
  assert.equal(d.reason, "sin_efectivo_esperado");
});

test('A2) esperado=0 y declarado="0" explicito: cierre permitido como declaracion', () => {
  // Un "0" tipeado es una declaracion legitima ("conte y no hay nada").
  // Debe tomar la rama de `declarado` y no la de `sin_efectivo_esperado`.
  const d = evaluateClosureSubmission({ actualCashInput: "0", expectedCash: 0 });
  assert.equal(d.canSubmit, true);
  assert.equal(d.needsCashDeclaration, false);
  assert.equal(d.reason, "declarado");
});

// ----- B) esperado>0 / contado=esperado ------------------------------------

test("B) esperado>0 y contado iguala esperado: helper permite (BALANCED)", () => {
  // El helper no evalua la diferencia, solo "hay declaracion?". La BALANCED
  // es responsabilidad del status de la UI. Lo que importa aqui es que la
  // declaracion existe y se puede enviar.
  const d = evaluateClosureSubmission({ actualCashInput: "500000", expectedCash: 500000 });
  assert.equal(d.canSubmit, true);
  assert.equal(d.needsCashDeclaration, false);
  assert.equal(d.reason, "declarado");

  // Replica del calculo que hace la pantalla para fijar el contrato numerico.
  const actualCash = parseFloat("500000") || 0;
  const difference = actualCash - 500000;
  assert.equal(difference, 0, "contado = esperado => BALANCED (diferencia 0)");
});

// ----- C) contado>esperado (sobrante) --------------------------------------

test("C) contado>esperado: helper permite y la diferencia marca SURPLUS", () => {
  const d = evaluateClosureSubmission({ actualCashInput: "600000", expectedCash: 500000 });
  assert.equal(d.canSubmit, true);
  assert.equal(d.needsCashDeclaration, false);
  assert.equal(d.reason, "declarado");

  // El sobrante no bloquea nada: solo requiere nota opcional en la UI.
  const actualCash = parseFloat("600000") || 0;
  const difference = actualCash - 500000;
  assert.equal(difference, 100000, "+$100.000 => SURPLUS");
});

// ----- D) contado<esperado (faltante) --------------------------------------

test("D) contado<esperado: helper permite; el bloqueo real es admin en la UI", () => {
  // IMPORTANTE: el helper deliberadamente devuelve canSubmit=true para
  // faltantes. La condicion de bloqueo real vive en handleCloseRegister de
  // la pantalla (abre showAuthModal) y exige credenciales admin. El
  // guardian estatico mas abajo verifica que esa regla sigue en pie.
  const d = evaluateClosureSubmission({ actualCashInput: "400000", expectedCash: 500000 });
  assert.equal(d.canSubmit, true, "el helper no decide el faltante; eso lo hace la UI");
  assert.equal(d.needsCashDeclaration, false);
  assert.equal(d.reason, "declarado");

  const actualCash = parseFloat("400000") || 0;
  const difference = actualCash - 500000;
  assert.equal(difference, -100000, "-$100.000 => SHORTAGE");
});

// ----- E) ceros explicitos no son "ausentes" --------------------------------

test('E1) actualCashInput="0" NO equivale a vacio en el helper', () => {
  // Esta es la trampa historica: con "!actualCashInput" el "0" se descartaba
  // y acababa en el estado PENDING. El helper distingue "" (sin contar) de
  // "0" (conte y no hay nada).
  const vacio = evaluateClosureSubmission({ actualCashInput: "", expectedCash: 500000 });
  const cero  = evaluateClosureSubmission({ actualCashInput: "0", expectedCash: 500000 });

  assert.notEqual(vacio.reason, cero.reason, "'' y '0' no comparten reason");
  assert.equal(vacio.needsCashDeclaration, true, "'' pide confirmacion");
  assert.equal(cero.needsCashDeclaration, false, "'0' es declaracion");
  assert.equal(cero.canSubmit, true);
});

test("E2) campos numericos cero no se interpretan como ausentes en el helper", () => {
  // El helper usa `numeric()` para expectedCash: 0, false, "0" todos deben
  // dar expectedCash=0 y, con campo vacio, resultar en 'sin_efectivo_esperado'.
  // Lo que no puede pasar es que una lectura truthy/falsy convierta un cero
  // legitimo en un bloqueo.
  for (const esperado of [0, "0", 0.0, false]) {
    const d = evaluateClosureSubmission({ actualCashInput: "", expectedCash: esperado });
    assert.equal(
      d.canSubmit,
      true,
      `expectedCash=${JSON.stringify(esperado)} con "" deberia cerrar (todo-cero)`,
    );
    assert.equal(d.reason, "sin_efectivo_esperado");
  }
});

test("E3) parseFloat del contado tolera cero sin convertirlo en NaN", () => {
  // Replica literal del calculo de la pantalla. parseFloat("") es NaN y
  // el `|| 0` lo rescata; parseFloat("0") es 0 y debe pasar como 0.
  const vacio = parseFloat("") || 0;
  const cero  = parseFloat("0") || 0;
  assert.equal(vacio, 0);
  assert.equal(cero,  0);
  assert.ok(!Number.isNaN(cero), "contado=0 no es NaN");
});

// ---------------------------------------------------------------------------
// Guardianes estaticos: lo que no se puede volver a romper
// ---------------------------------------------------------------------------

test("GUARDIAN) la pantalla usa parseFloat(actualCashInput) || 0", () => {
  const page = readFileSync(
    new URL("../src/app/(app)/dashboard/closure/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    page,
    /const\s+actualCash\s*=\s*parseFloat\(actualCashInput\)\s*\|\|\s*0/,
    "la lectura del contado debe tolerar '' y '0'; cambiar esta linea rompe el fix",
  );
});

test("GUARDIAN) el unico bloqueo de negocio es el faltante con admin modal", () => {
  const page = readFileSync(
    new URL("../src/app/(app)/dashboard/closure/page.tsx", import.meta.url),
    "utf8",
  );
  // Regla de negocio: SHORTAGE + no autorizado + no admin => pide credenciales.
  assert.match(
    page,
    /status\s*===\s*['"]SHORTAGE['"]\s*&&\s*!isAuthorized\s*&&\s*!isAdmin/,
    "la unica condicion de bloqueo (faltante sin autorizacion) debe sobrevivir",
  );
  assert.match(
    page,
    /setShowAuthModal\(true\)/,
    "el bloqueo por faltante tiene que abrir el modal de autorizacion admin",
  );
});

test("GUARDIAN) el boton CERRAR CAJA solo se desactiva por isSubmitting", () => {
  const raw = readFileSync(
    new URL("../src/app/(app)/dashboard/closure/page.tsx", import.meta.url),
    "utf8",
  );
  // El propio page.tsx documenta el bug viejo en un comentario largo citando
  // el patron toxico. Hay que inspeccionar el codigo real, no los comentarios.
  const page = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\/.*$/gm, "");

  // Patrones toxicos conocidos que dejaban el boton muerto sin explicacion.
  const malos = [
    /isDisabled=\{status === ['"]PENDING['"] \|\| isSubmitting\}/,
    /isDisabled=\{status === ['"]PENDING['"]\}/,
    /isDisabled=\{!actualCashInput[^}]*\}/,
    /isDisabled=\{actualCashInput === ['"]{2}[^}]*\}/,
  ];
  for (const re of malos) {
    assert.doesNotMatch(
      page,
      re,
      `el boton CERRAR CAJA no puede volver a desactivarse por '${re}' (regresion)`,
    );
  }

  // Y la decision real debe delegar en el helper + modales (no en isDisabled).
  assert.match(raw, /evaluateClosureSubmission\(/, "la decision usa el helper puro");
  assert.match(raw, /setShowNoCashModal\(true\)/, "campo vacio => pregunta, no bloqueo mudo");
});

test("GUARDIAN) /cash-register redirige al cierre canonico sin revivir el bug", () => {
  // La implementación duplicada golpeaba un endpoint inexistente y trataba
  // `0` como ausencia. Conservamos la URL para marcadores antiguos, pero su
  // única responsabilidad es enviar al usuario al flujo canónico corregido.
  const legacyPage = new URL("../src/app/(app)/cash-register/page.tsx", import.meta.url);
  assert.equal(existsSync(legacyPage), true, "la URL heredada debe seguir disponible");

  const src = readFileSync(legacyPage, "utf8");
  assert.match(
    src,
    /redirect\(\s*['"]\/dashboard\/closure['"]\s*\)/,
    "/cash-register debe redirigir a /dashboard/closure",
  );
  assert.doesNotMatch(
    src,
    /actualCashInput|status\s*===\s*['"]PENDING['"]|\/cash-register\/close/,
    "la ruta heredada no debe volver a implementar lógica propia de cierre",
  );
});

test("GUARDIAN) revalidate.ts no revive claves SWR huerfanas", () => {
  const revalidate = readFileSync(
    new URL("../src/lib/revalidate.ts", import.meta.url),
    "utf8",
  );
  // Estas claves nunca tuvieron un fetcher SWR en el frontend y apuntaban
  // a endpoints inexistentes en el backend.
  assert.doesNotMatch(
    revalidate,
    /\/cash-register\/history/,
    "clave huerfana: /cash-register/history (eliminada el 2026-10-03)",
  );
  assert.doesNotMatch(
    revalidate,
    /\/cash-register\/status/,
    "clave huerfana: /cash-register/status (eliminada el 2026-10-03)",
  );
});
