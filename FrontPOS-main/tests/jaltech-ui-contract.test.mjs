// =============================================================================
// tests/jaltech-ui-contract.test.mjs
//
// Guardianes estáticos para la integración Jaltech JAL-838L en la UI:
//
//   - `/labels/config` ofrece los dos botones de preset (Ethernet / USB-Windows)
//     y usa el helper puro `applyJaltechJAL838LPreset`.
//   - `/labels/config` expone el input `printableWidthMm` y lo clampa contra
//     el ancho físico.
//   - El chip "bridge detectado / sin bridge" se suscribe a los eventos de
//     conectividad (no es un snapshot muerto al montar).
//   - `/labels` enriquece ÚNICAMENTE el payload del bridge con el detalle
//     por item (`labelItems` con productName/salePrice). El payload de
//     auditoría enviado a `/labels/print-jobs` sigue siendo
//     `{ code, quantity }` por item (contrato con el backend).
//   - La apertura del cajón incluye `connection` y `drawer` en el bridge.
//
// Mantienen vivo lo que importa en /labels: hoja góndola Letter sigue
// completamente separada (sólo tocamos el handler térmico).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const configPage = join(here, "..", "src", "app", "(app)", "labels", "config", "page.tsx");
const workspace = join(here, "..", "src", "app", "(app)", "labels", "components", "LabelsWorkspace.tsx");
const thermalTicket = join(here, "..", "src", "lib", "thermal-ticket.ts");

async function read(path) { return readFile(path, "utf8"); }

// ============================================================================
// /labels/config
// ============================================================================

test("labels/config: importa y usa applyJaltechJAL838LPreset del helper puro", async () => {
  const src = await read(configPage);
  assert.match(src, /applyJaltechJAL838LPreset/,
    "El page debe importar applyJaltechJAL838LPreset del lib canónico.");
  assert.match(src, /JALTECH_JAL_838L_SPEC/,
    "El page debe referenciar la spec para pintar los datos conocidos.");
  assert.match(src, /JAL_838L_CONNECTION_MODES/,
    "El page debe usar las constantes de modo (NETWORK|SYSTEM), no strings sueltos.");
});

test("labels/config: expone los DOS botones de preset Jaltech (Ethernet y USB/Windows)", async () => {
  const src = await read(configPage);
  // Botón Ethernet
  assert.match(src, /data-testid="labels-config-preset-jal838l-ethernet"/,
    "Debe existir un botón con test-id para la variante Ethernet.");
  assert.match(src, /Jaltech \u00b7 Ethernet/,
    "El botón Ethernet debe mostrar 'Jaltech · Ethernet' con su etiqueta visible.");
  // Botón USB / Windows
  assert.match(src, /data-testid="labels-config-preset-jal838l-windows"/,
    "Debe existir un botón con test-id para la variante USB/Windows.");
  assert.match(src, /Jaltech \u00b7 USB \/ Windows/,
    "El botón USB debe mostrar 'Jaltech · USB / Windows'.");
});

test("labels/config: cada botón del preset dispara applyJaltechJAL838LPreset con su modo", async () => {
  const src = await read(configPage);
  // Ethernet → NETWORK
  assert.match(
    src,
    /applyJaltechJAL838LPreset\(d, \{\s*mode:\s*JAL_838L_CONNECTION_MODES\.NETWORK[\s\S]*?\}\)/,
    "El botón Ethernet debe pasar mode: JAL_838L_CONNECTION_MODES.NETWORK.",
  );
  // Windows → SYSTEM
  assert.match(
    src,
    /applyJaltechJAL838LPreset\(d, \{\s*mode:\s*JAL_838L_CONNECTION_MODES\.SYSTEM[\s\S]*?\}\)/,
    "El botón USB/Windows debe pasar mode: JAL_838L_CONNECTION_MODES.SYSTEM.",
  );
});

