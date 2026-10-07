import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const page = join(here, "..", "src", "app", "(app)", "inventory", "receive", "page.tsx");

// ============================================================================
// Guardianes estáticos del flujo "código solo en paquete" en receive/page.tsx.
//
//   - handleCodeSubmit llama a /inventory/package-barcode/resolve ANTES
//     de proceder con el matching local.
//   - Si el resolver responde match=exact|new (con un producto resuelto)
//     se abre PackageIntakeModal; nunca se agrega directo al carrito
//     con cantidad = 1.
//   - Si match=unknown cae al NotFoundDialog existente.
//   - El fallback offline conserva la UX previa.
//   - En el onConfirm del modal, el carrito recibe addedQuantity =
//     unidades × paquetes (no 1).
// ============================================================================

async function leer() { return readFile(page, "utf8"); }

test("receive/page: handleCodeSubmit llama a /inventory/package-barcode/resolve antes de agregar", async () => {
  const src = await leer();
  assert.ok(
    src.includes("/inventory/package-barcode/resolve"),
    "handleCodeSubmit debe consultar primero el resolver del backend; sin esto, un código de paquete entraría al carrito como 1 unidad.",
  );
  // El fetch del resolver debe estar DENTRO de handleCodeSubmit (no en otro handler).
  const match = /const\s+handleCodeSubmit\s*=\s*useCallback\s*\(\s*async[\s\S]*?\n\s{4}\},\s*\[/m.exec(src);
  assert.ok(match, "handleCodeSubmit debe ser async y envolver el fetch del resolver.");
  assert.ok(
    match[0].includes("/inventory/package-barcode/resolve"),
    "El fetch del resolver debe estar DENTRO del cuerpo de handleCodeSubmit.",
  );
});

test("receive/page: abre PackageIntakeModal cuando resolver devuelve match=exact|new", async () => {
  const src = await leer();
  assert.ok(
    /resolved\?\.match\s*===\s*['"]exact['"]/.test(src),
    "handleCodeSubmit debe reaccionar al match='exact'.",
  );
  assert.ok(
    /resolved\?\.match\s*===\s*['"]new['"]/.test(src),
    "handleCodeSubmit debe reaccionar al match='new'.",
  );
  // Abrir el modal (setPackageIntakeState con open:true)
  assert.ok(
    /setPackageIntakeState\(\s*\{[\s\S]*?open:\s*true/.test(src),
    "handleCodeSubmit debe abrir PackageIntakeModal al detectar un paquete.",
  );
});

test("receive/page: cae al NotFoundDialog cuando el resolver devuelve match=unknown", async () => {
  const src = await leer();
  assert.ok(
    src.includes("setScannedNotFoundCode") && src.includes("setNotFoundDialogOpen(true)"),
    "handleCodeSubmit debe caer al NotFoundDialog cuando el resolver no reconoce el código.",
  );
});

test("receive/page: onConfirm del modal usa addToReceive con cantidad = unidades × paquetes", async () => {
  const src = await leer();
  // addToReceive(target, totalUnits) — el segundo argumento es la cantidad.
  assert.ok(
    /addToReceive\(\s*target\s+as\s+any,\s*totalUnits\s*\)/.test(src) ||
    /addToReceive\(\s*target,\s*totalUnits\s*\)/.test(src),
    "onConfirm debe pasar totalUnits a addToReceive para que el stock entre como packs × units.",
  );
});

test("receive/page: NUNCA mezcla el package_code en products.alternateCodes", async () => {
  const src = await leer();
  // El page no debe tener código del tipo:
  //   setNewProduct(prev => ({ ...prev, alternateCodes: packageIntakeState.code ... }))
  // ni llamar a /products/update-products con alternateCodes construido desde packageIntakeState.
  assert.ok(
    !/packageIntakeState\.code[\s\S]*?alternateCodes/.test(src),
    "El page NUNCA debe empujar el package_code hacia products.alternateCodes: eso rompería la semántica (una unidad se vendería como paquete).",
  );
});

test("receive/page: resolver tiene fallback offline que preserva la UX previa", async () => {
  const src = await leer();
  // El bloque catch del fetch debe caer al matching local y addToReceive.
  assert.ok(
    /catch\s*\(\s*err\s*\)\s*\{[\s\S]*?localProduct[\s\S]*?addToReceive/.test(src),
    "El catch del resolver debe caer a addToReceive(localProduct) para no bloquear la recepción si el backend está caído.",
  );
});

test("receive/page: código que coincide EXACTO con product.barcode agrega 1 unidad (no abre modal)", async () => {
  const src = await leer();
  // La guardia:
  //   if ((resolved.product.barcode || '').toUpperCase() === finalCode) {
  //       addToReceive(resolved.product); return;
  //   }
  // Evita que un escaneo normal del barcode principal abra el modal pidiendo units_per_pack.
  assert.ok(
    /resolved\.product\.barcode[\s\S]*?toUpperCase\(\)\s*===\s*finalCode/.test(src),
    "Un escaneo del barcode principal del producto NO debe abrir el modal: se agrega 1 unidad.",
  );
});
