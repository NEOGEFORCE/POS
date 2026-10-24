import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const PAGE = new URL("../src/app/(app)/sales/new/page.tsx", import.meta.url);

async function source() {
  return readFile(PAGE, "utf8");
}

test("el teclado lateral separa operaciones, números y confirmación", async () => {
  const src = await source();
  assert.match(src, /aria-label="Operaciones rápidas"[^>]*grid grid-cols-4 gap-2 h-12/);
  assert.match(src, /aria-label="Teclado numérico de ventas"[^>]*grid grid-cols-3 grid-rows-4 gap-2/);
  assert.match(src, /className="w-full h-14 min-h-14[^\"]*"/);
});

test("el botón de confirmar ya no es una columna alta y angosta", async () => {
  const src = await source();
  assert.doesNotMatch(src, /col-span-3 grid grid-cols-3 gap-1/);
  assert.doesNotMatch(src, /col-span-1 h-full min-h-\[40px\][^\"]*text-2xl/);
});

test("la columna lateral tiene ancho táctil suficiente", async () => {
  const src = await source();
  assert.match(src, /lg:w-\[280px\] xl:w-\[300px\]/);
  assert.match(src, /min-h-\[44px\]/);
});

// ============================================================================
// Responsive móvil: el teclado se oculta por defecto y aparece con toggle.
// ============================================================================

test("el teclado tiene toggle de visibilidad en móvil (hidden/flex + lg:flex)", async () => {
  const src = await source();
  // El aside principal debe aceptar visibilidad condicional pero
  // mantenerse visible en escritorio (lg:flex).
  assert.match(src, /data-testid="sales-keypad-aside"/,
    "el aside del teclado debe exponer data-testid para los tests.");
  assert.match(src, /data-visible=\{isKeypadVisible \? 'true' : 'false'\}/,
    "el aside debe reflejar el estado de visibilidad en el DOM.");
  assert.match(src, /lg:flex\s+\$\{isKeypadVisible \? 'flex' : 'hidden'\}/,
    "el aside debe estar siempre visible en lg: y colapsarse condicionalmente en móvil.");
});

test("la preferencia del teclado se persiste en localStorage con clave 'pos_keypad_visible_mobile'", async () => {
  const src = await source();
  assert.match(src, /KEYPAD_PREFERENCE_KEY\s*=\s*'pos_keypad_visible_mobile'/,
    "la clave de localStorage debe ser 'pos_keypad_visible_mobile'.");
  assert.match(src, /localStorage\.getItem\(KEYPAD_PREFERENCE_KEY\)/,
    "la inicialización debe leer la preferencia de localStorage.");
  assert.match(src, /localStorage\.setItem\(KEYPAD_PREFERENCE_KEY,\s*next\s*\?\s*'true'\s*:\s*'false'\)/,
    "el toggle debe persistir la preferencia en localStorage.");
});

test("el toggle del teclado existe en la barra inferior sticky con aria-expanded", async () => {
  const src = await source();
  assert.match(src, /data-testid="sales-mobile-keypad-toggle"/,
    "debe existir un botón con data-testid='sales-mobile-keypad-toggle'.");
  assert.match(src, /aria-expanded=\{isKeypadVisible\}/,
    "el toggle debe exponer aria-expanded reactivo al estado.");
  assert.match(src, /aria-controls="sales-keypad-aside"/,
    "el toggle debe apuntar al aside controlado vía aria-controls.");
  assert.match(src, /aria-label="Mostrar teclado numérico"/,
    "el toggle debe tener aria-label legible por lectores de pantalla.");
});

test("la barra inferior sticky muestra total y COBRAR grande en móvil", async () => {
  const src = await source();
  assert.match(src, /data-testid="sales-mobile-action-bar"/,
    "debe existir la barra sticky con data-testid 'sales-mobile-action-bar'.");
  // Debe estar oculta en escritorio (lg:hidden) y fija al fondo.
  assert.match(src, /sales-mobile-action-bar[\s\S]{0,600}?lg:hidden/,
    "la barra sticky debe ocultarse en lg: (escritorio ve el teclado completo).");
  assert.match(src, /sales-mobile-action-bar[\s\S]{0,600}?fixed[\s\S]{0,120}?bottom-0/,
    "la barra sticky debe ser fixed bottom-0 para quedarse pegada al borde inferior.");
  // Debe tener el botón COBRAR con data-testid propio y mínimo táctil.
  assert.match(src, /data-testid="sales-mobile-pay-button"/,
    "el botón COBRAR móvil debe tener data-testid 'sales-mobile-pay-button'.");
  assert.match(src, /sales-mobile-pay-button[\s\S]{0,1200}?COBRAR/,
    "la barra sticky debe tener el texto COBRAR visible.");
});

test("la barra inferior sticky respeta safe-area del iPhone", async () => {
  const src = await source();
  assert.match(src, /sales-mobile-action-bar[\s\S]{0,600}?env\(safe-area-inset-bottom\)/,
    "la barra sticky móvil debe respetar env(safe-area-inset-bottom) para no quedar bajo el home indicator.");
});

test("categorías en móvil son carrusel horizontal (overflow-x-auto)", async () => {
  const src = await source();
  assert.match(src, /data-testid="sales-category-nav"/,
    "el nav de categorías debe tener data-testid 'sales-category-nav'.");
  // En móvil (<lg) debe ser una fila con overflow-x-auto.
  assert.match(src, /sales-category-nav[\s\S]{0,800}?flex lg:flex-col/,
    "las categorías deben ser row en móvil y columna en lg:.");
  assert.match(src, /sales-category-nav[\s\S]{0,800}?overflow-x-auto/,
    "las categorías en móvil deben desplazarse horizontalmente.");
});

test("las acciones secundarias viven en un menú '⋯' en móvil (sm:hidden trigger)", async () => {
  const src = await source();
  assert.match(src, /data-testid="sales-toolbar-more-menu"/,
    "debe existir un trigger de menú '⋯' con data-testid 'sales-toolbar-more-menu'.");
  // El trigger debe aparecer sólo en móvil (sm:hidden) y mantener los
  // botones Cliente/Dividir/Buscar inline en pantallas >= sm.
  assert.match(src, /sales-toolbar-more-menu[\s\S]{0,400}?sm:hidden/,
    "el menú '⋯' sólo debe aparecer en móvil (<sm).");
  assert.match(src, /aria-label="Seleccionar cliente \(Re Pág\)"[\s\S]{0,400}?hidden sm:inline-flex/,
    "el botón 'Cliente' debe estar oculto en móvil (reemplazado por el menú).");
});

test("ProductGrid respeta columnas responsive (2 móvil pequeño / 3 móvil grande)", async () => {
  const grid = await readFile(new URL("../src/app/(app)/sales/new/components/ProductGrid.tsx", import.meta.url), "utf8");
  assert.match(grid, /grid-cols-2 min-\[420px\]:grid-cols-3 sm:grid-cols-6/,
    "la grilla debe arrancar en 2 columnas (<420 px), subir a 3 (<640 px) y luego 6 (sm).");
  assert.match(grid, /data-testid="sales-product-grid-row"/,
    "cada fila virtual debe exponer data-testid 'sales-product-grid-row'.");
});

test("las tarjetas de producto crecen 100px en móvil para que el nombre a 2 líneas sea legible", async () => {
  const grid = await readFile(new URL("../src/app/(app)/sales/new/components/ProductGrid.tsx", import.meta.url), "utf8");
  assert.match(grid, /h-\[100px\] sm:h-\[90px\]/,
    "las tarjetas deben medir 100px en móvil y 90px en >= sm.");
  assert.match(grid, /text-\[11px\] sm:text-\[10px\] uppercase font-bold/,
    "el nombre debe ser 11px en móvil (legible) y 10px desde sm.");
});