test("labels/config: el Select de 'Ancho del rollo' expone la opción JAL_838L", async () => {
  const src = await read(configPage);
  assert.match(src, /<SelectItem key=\{PAPER_PRESETS\.JAL_838L\}>Jaltech JAL-838L/,
    "El Select debe listar la opción Jaltech JAL-838L visible al usuario.");
});

test("labels/config: expone un input editable para printableWidthMm clampeado al físico", async () => {
  const src = await read(configPage);
  assert.match(src, /Ancho imprimible/,
    "Debe existir el label 'Ancho imprimible' en la UI.");
  assert.match(src, /receipt\.printableWidthMm/,
    "El input debe estar atado a receipt.printableWidthMm del state.");
  // El input debe clampar contra widthMm físico — no contra BOUNDS máximo
  // absoluto. Buscamos el patrón de clamp cuyo max es d.receipt.widthMm.
  assert.match(
    src,
    /d\.receipt\.printableWidthMm = clampForInput\(\s*v,[\s\S]*?BOUNDS\.printableWidthMm\.min,[\s\S]*?d\.receipt\.widthMm,?\s*\)/,
    "El onValueChange del input debe clampar a d.receipt.widthMm (nunca excede el físico).",
  );
});

test("labels/config: muestra una sección 'Datos pendientes de configurar' cuando el preset está activo", async () => {
  const src = await read(configPage);
  assert.match(src, /Datos pendientes de configurar/,
    "La UI debe comunicar qué campos faltan por configurar manualmente (host/printerName).");
  // Y marca explícitamente las variantes como pendientes:
  assert.match(src, /sin configurar/,
    "Los campos vacíos deben pintarse como 'sin configurar' en lugar de inventar un IP.");
});

test("labels/config: el chip de bridge es reactivo (se suscribe a subscribePosBridgeStatus)", async () => {
  const src = await read(configPage);
  assert.match(src, /subscribePosBridgeStatus/,
    "El page debe importar y usar subscribePosBridgeStatus para reactividad.");
  // Y debe desuscribirse al desmontar (patrón useEffect → return unsubscribe).
  const idx = src.indexOf("subscribePosBridgeStatus(");
  assert.ok(idx > 0);
  const scope = src.slice(idx, idx + 500);
  assert.match(scope, /return \(\) => unsubscribe\(\)/,
    "La suscripción debe limpiarse al desmontar el componente.");
});

test("labels/config: no sobreescribe el chip 'sin bridge' cuando el admin elige deliveryMode='bridge'", async () => {
  // Guardián de regresión: el aviso cuando el admin eligió bridge pero no
  // hay bridge detectado debe seguir presente (requerido por el sprint R2).
  const src = await read(configPage);
  assert.match(src, /sin bridge — usará diálogo|sin bridge/,
    "Debe conservar la etiqueta 'sin bridge' en el chip reactivo.");
  assert.match(
    src,
    /window\.posBridge\.print/,
    "Debe conservar el aviso de que el admin eligió bridge sin bridge instalado.",
  );
});

test("labels/config: no renombra ni elimina las pestañas Perfil/Recibo/Etiquetas (BC)", async () => {
  const src = await read(configPage);
  for (const key of ["perfil", "recibo", "etiquetas"]) {
    assert.ok(src.includes(`key="${key}"`),
      `La pestaña ${key} debe seguir existiendo (contrato de UI existente).`);
  }
});

// ============================================================================
// LabelsWorkspace (compartido entre /labels y /labels/shelf)
// ============================================================================

