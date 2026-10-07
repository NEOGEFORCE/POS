import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// GUARDIAN ESTATICO — /inventory/history ya no dice "SIN PROVEEDOR"
// ============================================================================
//
// La captura del usuario mostraba cada tarjeta de recepcion con el titulo
// "SIN PROVEEDOR" aunque la base de datos tenia el supplierName en el
// metadata. La causa real estaba en el DTO del backend: el reporte legacy
// /dashboard/reports/movements omitia m.Metadata.
//
// El fix hace dos cosas:
//  1) Backend expone un endpoint dedicado /dashboard/receptions-history
//     con el supplier ya resuelto (metadata -> expense.supplier -> fallback
//     literal "Proveedor no registrado").
//  2) Frontend consume ese endpoint, tolera camelCase/snake_case, pinta
//     un fallback honesto en lugar de "SIN PROVEEDOR".
//
// Estos guardianes impiden que vuelva el bug.
// ============================================================================

const here = dirname(fileURLToPath(import.meta.url));
const historyPage = join(here, "..", "src", "app", "(app)", "inventory", "history", "page.tsx");

async function readSource() {
  return await readFile(historyPage, "utf8");
}

/**
 * Igual que en payment-combined-ui.test.mjs: para los asserts que buscan la
 * AUSENCIA de un literal (p.ej. "SIN PROVEEDOR" o un endpoint legacy),
 * descartamos los comentarios /* ... *\/ y // ... porque es legitimo que la
 * documentacion del propio bug mencione la cadena como referencia historica.
 */
async function readWithoutComments() {
  const raw = await readSource();
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("/inventory/history usa el endpoint dedicado /dashboard/receptions-history", async () => {
  const src = await readSource();
  assert.ok(
    src.includes("/dashboard/receptions-history"),
    "La pantalla volvio al endpoint legacy /dashboard/reports/movements; el supplier no llegara en el DTO.",
  );
  const srcNoComments = await readWithoutComments();
  assert.ok(
    !srcNoComments.includes("/dashboard/reports/movements"),
    "Hay una referencia residual al endpoint legacy; debe eliminarse para que no se consuma por accidente.",
  );
});

test("/inventory/history ya NO renderiza el literal 'SIN PROVEEDOR'", async () => {
  const src = await readWithoutComments();
  assert.ok(
    !/['"`]SIN\s+PROVEEDOR['"`]/i.test(src),
    "El literal 'SIN PROVEEDOR' sigue en el codigo. Debe usar supplierName del backend o 'Proveedor no registrado' como fallback honesto.",
  );
});

test("/inventory/history muestra el fallback 'Proveedor no registrado' cuando no hay dato", async () => {
  const src = await readSource();
  assert.ok(
    src.includes("Proveedor no registrado"),
    "El fallback honesto 'Proveedor no registrado' no esta en la pantalla; el usuario no podra distinguir un dato ausente.",
  );
});

test("/inventory/history tolera camelCase y snake_case en el contrato", async () => {
  const src = await readSource();
  // Debemos ver referencia a supplier_name (snake) junto a supplierName.
  assert.ok(
    src.includes("supplier_name"),
    "El contrato debe aceptar supplier_name tambien (snake_case) para no romperse si el backend expone ambos.",
  );
  assert.ok(
    src.includes("supplierName"),
    "El contrato debe aceptar supplierName (camelCase) — este es el formato canonico actual del backend.",
  );
});

test("/inventory/history distingue estado 403 (sin permisos) del estado de error genérico", async () => {
  const src = await readSource();
  assert.ok(
    /errorStatus\s*===\s*403|status\s*===\s*403/.test(src),
    "No existe rama diferenciada para 403. Un cajero vera 'Error al cargar' en vez del mensaje de permisos.",
  );
});

test("/inventory/history muestra totales (lineas, unidades) en la tarjeta", async () => {
  const src = await readSource();
  assert.ok(/totalLines/.test(src), "El resumen por tarjeta perdio totalLines.");
  assert.ok(/totalUnits/.test(src), "El resumen por tarjeta perdio totalUnits.");
});

test("/inventory/history muestra el badge 'Varios proveedores' cuando la recepcion es multi-proveedor", async () => {
  const src = await readSource();
  assert.ok(
    /multiSupplier|multi_supplier/.test(src),
    "La pantalla ignora multiSupplier; una recepcion con varios proveedores no se destacara.",
  );
});

test("/inventory/history solo renderiza acciones de admin cuando isAdmin es true", async () => {
  const src = await readSource();
  // La guardia debe seguir existiendo tras el rediseño.
  assert.ok(
    /isAdmin\s*&&/.test(src),
    "Se perdio la guardia `isAdmin &&` para los botones Editar/Deshacer. Un cajero volveria a verlos.",
  );
});

test("/inventory/history abre modal de detalle para listar lineas cuando hay muchas", async () => {
  const src = await readSource();
  // El modal con lista de lineas usa HeroUI Modal/ModalContent y la etiqueta
  // 'Ver N linea...' o similar en el boton de expansion.
  assert.ok(
    /Ver\s+\{hiddenCount\}/.test(src) || /ver\s+\d+\s+linea/i.test(src) || /onShowDetail/.test(src),
    "La tarjeta ya no expone un boton 'Ver N lineas mas'; recepciones grandes vuelven a mostrar solo las primeras.",
  );
  assert.ok(
    src.includes("ModalContent"),
    "El modal de detalle se perdio; el usuario no podra ver todas las lineas de una recepcion grande.",
  );
});
