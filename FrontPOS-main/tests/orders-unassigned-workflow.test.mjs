import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildProductSupplierLinkPayload,
  buildSupplierSchedulePayload,
} from "../src/lib/orders-admin-actions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ordersRoot = join(here, "..", "src", "app", "(app)", "inventory", "orders");
const pagePath = join(ordersRoot, "page.tsx");
const listPath = join(ordersRoot, "components", "VirtualizedSuggestionList.tsx");
const scheduleComparePath = join(ordersRoot, "components", "SupplierScheduleCompare.tsx");

test("vinculación construye únicamente supplierId numérico", () => {
  assert.deepEqual(buildProductSupplierLinkPayload("42"), { supplierId: 42 });
  assert.throws(() => buildProductSupplierLinkPayload("unassigned"), /entero positivo/);
  assert.throws(() => buildProductSupplierLinkPayload(0), /entero positivo/);
});

test("agenda normaliza días y lead 0..60 sin campos aprendidos ni personales", () => {
  const payload = buildSupplierSchedulePayload({
    visitDays: ["Miércoles", "lunes", "Lunes", "basura"],
    deliveryDays: ["Sábado", "viernes"],
    leadTimeDays: 99.8,
    learnedVisitDays: ["Martes"],
    learnedLeadTimeDays: 4,
    name: "NO ENVIAR",
    phone: "NO ENVIAR",
  });
  assert.deepEqual(payload, {
    visitDays: ["Lunes", "Miercoles"],
    deliveryDays: ["Viernes", "Sabado"],
    leadTimeDays: 60,
  });
  assert.equal("learnedVisitDays" in payload, false);
  assert.equal("learnedLeadTimeDays" in payload, false);
  assert.equal("name" in payload, false);
  assert.equal("phone" in payload, false);

  assert.deepEqual(buildSupplierSchedulePayload({ leadTimeDays: -8 }), { leadTimeDays: 0 });
});

test("Pedidos inicia en huérfanos y deja las opciones operativas debajo de los proveedores", async () => {
  const source = await readFile(pagePath, "utf8");
  assert.match(source, /searchParams\.get\("supplier"\) \?\? "unassigned"/);
  assert.match(source, /key: "unassigned", label: "Sin proveedor · por vincular"/);
  assert.match(source, /key: "global", label: "Todos los proveedores"/);
  assert.match(
    source,
    /return \[\s*\.\.\.options,\s*\{ key: "unassigned", label: "Sin proveedor · por vincular" \},\s*\{ key: "global", label: "Todos los proveedores" \},\s*\]/,
    "los proveedores reales deben aparecer antes de las opciones operativas",
  );
  assert.match(source, /const value = key \? String\(key\) : "unassigned"/);
  assert.match(source, /!isUnassignedMode && \(/, "Ver todo debe ocultarse en modo huérfanos");
});

test("guardián de scroll único y un solo paginador global", async () => {
  const [page, list] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(listPath, "utf8"),
  ]);

  assert.ok(!page.includes("min-h-screen"), "la página no debe crear otro alto de viewport");
  assert.match(page, /INITIAL_RENDER_LIMIT = 24/);
  assert.match(page, /incrementalGroups/);
  assert.equal((page.match(/new IntersectionObserver/g) ?? []).length, 1);
  assert.equal((page.match(/>\s*Cargar más\s*</g) ?? []).length, 1);
  assert.match(page, /Mostrando \{mountedProductCount\} de \{totalVisibleProducts\}/);

  assert.ok(!list.includes("useVirtualizer"), "la lista no debe virtualizar con viewport propio");
  assert.ok(!list.includes("useState"), "la lista no debe mantener otro presupuesto");
  assert.ok(!list.includes("IntersectionObserver"), "la lista no debe crear otro sentinel");
  assert.ok(!list.includes("Cargar más"), "la lista no debe crear otro botón de paginación");
  assert.ok(!list.includes("Mostrando"), "la lista no debe crear otro contador");
  assert.ok(!list.includes(".slice("), "la lista debe renderizar todos los ítems ya recortados");
  assert.ok(!list.includes("overflow"), "la lista no debe crear scroll interno");
  assert.ok(!list.includes("maxHeight"), "la lista no debe imponer altura máxima");
  assert.match(list, /items\.map\(\(item\) =>/);
});

