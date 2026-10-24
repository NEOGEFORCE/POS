// ============================================================================
// tests/payment-modal-stable-envelope.test.mjs
// ============================================================================
//
// Guardián ESTÁTICO del tamaño ESTABLE del `UniversalPaymentModal` en
// escritorio. Antes del sprint 2026-10 el `classNames.base` del Modal
// HeroUI era `md:w-auto md:h-auto md:max-h-[78vh]`: al cambiar entre
// Efectivo (grilla de billetes 4×n), Nequi (sólo input), Daviplata y Fiado
// el modal variaba ancho y alto de golpe, sacudiendo la pantalla del
// cajero y escondiendo el botón PROCESAR.
//
// El fix fija ancho y alto en escritorio:
//   - `size="5xl"`: evita la variante `full` de HeroUI, que inyecta
//     simultáneamente `h-[100dvh]` y `min-h-[100dvh]`.
//   - `md:w-[980px]` (dentro de `md:max-w-[1050px]`).
//   - `md:h-[500px]` (dentro de `md:max-h-[78vh]`).
// Con la envolvente fija los sub-paneles del centro (billetes, numpad,
// tarjeta de cupo) hacen scroll interno sin alterar el tamaño del modal.
//
// Reglas duras:
//
//   R0. El Modal usa `size="5xl"` y NO `size="full"`; volver a full
//       reintroduce min-height:100dvh y anula cualquier altura desktop.
//   R1. `classNames.base` incluye `md:w-[980px]` y `md:h-[500px]`.
//   R2. Conservar `md:max-w-[1050px]` como tope de ancho y `md:max-h-[78vh]`
//       como tope de alto (defensa para viewports pequeños de escritorio).
//   R3. Conservar los anchos fijos del móvil (`w-screen`, `max-w-[100vw]`,
//       `h-[100dvh]`) por contrato previo (`payment-modal-mobile.test.mjs`).
//   R4. Debe existir al menos un contenedor interno con `overflow-y-auto`
//       y `min-h-0` para que el centro scrollee si el contenido excede
//       el alto fijo (contrato de "scroll interno" exigido por el sprint
//       y por FRONTEND_LAYOUT_RULES.md).
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
// R1 — Ancho y alto fijos en escritorio
// ---------------------------------------------------------------------------

test("classNames.base fija el ancho desktop (md:w-[980px])", async () => {
  const src = await readSrc(MODAL_PATH);
  assert.match(
    src,
    /base:\s*"[^"]*\bmd:w-\[980px\]/,
    "classNames.base perdió `md:w-[980px]`; el modal volvera a cambiar de ancho entre métodos.",
  );
});

test("Modal evita size=full y fija el alto desktop en 500px", async () => {
  const src = await readSrc(MODAL_PATH);
  assert.match(
    src,
    /<Modal[\s\S]*?size="5xl"[\s\S]*?classNames=/,
    "UniversalPaymentModal debe usar `size=\"5xl\"` para evitar el min-height:100dvh de HeroUI.",
  );
  const paymentModalStart = src.indexOf("<Modal");
  const paymentModalClasses = src.indexOf("classNames=", paymentModalStart);
  const openingBlock = src.slice(paymentModalStart, paymentModalClasses);
  assert.ok(
    !openingBlock.includes('size="full"'),
    "UniversalPaymentModal volvió a `size=\"full\"`; HeroUI impondrá min-height:100dvh en escritorio.",
  );
  assert.match(
    src,
    /base:\s*"[^"]*\bmd:h-\[500px\]/,
    "classNames.base perdió `md:h-[500px]`; el modal volverá a cambiar de alto entre métodos.",
  );
});

test("classNames.base NO regresa a `md:w-auto` o `md:h-auto`", async () => {
  const src = await readSrc(MODAL_PATH);
  const baseMatch = src.match(/base:\s*"([^"]*)"/);
  assert.ok(baseMatch, "No se encontró classNames.base");
  const base = baseMatch[1];
  assert.ok(
    !/\bmd:w-auto\b/.test(base),
    "classNames.base regresó a `md:w-auto` — el ancho dependerá del contenido otra vez.",
  );
  assert.ok(
    !/\bmd:h-auto\b/.test(base),
    "classNames.base regresó a `md:h-auto` — el alto dependerá del contenido otra vez.",
  );
});

