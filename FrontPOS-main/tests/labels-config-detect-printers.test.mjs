// =============================================================================
// tests/labels-config-detect-printers.test.mjs
//
// Guardian estatico de la nueva seccion "Impresoras detectadas" en
// /labels/config (sprint 2026-10). Verifica que:
//
//   1. El `PerfilTab` monta `<DetectedPrintersSection>` como seccion
//      independiente — no reemplaza al Input manual de printerName ni a
//      la lista de perfiles DB016 (requisito 2 del contrato).
//   2. El componente usa la acción `listPrinters` del bridge local (metodo
//      del contrato PosBridge, no un fetch HTTP).
//   3. Expone chip de estado del bridge, boton "Detectar", boton
//      "Actualizar", lista con name/driver/port y datos derivados
//      (status/online/default).
//   4. Click en una fila setea `connection.system.printerName` (preserva
//      la entrada manual + perfiles DB016 arriba).
//   5. Si la interfaz no es SYSTEM, muestra la advertencia explicativa
//      pero igualmente permite seleccionar (para que el admin pueda
//      cambiar la interfaz despues).
//   6. Los testids canonicos existen y permiten que los pipelines de QA
//      enganchen la UI sin importar HeroUI.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const page = join(here, "..", "src", "app", "(app)", "labels", "config", "page.tsx");

async function leer() { return readFile(page, "utf8"); }

// ----------------------------------------------------------------------------
// 1. PerfilTab monta la nueva seccion
// ----------------------------------------------------------------------------

