import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const configPage = join(here, "..", "src", "app", "(app)", "labels", "config", "page.tsx");
const thermalTicket = join(here, "..", "src", "lib", "thermal-ticket.ts");
const thermalTicketText = join(here, "..", "src", "lib", "thermal-ticket-text.mjs");
const printSheet = join(here, "..", "src", "app", "(app)", "inventory", "receive", "components", "LabelPrintSheet.tsx");
const labelsPage = join(here, "..", "src", "app", "(app)", "labels", "page.tsx");
const configLib = join(here, "..", "src", "lib", "printing-config.mjs");

async function read(path) { return readFile(path, "utf8"); }

// =============================================================================
// Lib canónica: contratos clave que el resto del código asume.
// =============================================================================

test("printing-config.mjs exporta la clave canónica y la versión", async () => {
  const src = await read(configLib);
  assert.match(src, /export const PRINTING_CONFIG_VERSION\s*=\s*1\b/,
    "La versión canónica es 1 (hardcode intencional, referenciada por otros .mjs y por tests).");
  assert.match(src, /export const PRINTING_CONFIG_STORAGE_KEY\s*=\s*"pos_printing_config_v1"/,
    "La clave de LocalStorage debe estar versionada: pos_printing_config_v1.");
});

test("printing-config.mjs: nunca ejecuta el comando del cajón (no eval, no Function)", async () => {
  const src = await read(configLib);
  assert.ok(!/\beval\s*\(/.test(src), "No debe aparecer `eval(` en printing-config.mjs");
  assert.ok(!/new\s+Function\s*\(/.test(src), "No debe aparecer `new Function(` en printing-config.mjs");
});

// =============================================================================
// /labels/config — UI contract (lectura estática del page.tsx)
// =============================================================================

test("labels/config: usa el helper central isAdminUser (no hardcode de roles)", async () => {
  const src = await read(configPage);
  assert.match(src, /from\s+["']@\/lib\/auth-helpers\.mjs["']/,
    "Debe importar isAdminUser del helper central.");
  assert.match(src, /isAdminUser\(user\)/,
    "Debe llamar isAdminUser(user) en lugar de hardcodear roles.");
  // No debe sobrevivir el patrón hardcode anterior:
  assert.doesNotMatch(src, /role\s*===\s*"admin"\s*\|\|\s*role\s*===\s*"administrador"/,
    "No debe conservar el chequeo hardcodeado.");
});

test("labels/config: tiene las tres pestañas Perfil/Recibo/Etiquetas", async () => {
  const src = await read(configPage);
  for (const tabKey of ["perfil", "recibo", "etiquetas"]) {
    assert.ok(
      src.includes(`key="${tabKey}"`),
      `Falta <Tab key="${tabKey}" ...> en la configuración.`,
    );
  }
});

test("labels/config: 'Probar cajón' sigue haciendo POST /cash-drawer/open con override:true", async () => {
  const src = await read(configPage);
  assert.ok(src.includes("Probar cajón"), "Debe existir el botón 'Probar cajón'.");
  assert.ok(src.includes('"/cash-drawer/open"'), "Debe hacer POST /cash-drawer/open.");
  assert.ok(/override:\s*true/.test(src), "La auditoría del cajón requiere override admin explícito.");
});

test("labels/config: tiene botón 'Imprimir página de prueba' con fallback iframe", async () => {
  const src = await read(configPage);
  assert.ok(src.includes("Imprimir página de prueba"),
    "Debe existir el botón 'Imprimir página de prueba'.");
  assert.match(src, /posBridge\?\.?printTestPage|posBridge\.printTestPage/,
    "Debe intentar primero posBridge.printTestPage.");
  assert.match(src, /runIframeTestPrint|iframe\.contentWindow\?\.print\(\)/,
    "Debe tener fallback de impresión por iframe cuando el bridge no está.");
});

test("labels/config: usa apiFetch (no fetch directo) para todas las llamadas", async () => {
  const src = await read(configPage);
  // El `\b` evita que apiFetch dispare el guardián: `\b` entre `i` y `F`
  // (ambos word chars) NO existe. Sólo capturamos llamadas sueltas a fetch(.
  const bareFetchCalls = src.match(/\bfetch\s*\(/g) || [];
  assert.equal(bareFetchCalls.length, 0,
    "El page NO debe llamar fetch() directamente — todo pasa por apiFetch.");
});

test("labels/config: nunca usa dangerouslySetInnerHTML con interpolación directa", async () => {
  const src = await read(configPage);
  // Si llegara a usarse, debe ser con strings constantes. En este page nunca
  // se usa (la impresión arma el HTML en el iframe por string concatenation
  // CON escapeHtml). Guardián: la frase sólo aparece acotada.
  const occurrences = (src.match(/dangerouslySetInnerHTML/g) || []).length;
  assert.equal(occurrences, 0,
    "El page no debe tener dangerouslySetInnerHTML (toda la UI es declarativa).");
});

test("labels/config: la impresión de prueba escapa HTML del usuario", async () => {
  const src = await read(configPage);
  // Debe existir la función escapeHtml definida al tope.
  assert.match(src, /function\s+escapeHtml\s*\(/,
    "Debe existir un helper escapeHtml para sanitizar valores del usuario.");
  // Y debe usarse al armar el HTML del iframe (buildReceiptTestHtml / buildLabelTestHtml).
  assert.match(src, /buildReceiptTestHtml|buildLabelTestHtml/,
    "Debe existir el builder del HTML de prueba.");
  assert.ok(src.includes("escapeHtml("),
    "El builder debe aplicar escapeHtml a los campos del usuario.");
});

test("labels/config: no usa prompt/alert/confirm nativos (contrato POS)", async () => {
  const src = await read(configPage);
  for (const banned of ["window.alert(", "window.prompt(", "window.confirm(", "\n  alert(", "\n  prompt(", "\n  confirm("]) {
    assert.ok(!src.includes(banned),
      `El page no debe usar diálogos nativos (${banned.trim()}).`);
  }
});

test("labels/config: Save escribe en LocalStorage y proyecta best-effort al backend", async () => {
  const src = await read(configPage);
  assert.match(src, /savePrintingConfig\(/,
    "Debe llamar savePrintingConfig() al guardar.");
  assert.match(src, /projectConfigToPrinterProfile\(/,
    "Debe intentar proyectar a /labels/printers (DB 016).");
  assert.match(src, /apiFetch\(\s*"\/labels\/printers"[\s\S]{1,120}method:\s*"POST"/,
    "La proyección debe ser POST /labels/printers.");
});

// =============================================================================
// thermal-ticket: consume config persistida sin romper API pública.
// =============================================================================

test("thermal-ticket: importa helpers del módulo canónico de config", async () => {
  const src = await read(thermalTicket);
  assert.match(src, /from\s+["']\.\/printing-config\.mjs["']/,
    "thermal-ticket debe importar de printing-config.mjs (fuente canónica).");
  assert.match(src, /loadPrintingConfig/, "Debe usar loadPrintingConfig.");
  assert.match(src, /receiptWidthKey/, "Debe usar receiptWidthKey para el width.");
});

test("thermal-ticket: la lógica pura vive en thermal-ticket-text.mjs y se re-exporta", async () => {
  const text = await read(thermalTicketText);
  // La función pura DEBE existir en el .mjs para que los tests `node --test`
  // la puedan importar sin bundler.
  assert.match(text, /export function buildTicketText\(/,
    "buildTicketText debe exportarse desde el .mjs (importable por Node).");
  assert.match(text, /export function escapeHtml\(/,
    "escapeHtml debe exportarse desde el .mjs para que los consumidores lo usen y los tests lo verifiquen.");
  // Y NO debe tocar localStorage ni cargar la config persistida.
  assert.ok(!text.includes("localStorage"),
    "thermal-ticket-text.mjs es puro: no debe tocar localStorage.");
  assert.ok(!text.includes("loadPrintingConfig"),
    "thermal-ticket-text.mjs es puro: no debe disparar la lectura persistida.");

  // El facade TS re-exporta buildTicketText para que los consumidores
  // (SaleDetailModal, UniversalPaymentModal) sigan importando de
  // `@/lib/thermal-ticket` sin cambios.
  const facade = await read(thermalTicket);
  assert.match(facade, /from\s+["']\.\/thermal-ticket-text\.mjs["']/,
    "thermal-ticket.ts debe importar los helpers puros desde ./thermal-ticket-text.mjs.");
  assert.match(facade, /export\s*\{[^}]*buildTicketText[^}]*\}/,
    "thermal-ticket.ts debe re-exportar buildTicketText.");
});

test("thermal-ticket: printThermalTicket consulta la config si el llamador no pasa width", async () => {
  const src = await read(thermalTicket);
  const fnStart = src.indexOf("export function printThermalTicket(");
  assert.ok(fnStart > 0);
  // El cuerpo arranca en `{` tras los parámetros/tipo retorno. Buscamos la
  // siguiente declaración top-level para acotar.
  const next = src.indexOf("\n// =====", fnStart + 50);
  const scope = src.slice(fnStart, next > 0 ? next : fnStart + 5000);
  assert.ok(scope.includes("readPersistedConfig"),
    "Debe consultar la config persistida cuando falta un override explícito.");
  assert.ok(scope.includes("receiptWidthKey"),
    "El width efectivo se deriva de receiptWidthKey cuando hay config.");
  // Fallback histórico: si NO hay config persistida cae a "58mm".
  assert.ok(/"58mm"/.test(scope),
    "Si no hay config persistida, debe seguir cayendo al default histórico 58mm.");
});

test("thermal-ticket: printThermalTicket consume showTaxes/thankYou/cut desde la config persistida", async () => {
  const src = await read(thermalTicket);
  // El helper `composeEffectiveOptions` colapsa overrides del llamador con
  // config persistida. DEBE leer los tres toggles del alcance pedido en
  // la revisión (receipt.content.showTaxes, receipt.footer.thankYou,
  // receipt.cut).
  const composeStart = src.indexOf("function composeEffectiveOptions(");
  assert.ok(composeStart > 0, "composeEffectiveOptions debe existir para colapsar overrides.");
  const next = src.indexOf("\n/**", composeStart + 10);
  const composeBody = src.slice(composeStart, next > 0 ? next : composeStart + 2500);

  assert.match(composeBody, /content\.showTaxes/,
    "composeEffectiveOptions debe leer receipt.content.showTaxes de la config.");
  assert.match(composeBody, /footer\.thankYou/,
    "composeEffectiveOptions debe leer receipt.footer.thankYou de la config.");
  assert.match(composeBody, /\br\.cut\b|receipt\.cut/,
    "composeEffectiveOptions debe leer receipt.cut de la config.");
  assert.match(composeBody, /content\.showLogo/,
    "composeEffectiveOptions debe leer receipt.content.showLogo de la config.");
  assert.match(composeBody, /content\.showValidationQR/,
    "composeEffectiveOptions debe leer receipt.content.showValidationQR de la config.");
});

test("thermal-ticket: printThermalTicket escapa los valores de usuario antes de inyectarlos en HTML", async () => {
  const src = await read(thermalTicket);
  const fnStart = src.indexOf("export function printThermalTicket(");
  const next = src.indexOf("\n// =====", fnStart + 50);
  const scope = src.slice(fnStart, next > 0 ? next : fnStart + 5000);
  // El título del iframe lleva el ticketNumber del usuario. Si no se
  // escapa, un ticketNumber `</title><script>` romperÍa el head.
  assert.match(scope, /escapeHtml\(String\(data\.ticketNumber/,
    "ticketNumber se escapa antes de inyectarse como texto del <title>.");
  // El texto del ticket también se escapa antes de meterlo en <pre>.
  assert.match(scope, /escapeHtml\(text\)/,
    "el cuerpo del ticket se escapa como contenido HTML.");
});

test("thermal-ticket: showLogo embebe <img> SOLO cuando data.logoUrl está presente", async () => {
  const src = await read(thermalTicket);
  // El helper logoHtmlOrEmpty decide; honestamente devuelve "" cuando
  // la config dice showLogo=true pero el llamador no mandó URL. Nunca
  // falseamos una imagen.
  const helperStart = src.indexOf("function logoHtmlOrEmpty(");
  assert.ok(helperStart > 0, "logoHtmlOrEmpty debe existir para decidir el embed.");
  const next = src.indexOf("\n/**", helperStart + 10);
  const body = src.slice(helperStart, next > 0 ? next : helperStart + 1200);
  assert.match(body, /options\.showLogo/,
    "la decisión depende de options.showLogo.");
  assert.match(body, /data\.logoUrl/,
    "y de la existencia de data.logoUrl (si no hay URL, no se pinta).");
  assert.match(body, /escapeHtml\(url\)/,
    "la URL se escapa como atributo HTML antes de embeberla en <img src>.");
});

test("thermal-ticket: showValidationQR en el .mjs rotula URL de texto SIN inventar QR escaneable", async () => {
  // La parte puramente determinista del toggle vive en el .mjs. No debe
  // haber referencias a librerías o APIs de QR (QRCode, qrcode-generator,
  // navigator.canvas de QR, etc.) — eso implicaría una dependencia nueva
  // o un render falso que no se puede escanear.
  const text = await read(thermalTicketText);
  assert.ok(!/QRCode|qrcode|QR\(|\bqr\.generate/i.test(text),
    "thermal-ticket-text.mjs no debe depender de un generador de QR.");
  // Y debe rotular la URL como texto plano cuando se activa el toggle.
  assert.match(text, /showValidationQR/,
    "el helper puro debe honrar el toggle showValidationQR.");
  assert.match(text, /validationUrl/,
    "el helper puro debe leer la URL opcional de TicketData.");
});

// =============================================================================
// LabelPrintSheet / labels/page: payload del bridge enriquecido
// =============================================================================

test("LabelPrintSheet: payload del bridge incluye connection + labels sanitizadas", async () => {
  const src = await read(printSheet);
  assert.match(src, /loadPrintingConfig\(\)/,
    "LabelPrintSheet debe hidratar la config antes de llamar al bridge.");
  // El bridgePayload debe llevar connection y labels del printingConfig.
  const scope = src.slice(src.indexOf("const printingConfig"));
  assert.match(scope.slice(0, 800), /connection:\s*printingConfig\.connection/,
    "El bridge debe recibir printingConfig.connection.");
  assert.match(scope.slice(0, 800), /labels:\s*printingConfig\.labels/,
    "El bridge debe recibir printingConfig.labels.");
});

test("labels/page: handlePrint pasa connection + labels al bridge sin tocar la auditoría", async () => {
  const src = await read(labelsPage);
  assert.match(src, /loadPrintingConfig\(\)/, "labels/page debe cargar la config antes de delegar.");
  const idxAudit = src.indexOf('"/labels/print-jobs"');
  const idxBridge = src.indexOf("w.posBridge?.print");
  assert.ok(idxAudit >= 0 && idxBridge >= 0, "Deben existir auditoría + llamada al bridge.");
  assert.ok(idxAudit < idxBridge,
    "La auditoría a /labels/print-jobs debe seguir ocurriendo ANTES del bridge.");
  // Y el payload del bridge debe traer connection + labels (del printingConfig).
  const bridgeScope = src.slice(idxBridge, idxBridge + 800);
  assert.ok(bridgeScope.includes("bridgePayload"),
    "El payload enviado al bridge debe venir de bridgePayload (que agrega la config).");
});

test("LabelPrintSheet: siguen presentes las invariantes previas (no rollback, no tocar bulk-receive)", async () => {
  const src = await read(printSheet);
  assert.ok(!/rollback/i.test(src), "El sheet no debe ejecutar rollback de stock.");
  assert.ok(!/bulk-receive/.test(src), "El sheet no debe tocar la recepción.");
});