test("la página usa modales únicos y restringe la agenda a administradores", async () => {
  const [source, compare] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(scheduleComparePath, "utf8"),
  ]);
  assert.equal((source.match(/<ProductSupplierLinkDialog/g) ?? []).length, 1);
  assert.equal((source.match(/<SupplierScheduleEditor/g) ?? []).length, 1);
  assert.ok(!source.includes("ProductFormModal"));
  assert.match(source, /buildProductSupplierLinkPayload\(supplierId\)/);
  assert.match(source, /buildSupplierSchedulePayload\(draft\)/);
  assert.match(source, /if \(!isAdmin \|\| !group\.supplierId\) return/);
  assert.match(source, /if \(!isAdmin \|\| !scheduleTarget\) return/);
  assert.match(source, /\{isAdmin && \(\s*<SupplierScheduleEditor/);
  assert.match(source, /onEditSchedule=\{isAdmin \? \(\) => openScheduleEditor\(completeGroup\) : undefined\}/);
  assert.match(compare, /onEditSchedule\?: \(\) => void/);
  assert.equal((compare.match(/\{onEditSchedule && \(/g) ?? []).length, 2);
});



// ============================================================================
// GUARDIAN: EL SELECTOR DE PROVEEDOR NO PUEDE AUTO-FILTRARSE
// ============================================================================
//
// Bug reportado por el dueño el 2026-09-04: "aun esta preseleccionado
// automaticamente sin proveedor... cuando quisiera escoger uno rapido o
// escribir uno rapido no puedo". En la captura el desplegable mostraba UNA
// sola opción: "Sin proveedor · por vincular". Los proveedores reales no
// aparecían.
//
// CAUSA: un useEffect escribía la etiqueta del proveedor seleccionado dentro
// de supplierQuery, y ese mismo texto alimenta el filtro de la lista. Con el
// arranque en "unassigned" el filtro dejaba pasar sólo esa opción, así que el
// selector se volvía inútil: no se podía elegir ni teclear otro proveedor.
//
// REGLA: supplierQuery representa SÓLO lo que el usuario tecleó. Jamás la
// selección actual. El test anterior de esta suite verifica el ORDEN de las
// opciones, pero no detectó esto porque el orden estaba bien: el problema era
// que la lista llegaba filtrada a un elemento.

test("el selector de proveedor nunca escribe la etiqueta seleccionada en la búsqueda", async () => {
  const source = await readFile(pagePath, "utf8");

  // No puede volver el efecto que reflejaba la selección en el input.
  assert.ok(
    !/setSupplierQuery\(\s*match[?.]*\.?label/.test(source),
    "setSupplierQuery no puede recibir la etiqueta del proveedor seleccionado: eso vuelve a colapsar el desplegable a un solo ítem"
  );

  // Al seleccionar hay que LIMPIAR la búsqueda, no rellenarla.
  const selectionBlock = source.slice(
    source.indexOf("onSelectionChange="),
    source.indexOf("allowsCustomValue=")
  );
  assert.ok(
    selectionBlock.length > 0,
    "no se encontró el bloque onSelectionChange del Autocomplete de proveedor"
  );
  assert.ok(
    /setSupplierQuery\(\s*""\s*\)/.test(selectionBlock),
    "onSelectionChange debe limpiar supplierQuery con setSupplierQuery(\"\")"
  );
});

test("la lista de proveedores sólo se filtra con lo que el usuario teclea", async () => {
  const source = await readFile(pagePath, "utf8");

  // El filtro debe depender de supplierQuery y de la lista completa, y nada más.
  const filterStart = source.indexOf("const filteredSupplierOptions");
  assert.ok(filterStart > -1, "no se encontró filteredSupplierOptions");
  const filterBlock = source.slice(filterStart, filterStart + 600);

  assert.ok(
    /if\s*\(\s*!query\s*\)\s*return\s+supplierOptions/.test(filterBlock),
    "sin texto tecleado el filtro debe devolver TODAS las opciones (incluidos los proveedores reales)"
  );
  assert.ok(
    !/selectedSupplier/.test(filterBlock),
    "el filtro no puede depender de selectedSupplier: la selección no debe recortar la lista"
  );
});

test("la vista activa se muestra en pantalla aunque el campo quede vacío", async () => {
  const source = await readFile(pagePath, "utf8");

  // Como el input arranca vacío para poder teclear de una, tiene que haber otra
  // señal visible de qué proveedor se está mirando.
  assert.ok(
    /activeSupplierLabel/.test(source),
    "debe existir activeSupplierLabel para informar la vista activa"
  );
  assert.ok(
    /Viendo:/.test(source),
    "debe mostrarse un texto tipo 'Viendo: <proveedor>' junto al selector"
  );
});

test("el placeholder del selector invita a escribir, no sólo a buscar", async () => {
  const source = await readFile(pagePath, "utf8");
  assert.ok(
    /placeholder="Escribe o elige un proveedor/.test(source),
    "el placeholder debe dejar claro que se puede teclear el proveedor"
  );
});
