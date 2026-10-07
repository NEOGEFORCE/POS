import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guardianes app-wide del Switch compartido (`@/components/ui/switch`).
 *
 * Objetivo: después de la migración desde HeroUI debe existir **un único**
 * Switch en todo el frontend, con comportamiento accesible, estados visuales
 * (checked/unchecked/disabled/focus-visible) y respeto a `prefers-reduced-motion`.
 *
 * Estos tests son estáticos: leen el código fuente y verifican contratos sin
 * levantar un renderer de React. Son la red de seguridad que impide que:
 *   1. Alguien vuelva a importar `Switch` desde `@heroui/react`.
 *   2. Un consumidor active el Switch pero sin pasar por el componente compartido.
 *   3. El componente compartido pierda alguna de las piezas visuales/a11y
 *      (focus-visible, disabled, aria, dot de estado, perilla, glow, reduced-motion).
 *   4. Vuelva a aparecer el obsoleto `minimalistSwitchClass`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const srcRoot = join(repoRoot, "src");
const sharedSwitchPath = join(srcRoot, "components", "ui", "switch.tsx");

/**
 * Consumidores esperados del Switch compartido.
 *
 * Cualquier cambio aquí es intencional: si se añade un Switch nuevo en alguna
 * pantalla se agrega a esta lista; si se elimina uno hay que quitarlo. Así se
 * documenta en el repo la superficie real del control.
 */
const EXPECTED_CONSUMERS = [
  "src/app/(app)/labels/config/page.tsx",
  "src/app/(app)/products/components/ProductFormModal.tsx",
  "src/app/(app)/inventory/orders/page.tsx",
  "src/components/shared/UniversalPaymentModal.tsx",
];

/**
 * Archivos que previamente tenían un import muerto de `Switch` desde HeroUI.
 * Al limpiarlos conservan otros imports del paquete pero YA no deben traer
 * `Switch`. Si alguien vuelve a añadirlo, este test cae de inmediato.
 */
const CLEANED_FILES = [
  "src/app/(app)/inventory/receive/page.tsx",
  "src/app/(app)/expenses/components/ExpenseFormModal.tsx",
  "src/app/(app)/users/components/UserModals.tsx",
];

async function readSrc(relPath) {
  return readFile(join(repoRoot, relPath), "utf8");
}

