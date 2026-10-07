import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// GUARDIAN ESTATICO — pagos combinados en el historial de ventas
// ============================================================================
//
// Dos regresiones de 2026-10 que estos tests impiden que vuelvan:
//
// (1) BOTON + AUSENTE EN MOVIL. UniversalPaymentModal tenia el '+' solo en
//     el numpad lateral de ESCRITORIO. En movil el array del numpad era
//     [1-9, 0, '00', 'CE'] y era imposible acumular canales desde el
//     telefono — el cajero no podia corregir una venta mixta.
//
// (2) ETIQUETA "MIXTO" GENERICA. SalesTable, SaleDetailModal, ClosuresHistory
//     mostraban literalmente "MIXTO" cuando la venta tenia dos canales
//     digitales, en vez de "NEQUI + DAVIPLATA" o similar. El breakdown
//     numerico estaba en BD; faltaba la composicion en UI.
//
// Estos guardianes son STATIC CODE SEARCH (lectura de archivo + regex), no
// requieren DOM ni browser. Corren con `node --test`.
// ============================================================================

const here = dirname(fileURLToPath(import.meta.url));
const modalPath = join(here, "..", "src", "components", "shared", "UniversalPaymentModal.tsx");
const salesTablePath = join(here, "..", "src", "app", "(app)", "sales", "components", "SalesTable.tsx");
const saleDetailPath = join(here, "..", "src", "app", "(app)", "sales", "components", "SaleDetailModal.tsx");
const closuresHistoryPath = join(here, "..", "src", "app", "(app)", "reports", "components", "ClosuresHistory.tsx");

/**
 * Lee el archivo descartando comentarios /* ... *\/ y // ... porque la
 * palabra "MIXTO" aparece legitimamente en algunos comentarios (como
 * documentacion del fallback historico) y no queremos falsos positivos.
 */
async function readWithoutComments(path) {
  const raw = await readFile(path, "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// -------------------------------------------------------------------------
// (1) El boton '+' debe estar visible en el numpad MOVIL y en el DESKTOP.
// -------------------------------------------------------------------------

test("UniversalPaymentModal tiene el boton '+' en al menos DOS numpads (movil + desktop)", async () => {
  const source = await readFile(modalPath, "utf8");
  // Patron del array del numpad. Buscamos cualquier declaracion que incluya
  // literal '+' entre comillas simples o dobles como entrada de un array
  // [..., '+', 'CE'].
  const numpadsWithPlus = source.match(/\[\s*1\s*,\s*2\s*,\s*3[\s\S]{0,120}['"]\+['"][\s\S]{0,30}['"]CE['"]/g) || [];
  assert.ok(
    numpadsWithPlus.length >= 2,
    `UniversalPaymentModal.tsx debe tener '+' en MINIMO 2 numpads (movil + desktop). Encontre ${numpadsWithPlus.length}.`,
  );
});

test("UniversalPaymentModal expone un boton accesible '+ AGREGAR CANAL' para movil", async () => {
  // Boton grande dedicado al patron tactil, con label en espanol para que
  // sea obvio y con atributo aria-label para lectores de pantalla.
  const source = await readFile(modalPath, "utf8");
  assert.ok(
    source.includes("+ AGREGAR CANAL"),
    "falta el boton explicito '+ AGREGAR CANAL' en el modal (critico para movil)",
  );
  assert.ok(
    /aria-label=["']Agregar canal al pago combinado["']/.test(source),
    "el boton '+ AGREGAR CANAL' debe tener aria-label para accesibilidad",
  );
});

test("UniversalPaymentModal NO regresa al tab 'cash' automaticamente al acumular (confunde al cajero)", async () => {
  const source = await readFile(modalPath, "utf8");
  // Localizamos el inicio de handleAddPayment y leemos hasta su cierre
  // "}, [...]);". Validamos que ese setter no aparezca dentro.
  const startIdx = source.indexOf("const handleAddPayment = useCallback(");
  assert.ok(startIdx >= 0, "no se encontro handleAddPayment en UniversalPaymentModal.tsx");
  // El cuerpo real termina en el primer "}, [" posterior (deps array del useCallback).
  const bodyEnd = source.indexOf("}, [", startIdx);
  assert.ok(bodyEnd > startIdx, "no se encontro el cierre del useCallback de handleAddPayment");
  const body = source.slice(startIdx, bodyEnd);
  assert.ok(
    !/setActivePaymentTab\(\s*['"]cash['"]\s*\)/.test(body),
    "handleAddPayment vuelve a 'cash' automaticamente - esto confunde al cajero. Debe quedarse en el tab actual.",
  );
});

// -------------------------------------------------------------------------
// (2) La etiqueta "MIXTO" generica no debe aparecer como string DE DISPLAY.
// Los comentarios se descartan antes de buscar (ver readWithoutComments).
// -------------------------------------------------------------------------

test("SalesTable NO contiene literalmente la cadena 'MIXTO' como display", async () => {
  const source = await readWithoutComments(salesTablePath);
  assert.ok(
    !/['"]MIXTO['"]/.test(source),
    "SalesTable.tsx muestra 'MIXTO' literal - debe usar getPaymentDescription (desglose real).",
  );
});

test("SaleDetailModal NO contiene literalmente la cadena 'MIXTO' como display", async () => {
  const source = await readWithoutComments(saleDetailPath);
  assert.ok(
    !/['"]MIXTO['"]/.test(source),
    "SaleDetailModal.tsx muestra 'MIXTO' literal - debe usar getPaymentDescription (desglose real).",
  );
});

test("ClosuresHistory NO imprime 'MIXTO' como literal de display dentro del detalle de ventas", async () => {
  const source = await readWithoutComments(closuresHistoryPath);
  // Patron especifico: el bug viejo era
  //    s.cashAmount > 0 && s.transferAmount > 0 ? 'MIXTO' : ...
  // No queremos que vuelva. Permitimos 'MIXTO' en el helper
  // `getPaymentSourceStyle` (color) porque alli solo se compara, pero el
  // ternario literal esta prohibido.
  const forbidden = /cashAmount\s*>\s*0\s*&&\s*s?\.?transferAmount\s*>\s*0\s*\?\s*['"]MIXTO['"]/;
  assert.ok(
    !forbidden.test(source),
    "ClosuresHistory.tsx tiene el ternario legacy 'MIXTO' - debe componer canales desde los montos.",
  );
});
