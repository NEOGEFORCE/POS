// ============================================================================
// tests/payment-keypad-shared-contract.test.mjs
// ============================================================================
//
// Guardián ESTÁTICO del teclado numérico unificado del cobro.
//
// Historia: hasta 2026-10 el UniversalPaymentModal tenía TRES numpads
// escritos a mano, con tres tamaños distintos (dos móviles `h-12 text-lg`
// y uno desktop `h-full text-2xl`). Visualmente el cajero percibía dos
// teclados distintos al cambiar de método (Efectivo ↔ Nequi ↔ Daviplata)
// y uno "duplicado" al alternar el flip billetes↔numpad.
//
// Este sprint consolidó la grilla en un sub-componente privado
// `PaymentKeypad` que se usa en los DOS viewports (móvil y escritorio).
// Este guardián ancla el refactor:
//
//   R1. `PaymentKeypad` existe como función privada en el archivo del modal.
//   R2. Se renderiza al menos DOS veces (uno `md:hidden`, uno `hidden md:flex`).
//   R3. El array canónico `[1-9, 0, '+', 'CE']` aparece una SOLA vez: la
//       fuente única está en el cuerpo del componente, no copiada en cada
//       render.
//   R4. El componente expone callbacks puros (`onDigit`, `onAdd`, `onClear`)
//       en vez de mutar estado del modal directamente.
//   R5. El tamaño `compact` y `tall` quedan documentados en el componente
//       (`h-12 text-lg` para móvil, `h-14 text-xl` para pad fijo desktop).
//   R6. Las teclas no roban el foco al input (`tabIndex={-1}` +
//       `onMouseDown preventDefault`) — contrato táctil del POS.
//
// Son tests por LECTURA DE FUENTE y no requieren Jest/React-testing-library.
// ============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MODAL_PATH = join(here, "..", "src", "components", "shared", "UniversalPaymentModal.tsx");

async function readSrc(path) {
  return readFile(path, "utf8");
}

// ---------------------------------------------------------------------------
// R1 — PaymentKeypad definido en el archivo del modal
// ---------------------------------------------------------------------------