// ---------------------------------------------------------------------------
// R2 — Topes conservados para defensa en viewports pequeños
// ---------------------------------------------------------------------------

test("classNames.base conserva topes md:max-w-[1050px] y md:max-h-[78vh]", async () => {
  const src = await readSrc(MODAL_PATH);
  assert.match(
    src,
    /base:\s*"[^"]*\bmd:max-w-\[1050px\]/,
    "classNames.base perdió `md:max-w-[1050px]` (tope de ancho en escritorios chicos).",
  );
  assert.match(
    src,
    /base:\s*"[^"]*\bmd:max-h-\[78vh\]/,
    "classNames.base perdió `md:max-h-[78vh]` (tope de alto en portátiles).",
  );
});

// ---------------------------------------------------------------------------
// R3 — Compatibilidad móvil (contrato previo payment-modal-mobile.test.mjs)
// ---------------------------------------------------------------------------

test("classNames.base conserva w-screen + max-w-[100vw] + h-[100dvh] en móvil", async () => {
  const src = await readSrc(MODAL_PATH);
  const baseMatch = src.match(/base:\s*"([^"]*)"/);
  const base = baseMatch[1];
  assert.match(base, /\bw-screen\b/, "classNames.base perdió `w-screen` móvil.");
  assert.match(base, /\bmax-w-\[100vw\]/, "classNames.base perdió `max-w-[100vw]` móvil.");
  assert.match(base, /\bh-\[100dvh\]/, "classNames.base perdió `h-[100dvh]` móvil.");
});

// ---------------------------------------------------------------------------
// R4 — Scroll interno en los sub-paneles del centro
// ---------------------------------------------------------------------------

test("Modal: hay contenedores internos con overflow-y-auto + min-h-0 (scroll interno)", async () => {
  const src = await readSrc(MODAL_PATH);
  // El contenedor flex principal debe tener min-h-0 (ya cubierto por otro
  // guardián). Aquí anclamos que existe al menos un panel interno que
  // scrollea sin alterar el tamaño del modal, respetando FRONTEND_LAYOUT_RULES.md.
  const innerScrollers = src.match(
    /\bflex-1\b[^"'\n]*\bmin-h-0\b[^"'\n]*\boverflow-y-auto\b|\boverflow-y-auto\b[^"'\n]*\bmin-h-0\b[^"'\n]*\bflex-1\b/g,
  ) || src.match(
    /\boverflow-y-auto\b[^"'\n]*\bmin-h-0\b|\bmin-h-0\b[^"'\n]*\boverflow-y-auto\b/g,
  );
  const scrollers = innerScrollers || [];
  assert.ok(
    scrollers.length >= 2,
    `Se esperaban ≥2 paneles internos con overflow-y-auto + min-h-0 (uno por rama 'cash' / no-cash). ` +
      `Se encontraron ${scrollers.length}.`,
  );
});

test("Modal: el panel central lleva overflow-hidden para que los sub-paneles controlen el scroll", async () => {
  const src = await readSrc(MODAL_PATH);
  // El wrapper que contiene el header + resumen + panel por tab debe
  // tener `overflow-hidden` para evitar que crezca con el contenido.
  // El scroll se delega al panel interno (ver test previo).
  assert.match(
    src,
    /flex-1\s+min-w-0\s+bg-gray-50\s+dark:bg-zinc-950[^"]*overflow-hidden/,
    "El panel central del modal debe conservar `overflow-hidden` para delegar el scroll al sub-panel por tab.",
  );
});



test("UniversalPaymentModal usa una envolvente más alta y estrecha sólo para QR", async () => {
  const src = await readSrc(MODAL_PATH);
  assert.match(
    src,
    /base:\s*"[^"]*md:h-\[500px\][^"]*"\s*\+\s*\(isBoldQrOpen\s*\?\s*"[^"]*md:!w-\[620px\][^"]*md:!h-\[720px\][^"]*md:!max-h-\[90vh\]/,
    "La vista QR debe ampliar el padre a 620×720px (máx. 90vh) sin cambiar los 500px del cobro normal.",
  );
  assert.ok(
    !/size="full"/.test(src.slice(src.indexOf("<Modal"), src.indexOf("classNames=", src.indexOf("<Modal")))),
    "La envolvente QR no debe reintroducir size=full de HeroUI.",
  );
});
