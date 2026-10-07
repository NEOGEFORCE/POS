import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const libPath = join(here, "..", "src", "lib", "thermal-ticket.ts");
const paymentModalPath = join(here, "..", "src", "components", "shared", "UniversalPaymentModal.tsx");
const saleDetailPath = join(here, "..", "src", "app", "(app)", "sales", "components", "SaleDetailModal.tsx");
const salesPagePath = join(here, "..", "src", "app", "(app)", "sales", "page.tsx");
const auditPath = join(here, "..", "src", "app", "(app)", "audit", "components", "AuditTable.tsx");
const closurePath = join(here, "..", "src", "app", "(app)", "dashboard", "closure", "page.tsx");
const debtsPath = join(here, "..", "src", "app", "(app)", "sales", "debts", "page.tsx");

// ============================================================================
// RECIBO GRÁFICO — guardianes estáticos del rediseño
// ============================================================================
//
// La factura compartida y la impresión manual DEBEN usar la misma fuente que
// la tirilla térmica: `buildTicketText` / `saleToTicket` en `thermal-ticket`.
// Antes había tres plantillas distintas (una por pantalla) y los emojis se
// re-mandaban por WhatsApp aunque el PNG ya iba adjunto. Estos tests fijan
// las reglas para que no vuelvan a divergir.