test("PaymentKeypad: existe como función privada dentro del modal", async () => {
  const src = await readSrc(MODAL_PATH);
  assert.match(
    src,
    /function\s+PaymentKeypad\s*\(/,
    "Debe existir `function PaymentKeypad(...)` como sub-componente del modal.",
  );
  // También exige la interfaz tipada: evita firmas sueltas sin contrato
  // explícito.
  assert.match(
    src,
    /interface\s+PaymentKeypadProps\b/,
    "Debe existir `interface PaymentKeypadProps` con la firma del componente.",
  );
});

// ---------------------------------------------------------------------------
// R2 — Se renderiza al menos DOS veces (móvil + desktop)
// ---------------------------------------------------------------------------

test("PaymentKeypad: se renderiza al menos 2 veces (móvil + desktop)", async () => {
  const src = await readSrc(MODAL_PATH);
  const uses = src.match(/<PaymentKeypad\b/g) || [];
  assert.ok(
    uses.length >= 2,
    `Se esperaban ≥2 usos de <PaymentKeypad>, se encontraron ${uses.length}. ` +
      `El teclado debe aparecer en móvil (md:hidden) y escritorio (hidden md:flex).`,
  );
});

test("PaymentKeypad: una variante usa `size=\"tall\"` para el pad desktop", async () => {
  const src = await readSrc(MODAL_PATH);
  assert.match(
    src,
    /<PaymentKeypad[\s\S]{0,400}?size=["']tall["']/,
    "Debe existir un <PaymentKeypad size=\"tall\"> para el pad fijo de escritorio.",
  );
});

test("PaymentKeypad: una variante usa `size=\"compact\"` para móvil", async () => {
  const src = await readSrc(MODAL_PATH);
  assert.match(
    src,
    /<PaymentKeypad[\s\S]{0,400}?size=["']compact["']/,
    "Debe existir un <PaymentKeypad size=\"compact\"> para los tabs móviles.",
  );
});

// ---------------------------------------------------------------------------
// R3 — Fuente única del array canónico
// ---------------------------------------------------------------------------

test("PaymentKeypad: el array canónico [1-9, 0, '+', 'CE'] aparece una sola vez (fuente única)", async () => {
  const src = await readSrc(MODAL_PATH);
  const literals = src.match(/\[\s*1\s*,\s*2\s*,\s*3[\s\S]{0,120}['"]\+['"][\s\S]{0,30}['"]CE['"]/g) || [];
  assert.equal(
    literals.length,
    1,
    `Se esperaba EXACTAMENTE 1 literal del array canónico del numpad; se encontraron ${literals.length}. ` +
      `El refactor exige fuente única dentro de PaymentKeypad.`,
  );
});

// ---------------------------------------------------------------------------
// R4 — Callbacks puros: no mutar estado desde el componente
// ---------------------------------------------------------------------------

test("PaymentKeypad: expone callbacks puros `onDigit`, `onAdd`, `onClear`", async () => {
  const src = await readSrc(MODAL_PATH);
  const bodyMatch = src.match(/interface\s+PaymentKeypadProps\s*\{([\s\S]*?)\}/);
  assert.ok(bodyMatch, "No se encontró interface PaymentKeypadProps");
  const body = bodyMatch[1];
  for (const prop of ["onDigit", "onAdd", "onClear"]) {
    assert.match(
      body,
      new RegExp(`\\b${prop}\\s*:`),
      `PaymentKeypadProps debe declarar la prop ${prop} (callback puro).`,
    );
  }
});

test("PaymentKeypad: no toca `setDialogAmount` directamente dentro del componente", async () => {
  const src = await readSrc(MODAL_PATH);
  const compMatch = src.match(/function\s+PaymentKeypad\s*\([\s\S]*?\n\}\n/);
  assert.ok(compMatch, "No se pudo acotar el cuerpo del componente PaymentKeypad");
  const body = compMatch[0];
  assert.ok(
    !/setDialogAmount\s*\(/.test(body),
    "PaymentKeypad NO debe llamar setDialogAmount: el estado vive en el padre y se pasa por callbacks.",
  );
  assert.ok(
    !/setCashTendered\s*\(/.test(body),
    "PaymentKeypad NO debe tocar setCashTendered: callbacks puros.",
  );
});

// ---------------------------------------------------------------------------
// R5 — Jerarquía táctil documentada (h-12 móvil, h-14 escritorio)
// ---------------------------------------------------------------------------

test("NumpadKey: expone size `compact` → h-12 y `tall` → h-14 (tamaños UNIFICADOS)", async () => {
  const src = await readSrc(MODAL_PATH);
  // El componente NumpadKey resuelve el tamaño en función del prop size.
  // Verificamos que las dos clases canónicas estén presentes como ramas
  // explícitas en el código (sin regex ambigua). Aceptamos tanto `size`
  // directo como `resolvedSize` (nombre interno tras el refactor).
  assert.match(
    src,
    /(?:resolvedSize|size)\s*===\s*["']tall["'][\s\S]{0,200}["']h-14 text-xl["']/,
    "La variante tall del NumpadKey debe usar `h-14 text-xl`.",
  );
  assert.match(
    src,
    /["']h-12 text-lg["']/,
    "La variante compact debe usar `h-12 text-lg` (el default táctil móvil).",
  );
});

// ---------------------------------------------------------------------------
// R6 — Contrato táctil: no robar el foco al input al presionar una tecla
// ---------------------------------------------------------------------------

test("NumpadKey: no roba foco (tabIndex=-1 + onMouseDown preventDefault)", async () => {
  const src = await readSrc(MODAL_PATH);
  const compMatch = src.match(/function\s+NumpadKey\s*\([\s\S]*?\n\}\n/);
  assert.ok(compMatch, "No se pudo acotar el cuerpo del componente NumpadKey");
  const body = compMatch[0];
  assert.match(
    body,
    /tabIndex=\{\s*-1\s*\}/,
    "NumpadKey debe traer `tabIndex={-1}` para no capturar el foco del teclado.",
  );
  assert.match(
    body,
    /onMouseDown=\{\s*\(e\)\s*=>\s*e\.preventDefault\(\)\s*\}/,
    "NumpadKey debe traer `onMouseDown={(e) => e.preventDefault()}` — contrato táctil del POS.",
  );
});

// ---------------------------------------------------------------------------
// R7 — Accesibilidad del grupo (aria-label dinámico)
// ---------------------------------------------------------------------------

test("PaymentKeypad: el contenedor expone role=group + aria-label", async () => {
  const src = await readSrc(MODAL_PATH);
  const compMatch = src.match(/function\s+PaymentKeypad\s*\([\s\S]*?\n\}\n/);
  assert.ok(compMatch, "No se pudo acotar el cuerpo del componente PaymentKeypad");
  const body = compMatch[0];
  assert.match(
    body,
    /role=\{?["']group["']/,
    "El wrapper del teclado debe traer role=\"group\" para que lectores de pantalla lo agrupen.",
  );
  assert.match(
    body,
    /aria-label=/,
    "El wrapper debe traer un aria-label (dinámico vía prop) para describir el teclado.",
  );
});