test("workspace: enriquece el payload del bridge con labelItems (code+quantity+productName+salePrice)", async () => {
  const src = await read(workspace);
  // `labelItems` sólo existe en el payload del bridge, no en el de /labels/print-jobs.
  assert.match(src, /const labelItems = queue\.map\(\(q\) => \(/,
    "handlePrint debe armar labelItems a partir del queue local.");
  assert.match(src, /productName:/,
    "Cada labelItem debe llevar productName derivado del queue.");
  assert.match(src, /salePrice:\s*typeof q\.product\?\.salePrice === "number"/,
    "Cada labelItem debe llevar salePrice numérico (con fallback a q.code.salePrice).");
  assert.match(src, /labelItems,?\s*\}/,
    "El bridgePayload debe terminar incluyendo labelItems.");
});

test("workspace: el payload de auditoría a /labels/print-jobs sigue siendo { code, quantity }", async () => {
  const src = await read(workspace);
  // La auditoría se construye en `payload`, antes del bridge.
  const payloadIdx = src.indexOf("const payload = {");
  assert.ok(payloadIdx > 0);
  const payloadScope = src.slice(payloadIdx, payloadIdx + 1200);
  // El items del payload de auditoría NO debe incluir productName/salePrice.
  assert.match(
    payloadScope,
    /items: queue\.map\(\(q\) => \(\{ code: q\.code\.code, quantity: q\.quantity \}\)\)/,
    "El payload auditado debe seguir siendo { code, quantity } por item (contrato con el backend).",
  );
  // Y confirmamos que es ESE objeto el que llega a /labels/print-jobs (no el enriquecido).
  const postIdx = src.indexOf('await apiFetch("/labels/print-jobs"');
  assert.ok(postIdx > payloadIdx, "El POST a /labels/print-jobs debe hacerse después del armado del payload.");
  const postScope = src.slice(postIdx, postIdx + 500);
  assert.match(postScope, /body: JSON\.stringify\(payload\)/,
    "El POST a /labels/print-jobs debe enviar `payload`, NO `bridgePayload`.");
});

test("workspace: el bridgePayload incluye connection + labels + labelItems (los tres) y SOLO va al bridge", async () => {
  const src = await read(workspace);
  const idx = src.indexOf("const bridgePayload = {");
  assert.ok(idx > 0, "Debe existir bridgePayload = { ... }.");
  const scope = src.slice(idx, idx + 800);
  assert.match(scope, /\.\.\.payload/, "El bridgePayload debe partir del payload auditado.");
  assert.match(scope, /connection:\s*printingConfig\.connection/,
    "El bridgePayload debe incluir printingConfig.connection.");
  assert.match(scope, /labels:\s*printingConfig\.labels/,
    "El bridgePayload debe incluir printingConfig.labels.");
  assert.match(scope, /labelItems/,
    "El bridgePayload debe incluir labelItems (detalle por item con productName+salePrice).");
});

test("workspace: ya no expone handleOpenDrawer ni la apertura manual del cajón", async () => {
  const src = await read(workspace);
  assert.ok(!src.includes("handleOpenDrawer"),
    "handleOpenDrawer debe estar completamente eliminado del workspace.");
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.ok(!/Abrir cajón/.test(codeOnly),
    "El botón visible 'Abrir cajón' debe estar fuera de la UI.");
  assert.ok(!/caj[oó]n/i.test(codeOnly),
    "Ninguna cadena visible del workspace puede mencionar al cajón.");
});

test("workspace: la hoja góndola Carta/Oficio sigue 100% separada — handlePrintShelfSheetSheet NO toca labelItems", async () => {
  const src = await read(workspace);
  const idx = src.indexOf("const handlePrintShelfSheetSheet = useCallback");
  assert.ok(idx > 0, "handlePrintShelfSheetSheet debe seguir vivo (rama LETTER/LEGAL).");
  const endIdx = src.indexOf("const handlePrintShelfSheetThermal = useCallback", idx);
  const scope = src.slice(idx, endIdx > 0 ? endIdx : idx + 10000);
  // Góndola NO introduce labelItems (es un helper separado con su propio shape).
  assert.ok(!/labelItems/.test(scope),
    "La hoja góndola Carta/Oficio NO debe compartir el shape labelItems del térmico.");
  // Góndola sigue usando el iframe aislado + buildShelfLabelsPrintHtml.
  assert.match(scope, /buildShelfLabelsPrintHtml/,
    "La hoja góndola Carta/Oficio debe seguir usando buildShelfLabelsPrintHtml (iframe aislado).");
  // Y conservando el audit meta con layout canónico.
  assert.match(scope, /buildAuditMeta/,
    "La hoja góndola Carta/Oficio debe seguir pasando buildAuditMeta al POST.");
});

// ============================================================================
// thermal-ticket.ts: payload del bridge incluye printableWidthMm
// ============================================================================

test("thermal-ticket.ts: ThermalBridgePayload declara printableWidthMm en su interfaz", async () => {
  const src = await read(thermalTicket);
  assert.match(src, /readonly printableWidthMm:\s*number;/,
    "La interface ThermalBridgePayload debe declarar printableWidthMm.");
});

test("thermal-ticket.ts: printThermalTicketDirect calcula printableWidthMm con clamp a widthMm", async () => {
  const src = await read(thermalTicket);
  const fnStart = src.indexOf("export async function printThermalTicketDirect");
  assert.ok(fnStart > 0);
  const nextExport = src.indexOf("\n// =====", fnStart + 50);
  const scope = src.slice(fnStart, nextExport > 0 ? nextExport : fnStart + 4000);

  // Clamp inline: nunca excede pageWidthMm.
  assert.match(scope, /sanitized\.receipt\.printableWidthMm/,
    "El helper directo debe leer sanitized.receipt.printableWidthMm.");
  assert.match(scope, /sanitized\.receipt\.printableWidthMm <= pageWidthMm/,
    "Debe verificar que no exceda el pageWidthMm físico.");
  assert.match(scope, /printableWidthMm:\s*sanitizedPrintable/,
    "El payload debe transportar el printableWidthMm sanitizado.");
});

test("thermal-ticket.ts: ticketCSS acepta y aplica printableWidthMm al <pre>", async () => {
  const src = await read(thermalTicket);
  // Firma de ticketCSS incluye printableWidthMm entre width y fontSizePx.
  assert.match(src, /function ticketCSS\(\s*width:\s*TicketWidth,\s*pageWidthMm:\s*number,\s*printableWidthMm:\s*number/,
    "ticketCSS debe recibir printableWidthMm como argumento separado de pageWidthMm.");
  // Y usar ese valor dentro del CSS del `pre` (ancho de la columna de impresión).
  assert.match(src, /const printableWidthValue = `\$\{printableWidthMm\}mm`/,
    "ticketCSS debe calcular el string CSS a partir de printableWidthMm.");
  assert.match(src, /width:\s*\$\{printableWidthValue\}/,
    "El <pre> debe limitarse al ancho imprimible (no al físico), dejando el margen muerto.");
});

test("thermal-ticket.ts: printThermalTicket pasa printableWidthMm al ticketCSS", async () => {
  const src = await read(thermalTicket);
  const fnStart = src.indexOf("export function printThermalTicket(");
  assert.ok(fnStart > 0);
  const next = src.indexOf("\n// =====", fnStart + 50);
  const scope = src.slice(fnStart, next > 0 ? next : fnStart + 7000);
  assert.match(scope, /resolvePrintableWidthMm\(persisted, pageWidthMm\)/,
    "Debe resolver el ancho imprimible a partir de la config persistida (BC segura).");
  assert.match(scope, /ticketCSS\(effectiveWidth, pageWidthMm, printableWidthMm/,
    "El llamador a ticketCSS debe inyectar printableWidthMm como tercer argumento.");
});

test("thermal-ticket.ts: resolvePrintableWidthMm nunca excede pageWidthMm", async () => {
  const src = await read(thermalTicket);
  const fnStart = src.indexOf("function resolvePrintableWidthMm(");
  assert.ok(fnStart > 0, "El helper interno debe existir.");
  const scope = src.slice(fnStart, fnStart + 1200);
  assert.match(scope, /if \(n > pageWidthMm\) return pageWidthMm/,
    "El helper debe caparse al ancho físico como última línea de defensa.");
  assert.match(scope, /if \(!persisted\) return pageWidthMm/,
    "Sin config persistida el ancho imprimible iguala al físico (BC con el default histórico).");
});
