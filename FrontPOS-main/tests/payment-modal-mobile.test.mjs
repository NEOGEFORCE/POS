import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// GUARDIAN ESTATICO — mobile responsive del UniversalPaymentModal
// ============================================================================
//
// Captura real del usuario mostraba el modal de cobro cortandose por la
// derecha, con una galeria gigante de billetes consumiendo mas de la mitad
// del alto y el boton PROCESAR fuera de pantalla. Este guardian impide que
// vuelvan los antipatrones responsables:
//
//  (1) El modal usa `size="5xl"` para que HeroUI no inyecte
//      `min-h-[100dvh]`; las clases propias `w-screen max-w-[100vw]
//      h-[100dvh]` mantienen el comportamiento full-screen sólo en móvil.
//  (2) Las denominaciones usaban `aspect-[2.2/1]` + <img object-cover>
//      incluso en movil, pintando una galeria de ~462 px de alto.
//  (3) El pad desktop sin `shrink-0` depende de que ningun child de la
//      columna central tenga ancho fijo.
//  (4) Sin `min-h-0 min-w-0` en el contenedor flex, HeroUI expandia la base
//      al intrinsic size y la cortaba contra el wrapper.
//
// Son tests de lectura de archivo + regex, no requieren DOM.
// ============================================================================

const here = dirname(fileURLToPath(import.meta.url));
const modalPath = join(here, "..", "src", "components", "shared", "UniversalPaymentModal.tsx");
const layoutPath = join(here, "..", "src", "app", "layout.tsx");

async function readSource(path) {
  return await readFile(path, "utf8");
}

test("UniversalPaymentModal fija ancho real al viewport en movil (w-screen + max-w-[100vw])", async () => {
  const src = await readSource(modalPath);
  assert.ok(
    /base:\s*"[^"]*\bw-screen\b[^"]*\bmax-w-\[100vw\]/.test(src),
    "classNames.base perdio w-screen + max-w-[100vw]; el modal volvera a cortarse en movil.",
  );
  assert.ok(
    /base:\s*"[^"]*\bmd:max-w-\[1050px\]/.test(src),
    "classNames.base perdio md:max-w-[1050px]; escritorio queda limitado al ancho movil.",
  );
});

test("UniversalPaymentModal contiene min-h-0 min-w-0 en el flex row interno", async () => {
  const src = await readSource(modalPath);
  // El contenedor que organiza sidebar + main + pad desktop. Si no tiene
  // min-h-0 min-w-0, los children con ancho fijo empujan la base.
  assert.ok(
    /flex\s+flex-col\s+md:flex-row[^"]*\bmin-h-0\b[^"]*\bmin-w-0\b/.test(src)
      || /flex\s+flex-col\s+md:flex-row[^"]*\bmin-w-0\b[^"]*\bmin-h-0\b/.test(src),
    "el div flex-col md:flex-row principal perdio min-h-0 min-w-0; children con w-fija romperan el modal.",
  );
});

test("UniversalPaymentModal: pad desktop lleva shrink-0 (no empuja el flex row)", async () => {
  const src = await readSource(modalPath);
  // Localizar el pad desktop: `hidden md:flex w-[280px]`
  assert.ok(
    /hidden\s+md:flex\s+w-\[280px\][^"]*\bshrink-0\b/.test(src),
    "el pad desktop w-[280px] perdio shrink-0; en escritorio volvera a comprimirse o empujar la base.",
  );
});

test("UniversalPaymentModal: sidebar movil no fuerza ancho mas alla del viewport", async () => {
  const src = await readSource(modalPath);
  // La sidebar w-full md:w-[190px] debe tener min-w-0 o md:shrink-0 para no
  // empujar la base en movil.
  assert.ok(
    /w-full\s+md:w-\[190px\][^"]*\b(min-w-0|md:shrink-0)\b/.test(src),
    "el sidebar perdio min-w-0 / md:shrink-0; podria arrastrar el ancho del main en movil.",
  );
});

test("UniversalPaymentModal: en MOVIL las denominaciones son chips compactos (no galeria aspect-[2.2/1])", async () => {
  const src = await readSource(modalPath);
  // El Button de denominacion antes era: aspect-[2.2/1] w-full ... h-auto
  // Despues del fix debe cambiar a h-10 (chip pequeno) con la imagen oculta
  // en movil (hidden md:block). Garantiza que no haya un aspect-[2.2/1]
  // SIN prefijo md:
  const bareAspectRatio = /className="[^"]*(?<!md:)aspect-\[2\.2\/1\][^"]*w-full[^"]*"/;
  assert.ok(
    !bareAspectRatio.test(src),
    "Las denominaciones siguen usando aspect-[2.2/1] en movil; vuelve la galeria gigante que tapa el boton PROCESAR.",
  );
  // La imagen del billete debe ocultarse en movil (hidden md:block) para
  // que el chip pequeno sea legible.
  assert.ok(
    /<img[^>]*className="hidden\s+md:block/.test(src),
    "la imagen de billete debe tener `hidden md:block`; en movil se renderiza un chip con la cifra, no la imagen.",
  );
});

test("UniversalPaymentModal: existe sticky bottom action con safe-area para movil (sticky bottom + env(safe-area-inset-bottom))", async () => {
  const src = await readSource(modalPath);
  assert.ok(
    /env\(safe-area-inset-bottom\)/.test(src),
    "El modal no respeta safe-area del iPhone; el boton PROCESAR puede quedar debajo del home indicator.",
  );
  assert.ok(
    /md:hidden[^"]*sticky[^"]*bottom-0/.test(src)
      || /sticky[^"]*bottom-0[^"]*md:hidden/.test(src),
    "No hay accion sticky en el fondo para movil; el usuario tendria que hacer scroll para completar la venta.",
  );
});

test("UniversalPaymentModal: SummaryTile tolera cifras grandes (min-w-0 + truncate)", async () => {
  const src = await readSource(modalPath);
  // El SummaryTile es la unidad visual con los 3 KPIs; en 280 px una cifra
  // de $1.234.567 empujaba el grid sin truncate. Nos aseguramos que el
  // contenedor tenga min-w-0 y el <p> con truncate.
  const summaryTileMatch = src.match(/function SummaryTile[\s\S]*?return \([\s\S]*?\);\s*\}/);
  assert.ok(summaryTileMatch, "No se encontro el componente SummaryTile; cambio su firma?");
  assert.ok(
    /\bmin-w-0\b/.test(summaryTileMatch[0]),
    "SummaryTile perdio min-w-0; una cifra larga volvera a desbordar el grid en movil.",
  );
  assert.ok(
    /\btruncate\b/.test(summaryTileMatch[0]),
    "SummaryTile perdio truncate; las cifras grandes rompen el layout.",
  );
});

test("layout.tsx activa viewportFit:'cover' para que env(safe-area-inset-*) funcione en iOS", async () => {
  const src = await readSource(layoutPath);
  assert.ok(
    /viewportFit:\s*['"]cover['"]/.test(src),
    "export const viewport perdio viewportFit:'cover'; las safe-area del iPhone quedan inactivas y el boton PROCESAR cae bajo el home indicator.",
  );
});
