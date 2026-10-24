import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// GUARDIANES DE RESPONSIVE A NIVEL DE SISTEMA
// ============================================================================
//
// Después del sprint responsive (/sales/new móvil + toggle del teclado +
// tablas con scroll + modales full-screen), estos tests capturan los
// contratos clave que no deben regresar:
//
//  (1) Las grillas de KPIs usan 1 col móvil / 2 tablet / 4 desktop.
//  (2) Las tablas de ventas, deudas y auditoría tienen ancho mínimo
//      para scroll horizontal en móvil.
//  (3) Los modales de formulario (Customer/Supplier/Category/PendingDebts)
//      no desbordan el viewport en móvil.
//  (4) La configuración global de layout mantiene la cadena flex-1
//      min-h-0 descrita en FRONTEND_LAYOUT_RULES.md.
// ============================================================================

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "src", "app", "(app)");

async function readPage(relative) {
  return readFile(join(root, relative), "utf8");
}

// --- (1) KPI grids escalan correctamente en breakpoints -------------------

test("Dashboard KPIs: grid 1 col móvil / 2 tablet / 4 desktop", async () => {
  const src = await readPage("dashboard/components/DashboardKPIs.tsx");
  assert.match(
    src,
    /grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4/,
    "DashboardKPIs debe escalar grid-cols-1 → sm:grid-cols-2 → md:grid-cols-4.",
  );
});

test("Dashboard loading skeletons: grid 1 col móvil / 2 tablet / 4 desktop", async () => {
  const src = await readPage("dashboard/page.tsx");
  assert.match(
    src,
    /grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4/,
    "El skeleton de carga del dashboard también debe seguir el patrón 1/2/4.",
  );
});

test("Reports KPIs: grid 1 col móvil / 2 tablet / 4 desktop", async () => {
  const src = await readPage("reports/page.tsx");
  assert.match(
    src,
    /grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4/,
    "La página de reportes debe tener MetricCards en 1/2/4 columnas.",
  );
});

// --- (2) Tablas con scroll horizontal en móvil ----------------------------

test("SalesTable: la cabecera y las filas tienen min-w-[760px] para scroll horizontal", async () => {
  const src = await readPage("sales/components/SalesTable.tsx");
  assert.match(src, /min-w-\[760px\]/,
    "SalesTable debe tener min-w-[760px] para forzar scroll horizontal en móvil.");
  assert.match(src, /overflow-auto overscroll-contain custom-scrollbar/,
    "El contenedor virtual debe permitir scroll vertical + horizontal.");
});

test("sales/debts page: la tabla acepta scroll horizontal en móvil (min-w-[640px])", async () => {
  const src = await readPage("sales/debts/page.tsx");
  assert.match(src, /min-w-\[640px\]/,
    "La tabla de deudas debe tener min-w-[640px] para no recortar columnas en móvil.");
  assert.match(src, /overflow-auto overscroll-contain custom-scrollbar/,
    "El CardBody debe tener overflow-auto para scroll horizontal cuando se necesite.");
});

// --- (3) Modales full-screen y responsivos --------------------------------

test("PendingDebtsModal: full-screen en móvil (sm:rounded-[2.5rem] + h-[100dvh])", async () => {
  const src = await readPage("dashboard/components/PendingDebtsModal.tsx");
  assert.match(src, /rounded-none sm:rounded-\[2\.5rem\]/,
    "PendingDebtsModal debe quitar el radio en móvil para quedar flush al borde.");
  assert.match(src, /h-\[100dvh\] sm:h-auto/,
    "PendingDebtsModal debe ocupar la altura total del viewport en móvil.");
  assert.match(src, /w-screen sm:w-auto/,
    "PendingDebtsModal debe tomar ancho completo en móvil.");
});

test("CustomerFormModal: max-w limita al viewport en móvil", async () => {
  const src = await readPage("customers/components/CustomerFormModal.tsx");
  assert.match(src, /max-w-\[calc\(100vw-1rem\)\] sm:max-w-2xl/,
    "CustomerFormModal debe limitar max-w al viewport menos padding en móvil.");
  assert.match(src, /rounded-2xl sm:rounded-\[2rem\]/,
    "CustomerFormModal debe usar radio compacto en móvil y amplio en >= sm.");
});

test("SupplierFormModal: max-w limita al viewport en móvil", async () => {
  const src = await readPage("suppliers/components/SupplierFormModal.tsx");
  assert.match(src, /max-w-\[calc\(100vw-1rem\)\] sm:max-w-2xl/,
    "SupplierFormModal debe limitar max-w al viewport menos padding en móvil.");
});

test("CategoryFormModal: max-w limita al viewport en móvil", async () => {
  const src = await readPage("categories/components/CategoryFormModal.tsx");
  assert.match(src, /max-w-\[calc\(100vw-1rem\)\] sm:max-w-2xl/,
    "CategoryFormModal debe limitar max-w al viewport menos padding en móvil.");
});

// --- (4) Cadena flex-1 min-h-0 preservada --------------------------------

test("Layout principal (app): la cadena flex-1 min-h-0 sigue viva (FRONTEND_LAYOUT_RULES)", async () => {
  const src = await readPage("layout.tsx");
  assert.match(src, /flex h-\[100dvh\] md:h-screen w-screen overflow-hidden/,
    "El contenedor raíz debe usar h-[100dvh] en móvil (dynamic viewport).");
  assert.match(src, /flex-1 h-full min-h-0/,
    "El main interno debe mantener flex-1 min-h-0 para la cadena de scroll.");
  assert.match(src, /overflow-y-auto custom-scrollbar/,
    "El main debe scrollear verticalmente con custom-scrollbar.");
});
