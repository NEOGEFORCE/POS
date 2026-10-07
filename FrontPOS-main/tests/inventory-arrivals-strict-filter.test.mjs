import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const inventoryPage = join(here, "..", "src", "app", "(app)", "inventory", "page.tsx");

// ============================================================================
// Guardián de /inventory: el filtro de "Entregas Programadas" debe ser
// ESTRICTO por fecha (no acumulativo) y DEBE existir una banda separada
// para pedidos RETRASADOS que siempre está visible cuando hay atrasos.
// ============================================================================
//
// Síntoma histórico: `if (orderDate > bogotaDateStr) return false;` dejaba
// pasar TODAS las fechas <= seleccionada. Al elegir "mañana" aparecían
// mañana + hoy + ayer + ... Al elegir "hoy" aparecían hoy + atrasados
// mezclados sin distinción visual.
//
// El dueño pidió: filtrado estricto por fecha; los atrasados aparte con
// chip rojo "RETRASADO".

async function leerPagina() {
  return await readFile(inventoryPage, "utf8");
}

test("inventory/page: expectedOrders usa igualdad estricta orderDate === bogotaDateStr", async () => {
  const src = await leerPagina();
  // El filtro histórico `orderDate > bogotaDateStr` (dejaba pasar <=) está
  // prohibido. Ya no debe aparecer en el memo que calcula expectedOrders.
  // Debe aparecer la igualdad estricta.
  assert.match(
    src,
    /if\s*\(\s*orderDate\s*!==\s*bogotaDateStr\s*\)\s*return\s+false/,
    "expectedOrders debe filtrar con `orderDate !== bogotaDateStr` (estricto).",
  );
});

test("inventory/page: existe memo overdueOrders separado para pedidos atrasados", async () => {
  const src = await leerPagina();
  assert.match(
    src,
    /const\s+overdueOrders\s*=\s*useMemo/,
    "Debe existir const overdueOrders = useMemo(...) para listar los pedidos con orderDate < hoy.",
  );
  // El filtro de overdue es strict `< todayStr` (nunca mezcla hoy).
  assert.match(
    src,
    /if\s*\(\s*orderDate\s*>=\s*todayStr\s*\)\s*return\s+false/,
    "overdueOrders debe filtrar con `orderDate >= todayStr → return false`.",
  );
});

test("inventory/page: el chip 'Retrasado' aparece visualmente en la banda de atrasados", async () => {
  const src = await leerPagina();
  // Buscamos tanto el texto Retrasado como el atributo data-arrival-status="late".
  assert.ok(
    src.includes("Retrasado"),
    "La UI debe renderizar un chip con texto 'Retrasado'.",
  );
  assert.ok(
    src.includes('data-arrival-status="late"'),
    "Los items en la banda de atrasados deben llevar data-arrival-status=\"late\" para auditoría/tests.",
  );
});

test("inventory/page: la banda de atrasados se renderiza SOLO cuando overdueOrders.length > 0", async () => {
  const src = await leerPagina();
  assert.match(
    src,
    /\{overdueOrders\.length\s*>\s*0\s*&&/,
    "La banda de atrasados debe mostrarse únicamente si overdueOrders.length > 0.",
  );
});
