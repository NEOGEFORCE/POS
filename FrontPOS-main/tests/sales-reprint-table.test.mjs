import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const salesTable = join(here, "..", "src", "app", "(app)", "sales", "components", "SalesTable.tsx");
const salesPage = join(here, "..", "src", "app", "(app)", "sales", "page.tsx");
const saleDetailModal = join(here, "..", "src", "app", "(app)", "sales", "components", "SaleDetailModal.tsx");

// =============================================================================
// R5 — Reimpresión EXPLÍCITA en el historial.
//
// Antes la única forma de reimprimir era abrir el detalle (Eye) → tocar
// "IMPRIMIR FACTURA" dentro del modal: dos clicks y un nombre genérico.
// El sprint pide:
//
//   - Botón claro "Reimprimir factura" en el historial, usando el MISMO
//     contrato térmico (printThermalTicket + saleToTicket).
//   - El modal de detalle sigue existiendo pero su botón se renombra a
//     "REIMPRIMIR" y expone bridge/navegador explícitos.
//
// Estos tests son estáticos sobre el código fuente.
// =============================================================================

async function read(path) {
  return readFile(path, "utf8");
}

test("SalesTable: declara la prop onOpenReprint en su interfaz", async () => {
  const src = await read(salesTable);
  assert.match(src, /interface SalesTableProps\s*\{[\s\S]*onOpenReprint:\s*\(sale:\s*Sale\)\s*=>\s*void/,
    "SalesTableProps debe declarar onOpenReprint: (sale: Sale) => void para que el padre inyecte el handler.");
});

test("SalesTable: cada fila expone un botón accesible 'Reimprimir factura' con icono Printer", async () => {
  const src = await read(salesTable);
  // El Tooltip debe decir "REIMPRIMIR FACTURA"
  assert.match(src, /content="REIMPRIMIR FACTURA"/,
    "Debe haber un Tooltip con 'REIMPRIMIR FACTURA' sobre el nuevo botón.");
  // El Button debe exponer aria-label con el patrón "Reimprimir factura <id>" para a11y
  assert.match(src, /aria-label=\{`Reimprimir factura \$\{sale\.id\}`\}/,
    "El botón debe tener aria-label='Reimprimir factura <id>' por accesibilidad.");
  // Debe importar el icono Printer de lucide-react
  assert.match(src, /from\s+['"]lucide-react['"]/, "SalesTable sigue importando iconos de lucide-react.");
  assert.match(src, /\bPrinter\b[^;]*from\s+['"]lucide-react['"]|{[^}]*\bPrinter\b[^}]*}/,
    "SalesTable debe importar el icono Printer de lucide-react.");
});

test("SalesTable: el botón de reimpresión llama a onReprint(sale) sin tocar la lógica de audit/edit/anular", async () => {
  const src = await read(salesTable);
  // El botón debe disparar onReprint(sale) via onPress
  assert.match(src, /onPress=\{\(\)\s*=>\s*onReprint\(sale\)\}/,
    "El botón de reimpresión debe disparar onReprint(sale), no la navegación al detalle.");
});

test("SalesTable: SaleRow memo recibe la prop onReprint con la firma correcta", async () => {
  const src = await read(salesTable);
  // La firma del memo debe incluir onReprint
  assert.match(src, /onReprint:\s*\(s:\s*Sale\)\s*=>\s*void/,
    "El memo SaleRow debe declarar onReprint en su tipo de props.");
});

test("sales/page.tsx: wire handleReprint que usa printThermalTicket + saleToTicket + getPaymentDescription", async () => {
  const src = await read(salesPage);
  assert.match(src, /from\s+['"]@\/lib\/thermal-ticket['"]/,
    "sales/page debe importar del helper térmico canónico.");
  assert.match(src, /printThermalTicket/, "sales/page debe usar printThermalTicket.");
  assert.match(src, /saleToTicket/, "sales/page debe usar saleToTicket.");
  assert.match(src, /getPaymentDescription/,
    "sales/page debe usar getPaymentDescription para componer la descripción fiel del método de pago.");
  // El handler debe invocarse con `handleReprint(sale)` o similar y pasar al SalesTable
  assert.match(src, /const handleReprint\s*=\s*useCallback\(\s*\(sale:\s*Sale\)/,
    "sales/page debe definir handleReprint como useCallback((sale: Sale) => ...).");
  assert.match(src, /onOpenReprint=\{handleReprint\}/,
    "sales/page debe cablear onOpenReprint={handleReprint} al SalesTable.");
});

test("sales/page.tsx: la reimpresión NO abre window.print() ni usa el DOM entero del POS", async () => {
  const src = await read(salesPage);
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/window\.print\(\)/.test(stripped),
    "La reimpresión desde el historial jamás puede volver a window.print(); va por printThermalTicket.");
});

test("SaleDetailModal: el footer renombra 'IMPRIMIR FACTURA' a 'REIMPRIMIR' con bridge + navegador separados", async () => {
  const src = await read(saleDetailModal);
  // Debe existir el texto "REIMPRIMIR" en lugar del genérico "IMPRIMIR FACTURA"
  assert.match(src, /REIMPRIMIR/,
    "El modal de detalle debe mostrar 'REIMPRIMIR' en los botones de impresión.");
  // Separación bridge vs navegador
  assert.match(src, /REIMPRIMIR \(BRIDGE\)/,
    "Debe existir el botón 'REIMPRIMIR (BRIDGE)' para la ruta directa.");
  assert.match(src, /REIMPRIMIR \(NAVEGADOR \/ PDF\)/,
    "Debe existir el botón 'REIMPRIMIR (NAVEGADOR / PDF)' para la ruta con diálogo.");
  // El botón bridge se deshabilita cuando no hay bridge detectado
  assert.match(src, /isDisabled=\{!bridgeAvailable\}/,
    "El botón de bridge debe deshabilitarse cuando no hay bridge local disponible.");
});

test("SaleDetailModal: usa hasPosBridgePrint + printThermalTicketDirect y DIRECT_PRINT_UNAVAILABLE para el fallback", async () => {
  const src = await read(saleDetailModal);
  assert.match(src, /hasPosBridgePrint/,
    "El modal debe detectar la presencia del bridge con el helper centralizado.");
  assert.match(src, /printThermalTicketDirect/,
    "El botón bridge debe invocar printThermalTicketDirect, no printThermalTicket.");
  assert.match(src, /DIRECT_PRINT_UNAVAILABLE/,
    "Debe inspeccionar el sentinel DIRECT_PRINT_UNAVAILABLE para distinguir 'bridge ausente' de otros errores.");
  // El modal NO debe caer silenciosamente al navegador al fallar el bridge
  assert.match(src, /BRIDGE NO DISPONIBLE/,
    "Al rechazar el bridge, el modal debe mostrar un toast accionable (no abrir el diálogo).");
});