test("PerfilTab monta <DetectedPrintersSection> dentro de la rama de Conexion", async () => {
  const src = await leer();
  assert.match(
    src,
    /<DetectedPrintersSection[\s\S]*?iface=\{iface\}/,
    "PerfilTab debe pasar `iface` a <DetectedPrintersSection> para que el componente avise cuando la interfaz no sea SYSTEM.",
  );
  assert.match(
    src,
    /<DetectedPrintersSection[\s\S]*?onPickPrinter=\{/,
    "PerfilTab debe pasar un handler `onPickPrinter` para capturar el click en una fila de la lista detectada.",
  );
});

test("PerfilTab conserva el Input manual de printerName y la lista de perfiles DB016", async () => {
  const src = await leer();
  // El Input de printerName sigue existiendo (requisito 2: preservar entrada manual).
  assert.match(
    src,
    /label="Nombre de la impresora en el SO"/,
    "Debe conservarse el Input manual del printerName — la deteccion es ADITIVA, no sustitutiva.",
  );
  // La seccion de perfiles DB016 sigue existiendo.
  assert.match(
    src,
    /Perfiles existentes en el servidor/,
    "La seccion de perfiles existentes (/labels/printers) debe seguir viva junto a la deteccion.",
  );
});

// ----------------------------------------------------------------------------
// 2. DetectedPrintersSection usa la accion WebSocket tipada listPrinters
// ----------------------------------------------------------------------------

test("DetectedPrintersSection llama window.posBridge.listPrinters (no fetch HTTP)", async () => {
  const src = await leer();
  // La definicion del componente debe invocar listPrinters del bridge.
  assert.match(
    src,
    /w\.posBridge\.listPrinters\(\{\s*refresh:/,
    "El componente debe llamar a `listPrinters({refresh:boolean})` del bridge — no un fetch HTTP ni un POST.",
  );
  assert.match(
    src,
    /parseDetectedPrintersResult\(/,
    "La respuesta del bridge debe pasar por `parseDetectedPrintersResult` para tipar el shape.",
  );
});

test("DetectedPrintersSection honra hasPosBridgePrint + hasPosBridgeListPrinters", async () => {
  const src = await leer();
  assert.match(
    src,
    /hasPosBridgePrint\(\)/,
    "Debe honrar hasPosBridgePrint() para pintar el chip 'bridge detectado'.",
  );
  assert.match(
    src,
    /hasPosBridgeListPrinters\(\)/,
    "Debe honrar hasPosBridgeListPrinters() para habilitar los botones de deteccion.",
  );
  assert.match(
    src,
    /subscribePosBridgeStatus\(/,
    "Debe suscribirse a subscribePosBridgeStatus para que el chip reaccione al drop del WS.",
  );
});

// ----------------------------------------------------------------------------
// 3. UI: chip de estado + botones + lista con name/driver/port + badges
// ----------------------------------------------------------------------------

test("DetectedPrintersSection expone chip de estado del bridge", async () => {
  const src = await leer();
  assert.match(
    src,
    /data-testid="labels-config-detect-printers-bridge-chip"/,
    "El chip de estado del bridge debe tener testid canonico para QA.",
  );
});

test("DetectedPrintersSection expone boton 'Detectar impresoras' y 'Actualizar'", async () => {
  const src = await leer();
  assert.match(
    src,
    /data-testid="labels-config-detect-printers-btn"/,
    "Falta el testid del boton 'Detectar impresoras'.",
  );
  assert.match(
    src,
    /data-testid="labels-config-detect-printers-refresh-btn"/,
    "Falta el testid del boton 'Actualizar' (forza refresh=true).",
  );
  // El boton de refresh pasa refresh=true al bridge:
  assert.match(
    src,
    /requestList\(true\)/,
    "El boton 'Actualizar' debe forzar refresh=true (ignora cache del bridge).",
  );
});

test("DetectedPrintersSection renderiza name/driver/port y badges status/online/default", async () => {
  const src = await leer();
  assert.match(
    src,
    /data-testid="labels-config-detect-printers-list"/,
    "La lista detectada debe tener testid canonico para QA.",
  );
  // Cada fila debe exponer sus atributos de datos para que QA/aria-expresivos los lean.
  assert.match(
    src,
    /data-printer-status=/,
    "Cada fila debe exponer data-printer-status (requisito 1: status/online/default).",
  );
  assert.match(
    src,
    /data-printer-default=/,
    "Cada fila debe exponer data-printer-default.",
  );
  assert.match(
    src,
    /data-printer-online=/,
    "Cada fila debe exponer data-printer-online.",
  );
  assert.match(
    src,
    /p\.driver\s*\|\|\s*"driver desconocido"/,
    "Debe pintarse el driver como string opaco.",
  );
  assert.match(
    src,
    /p\.port\s*\|\|\s*"puerto desconocido"/,
    "Debe pintarse el port como string opaco.",
  );
});

// ----------------------------------------------------------------------------
// 4. Click en una fila setea connection.system.printerName
// ----------------------------------------------------------------------------

test("DetectedPrintersSection onPickPrinter setea connection.system.printerName", async () => {
  const src = await leer();
  // El wiring en PerfilTab debe guardar el nombre en system.printerName:
  assert.match(
    src,
    /onPickPrinter=\{\(name\)\s*=>\s*\{[\s\S]*?d\.connection\.system\.printerName\s*=\s*name/,
    "El click en una fila debe actualizar `connection.system.printerName` (preserva la entrada manual).",
  );
});

// ----------------------------------------------------------------------------
// 5. Advertencia cuando iface !== SYSTEM
// ----------------------------------------------------------------------------

test("DetectedPrintersSection muestra aviso cuando la interfaz no es SYSTEM", async () => {
  const src = await leer();
  assert.match(
    src,
    /iface\s*!==\s*INTERFACES\.SYSTEM/,
    "Debe existir un render condicional sensible al cambio de interfaz.",
  );
  // El copy del aviso debe sugerir cambiar la interfaz o usar NETWORK/TCP.
  assert.match(
    src,
    /cambia la interfaz a[\s\S]*?Sistema operativo[\s\S]*?\(spooler\)/i,
    "El aviso debe sugerir cambiar la interfaz a SYSTEM; no sustituir la seleccion silenciosamente.",
  );
});

// ----------------------------------------------------------------------------
// 6. Testids canonicos presentes para QA
// ----------------------------------------------------------------------------

test("DetectedPrintersSection expone todos los testids canonicos", async () => {
  const src = await leer();
  const expected = [
    "labels-config-detect-printers-section",
    "labels-config-detect-printers-bridge-chip",
    "labels-config-detect-printers-btn",
    "labels-config-detect-printers-refresh-btn",
    "labels-config-detect-printers-list",
    "labels-config-detect-printers-row",
    "labels-config-detect-printers-row-pick",
    "labels-config-detect-printers-empty",
  ];
  for (const id of expected) {
    assert.match(
      src,
      new RegExp(`data-testid="${id}"`),
      `Falta el data-testid canonico '${id}' en /labels/config.`,
    );
  }
});
