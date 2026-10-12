// =============================================================================
// tests/drawer-visible-strings-hidden.test.mjs
//
// Guardianes de la etapa "ocultar-cajon-frontpos": tras remover los controles
// visibles del cajón de /labels/config y de LabelsWorkspace, ninguna cadena
// VISIBLE (texto JSX, títulos de toast, aria-labels, descripciones) de los
// tres archivos del alcance puede contener /caj[oó]n/i.
//
// Qué se preserva (fuera del alcance de este test):
//   - La rama typed JSON `drawer` dentro de PrintingConfig.
//   - `buildBridgeConfigPayload` + `kickDrawer` del pos-bridge.
//   - El dispatcher interno `dispatchDrawerKickOnSale` del
//     UniversalPaymentModal, cuyos fallos ahora son silenciosos y no
//     interrumpen la venta.
//   - Comentarios internos. El guardián los descarta antes de comparar.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const TARGETS = [
  "src/app/(app)/labels/config/page.tsx",
  "src/app/(app)/labels/components/LabelsWorkspace.tsx",
  "src/components/shared/UniversalPaymentModal.tsx",
];

/**
 * Devuelve el código "visible": elimina comentarios `/* ... *\/` de bloque y
 * `// ...` de línea. No intenta parsear strings — el objetivo es garantizar
 * que ni los literales de texto ni las descripciones accesibles usen la
 * palabra "cajón".
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

async function readTarget(rel) {
  return readFile(join(repoRoot, rel), "utf8");
}

for (const target of TARGETS) {
  test(`${target}: ninguna cadena visible menciona al cajón`, async () => {
    const raw = await readTarget(target);
    const visible = stripComments(raw);
    const match = visible.match(/caj[oó]n/i);
    if (match) {
      // Emitimos un extracto del contexto donde se detectó para facilitar
      // la limpieza futura si alguien reintroduce el término.
      const index = visible.indexOf(match[0]);
      const start = Math.max(0, index - 80);
      const end = Math.min(visible.length, index + match[0].length + 80);
      const snippet = visible.slice(start, end).replace(/\s+/g, " ").trim();
      assert.fail(
        `${target} contiene una referencia visible a 'cajón' tras quitar comentarios. ` +
          `Contexto: "…${snippet}…". ` +
          "Esperamos que toda mención visible esté retirada tras ocultar el flujo del cajón.",
      );
    }
  });
}

test("labels/config: tampoco contiene testDrawer / drawerBusy en la UI retirada", async () => {
  const raw = await readTarget(TARGETS[0]);
  const visible = stripComments(raw);
  for (const dead of ["testDrawer", "drawerBusy"]) {
    assert.ok(!visible.includes(dead),
      `labels/config conserva la referencia muerta "${dead}" tras ocultar el cajón.`);
  }
});

test("LabelsWorkspace: tampoco contiene handleOpenDrawer en la UI retirada", async () => {
  const raw = await readTarget(TARGETS[1]);
  const visible = stripComments(raw);
  assert.ok(!visible.includes("handleOpenDrawer"),
    "LabelsWorkspace conserva la referencia muerta 'handleOpenDrawer' tras ocultar el cajón.");
});

test("UniversalPaymentModal: dispatchDrawerKickOnSale sigue existiendo (contrato interno)", async () => {
  // Preservamos el flujo interno automático porque config legacy
  // (`drawer.openDrawerOnSale=true`) puede todavía disparar el kick.
  // Su fallos deben ser silenciosos — eso se garantiza con otros tests
  // (`drawer-on-sale-complete.test.mjs`).
  const raw = await readTarget(TARGETS[2]);
  assert.ok(raw.includes("const dispatchDrawerKickOnSale"),
    "El dispatcher interno dispatchDrawerKickOnSale debe seguir presente para config legacy.");
  // Y el helper debe seguir dependiendo de la configuración persistida.
  assert.ok(raw.includes("loadPrintingConfig"),
    "El modal debe seguir usando loadPrintingConfig para resolver la rama drawer.");
});