test("thermal-ticket exporta todas las piezas necesarias para compartir imagen", async () => {
  const source = await readFile(libPath, "utf8");
  // La lógica pura de buildTicketText vive en thermal-ticket-text.mjs
  // (para que los tests `node --test` la puedan ejercitar sin bundler);
  // el facade TS lo re-exporta para que los consumidores sigan
  // importando `@/lib/thermal-ticket` sin cambios.
  const textSource = await readFile(
    join(here, "..", "src", "lib", "thermal-ticket-text.mjs"),
    "utf8",
  );
  assert.match(textSource, /export function buildTicketText\(/,
    "buildTicketText es la fuente única del texto del ticket (en el .mjs puro)");
  assert.match(source, /export\s*\{[^}]*buildTicketText[^}]*\}/,
    "thermal-ticket.ts debe re-exportar buildTicketText para los consumidores");
  assert.match(source, /export function saleToTicket\(/,
    "saleToTicket mapea una venta del historial al ticket");
  assert.match(source, /export function printThermalTicket\(/,
    "la impresión manual pasa por printThermalTicket, no window.print");
  assert.match(source, /export function renderTicketCanvas\(/,
    "el PNG se arma con Canvas 2D nativo, sin dependencia nueva");
  assert.match(source, /export function ticketImageBlob\(/,
    "el PNG se expone como Blob listo para share o download");
  assert.match(source, /export (?:async )?function shareTicketImage\(/,
    "shareTicketImage orquesta share nativo + fallback descarga+WhatsApp");
  assert.match(source, /export (?:async )?function sendTicketImageToTelegram\(/,
    "el envío a Telegram vía multipart vive en el helper compartido");
  assert.match(source, /export function whatsappShortTicketText\(/,
    "el texto corto evita re-enviar la factura completa por WhatsApp");
});

test("shareTicketImage usa navigator.share con archivos cuando está disponible", async () => {
  const source = await readFile(libPath, "utf8");
  const shareBlock = source.slice(source.indexOf("export async function shareTicketImage"));
  const upperBlock = shareBlock.slice(0, 2500);
  assert.match(upperBlock, /canShareFiles\(\[file\]\)/,
    "debe comprobar canShare({files}) antes de llamar a share");
  assert.match(upperBlock, /\.share\(\{/,
    "la rama feliz dispara navigator.share con un objeto {title, text, files}");
  assert.match(upperBlock, /files: \[file\]/,
    "el share debe adjuntar el PNG en el campo files");
  assert.match(upperBlock, /URL\.createObjectURL\(blob\)/,
    "el fallback descarga el PNG localmente");
  assert.match(upperBlock, /whatsappShortURL\(data/,
    "el fallback abre WhatsApp con el texto corto, no con la factura completa");
});

test("sendTicketImageToTelegram sube multipart al endpoint protegido", async () => {
  const source = await readFile(libPath, "utf8");
  const telegramBlock = source.slice(source.indexOf("sendTicketImageToTelegram"));
  assert.match(telegramBlock.slice(0, 2000), /FormData\(\)/,
    "debe usar FormData para multipart");
  assert.match(telegramBlock.slice(0, 2000), /\/telegram\/ticket-image/,
    "el path destino es el endpoint nuevo multipart");
  assert.match(telegramBlock.slice(0, 2000), /Authorization:[^,]*Bearer/,
    "debe mandar el token de sesión en Authorization");
  assert.match(telegramBlock.slice(0, 2000), /image\/png/,
    "el archivo se marca como image/png para que el backend valide MIME");
});

// ----------------------------------------------------------------------------
// GUARDIÁN DEL MULTIPART REAL
// ----------------------------------------------------------------------------
//
// El backend hace `c.FormFile("image")` en `notification_ticket_image_handler.go`.
// La UI venía adjuntando el PNG como campo `"ticket"`, lo que hacía fallar el
// endpoint con 400 silencioso ("Debe adjuntar el PNG en el campo \"image\"").
// Este bloque fija el nombre canónico y PROHÍBE que vuelva a aparecer el
// legacy. Es la contraparte frontend del test
// `backPOS-go/.../notification_ticket_image_handler_test.go`.

test("el multipart adjunta el PNG con el campo canónico 'image' (contrato con el backend)", async () => {
  const source = await readFile(libPath, "utf8");

  // --- Alcance 1: dentro de sendTicketImageToTelegram ---
  // El `indexOf("sendTicketImage...")` cae en el JSDoc que precede a la
  // declaración; hay que saltar al `export async function` real para no
  // escanear solo el comentario.
  const fnStart = source.indexOf("export async function sendTicketImageToTelegram");
  assert.ok(fnStart > 0, "sendTicketImageToTelegram debe existir en el archivo");
  const nextExport = source.indexOf("\nexport ", fnStart + 10);
  const scope = source.slice(fnStart, nextExport > 0 ? nextExport : fnStart + 2000);

  // El PNG se adjunta con el campo "image" (coincide con c.FormFile("image")).
  assert.match(scope, /form\.append\(\s*["']image["']\s*,/,
    'el PNG se adjunta con el campo "image" (el backend lee FormFile("image"))');

  // El tipo MIME viaja junto al File, no como un append suelto.
  assert.match(scope, /new File\(\s*\[\s*blob\s*\][\s\S]*?type:\s*["']image\/png["']/,
    'el File se construye con type: "image/png" para que la firma MIME cuadre');

  // --- Alcance 2: toda la fuente ---
  // Ningún form.append puede volver a usar "ticket" como nombre de campo. El
  // contrato viejo rompía el endpoint y nadie se enteraba (status 400 que
  // caía al fallback de texto plano).
  const campos = Array.from(source.matchAll(/form\.append\(\s*["']([^"']+)["']/g)).map((m) => m[1]);
  assert.ok(!campos.includes("ticket"),
    `ningún form.append puede usar "ticket" como nombre de campo. Campos usados: [${campos.join(", ")}]`);

  // Y los únicos campos permitidos en el multipart del ticket son "image" y
  // "caption" (opcional). Si aparece un tercero, probablemente es un typo.
  const camposPermitidos = new Set(["image", "caption"]);
  const inesperados = campos.filter((c) => !camposPermitidos.has(c));
  assert.deepEqual(inesperados, [],
    `el multipart solo acepta "image" y "caption"; aparecieron campos extra: ${JSON.stringify(inesperados)}`);
});

// Guardián dinámico: ejecuta el cuerpo REAL de sendTicketImageToTelegram
// contra un `fetch` interceptado para inspeccionar el `FormData` tal cual lo
// recibe el servidor. Esto cubre regresiones donde alguien pueda escribir
// `form.append("image", ...)` arriba y después pisar `body: form` con otro
// cuerpo más abajo — un match de regex no lo cazaría.
//
// Como la fuente es TypeScript y el runner es `node --test` sobre `.mjs`,
// extraemos el cuerpo balanceado por llaves de la función (sin anotaciones de
// tipos adentro, son solo JS puro) y lo evaluamos con `new AsyncFunction`
// inyectando las dependencias (fetch, ticketImageBlob, ticketImageFileName,
// FormData, File) como parámetros. No se renderiza canvas ni se requiere DOM.
test("al enviar a Telegram, el fetch recibe un FormData con el campo 'image' y MIME image/png", async () => {
  const source = await readFile(libPath, "utf8");

  const fnStart = source.indexOf("export async function sendTicketImageToTelegram");
  assert.ok(fnStart > 0, "sendTicketImageToTelegram debe existir en el archivo");

  // Encontrar el `{` que abre el CUERPO de la función. Hay que saltar las
  // llaves que viven dentro de la lista de parámetros (ej. `options: { ... }`)
  // y dentro del tipo de retorno (`Promise<{ ok: boolean; status: number }>`),
  // así que llevamos la cuenta de paréntesis y de ángulos de genéricos TS.
  let parenDepth = 0;
  let angleDepth = 0;
  let openBrace = -1;
  for (let i = fnStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === "<" && parenDepth === 0) angleDepth++;
    else if (ch === ">" && parenDepth === 0 && angleDepth > 0) angleDepth--;
    else if (ch === "{" && parenDepth === 0 && angleDepth === 0) {
      openBrace = i;
      break;
    }
  }
  assert.ok(openBrace > fnStart, "no se encontró el `{` que abre el cuerpo de sendTicketImageToTelegram");

  // Cierre balanceado por llaves (ya adentro del cuerpo).
  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { closeBrace = i; break; }
    }
  }
  assert.ok(closeBrace > openBrace, "no se pudo balancear las llaves de sendTicketImageToTelegram");
  const body = source.slice(openBrace + 1, closeBrace);

  const capturado = { url: null, init: null };
  const fakeFetch = async (url, init) => {
    capturado.url = url;
    capturado.init = init;
    return { ok: true, status: 200 };
  };

  // 8 bytes: la firma mágica PNG. El backend la valida; usar bytes reales
  // deja el test preparado para futuras verificaciones de MIME aquí.
  const fakeTicketImageBlob = async () =>
    new Blob([new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])], { type: "image/png" });
  const fakeTicketImageFileName = () => "ticket-GUARD.png";

  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFn(
    "data", "options", "fetch", "ticketImageBlob", "ticketImageFileName", "FormData", "File",
    body,
  );

  const result = await run(
    { ticketNumber: "GUARD" },
    { token: "tok-xyz", apiBase: "https://pos.local/api/", caption: "Factura #GUARD" },
    fakeFetch,
    fakeTicketImageBlob,
    fakeTicketImageFileName,
    FormData,
    File,
  );

  assert.deepEqual(result, { ok: true, status: 200 }, "el helper debe propagar {ok,status} de fetch");
  assert.equal(capturado.url, "https://pos.local/api/telegram/ticket-image",
    "la URL final debe terminar en /telegram/ticket-image, sin barra duplicada");
  assert.equal(capturado.init.method, "POST");
  assert.equal(capturado.init.headers.Authorization, "Bearer tok-xyz",
    "el token debe viajar como Bearer en Authorization");
  assert.ok(capturado.init.body instanceof FormData,
    "el body debe ser FormData (multipart), nunca JSON stringificado");

  // El guardián clave: el PNG viaja bajo el campo "image", NO "ticket".
  const image = capturado.init.body.get("image");
  assert.ok(image, 'FormData debe contener el campo "image" (lo que lee c.FormFile("image"))');
  assert.ok(!capturado.init.body.has("ticket"),
    'FormData NO debe contener el campo legacy "ticket" (rompe el endpoint silenciosamente)');

  // El archivo debe ser un File PNG con el nombre esperado.
  assert.equal(image.type, "image/png", "el File debe declarar MIME image/png");
  assert.equal(image.name, "ticket-GUARD.png", "el nombre del archivo debe venir de ticketImageFileName");

  // Y el caption, cuando viene, va como campo de texto suelto.
  assert.equal(capturado.init.body.get("caption"), "Factura #GUARD",
    'cuando hay caption, se adjunta como campo de texto "caption"');
});

test("la preferencia auto-print se unifica en pos_auto_print, honrando la legacy", async () => {
  const source = await readFile(libPath, "utf8");
  const autoPrintBlock = source.slice(source.indexOf("Preferencia de impresión automática"));
  assert.match(autoPrintBlock.slice(0, 2000), /AUTO_PRINT_KEY = "pos_auto_print"/,
    "la clave canónica es pos_auto_print");
  assert.match(autoPrintBlock.slice(0, 2000), /AUTO_PRINT_KEY_LEGACY = "pos_auto_print_ticket"/,
    "la legacy se honra en lectura");
  assert.match(autoPrintBlock.slice(0, 2000), /removeItem\(AUTO_PRINT_KEY_LEGACY\)/,
    "al escribir se purga la legacy para no revivirla");
});

test("UniversalPaymentModal usa printThermalTicket y shareTicketImage, no window.print", async () => {
  const source = await readFile(paymentModalPath, "utf8");

  assert.match(source, /printThermalTicket\(/, "la impresión debe pasar por printThermalTicket");
  assert.match(source, /shareTicketImage\(/, "WhatsApp debe compartir la imagen");
  // Permitimos la mención en comentarios (contexto histórico) pero rechazamos
  // la llamada ejecutable sin estar comentada.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/window\.print\(\)/.test(stripped),
    "ya no se puede llamar a window.print(): descarga el DOM completo a la impresora");
  // Lee auto-print con el helper compartido para no desincronizar la clave.
  assert.match(source, /readAutoPrint\(\)/, "autoPrint se lee con readAutoPrint para honrar la legacy");
  assert.match(source, /persistAutoPrint\(/, "autoPrint se guarda con persistAutoPrint");
  // Mantiene el fallback de texto para compatibilidad con backend viejo.
  assert.match(source, /\/telegram\/ticket/, "el endpoint de texto queda como fallback de compat");
});

test("SaleDetailModal reutiliza la plantilla térmica para imprimir y compartir", async () => {
  const source = await readFile(saleDetailPath, "utf8");
  assert.match(source, /saleToTicket\(sale/, "la reimpresión usa saleToTicket del helper");
  assert.match(source, /printThermalTicket\(saleToTicket\(sale/,
    "la impresión no abre window.print");
  assert.match(source, /shareTicketImage\(saleToTicket\(sale/,
    "WhatsApp comparte la imagen con la misma fuente");
  assert.ok(!/window\.print\(\)/.test(source), "sin window.print aquí");
  // Ya no hay plantilla con emojis duplicada: el texto corto lo arma el helper.
  assert.ok(!/🧾 \*FACTURA DE VENTA/.test(source),
    "no debe quedar una plantilla propia con emojis que pise la del helper");
});

test("sales/page.tsx ya no usa window.print para reimprimir", async () => {
  const source = await readFile(salesPagePath, "utf8");
  // Permitimos la mención en comentarios (contexto histórico) pero rechazamos
  // la llamada ejecutable `window.print()` sin estar comentada.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!/window\.print\(\)/.test(stripped),
    "la reimpresión desde el historial pasa por el modal con printThermalTicket");
});

// Pantallas secundarias que todavía usan window.print quedan como pendiente
// explícito. No las migramos en este sprint para evitar regresiones en los
// reportes impresos (cierres, auditoría), que usan HTML completo. El test
// solo documenta el pendiente para que no se olvide.
test("documenta las pantallas con impresión HTML pendiente de migrar", async () => {
  const audit = await readFile(auditPath, "utf8");
  const closure = await readFile(closurePath, "utf8");
  const debts = await readFile(debtsPath, "utf8");
  // Confirmamos que el pendiente sigue vivo: estas pantallas imprimen HTML
  // completo intencionalmente (reportes, cierres), no tickets térmicos.
  assert.match(audit, /window\.print\(\)/, "auditoría imprime HTML — pendiente de migrar");
  assert.match(closure, /window\.print\(\)/, "cierre de caja imprime HTML — pendiente de migrar");
  assert.match(debts, /window\.print\(\)/, "deudores imprime HTML — pendiente de migrar");
});

// ----------------------------------------------------------------------------
// Reglas de contenido del texto térmico. Son estáticas: inspeccionan la
// fuente para asegurar que no se cuela una plantilla alternativa en el ticket.
// ----------------------------------------------------------------------------

test("whatsappShortTicketText NO incluye el detalle completo de productos", async () => {
  const source = await readFile(libPath, "utf8");
  const shortBlock = source.slice(source.indexOf("whatsappShortTicketText"));
  const nextFn = shortBlock.indexOf("export function", 20);
  const fnBody = shortBlock.slice(0, nextFn > 0 ? nextFn : 1200);
  // Debe mandar nombre, número y total, pero no re-listar productos ni
  // emojis decorativos del ticket completo.
  assert.ok(!/DETALLE DE PRODUCTOS/.test(fnBody),
    "el texto corto no debe repetir el detalle que ya va en el PNG adjunto");
  assert.match(fnBody, /Te adjunto la factura/,
    "debe indicar que la imagen va adjunta");
});