async function walkSources(dir) {
  const out = [];
  for (const entry of await readdir(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "out" || entry === ".git") continue;
    const abs = join(dir, entry);
    const st = await stat(abs);
    if (st.isDirectory()) {
      out.push(...(await walkSources(abs)));
    } else if (/\.(tsx?|mjs|jsx?)$/.test(entry)) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Extrae los símbolos nombrados importados desde `@heroui/react` en un archivo.
 * Robusto a imports multi-línea con comentarios.
 */
function extractHeroImports(source) {
  const names = new Set();
  const re = /import\s*(?:type\s+)?\{([\s\S]+?)\}\s*from\s*['"]@heroui\/react['"]/g;
  for (const match of source.matchAll(re)) {
    const chunk = match[1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const raw of chunk.split(",")) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]
        .replace(/^type\s+/, "")
        .trim();
      if (name) names.add(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// 1. El componente compartido existe y expone el contrato esperado.
// ---------------------------------------------------------------------------

test("switch compartido vive en src/components/ui/switch.tsx y usa Radix", async () => {
  const src = await readFile(sharedSwitchPath, "utf8");
  assert.match(src, /@radix-ui\/react-switch/, "Debe apoyarse en @radix-ui/react-switch (ya instalado).");
  assert.match(src, /export\s*\{\s*Switch\s*\}/, "Debe exportar el componente Switch.");
  assert.match(src, /displayName\s*=\s*["']Switch["']/, "displayName debe ser 'Switch'.");
});

test("switch compartido acepta tanto el contrato Radix como el alias HeroUI", async () => {
  const src = await readFile(sharedSwitchPath, "utf8");
  // Contrato Radix canónico.
  for (const prop of ["checked", "defaultChecked", "onCheckedChange", "disabled"]) {
    assert.match(src, new RegExp(`\\b${prop}\\b`), `Falta soporte explícito del prop Radix "${prop}".`);
  }
  // Alias HeroUI que seguían usando los call-sites antes de migrar.
  for (const prop of ["isSelected", "defaultSelected", "onValueChange", "isDisabled"]) {
    assert.match(src, new RegExp(`\\b${prop}\\b`), `Falta soporte retrocompatible del prop HeroUI "${prop}".`);
  }
  // Tamaños y colores.
  for (const size of ["sm", "md", "lg"]) {
    assert.match(src, new RegExp(`["']${size}["']`), `Falta token de tamaño "${size}".`);
  }
  for (const color of ["success", "warning", "danger", "primary", "secondary", "default"]) {
    assert.match(src, new RegExp(`["']${color}["']`), `Falta token de color "${color}".`);
  }
});

test("switch compartido conserva piezas visuales de la referencia neon/3D", async () => {
  const src = await readFile(sharedSwitchPath, "utf8");
  // Track oscuro neumórfico.
  assert.match(src, /bg-\[#1a1c23\]/, "El track debe tener fondo oscuro neumórfico (#1a1c23).");
  assert.match(src, /border-\[#2f333e\]/, "El track debe tener borde oscuro visible.");
  // Sombra interior en estado off (pozo).
  assert.match(src, /data-\[state=unchecked\]:shadow-\[inset_3px_3px_6px/, "Falta la sombra interior del estado off.");
  // Glow externo al activarse (al menos uno de los colores debe presentar el patrón).
  assert.match(src, /data-\[state=checked\]:shadow-\[0_0_15px/, "Falta el glow externo cuando el switch está activo.");
  // Perilla 3D con gradiente y relieve.
  assert.match(src, /bg-gradient-to-br from-\[#2a2d35\] to-\[#1c1e24\]/, "Falta el gradiente de la perilla.");
  assert.match(src, /shadow-\[2px_2px_5px_rgba\(0,0,0,0\.7\)/, "Falta la sombra proyectada de la perilla.");
  // Dot de estado (rojo apagado / verde encendido en success).
  assert.match(src, /bg-rose-500/, "Falta el color del dot cuando el switch está apagado.");
  assert.match(src, /bg-emerald-400/, "Falta el color del dot encendido para la variante success.");
});

test("switch compartido es accesible: focus visible, disabled y reduced-motion", async () => {
  const src = await readFile(sharedSwitchPath, "utf8");
  assert.match(src, /focus-visible:ring-2/, "Debe pintar un aro de focus visible accesible.");
  assert.match(src, /focus-visible:ring-offset-2/, "El aro de focus debe tener offset para separarse del track.");
  assert.match(src, /disabled:cursor-not-allowed/, "Debe cambiar el cursor cuando está deshabilitado.");
  assert.match(src, /disabled:opacity-50/, "Debe atenuar la opacidad cuando está deshabilitado.");
  assert.match(src, /motion-reduce:transition-none/, "Debe honrar prefers-reduced-motion desactivando transiciones.");
  // El label clicable usa htmlFor para asociarse al root.
  assert.match(src, /htmlFor=\{id\}/, "El label clicable debe apuntar al id del root con htmlFor.");
});

// ---------------------------------------------------------------------------
// 2. Nadie importa `Switch` desde `@heroui/react`.
// ---------------------------------------------------------------------------

test("ningún archivo del frontend importa Switch desde @heroui/react", async () => {
  const files = await walkSources(srcRoot);
  const offenders = [];
  for (const file of files) {
    const src = await readFile(file, "utf8");
    const named = extractHeroImports(src);
    if (named.has("Switch")) offenders.push(file.replace(repoRoot + "\\", "").replace(repoRoot + "/", ""));
  }
  assert.deepEqual(
    offenders,
    [],
    `Estos archivos siguen trayendo Switch desde @heroui/react:\n  - ${offenders.join("\n  - ")}\n` +
      `Deben importar Switch desde "@/components/ui/switch".`,
  );
});

test("los imports previamente muertos de Switch quedan limpios en los 3 archivos conocidos", async () => {
  for (const relPath of CLEANED_FILES) {
    const src = await readSrc(relPath);
    const named = extractHeroImports(src);
    assert.ok(
      !named.has("Switch"),
      `${relPath} tiene de nuevo Switch dentro de los imports de @heroui/react. ` +
        "Si realmente lo necesita, debe venir de '@/components/ui/switch'.",
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Los consumidores esperados importan y usan el Switch compartido.
// ---------------------------------------------------------------------------

test("los consumidores esperados importan Switch desde '@/components/ui/switch'", async () => {
  for (const relPath of EXPECTED_CONSUMERS) {
    const src = await readSrc(relPath);
    assert.match(
      src,
      /import\s*\{\s*Switch\s*\}\s*from\s*["']@\/components\/ui\/switch["']/,
      `${relPath} debe importar el Switch compartido desde '@/components/ui/switch'.`,
    );
    assert.match(
      src,
      /<Switch[\s\S]*?(\/>|>[\s\S]*?<\/Switch>)/,
      `${relPath} importa Switch compartido pero no lo usa en JSX. ¿Quedó un import huérfano?`,
    );
  }
});

test("conteo exacto de usos del Switch por consumidor (impide regresiones silenciosas)", async () => {
  const expectedUsageCounts = new Map([
    ["src/app/(app)/labels/config/page.tsx", 10],
    ["src/app/(app)/products/components/ProductFormModal.tsx", 2],
    ["src/app/(app)/inventory/orders/page.tsx", 1],
    ["src/components/shared/UniversalPaymentModal.tsx", 1],
  ]);

  for (const [relPath, expected] of expectedUsageCounts) {
    const src = await readSrc(relPath);
    const matches = src.match(/<Switch[\s>]/g) ?? [];
    assert.equal(
      matches.length,
      expected,
      `${relPath}: se esperaban ${expected} <Switch /> pero se encontraron ${matches.length}. ` +
        "Si agregaste o quitaste switches, actualiza este test.",
    );
  }
});

// ---------------------------------------------------------------------------
// 4. No queda rastro del helper obsoleto `minimalistSwitchClass`.
// ---------------------------------------------------------------------------

test("no debe sobrevivir ningún `minimalistSwitchClass` en el frontend", async () => {
  const files = await walkSources(srcRoot);
  const offenders = [];
  for (const file of files) {
    const src = await readFile(file, "utf8");
    if (src.includes("minimalistSwitchClass")) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `Estos archivos aún referencian el obsoleto minimalistSwitchClass:\n  - ${offenders.join("\n  - ")}`,
  );
});

// ---------------------------------------------------------------------------
// 5. Los props que efectivamente pasan los consumidores se conservan intactos
// (preserva lógica/estado/callbacks sin tocar la ruta de datos).
// ---------------------------------------------------------------------------

test("UniversalPaymentModal: el Switch de impresión automática mantiene su callback y color", async () => {
  const src = await readSrc("src/components/shared/UniversalPaymentModal.tsx");
  assert.match(src, /isSelected=\{autoPrint\}/, "El switch de autoPrint debe seguir ligado al estado `autoPrint`.");
  assert.match(src, /color="success"/, "El switch de autoPrint debe conservar el color success.");
  assert.match(src, /aria-label="Impresión automática del ticket"/, "El switch de autoPrint debe tener nombre accesible explícito.");
  assert.match(src, /setAutoPrint\(val\);[\s\S]*?persistAutoPrint\(val\);/, "El callback debe setear estado y persistir.");
});

test("inventory/orders: el Switch 'Ver todo el catálogo' mantiene color warning y toggleIncludeAll", async () => {
  const src = await readSrc("src/app/(app)/inventory/orders/page.tsx");
  assert.match(src, /color="warning"/, "El switch de includeAll debe conservar el color warning.");
  assert.match(src, /isSelected=\{includeAll\}/, "Debe seguir ligado al estado `includeAll`.");
  assert.match(src, /onValueChange=\{toggleIncludeAll\}/, "Debe seguir llamando a toggleIncludeAll.");
});

test("ProductFormModal: los switches de Pesable y Pack preservan sus setters", async () => {
  const src = await readSrc("src/app/(app)/products/components/ProductFormModal.tsx");
  assert.match(src, /isSelected=\{isProductWeighted\(/, "Debe seguir usando isProductWeighted() como fuente del estado.");
  assert.match(src, /isSelected=\{isPack\}/, "Debe mantener el estado `isPack`.");
  // El `minimalistSwitchClass` queda enterrado — se verifica en el test anterior.
});

test("labels/config: los switches de recibo/etiquetas siguen controlando las claves correctas del store", async () => {
  const src = await readSrc("src/app/(app)/labels/config/page.tsx");
  const keys = [
    "config.drawer.enabled",
    "config.receipt.content.showLogo",
    "config.receipt.content.showTaxes",
    "config.receipt.content.showValidationQR",
    "config.labels.productName.visible",
    "config.labels.price.visible",
    "config.labels.price.emphasized",
    "config.labels.extras.showDate",
    "config.labels.extras.showInternalCode",
    "config.labels.extras.showCategory",
  ];
  for (const key of keys) {
    assert.ok(
      src.includes(`isSelected={${key}}`),
      `El switch que controla ${key} no está presente o cambió su prop. ` +
        "Mantén la vinculación isSelected={...} para preservar la lógica del store.",
    );
  }
});
