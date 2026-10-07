import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const modal = join(here, "..", "src", "app", "(app)", "inventory", "receive", "components", "PackageIntakeModal.tsx");

// ============================================================================
// Guardianes estáticos del PackageIntakeModal.
//
// Fijan invariantes críticas del flujo "código solo en paquete":
//
//   - El modal muestra el nombre del producto resuelto antes de confirmar
//     (nunca debe pedir confirmar sin mostrar qué producto va a entrar).
//   - El cálculo "paquetes × unidades" se pinta grande para que el
//     cajero valide el total antes de confirmar.
//   - El modal POSTea a /inventory/package-barcode (idempotente) cuando
//     el checkbox "guardar alias" está activo.
//   - El checkbox se default-activa cuando el alias es NUEVO (initialUnitsPerPack === null).
//   - El modal JAMÁS escribe el package_code a products.alternateCodes.
//   - El modal maneja el 409 PACKAGE_CODE_BELONGS_TO_OTHER_PRODUCT.
// ============================================================================

async function leer() { return readFile(modal, "utf8"); }

test("PackageIntakeModal: muestra el nombre del producto resuelto antes de confirmar", async () => {
  const src = await leer();
  assert.ok(
    /product\.productName/.test(src),
    "El modal debe renderizar product.productName; el cajero no puede confirmar a ciegas.",
  );
});

test("PackageIntakeModal: calcula y pinta 'paquetes × unidades' en vista previa", async () => {
  const src = await leer();
  assert.ok(
    /totalUnits\s*=\s*unitsNum\s*\*\s*packagesNum/.test(src),
    "El modal debe calcular totalUnits = unitsNum × packagesNum.",
  );
  assert.ok(
    /totalUnits\.toLocaleString\(/.test(src) || /unidades/.test(src),
    "El modal debe renderizar el totalUnits visible al usuario.",
  );
});

test("PackageIntakeModal: POSTea a /inventory/package-barcode cuando saveAlias está activo", async () => {
  const src = await leer();
  assert.ok(
    src.includes("'/inventory/package-barcode'") || src.includes('"/inventory/package-barcode"'),
    "El modal debe POSTear a /inventory/package-barcode cuando saveAlias está activo.",
  );
});

test("PackageIntakeModal: checkbox 'guardar alias' default-activo en match=new", async () => {
  const src = await leer();
  // La inicialización: setSaveAlias(initialUnitsPerPack === null)
  assert.ok(
    /useState<boolean>\(\s*initialUnitsPerPack\s*===\s*null\s*\)/.test(src),
    "El checkbox saveAlias debe iniciar en TRUE cuando el alias es nuevo (initialUnitsPerPack === null).",
  );
});

test("PackageIntakeModal: NUNCA escribe el package_code a products.alternateCodes", async () => {
  const src = await leer();
  // Buscamos cualquier referencia a alternateCodes en el componente.
  // Si existe alguna, debe ser lectura — pero por simplicidad total,
  // prohibimos la mención.
  assert.ok(
    !src.includes("alternateCodes") && !src.includes("alternate_codes"),
    "PackageIntakeModal NO debe mencionar alternateCodes: eso crearía el riesgo de que el código del paquete termine siendo escaneable en caja.",
  );
});

test("PackageIntakeModal: maneja el 409 PACKAGE_CODE_BELONGS_TO_OTHER_PRODUCT con mensaje claro", async () => {
  const src = await leer();
  assert.ok(
    src.includes("PACKAGE_CODE_BELONGS_TO_OTHER_PRODUCT"),
    "El modal debe matchear el código 'PACKAGE_CODE_BELONGS_TO_OTHER_PRODUCT' para mostrar el mensaje humano del backend.",
  );
  // El toast de colisión debe ser destructivo y no debe cerrar el modal
  // sin que el usuario corrija el código.
  assert.ok(
    /variant:\s*['"]destructive['"]/.test(src),
    "El toast del 409 debe ser destructivo.",
  );
});

test("PackageIntakeModal: NUNCA toca IsPack del producto al confirmar", async () => {
  const src = await leer();
  // Marcar IsPack=true cambiaría la semántica de ventas (precio del pack).
  assert.ok(
    !/isPack:\s*true/.test(src) && !/IsPack:\s*true/.test(src),
    "El modal NUNCA debe modificar isPack del producto: la propiedad la decide el usuario desde el modal de productos.",
  );
});

test("PackageIntakeModal: footer sticky con safe-area-inset-bottom", async () => {
  const src = await leer();
  // Diseño mobile-first: el footer no puede tapar la barra inferior del navegador.
  assert.ok(
    src.includes("env(safe-area-inset-bottom)"),
    "El footer del modal debe usar env(safe-area-inset-bottom) para evitar tapar la barra inferior en móviles.",
  );
});

test("PackageIntakeModal: cantidades parseadas con Math.floor para prevenir decimales", async () => {
  const src = await leer();
  assert.ok(
    /Math\.floor\(Number\(unitsPerPack\)/.test(src) || /Math\.floor\(Number\(.*units/.test(src),
    "unitsPerPack debe parsearse con Math.floor: no tiene sentido 1.5 unidades por paquete.",
  );
});
